//! One pseudoterminal per pane (ConPTY on Windows, a unix pty on macOS). Output streams to the
//! webview over a Tauri channel as UTF-8 strings (split multi-byte sequences are carried over to the
//! next read so nothing is mangled).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { d: String },
    Exit { code: u32 },
}

/// Where a pane's output goes. The channel is swappable so a reloaded webview can re-attach to a
/// running process; `replay` keeps the tail of the output to repaint the fresh terminal.
pub struct Sink {
    chan: Mutex<Channel<PtyEvent>>,
    replay: Mutex<String>,
}

const REPLAY_CAP: usize = 768 * 1024;

impl Sink {
    fn send(&self, ev: PtyEvent) {
        if let PtyEvent::Data { d } = &ev {
            let mut r = self.replay.lock().unwrap();
            r.push_str(d);
            if r.len() > REPLAY_CAP {
                // Trim from the front at a line break so we don't start mid-sequence too often.
                let cut = r.len() - REPLAY_CAP / 2;
                let at = r[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
                let at = (at..r.len()).find(|i| r.is_char_boundary(*i)).unwrap_or(r.len());
                r.drain(..at);
            }
        }
        let _ = self.chan.lock().unwrap().send(ev);
    }
}

struct PaneProc {
    sink: Arc<Sink>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
    /// Unique per spawn. Pane ids are reused (restart, webview reload), so exit handling must
    /// only ever touch the spawn it belongs to.
    gen: u64,
}

static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Default)]
pub struct Ptys {
    panes: Mutex<HashMap<u32, PaneProc>>,
}

impl Ptys {
    pub fn pane_pids(&self) -> Vec<(u32, u32)> {
        let panes = self.panes.lock().unwrap();
        panes
            .iter()
            .filter_map(|(id, p)| p.pid.map(|pid| (*id, pid)))
            .collect()
    }

    pub fn kill_all(&self) {
        let mut panes = self.panes.lock().unwrap();
        #[cfg(unix)]
        {
            // The app is exiting: hang up every pane's whole session, give them a moment, then
            // make sure nothing survives (a deferred SIGKILL thread would die with us).
            let groups: Vec<(u32, Vec<i32>)> =
                panes.values().filter_map(|p| p.pid).map(|pid| (pid, unix::hang_up_session(pid))).collect();
            if !groups.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(400));
                for (pid, members) in groups {
                    unix::kill_stragglers(pid, &members);
                }
            }
        }
        for (_, p) in panes.iter_mut() {
            let _ = p.child.kill();
        }
        panes.clear();
    }
}

/// Split `buf` into the longest valid UTF-8 prefix and a tail that may be an incomplete sequence.
fn take_utf8(carry: &mut Vec<u8>) -> String {
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_string();
            carry.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            match e.error_len() {
                // Incomplete sequence at the end: keep it for the next read.
                None => {
                    let out = String::from_utf8_lossy(&carry[..valid]).into_owned();
                    carry.drain(..valid);
                    out
                }
                // Genuinely invalid bytes: replace them and carry on.
                Some(_) => {
                    let out = String::from_utf8_lossy(carry).into_owned();
                    carry.clear();
                    out
                }
            }
        }
    }
}

fn claude_exe() -> String {
    // Prefer the native installer's binary; fall back to PATH lookup by name.
    let name = if cfg!(windows) { "claude.exe" } else { "claude" };
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".local").join("bin").join(name);
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    "claude".into()
}

/// The OpenSSH client the system ships.
pub fn ssh_exe() -> &'static str {
    if cfg!(windows) {
        r"C:\Windows\System32\OpenSSH\ssh.exe"
    } else {
        "/usr/bin/ssh"
    }
}

/// `--resume <id>` for a Claude pane, if the id is safe to pass and its chat has a transcript.
fn resume_arg(resume: Option<&str>, cwd: &str) -> Result<Option<String>, String> {
    let Some(sid) = resume.filter(|s| !s.is_empty()) else { return Ok(None) };
    // Session ids are UUIDs; reject anything else rather than splice it into a command.
    if !sid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("bad session id".into());
    }
    // A chat that never got a message has no transcript, and `--resume` would just error.
    Ok(crate::sessions::transcript_path(sid, cwd).map(|_| format!(" --resume {sid}")))
}

/// What a pane runs on Windows. Claude and SSH panes run inside PowerShell so quitting them leaves
/// a usable shell in the pane.
#[cfg(windows)]
fn pane_command(
    kind: &str,
    cwd: &str,
    resume: Option<&str>,
    host: Option<String>,
    remote_cmd: Option<String>,
) -> Result<CommandBuilder, String> {
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    if kind == "claude" {
        let mut line = format!("& '{}'", claude_exe());
        if let Some(arg) = resume_arg(resume, cwd)? {
            line.push_str(&arg);
        }
        cmd.args(["-NoExit", "-Command", &line]);
    } else if kind == "ssh" {
        let host = host.unwrap_or_default();
        if !crate::remote::valid_target(&host) {
            return Err("bad host".into());
        }
        // Windows OpenSSH plays best with ConPTY. -t forces a remote TTY for interactive commands.
        let mut line = format!("& '{}' -t {host}", ssh_exe());
        if let Some(rc) = remote_cmd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            line.push_str(&format!(" '{}'", rc.replace('\'', "''")));
        }
        cmd.args(["-NoExit", "-Command", &line]);
    }
    Ok(cmd)
}

/// Single-quote for a POSIX shell (also fine for zsh, bash and fish).
#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// What a pane runs on macOS. A shell pane is the user's login shell. Claude and SSH panes run
/// inside a login interactive shell (so PATH and the rc files are the same as in Terminal) and
/// drop back to that shell when they exit.
#[cfg(unix)]
fn pane_command(
    kind: &str,
    cwd: &str,
    resume: Option<&str>,
    host: Option<String>,
    remote_cmd: Option<String>,
) -> Result<CommandBuilder, String> {
    let default = CommandBuilder::new_default_prog();
    if kind != "claude" && kind != "ssh" {
        return Ok(default); // $SHELL (else the passwd shell) as a login shell
    }
    let shell = default.get_shell();
    let line = if kind == "claude" {
        let mut line = sh_quote(&claude_exe());
        if let Some(arg) = resume_arg(resume, cwd)? {
            line.push_str(&arg);
        }
        line
    } else {
        let host = host.unwrap_or_default();
        if !crate::remote::valid_target(&host) {
            return Err("bad host".into());
        }
        let mut line = format!("{} -t {host}", ssh_exe());
        if let Some(rc) = remote_cmd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            line.push(' ');
            line.push_str(&sh_quote(rc));
        }
        line
    };
    let script = format!("{line}; exec {} -l", sh_quote(&shell));
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-l", "-i", "-c", &script]);
    Ok(cmd)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    state: tauri::State<'_, Arc<Ptys>>,
    id: u32,
    kind: String,
    cwd: String,
    resume: Option<String>,
    host: Option<String>,
    remote_cmd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    // A webview reload re-spawns panes with the same ids; retire the orphaned processes first.
    let _ = pty_kill(state.clone(), id);
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = pane_command(&kind, &cwd, resume.as_deref(), host, remote_cmd)?;
    let fallback = if cfg!(windows) { "C:\\" } else { "/" };
    let dir = if std::path::Path::new(&cwd).is_dir() { cwd } else { dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| fallback.into()) };
    cmd.cwd(dir);
    // Never leak a parent Claude session's markers into a pane (launching Switchboard from inside
    // Claude Code would otherwise make every pane a "child session" with transcripts turned off).
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        if k.starts_with("CLAUDE_CODE_") || k == "CLAUDECODE" || k.starts_with("CLAUDE_AGENT") {
            cmd.env_remove(&k);
        }
    }
    cmd.env("COLORTERM", "truecolor");
    #[cfg(unix)]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "Switchboard");
        // Apps opened from Finder get no locale; without one zsh and Claude Code mangle UTF-8.
        let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()));
        if !has_locale {
            cmd.env("LANG", "en_US.UTF-8");
        }
    }
    cmd.env("SWITCHBOARD_PANE", id.to_string());

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);
    let pid = child.process_id();
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

    let gen = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sink = Arc::new(Sink { chan: Mutex::new(on_event), replay: Mutex::new(String::new()) });
    // Register before the watcher threads start, so a process that exits instantly is still seen.
    state
        .panes
        .lock()
        .unwrap()
        .insert(id, PaneProc { sink: sink.clone(), master: pair.master, writer, child, pid, gen });
    let st: Arc<Ptys> = state.inner().clone();
    let sk = sink.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let s = take_utf8(&mut carry);
                    if !s.is_empty() {
                        // A send failing just means the webview is reloading; keep the process.
                        sk.send(PtyEvent::Data { d: s });
                    }
                }
            }
        }
        // Reader ends when the child exits and the pty closes.
        finish(&st, id, gen);
    });

    // ConPTY keeps the output pipe open until the pseudoconsole closes (and on unix a background
    // job can hold the pty open), so watch the child separately and close our master when it
    // exits; that unblocks the reader above.
    let st2: Arc<Ptys> = state.inner().clone();
    if let Some(pid) = pid {
        std::thread::spawn(move || {
            wait_pid(pid);
            finish(&st2, id, gen);
            // A pane killed by pty_kill is no longer in the map, so `finish` didn't reap it; do it
            // here or it stays a zombie until the app quits. (No-op if `finish` already did.)
            #[cfg(unix)]
            unsafe {
                libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG);
            }
        });
    }

    Ok(pid.unwrap_or(0))
}

/// Remove the pane (if it's still ours) and report its exit once. Dropping the master closes the
/// pseudoconsole, which is what finally unblocks a reader stuck on a live ConPTY pipe.
fn finish(st: &Ptys, id: u32, gen: u64) {
    let removed = {
        let mut panes = st.panes.lock().unwrap();
        match panes.get(&id) {
            Some(p) if p.gen == gen => panes.remove(&id),
            _ => None,
        }
    };
    if let Some(mut p) = removed {
        let code = p.child.try_wait().ok().flatten().map(|s| s.exit_code()).unwrap_or(0);
        let sink = p.sink.clone();
        drop(p); // outside the lock: ClosePseudoConsole can block while output drains
        sink.send(PtyEvent::Exit { code });
    }
}

#[cfg(windows)]
fn wait_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
    unsafe {
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return;
        }
        WaitForSingleObject(h, INFINITE);
        CloseHandle(h);
    }
}

/// Block until the child exits without reaping it (WNOWAIT), so `finish` still reads its real exit
/// code. Then give the reader a moment to drain the last output before the master is dropped.
#[cfg(unix)]
fn wait_pid(pid: u32) {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if r == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            break;
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
}

/// Re-bind a running pane to a new channel (after a webview reload). Returns the buffered output
/// to repaint, or None if no such pane is running (the caller then spawns).
#[tauri::command]
pub fn pty_attach(
    state: tauri::State<'_, Arc<Ptys>>,
    id: u32,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Option<String> {
    let panes = state.panes.lock().unwrap();
    let p = panes.get(&id)?;
    *p.sink.chan.lock().unwrap() = on_event;
    let _ = p.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 });
    let replay = p.sink.replay.lock().unwrap().clone();
    Some(replay)
}

/// Kill every running pane whose id the frontend no longer has (after a reload).
#[tauri::command]
pub fn pty_prune(state: tauri::State<'_, Arc<Ptys>>, keep: Vec<u32>) {
    let stale: Vec<u32> = state.panes.lock().unwrap().keys().filter(|k| !keep.contains(k)).copied().collect();
    for id in stale {
        let _ = pty_kill(state.clone(), id);
    }
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, Arc<Ptys>>, id: u32, data: String) -> Result<(), String> {
    let mut panes = state.panes.lock().unwrap();
    let p = panes.get_mut(&id).ok_or("no such pane")?;
    p.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    p.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, Arc<Ptys>>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let panes = state.panes.lock().unwrap();
    let p = panes.get(&id).ok_or("no such pane")?;
    p.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, Arc<Ptys>>, id: u32) -> Result<(), String> {
    let mut panes = state.panes.lock().unwrap();
    if let Some(mut p) = panes.remove(&id) {
        // Kill the whole tree: shell -> claude -> its tools.
        if let Some(pid) = p.pid {
            kill_tree(pid);
        }
        let _ = p.child.kill();
    }
    Ok(())
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags_no_window()
        .status();
}

/// SIGHUP to the pane's whole session now (what closing a terminal window does), SIGKILL to
/// anything still there a moment later.
#[cfg(unix)]
fn kill_tree(pid: u32) {
    let members = unix::hang_up_session(pid);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        unix::kill_stragglers(pid, &members);
    });
}

#[cfg(unix)]
mod unix {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    /// portable-pty makes each pane's shell a session leader (setsid), so everything started in the
    /// pane shares its session id, even jobs the shell put in their own process groups. Also take
    /// descendants that started a session of their own.
    fn session_members(leader: u32) -> Vec<i32> {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let lead = Pid::from_u32(leader);
        let mut out: Vec<i32> = Vec::new();
        for (pid, p) in sys.processes() {
            let mut ours = p.session_id() == Some(lead);
            let mut cur = p.parent();
            for _ in 0..12 {
                if ours {
                    break;
                }
                let Some(pp) = cur else { break };
                ours = pp == lead;
                cur = sys.process(pp).and_then(|x| x.parent());
            }
            if ours && *pid != lead {
                out.push(pid.as_u32() as i32);
            }
        }
        out
    }

    pub fn hang_up_session(leader: u32) -> Vec<i32> {
        let members = session_members(leader);
        unsafe {
            libc::killpg(leader as i32, libc::SIGHUP);
            libc::kill(leader as i32, libc::SIGHUP);
            for m in &members {
                libc::kill(*m, libc::SIGHUP);
            }
        }
        members
    }

    /// SIGKILL whatever ignored the hang-up. Only processes still in the pane's session, so a pid
    /// that was reused in the meantime is left alone.
    pub fn kill_stragglers(leader: u32, members: &[i32]) {
        unsafe {
            for m in members {
                if libc::getsid(*m) == leader as i32 {
                    libc::kill(*m, libc::SIGKILL);
                }
            }
        }
    }
}

#[cfg(windows)]
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
#[cfg(windows)]
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        self
    }
}

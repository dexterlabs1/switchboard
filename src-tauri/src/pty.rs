//! One ConPTY per pane. Output streams to the webview over a Tauri channel as UTF-8 strings
//! (split multi-byte sequences are carried over to the next read so nothing is mangled).

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
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".local").join("bin").join("claude.exe");
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    "claude".into()
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

    // Claude panes run inside PowerShell so quitting Claude leaves a usable shell in the pane.
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    if kind == "claude" {
        let mut line = format!("& '{}'", claude_exe());
        if let Some(sid) = resume.as_deref().filter(|s| !s.is_empty()) {
            // Session ids are UUIDs; reject anything else rather than splice it into a command.
            if !sid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                return Err("bad session id".into());
            }
            // A chat that never got a message has no transcript, and `--resume` would just error.
            if crate::sessions::transcript_path(sid, &cwd).is_some() {
                line.push_str(&format!(" --resume {sid}"));
            }
        }
        cmd.args(["-NoExit", "-Command", &line]);
    } else if kind == "ssh" {
        let host = host.unwrap_or_default();
        if !crate::remote::valid_target(&host) {
            return Err("bad host".into());
        }
        // Windows OpenSSH plays best with ConPTY. -t forces a remote TTY for interactive commands.
        let ssh = r"C:\Windows\System32\OpenSSH\ssh.exe";
        let mut line = format!("& '{ssh}' -t {host}");
        if let Some(rc) = remote_cmd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            line.push_str(&format!(" '{}'", rc.replace('\'', "''")));
        }
        cmd.args(["-NoExit", "-Command", &line]);
    }
    let dir = if std::path::Path::new(&cwd).is_dir() { cwd } else { dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "C:\\".into()) };
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
        // Reader ends when the child exits and ConPTY closes.
        finish(&st, id, gen);
    });

    // ConPTY keeps the output pipe open until the pseudoconsole closes, so watch the child
    // separately and close our master when it exits; that unblocks the reader above.
    let st2: Arc<Ptys> = state.inner().clone();
    if let Some(pid) = pid {
        std::thread::spawn(move || {
            wait_pid(pid);
            finish(&st2, id, gen);
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
        // Kill the whole tree: powershell -> claude -> its tools.
        if let Some(pid) = p.pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags_no_window()
                .status();
        }
        let _ = p.child.kill();
    }
    Ok(())
}

trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        self
    }
}

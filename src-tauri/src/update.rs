//! One-click updates from GitHub Releases. `npm run release` publishes the installer plus a
//! `latest.json` (version, installer url, sha256, release notes) as assets of a release; the app reads
//! `releases/latest/download/latest.json`, and on request downloads the installer, checks its hash, and
//! hands off to a helper that waits for us to exit, installs silently and starts Switchboard again.
//!
//! The top-level `installer`/`url`/`sha256` are the Windows build (what 0.1.x/0.2.0 read). Other
//! platforms live under `platforms`: CI adds `darwin-universal` (a `.app.tar.gz`) to the same release a
//! few minutes after it is published. Until that entry exists a Mac sees no update.
//!
//! `SWITCHBOARD_UPDATE_DIR=<folder with latest.json + installer>` switches to a local folder instead
//! (testing an update without publishing it). Debug builds only check when that is set.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

const REPO: &str = "dexterlabs1/switchboard";
const MAX_INSTALLER: u64 = 200 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone)]
pub struct Note {
    version: String,
    date: String,
    items: Vec<String>,
}

/// One downloadable build: an installer (Windows) or an app archive (macOS).
#[derive(Deserialize, Clone, Default)]
struct Asset {
    installer: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    sha256: String,
}

#[derive(Deserialize, Clone)]
struct Latest {
    version: String,
    /// The Windows build, flattened at the top level for older clients.
    #[serde(flatten)]
    windows: Asset,
    #[serde(default)]
    platforms: HashMap<String, Asset>,
    #[serde(default)]
    changelog: Vec<Note>,
}

impl Latest {
    /// The build for the platform we run on, if this release has one.
    fn asset(&self) -> Option<&Asset> {
        if cfg!(windows) {
            Some(&self.windows)
        } else if cfg!(target_os = "macos") {
            self.platforms.get("darwin-universal")
        } else {
            None
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: String,
    available: bool,
    /// Release notes for every version newer than the running one, newest first.
    notes: Vec<Note>,
}

fn local_dir() -> Option<PathBuf> {
    std::env::var_os("SWITCHBOARD_UPDATE_DIR").map(PathBuf::from)
}

fn parse(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split('.').map(|x| x.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(8))
        .timeout_read(std::time::Duration::from_secs(60))
        .user_agent(concat!("Switchboard/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn fetch_latest() -> Result<Latest, String> {
    if let Some(dir) = local_dir() {
        let text = std::fs::read_to_string(dir.join("latest.json")).map_err(|e| e.to_string())?;
        return serde_json::from_str(&text).map_err(|e| e.to_string());
    }
    let url = format!("https://github.com/{REPO}/releases/latest/download/latest.json");
    let resp = agent().get(&url).call().map_err(|e| e.to_string())?;
    let mut text = String::new();
    resp.into_reader().take(4 * 1024 * 1024).read_to_string(&mut text).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateInfo {
    let current = app.package_info().version.to_string();
    let mut info = UpdateInfo { current: current.clone(), ..Default::default() };
    // Dev builds update by rebuilding, unless pointed at a local test folder.
    if cfg!(debug_assertions) && local_dir().is_none() {
        return info;
    }
    let Ok(Ok(latest)) = tauri::async_runtime::spawn_blocking(fetch_latest).await else { return info };
    if latest.asset().is_none() {
        return info; // released, but not (yet) for this platform
    }
    let cur = parse(&current);
    info.latest = latest.version.clone();
    info.available = parse(&latest.version) > cur;
    info.notes = latest.changelog.into_iter().filter(|n| parse(&n.version) > cur).collect();
    info
}

/// Only ever install a file named like ours.
fn expected_name(name: &str) -> bool {
    let suffix = if cfg!(windows) { "-setup.exe" } else { ".app.tar.gz" };
    name.starts_with("Switchboard_") && name.ends_with(suffix) && !name.contains(['/', '\\'])
}

/// Where the installer for `latest` is on disk, downloading and verifying it first if needed.
fn installer_for(latest: &Latest) -> Result<PathBuf, String> {
    let asset = latest.asset().ok_or("this release has no build for this platform")?;
    let name = asset.installer.as_str();
    if !expected_name(name) {
        return Err(format!("unexpected installer name: {name}"));
    }
    if let Some(dir) = local_dir() {
        let p = dir.join(name);
        return if p.exists() { Ok(p) } else { Err(format!("{} not found", p.display())) };
    }
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    if !asset.url.starts_with(&prefix) {
        return Err("installer url is not a Switchboard release".into());
    }
    if asset.sha256.len() != 64 {
        return Err("release has no installer checksum".into());
    }
    let dir = std::env::temp_dir().join("switchboard-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(name);
    let part = dir.join(format!("{name}.part"));
    let resp = agent().get(&asset.url).call().map_err(|e| format!("download failed: {e}"))?;
    let mut reader = resp.into_reader().take(MAX_INSTALLER);
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    drop(file);
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(&asset.sha256) {
        let _ = std::fs::remove_file(&part);
        return Err("downloaded installer failed its checksum".into());
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Download + verify the newest installer and start the helper; the caller then saves state and exits.
/// The helper waits for this process to end (so the installer can replace the exe), installs silently,
/// and relaunches.
#[tauri::command]
pub async fn update_apply() -> Result<(), String> {
    let path = tauri::async_runtime::spawn_blocking(|| fetch_latest().and_then(|l| installer_for(&l)))
        .await
        .map_err(|e| e.to_string())??;
    launch_helper(&path)
}

#[cfg(windows)]
fn launch_helper(installer: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let q = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let log = std::env::temp_dir().join("switchboard-update.log");
    let script = format!(
        "Start-Transcript -Path '{log}' -Force | Out-Null; \
         Wait-Process -Id {pid} -Timeout 60 -ErrorAction SilentlyContinue; \
         Start-Process -FilePath '{inst}' -ArgumentList '/S' -Wait; \
         Start-Process -FilePath '{exe}'; \
         Stop-Transcript | Out-Null",
        log = q(&log),
        inst = q(installer),
        exe = q(&exe),
    );
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW only; it still outlives us. DETACHED_PROCESS made powershell exit without
        // running the script at all (0.1.1-0.1.3: the app closed and never came back).
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// macOS: unpack the new `.app` next to the download now (so a bad archive fails while the app is
/// still open), then a detached `sh` helper waits for us to exit, swaps the bundle in place (the
/// old one is kept until the new one is in), clears the quarantine flag and opens it again.
/// Log: `$TMPDIR/switchboard-update.log`.
#[cfg(target_os = "macos")]
fn launch_helper(archive: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // .../Switchboard.app/Contents/MacOS/switchboard
    let app = exe
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|x| x == "app"))
        .ok_or("Switchboard isn't running from an .app bundle")?
        .to_path_buf();
    if app.to_string_lossy().contains("/AppTranslocation/") {
        return Err("move Switchboard to Applications first (it is running from a read-only copy), then update".into());
    }
    let parent = app.parent().ok_or("no folder above the app")?;
    let probe = parent.join(".switchboard-update-probe");
    std::fs::write(&probe, b"").map_err(|_| format!("can't write to {}: drag Switchboard somewhere you own and retry", parent.display()))?;
    let _ = std::fs::remove_file(&probe);

    let stage = std::env::temp_dir().join("switchboard-update").join("app");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let ok = Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&stage)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?
        .success();
    let new_app = stage.join("Switchboard.app");
    if !ok || !new_app.join("Contents").join("MacOS").is_dir() {
        return Err("the downloaded update didn't unpack to Switchboard.app".into());
    }

    let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
    let log = std::env::temp_dir().join("switchboard-update.log");
    let old = parent.join(".Switchboard-old.app");
    let script = format!(
        "exec >{log} 2>&1\n\
         i=0; while kill -0 {pid} 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done\n\
         rm -rf {old}\n\
         if mv {app} {old} && mv {new} {app}; then rm -rf {old}; else echo 'swap failed, restoring'; [ -d {app} ] || mv {old} {app}; fi\n\
         /usr/bin/xattr -dr com.apple.quarantine {app} 2>/dev/null\n\
         /usr/bin/open {app}\n",
        log = q(&log),
        pid = std::process::id(),
        old = q(&old),
        app = q(&app),
        new = q(&new_app),
    );
    Command::new("/bin/sh")
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0) // its own group: nothing aimed at ours on exit reaches it
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn launch_helper(_installer: &Path) -> Result<(), String> {
    Err("updates aren't supported on this platform".into())
}

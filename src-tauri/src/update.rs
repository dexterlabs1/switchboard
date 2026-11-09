//! One-click updates from GitHub Releases. `npm run release` publishes the installer plus a
//! `latest.json` (version, installer url, sha256, release notes) as assets of a release; the app reads
//! `releases/latest/download/latest.json`, and on request downloads the installer, checks its hash, and
//! hands off to a helper that waits for us to exit, installs silently and starts Switchboard again.
//!
//! `SWITCHBOARD_UPDATE_DIR=<folder with latest.json + installer>` switches to a local folder instead
//! (testing an update without publishing it). Debug builds only check when that is set.

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

#[derive(Deserialize, Clone)]
struct Latest {
    version: String,
    installer: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    changelog: Vec<Note>,
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
    let cur = parse(&current);
    info.latest = latest.version.clone();
    info.available = parse(&latest.version) > cur;
    info.notes = latest.changelog.into_iter().filter(|n| parse(&n.version) > cur).collect();
    info
}

/// Where the installer for `latest` is on disk, downloading and verifying it first if needed.
fn installer_for(latest: &Latest) -> Result<PathBuf, String> {
    let name = latest.installer.as_str();
    // Only ever run an installer named like ours.
    if !name.starts_with("Switchboard_") || !name.ends_with("-setup.exe") || name.contains(['/', '\\']) {
        return Err(format!("unexpected installer name: {name}"));
    }
    if let Some(dir) = local_dir() {
        let p = dir.join(name);
        return if p.exists() { Ok(p) } else { Err(format!("{} not found", p.display())) };
    }
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    if !latest.url.starts_with(&prefix) {
        return Err("installer url is not a Switchboard release".into());
    }
    if latest.sha256.len() != 64 {
        return Err("release has no installer checksum".into());
    }
    let dir = std::env::temp_dir().join("switchboard-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(name);
    let part = dir.join(format!("{name}.part"));
    let resp = agent().get(&latest.url).call().map_err(|e| format!("download failed: {e}"))?;
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
    if !got.eq_ignore_ascii_case(&latest.sha256) {
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW only; it still outlives us. DETACHED_PROCESS made powershell exit without
        // running the script at all (0.1.1-0.1.3: the app closed and never came back).
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

//! Remote hosts for SSH panes: `~/.ssh/config` entries plus Tailscale peers (when Tailscale runs).

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    /// What to pass to ssh (config alias, MagicDNS name or IP).
    pub target: String,
    pub label: String,
    pub source: String, // "ssh-config" | "tailscale"
    pub os: String,
    pub online: Option<bool>,
}

pub fn valid_target(t: &str) -> bool {
    !t.is_empty() && t.len() < 200 && t.chars().all(|c| c.is_ascii_alphanumeric() || "@._:-".contains(c))
}

fn ssh_config_hosts() -> Vec<Host> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else { return vec![] };
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        let mut parts = l.splitn(2, char::is_whitespace);
        if !parts.next().unwrap_or("").eq_ignore_ascii_case("host") {
            continue;
        }
        for name in parts.next().unwrap_or("").split_whitespace() {
            if name.contains('*') || name.contains('?') || name.starts_with('!') || !valid_target(name) {
                continue;
            }
            out.push(Host {
                target: name.to_string(),
                label: name.to_string(),
                source: "ssh-config".into(),
                os: String::new(),
                online: None,
            });
        }
    }
    out
}

fn tailscale_exe() -> String {
    // macOS: the app bundle's binary doubles as the CLI; apps opened from Finder don't get the
    // Homebrew folders on PATH, so look there too.
    let candidates: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe"]
    } else {
        &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
    };
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
        .unwrap_or_else(|| "tailscale".into())
}

/// `tailscale status --json`, bounded to 3 s so a wedged daemon can't stall the picker.
fn tailscale_hosts() -> Vec<Host> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut cmd = Command::new(tailscale_exe());
        cmd.args(["status", "--json"]).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let _ = tx.send(cmd.output().ok());
    });
    let Ok(Some(out)) = rx.recv_timeout(Duration::from_secs(3)) else { return vec![] };
    let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else { return vec![] };
    let Some(peers) = v.get("Peer").and_then(|p| p.as_object()) else { return vec![] };
    let mut hosts: Vec<Host> = peers
        .values()
        .filter_map(|p| {
            let name = p.get("HostName").and_then(|x| x.as_str()).unwrap_or("");
            let dns = p.get("DNSName").and_then(|x| x.as_str()).unwrap_or("").trim_end_matches('.');
            let ip = p
                .get("TailscaleIPs")
                .and_then(|x| x.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.as_str())
                .unwrap_or("");
            // Prefer the IP: MagicDNS may be off on this machine.
            let target = if !ip.is_empty() { ip } else { dns };
            if !valid_target(target) {
                return None;
            }
            Some(Host {
                target: target.to_string(),
                label: if name.is_empty() { dns.to_string() } else { name.to_string() },
                source: "tailscale".into(),
                os: p.get("OS").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                online: p.get("Online").and_then(|x| x.as_bool()),
            })
        })
        .collect();
    hosts.sort_by(|a, b| b.online.cmp(&a.online).then(a.label.to_lowercase().cmp(&b.label.to_lowercase())));
    hosts
}

#[tauri::command]
pub async fn list_hosts() -> Vec<Host> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut h = ssh_config_hosts();
        h.extend(tailscale_hosts());
        h
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize)]
pub struct SshInfo {
    user: String,
    hostname: String,
}

/// Resolve a host the way ssh will (`ssh -G` reads ~/.ssh/config; it does not connect).
#[tauri::command]
pub async fn ssh_info(host: String) -> Result<SshInfo, String> {
    if !valid_target(&host) {
        return Err("bad host".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(crate::pty::ssh_exe());
        cmd.args(["-G", &host]).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let field = |k: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(k).map(|v| v.trim().to_string()))
                .unwrap_or_default()
        };
        Ok(SshInfo { user: field("user "), hostname: field("hostname ") })
    })
    .await
    .map_err(|e| e.to_string())?
}

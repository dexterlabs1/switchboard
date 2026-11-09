//! Plan usage (the numbers behind Claude Code's /usage) for the status bar.
//! Reads the OAuth token Claude Code already keeps in ~/.claude/.credentials.json and asks
//! api.anthropic.com for this account's limits. Unofficial endpoint: shape changes fail quietly.
//! The token is only ever sent to api.anthropic.com and never leaves this module.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    label: String,
    group: String,
    percent: f64,
    severity: String,
    resets_at: String,
    active: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    ok: bool,
    error: String,
    plan: String,
    limits: Vec<Limit>,
    fetched_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn label_for(kind: &str, scope: Option<&Value>) -> String {
    let model = scope
        .and_then(|s| s.get("model"))
        .and_then(|m| m.get("display_name"))
        .and_then(|n| n.as_str());
    match (kind, model) {
        (_, Some(m)) => m.to_lowercase(),
        ("weekly_all", _) => "week".into(),
        (k, _) if k.contains("five_hour") || k.contains("session") => "5h".into(),
        (k, _) => k.replace('_', " "),
    }
}

pub fn fetch() -> Usage {
    let mut u = Usage { fetched_at: now_ms(), ..Default::default() };
    let path = dirs::home_dir().unwrap_or_default().join(".claude").join(".credentials.json");
    let creds: Value = match std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(v) => v,
        None => {
            u.error = "not signed in".into();
            return u;
        }
    };
    let oauth = &creds["claudeAiOauth"];
    let Some(token) = oauth["accessToken"].as_str() else {
        u.error = "not signed in".into();
        return u;
    };
    u.plan = oauth["rateLimitTier"]
        .as_str()
        .or(oauth["subscriptionType"].as_str())
        .unwrap_or("")
        .replace("default_claude_", "")
        .replace('_', " ");

    let resp = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("User-Agent", "switchboard/0.1")
        .timeout(Duration::from_secs(10))
        .call();
    let body: Value = match resp {
        Ok(r) => match r.into_json() {
            Ok(v) => v,
            Err(_) => {
                u.error = "bad response".into();
                return u;
            }
        },
        // Claude Code refreshes the token while it runs; an expired one means no chat has run lately.
        Err(ureq::Error::Status(401, _)) => {
            u.error = "login expired: open a chat to refresh".into();
            return u;
        }
        Err(ureq::Error::Status(429, _)) => {
            u.error = "rate limited, retrying".into();
            return u;
        }
        Err(ureq::Error::Status(code, _)) => {
            u.error = format!("http {code}");
            return u;
        }
        Err(_) => {
            u.error = "offline".into();
            return u;
        }
    };

    if let Some(arr) = body["limits"].as_array() {
        for l in arr {
            u.limits.push(Limit {
                label: label_for(l["kind"].as_str().unwrap_or(""), l.get("scope").filter(|s| !s.is_null())),
                group: l["group"].as_str().unwrap_or("").into(),
                percent: l["percent"].as_f64().unwrap_or(0.0),
                severity: l["severity"].as_str().unwrap_or("normal").into(),
                resets_at: l["resets_at"].as_str().unwrap_or("").into(),
                active: l["is_active"].as_bool().unwrap_or(true),
            });
        }
    }
    // Older shape: top-level windows.
    if u.limits.is_empty() {
        for (key, label, group) in [("five_hour", "5h", "session"), ("seven_day", "week", "weekly")] {
            if let Some(w) = body.get(key).filter(|w| !w.is_null()) {
                u.limits.push(Limit {
                    label: label.into(),
                    group: group.into(),
                    percent: w["utilization"].as_f64().unwrap_or(0.0),
                    severity: "normal".into(),
                    resets_at: w["resets_at"].as_str().unwrap_or("").into(),
                    active: true,
                });
            }
        }
    }
    u.ok = true;
    u
}

static LAST: Mutex<Option<Usage>> = Mutex::new(None);

fn cache_path() -> std::path::PathBuf {
    dirs::config_dir().unwrap_or_default().join("switchboard").join("usage.json")
}

/// Fetch, but never more than once a minute, and keep showing the last good numbers when the
/// endpoint rate-limits or the network blips (marked stale rather than blanked).
fn fetch_cached(force: bool) -> Usage {
    {
        let last = LAST.lock().unwrap();
        if let Some(u) = last.as_ref() {
            let min_gap = if force { 60_000 } else { 240_000 };
            if now_ms().saturating_sub(u.fetched_at) < min_gap {
                return u.clone();
            }
        }
    }
    let fresh = fetch();
    let mut last = LAST.lock().unwrap();
    if fresh.ok {
        let _ = std::fs::write(cache_path(), serde_json::to_string(&fresh).unwrap_or_default());
        *last = Some(fresh.clone());
        return fresh;
    }
    match last.as_ref() {
        Some(prev) => {
            let mut stale = prev.clone();
            stale.error = fresh.error;
            stale
        }
        None => fresh,
    }
}

/// Poll every 5 minutes; `refresh_usage` asks for one now (rate-limited above).
pub fn start(app: AppHandle) {
    // Seed from disk so the bar has numbers the moment the window opens.
    if let Some(u) = std::fs::read_to_string(cache_path()).ok().and_then(|s| serde_json::from_str::<Usage>(&s).ok()) {
        *LAST.lock().unwrap() = Some(u);
    }
    std::thread::spawn(move || loop {
        let _ = app.emit("usage", fetch_cached(false));
        std::thread::sleep(Duration::from_secs(300));
    });
}

#[tauri::command]
pub async fn refresh_usage() -> Usage {
    tauri::async_runtime::spawn_blocking(|| fetch_cached(true)).await.unwrap_or_default()
}

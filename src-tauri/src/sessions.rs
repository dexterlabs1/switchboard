//! Claude awareness. Claude Code keeps a live registry at `~/.claude/sessions/<pid>.json`
//! (pid, sessionId, cwd, name, entrypoint, status busy/idle). We poll it once a second, map each
//! registry pid to the pane whose PTY process tree contains it, and enrich with title/model/context
//! from the session transcript. Undocumented format: every field is optional and failures are quiet.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

use crate::pty::Ptys;

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct RegEntry {
    pid: u32,
    session_id: String,
    cwd: String,
    name: String,
    entrypoint: String,
    status: String,
    status_updated_at: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub pid: u32,
    pub session_id: String,
    pub cwd: String,
    pub name: String,
    pub entrypoint: String,
    pub status: String,
    pub status_updated_at: u64,
    pub pane_id: Option<u32>,
    pub title: String,
    pub model: String,
    pub effort: String,
    pub ctx_tokens: u64,
    pub last_text: String,
    pub project: String,
}

#[derive(Clone, Default)]
struct TranscriptInfo {
    mtime: Option<SystemTime>,
    title: String,
    model: String,
    effort: String,
    ctx_tokens: u64,
    cwd: String,
    last_text: String,
    project: String,
}

#[derive(Default)]
pub struct SessionCache {
    transcripts: Mutex<HashMap<PathBuf, TranscriptInfo>>,
}

fn claude_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude")
}

/// Claude's project folder name: every non-alphanumeric char of the cwd becomes '-'.
fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub fn transcript_path(session_id: &str, cwd: &str) -> Option<PathBuf> {
    let projects = claude_dir().join("projects");
    let guess = projects.join(project_slug(cwd)).join(format!("{session_id}.jsonl"));
    if guess.exists() {
        return Some(guess);
    }
    for dir in std::fs::read_dir(&projects).ok()?.flatten() {
        let c = dir.path().join(format!("{session_id}.jsonl"));
        if c.exists() {
            return Some(c);
        }
    }
    None
}

fn default_effort() -> String {
    let p = claude_dir().join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("effortLevel").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_default()
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => items
            .iter()
            .find(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
            .and_then(|i| i.get("text").and_then(|t| t.as_str()).map(String::from)),
        _ => None,
    }
}

fn clean_title(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 80 {
        one.chars().take(79).collect::<String>() + "…"
    } else {
        one
    }
}

/// Title from the head (custom-title > ai-title > first real prompt), model/context/effort from the tail.
/// Name of the git repo containing `path` (nearest ancestor with a `.git`), skipping the home folder
/// itself. Cached per directory; transcripts mention the same few folders over and over.
fn repo_name(path: &Path) -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    if !path.is_absolute() {
        return None;
    }
    let dir = if path.is_dir() { path.to_path_buf() } else { path.parent()?.to_path_buf() };
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap().get(&dir) {
        return hit.clone();
    }
    let home = dirs::home_dir();
    let found = dir
        .ancestors()
        .take(12)
        .find(|a| a.join(".git").exists())
        .filter(|root| home.as_deref() != Some(*root) && root.parent().is_some())
        .and_then(|root| root.file_name())
        .map(|n| n.to_string_lossy().to_lowercase());
    cache.lock().unwrap().insert(dir, found.clone());
    found
}

fn read_transcript(path: &Path, fallback_effort: &str) -> TranscriptInfo {
    let mut info = TranscriptInfo::default();
    let Ok(f) = File::open(path) else { return info };
    info.mtime = f.metadata().and_then(|m| m.modified()).ok();
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);

    let mut custom = String::new();
    let mut ai = String::new();
    let mut first = String::new();
    for line in BufReader::new(&f).lines().take(400).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if info.cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                info.cwd = c.to_string();
            }
        }
        match ty {
            "custom-title" => {
                if let Some(t) = v.get("customTitle").and_then(|t| t.as_str()) {
                    custom = t.to_string();
                }
            }
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    ai = t.to_string();
                }
            }
            "user" if first.is_empty() => {
                if let Some(t) = v.get("message").and_then(|m| m.get("content")).and_then(text_of) {
                    if !t.trim_start().starts_with('<') && !t.trim().is_empty() {
                        first = t;
                    }
                }
            }
            _ => {}
        }
    }

    // Tail: last ~512 KB, newest first.
    let mut tail = String::new();
    if let Ok(mut f2) = File::open(path) {
        let start = len.saturating_sub(512 * 1024);
        if f2.seek(SeekFrom::Start(start)).is_ok() {
            let mut bytes = Vec::new();
            let _ = f2.read_to_end(&mut bytes);
            tail = String::from_utf8_lossy(&bytes).into_owned();
        }
    }
    let effort_re = regex::Regex::new(r"Set effort level to (\w+)").unwrap();
    // Which project the chat is working in: the git repo holding the files its tool calls touch
    // (file_path / path inputs), most common wins; else the repo the chat started in.
    let path_re = regex::Regex::new(r#""(?:file_path|notebook_path|path)":"([^"]{3,400})""#).unwrap();
    let mut counts: HashMap<String, usize> = HashMap::new();
    // Only Claude's own turns (its tool calls and replies): user-side lines carry the injected
    // CLAUDE.md / memory text, which mentions every project and would drown the signal.
    for line in tail.lines().filter(|l| l.contains("\"type\":\"assistant\"")) {
        for c in path_re.captures_iter(line) {
            let raw = c[1].replace("\\\\", "\\");
            if let Some(name) = repo_name(Path::new(&raw)) {
                *counts.entry(name).or_default() += 1;
            }
        }
    }
    info.project = counts.into_iter().max_by_key(|(_, n)| *n).map(|(k, _)| k).unwrap_or_default();
    if info.project.is_empty() && !info.cwd.is_empty() {
        info.project = repo_name(Path::new(&info.cwd)).unwrap_or_default();
    }
    for line in tail.lines().rev() {
        if info.last_text.is_empty() && line.contains("\"type\":\"assistant\"") && !line.contains("\"isSidechain\":true") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(arr) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                    let text: String = arr
                        .iter()
                        .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !one.is_empty() {
                        info.last_text = if one.chars().count() > 420 {
                            one.chars().take(419).collect::<String>() + "…"
                        } else {
                            one
                        };
                    }
                }
            }
        }
        if custom.is_empty() && line.contains("\"custom-title\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(t) = v.get("customTitle").and_then(|t| t.as_str()) {
                    custom = t.to_string();
                }
            }
        }
        if info.effort.is_empty() && line.contains("Set effort level to") {
            if let Some(c) = effort_re.captures(line) {
                info.effort = c[1].to_string();
            }
        }
        if info.model.is_empty() && line.contains("\"type\":\"assistant\"") && !line.contains("\"isSidechain\":true") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                let msg = v.get("message");
                if let Some(m) = msg.and_then(|m| m.get("model")).and_then(|m| m.as_str()) {
                    if m != "<synthetic>" {
                        info.model = m.to_string();
                        if let Some(u) = msg.and_then(|m| m.get("usage")) {
                            let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                            info.ctx_tokens = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
                        }
                    }
                }
            }
        }
        if !info.model.is_empty() && !info.effort.is_empty() && !custom.is_empty() && !info.last_text.is_empty() {
            break;
        }
    }
    if info.effort.is_empty() {
        info.effort = fallback_effort.to_string();
    }
    info.title = clean_title(if !custom.is_empty() { &custom } else if !ai.is_empty() { &ai } else { &first });
    info
}

impl SessionCache {
    fn info(&self, path: &Path, fallback_effort: &str) -> TranscriptInfo {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let mut cache = self.transcripts.lock().unwrap();
        if let Some(c) = cache.get(path) {
            if c.mtime == mtime && mtime.is_some() {
                return c.clone();
            }
        }
        let fresh = read_transcript(path, fallback_effort);
        cache.insert(path.to_path_buf(), fresh.clone());
        fresh
    }
}

fn read_registry() -> Vec<RegEntry> {
    let dir = claude_dir().join("sessions");
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str::<RegEntry>(&s).ok())
        .filter(|r| r.pid != 0)
        .collect()
}

/// Background loop: emit `sessions` (Vec<LiveSession>) whenever anything changes.
pub fn start(app: AppHandle, ptys: Arc<Ptys>, cache: Arc<SessionCache>) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut last = String::new();
        loop {
            let fallback_effort = default_effort();
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
            let pane_pids: HashMap<u32, u32> = ptys.pane_pids().into_iter().map(|(pane, pid)| (pid, pane)).collect();

            let mut out = Vec::new();
            for r in read_registry() {
                // Skip stale files left by a crashed Claude.
                if sys.process(Pid::from_u32(r.pid)).is_none() {
                    continue;
                }
                // Walk up the parent chain until we hit a pane's shell.
                let mut pane_id = None;
                let mut cur = Some(Pid::from_u32(r.pid));
                for _ in 0..8 {
                    let Some(p) = cur else { break };
                    if let Some(pane) = pane_pids.get(&p.as_u32()) {
                        pane_id = Some(*pane);
                        break;
                    }
                    cur = sys.process(p).and_then(|pr| pr.parent());
                }
                let t = transcript_path(&r.session_id, &r.cwd)
                    .map(|p| cache.info(&p, &fallback_effort))
                    .unwrap_or_default();
                out.push(LiveSession {
                    pid: r.pid,
                    session_id: r.session_id,
                    cwd: r.cwd,
                    name: r.name,
                    entrypoint: r.entrypoint,
                    status: r.status,
                    status_updated_at: r.status_updated_at,
                    pane_id,
                    title: t.title,
                    model: t.model,
                    effort: if t.effort.is_empty() { fallback_effort.clone() } else { t.effort },
                    ctx_tokens: t.ctx_tokens,
                    last_text: t.last_text,
                    project: t.project,
                });
            }
            out.sort_by_key(|s| s.pid);
            let json = serde_json::to_string(&out).unwrap_or_default();
            if json != last {
                let _ = app.emit("sessions", &out);
                last = json;
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    session_id: String,
    cwd: String,
    title: String,
    modified_ms: u64,
    project: String,
}

/// Most recent transcripts across all projects, for the resume drawer.
#[tauri::command]
pub fn list_recent(cache: tauri::State<'_, Arc<SessionCache>>, limit: usize) -> Vec<RecentSession> {
    let projects = claude_dir().join("projects");
    let mut files: Vec<(SystemTime, PathBuf, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&projects) {
        for d in rd.flatten() {
            let proj = d.file_name().to_string_lossy().into_owned();
            if let Ok(inner) = std::fs::read_dir(d.path()) {
                for f in inner.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                        continue;
                    }
                    if let Ok(m) = f.metadata().and_then(|m| m.modified()) {
                        files.push((m, p, proj.clone()));
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let fallback = default_effort();
    files
        .into_iter()
        .filter_map(|(m, p, proj)| {
            let sid = p.file_stem()?.to_string_lossy().into_owned();
            let info = cache.info(&p, &fallback);
            // Transcripts with no user prompt (e.g. aborted starts) aren't worth resuming.
            if info.title.is_empty() {
                return None;
            }
            Some(RecentSession {
                session_id: sid,
                cwd: info.cwd,
                title: info.title,
                modified_ms: m.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                project: proj,
            })
        })
        .take(limit)
        .collect()
}

mod pty;
mod remote;
mod sessions;
mod update;
mod usage;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent};

/// Dev builds keep their own state so a dev instance can run beside the installed app without
/// both restoring (and resuming) the same chats. The WebView2 profile is split by the dev
/// identifier in tauri.dev.conf.json.
fn state_path() -> PathBuf {
    let dir = if cfg!(debug_assertions) { "switchboard-dev" } else { "switchboard" };
    dirs::config_dir().unwrap_or_default().join(dir).join("state.json")
}

/// Command-line args of this launch (the first instance reads them at boot; later launches are
/// forwarded through the single-instance plugin as a `cli` event).
#[tauri::command]
fn launch_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// The frontend owns the shape of the saved state; Rust only stores it.
#[tauri::command]
fn load_state() -> Option<String> {
    std::fs::read_to_string(state_path()).ok()
}

#[tauri::command]
fn save_state(json: String) -> Result<(), String> {
    let p = state_path();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_has_image() -> bool {
    use clipboard_win::{formats, is_format_avail};
    is_format_avail(formats::CF_DIB) || is_format_avail(formats::CF_BITMAP)
}

#[tauri::command]
fn clipboard_text() -> Option<String> {
    clipboard_win::get_clipboard_string().ok()
}

#[tauri::command]
fn clipboard_set(text: String) -> Result<(), String> {
    clipboard_win::set_clipboard_string(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) links open".into());
    }
    std::process::Command::new("explorer").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn home_dir() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ptys = Arc::new(pty::Ptys::default());
    let cache = Arc::new(sessions::SessionCache::default());
    // Remember size/position/maximized, but leave visibility to the frontend (shown after first paint).
    let window_state = tauri_plugin_window_state::Builder::default()
        .with_state_flags(
            tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
        )
        .build();
    let app = tauri::Builder::default()
        // Must be first: a second launch (Stream Deck button, Start Menu) hands its args to the
        // running window and exits instead of opening another Switchboard.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit("cli", args.into_iter().skip(1).collect::<Vec<String>>());
        }))
        .plugin(window_state)
        .manage(ptys.clone())
        .manage(cache.clone())
        .setup(move |app| {
            sessions::start(app.handle().clone(), ptys.clone(), cache.clone());
            usage::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_attach,
            pty::pty_prune,
            sessions::list_recent,
            remote::list_hosts,
            remote::ssh_info,
            usage::refresh_usage,
            update::update_check,
            update::update_apply,
            load_state,
            save_state,
            clipboard_has_image,
            clipboard_text,
            clipboard_set,
            home_dir,
            open_url,
            launch_args,
        ])
        .build(tauri::generate_context!())
        .expect("error while building switchboard");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Arc<pty::Ptys>>().kill_all();
        }
    });
}

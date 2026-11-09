# CLAUDE.md — Switchboard

## What it is
A Claude-aware tiling terminal for Windows. Several Claude Code chats (plus PowerShell and SSH panes) sit
tiled in one window; each pane knows whether its chat is working, idle, or needs you, and lights up when
it finishes or asks something while you're elsewhere. Tauri 2 + xterm.js. User-facing docs are in
README.md. Maintainers keep local, untracked notes in `dev-notes/` (gitignored); read
`dev-notes/CLAUDE-private.md` and `dev-notes/PROGRESS.md` first when they exist.

## Confirmed decisions
- **Tauri 2 + xterm.js 6**, not Electron or a custom VT: correct Claude Code rendering, ~10 MB, fast.
- **Tiling with drag-to-dock** (binary split tree in `layout.ts`). Drop on an edge = dock there, middle = swap.
- **Claude awareness without touching `settings.json` or hooks**: poll Claude Code's live registry
  `~/.claude/sessions/<pid>.json` (status busy/idle, sessionId, name) and map each registry pid up the
  process tree to a pane's shell. Title/model/context/project come from the transcript JSONL. The format
  is undocumented, so every field is optional and missing data must never break a pane.
- **Plan usage** comes from `GET api.anthropic.com/api/oauth/usage` with the OAuth token Claude Code
  already stores in `~/.claude/.credentials.json` (same numbers as `/usage`). Unofficial; cached to
  `%APPDATA%\switchboard\usage.json`, polled every 5 min, never more than once a minute (it 429s).
  The token is read only in `usage.rs` and only ever sent to api.anthropic.com.
- **Updates from GitHub Releases** (`update.rs`): `releases/latest/download/latest.json` → download the
  installer, check its sha256, a hidden PowerShell helper waits for the app to exit, runs the NSIS
  installer with `/S` and relaunches. `SWITCHBOARD_UPDATE_DIR` points it at a local folder for testing.
- **Keys follow conventions people know**: browser (Ctrl+1..9, Ctrl+Tab), VS Code (Ctrl+Shift+P/F1
  palette, Ctrl+, shortcuts), Windows Terminal (Ctrl+Shift+T/W/F, Alt+arrows, Alt+Shift+D/+/-). Unique:
  Ctrl+Shift+Space (next needs-you), Ctrl+Shift+S park, Ctrl+Shift+B bring back, Ctrl+Alt macros.
- **Shelf**: parking a busy chat keeps it running off-screen (`#parking`), an idle one is closed and
  resumes on unpark. Parking leaves an empty slot (negative id in the layout tree) with new chat / fill space.
- Look: TUI/ASCII-flavoured, all monospace, one warm "lamp" accent for needs-you, teal for keys,
  amber for work. Six themes. No emoji, no gradients. Wordmark `› switchboard█`, icon › + orange block.

## Stack
- `src-tauri/src/`: `pty.rs` (ConPTY per pane via portable-pty, swappable output sink + replay
  buffer so a webview reload re-attaches, generation tokens), `sessions.rs` (registry watcher, transcript
  reader, recent sessions), `usage.rs`, `remote.rs` (ssh config + `tailscale status --json`),
  `update.rs`, `lib.rs` (state file, clipboard, single instance, CLI args).
- `src/`: `main.ts` (app, layout ops, attention, keyboard dispatch, drag, palette, update), `pane.ts`
  (xterm wrapper), `layout.ts` (pure split-tree ops), `keys.ts` (bindings, macros, shortcuts menu),
  `shelf.ts`, `themes.ts`, `statusline.ts` (usage meters), `ui.ts` (drawers/modals).
- State: `%APPDATA%\switchboard\state.json` (layout, panes, sessionIds, zoom, keys, theme, hosts, shelf).

## Key commands
```
npm install
npm run app:dev                          # dev build as "Switchboard Dev": own identifier, WebView2 profile and
                                         # state (%APPDATA%\switchboard-dev), so it runs beside an installed copy
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=4831 npm run app:dev   # + DevTools protocol for tests
npx tsc --noEmit                         # type-check
npm run tauri build                      # installer in src-tauri/target/release/bundle/nsis
npm run release [-- minor|major]         # bump, build, tag, push, publish a GitHub release (installer + latest.json)
npm run release -- --local               # same build + latest.json, nothing published (test with SWITCHBOARD_UPDATE_DIR)
switchboard.exe --new-claude [--continue] [--cwd DIR] | --shell [--cwd DIR]   # forwards to the running window
```
Dev builds expose `window.__sb` (panes, addPane, …) for driving the UI over the DevTools port.

## Golden rules
- **Every user-visible change gets a plain-language line under `## Unreleased` in `CHANGELOG.md`**; the
  release script turns it into the notes people read in the app's update window.
- Ship with `npm run release`; never run an installer over someone's open app (the helper does that
  after the app exits).
- Restarting the Rust side kills running chats (they resume, but in-flight work is interrupted).
  Frontend edits are safe: a reload re-attaches to the running PTYs.
- Strip `CLAUDE_CODE_*` / `CLAUDECODE` env from panes (done in `pty.rs`), or nested chats lose transcripts.
- No personal paths, hosts or screenshots of real chats in the repo; demo media come from a sandbox folder.
- Traps already hit are in `docs/gotchas.md`. Add new ones there.

# Gotchas

## GOTCHA: a reloaded pane went blank (old reader removed the new pane)
- Symptom: after a webview reload, some panes stayed empty while their shells ran.
- Cause: pane ids are reused. The old spawn's reader thread hit EOF after the kill and its exit
  handler removed whatever pane had that id, i.e. the new one, closing its pseudoconsole.
- Fix: every spawn gets a generation token (`GEN` in `pty.rs`); exit handling only removes the
  entry whose `gen` matches. Register the pane in the map before starting watcher threads.

## GOTCHA: reusing one Tauri Channel across two invokes loses all output
- Symptom: a brand-new pane stayed blank although its process ran and accepted input.
- Cause: `start()` passed the same JS `Channel` to `pty_attach` (which found nothing and dropped
  it) and then to `pty_spawn`. Dropping the Rust side closes the channel on the JS side too.
- Fix: create a new `Channel` for every invoke that takes one.

## GOTCHA: ConPTY never sends EOF when the child exits
- The output pipe stays open until the pseudoconsole is closed. `pty.rs` waits on the child's
  process handle in a second thread and drops the master (ClosePseudoConsole) on exit. Drop it
  outside the mutex: ClosePseudoConsole can block while output drains.

## GOTCHA: WebView2 refuses to start with different browser args
- Symptom: `WebView2 error 0x8007139F` at startup.
- Cause: another Switchboard (same user-data folder) was already running with different
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. Stopping `npm run tauri dev` does not always kill the exe.
- Fix: kill the leftover `switchboard.exe` first.

## GOTCHA: xterm 6 paints a black strip under the last row
- `.xterm-viewport` has `background-color: #000` in xterm.css. Override it to the pane colour.
  Also mount xterm in a padding-free host: FitAddon measures the parent with box-sizing, so padding
  on the parent made it overflow (horizontal scrollbar).

## GOTCHA: a CSS class shared by the title-bar pill and panes
- `.attn` styled the "needs you" pill with `align-self: center`; panes in attention also got
  `.attn` and collapsed to their header. The pill is `.attn-pill` now. Keep chrome class names unique.

## GOTCHA: launching from inside Claude Code turns off transcripts in panes
- Panes inherited `CLAUDE_CODE_CHILD_SESSION` etc. ("Transcript saving is off"). `pty.rs` strips
  every `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_AGENT*` variable before spawning.

## GOTCHA: `--resume` on a chat that never got a message
- No transcript exists until the first message, so `claude --resume <id>` errors. Only pass
  `--resume` when the transcript file exists.

## GOTCHA: the usage endpoint rate-limits hard
- A few calls in a minute return 429. Keep the last good numbers (shown as stale) and poll at 5 min.

## GOTCHA: dev port picked inside a Windows-excluded range
- 4720 gave EACCES: the excluded range was 4703–4802 that boot (ports.md said 4561–4660 earlier).
  The ranges move between reboots. Switchboard uses 4830/4831.

## GOTCHA: a new app icon doesn't reach the exe on an incremental build
- Symptom: after `npx tauri icon`, the installed exe (and taskbar/Start Menu) still showed the old icon.
- Cause: the icon is compiled into the exe's Windows resources by tauri-build in build.rs, and Cargo
  didn't re-run it when only `icons/icon.ico` changed.
- Fix: `cargo clean -p switchboard --release` (in src-tauri) before `npm run tauri build`, then
  `ie4uinit.exe -show` to refresh Windows' icon cache. Check with
  `[System.Drawing.Icon]::ExtractAssociatedIcon(exe)`.

## GOTCHA: powershell launched with DETACHED_PROCESS runs nothing
- Symptom: clicking update closed the app and it never came back; no installer ran (0.1.1 to 0.1.3).
- Cause: the hand-off helper was `powershell -Command ...` spawned with `DETACHED_PROCESS`. PowerShell
  without a console exits without executing the script. Reproduced outside the app with Python Popen.
- Fix: `CREATE_NO_WINDOW` only (it still survives the parent exiting). The helper writes
  `%TEMP%\switchboard-update.log` (Start-Transcript) so the next failure is visible.

## GOTCHA: resize during spawn is lost → garbled Claude output
- **Symptom:** a chat opened while the layout was still changing (several panes added at once, a preset applied) draws overlapping lines and leftovers like "Enter to confirm".
- **Cause:** xterm's `onResize` fires while `pty_spawn` is still in flight; `pty_resize` finds no pane yet and the error is swallowed, so the PTY keeps the size from spawn time and Claude Code draws for the wrong width.
- **Fix:** after `pty_spawn`/`pty_attach` resolve, compare the terminal's cols/rows with the size sent and resize if they differ (`Pane.syncSize`).

## GOTCHA (macOS): the dev config drops the traffic lights
- **Symptom:** `tauri dev --config src-tauri/tauri.dev.conf.json` on a Mac opens a frameless window with no
  traffic lights (and the custom buttons are hidden on Mac, so nothing closes it but ⌘Q).
- **Cause:** configs merge as JSON merge patches and arrays are replaced whole: tauri.conf.json, then
  tauri.macos.conf.json, then each `--config`. The dev config's `app.windows` replaces the Mac one.
- **Fix:** `npm run app:dev` goes through `tools/app-dev.mjs`, which adds `tauri.dev.macos.conf.json` last on a
  Mac. A window option that must differ per platform lives in every config that lists `app.windows`.

## GOTCHA (macOS): Tauri's default menu takes ⌘W
- The default macOS menu has Window → Close Window on ⌘W and Quit on ⌘Q, which closed the whole window
  (or skipped the "chats still working?" check) instead of closing a pane. `lib.rs` builds its own menu:
  no Close Window, and Quit is a custom item that calls `window.close()` so it goes through the same
  close-requested handler as the close button. Keep the Edit menu: without it ⌘C/⌘V don't work in text fields.

## GOTCHA (macOS): an exit watcher that reaps the child loses its exit code
- `waitpid` in the watcher thread reaps the shell, so `finish()`'s `try_wait` then fails and every pane
  reports `[exited 0]`. Wait with `waitid(P_PID, …, WEXITED | WNOWAIT)` (waits without reaping), and reap
  with `waitpid(WNOHANG)` after `finish()`, for panes `pty_kill` already removed (else zombies until quit).
  Don't poll `kill(pid, 0)`: a zombie still answers it.

## GOTCHA (macOS): xterm's WebGL renderer draws nothing in WKWebView on the CI Mac
- **Symptom:** on the GitHub macOS runner every pane was blank (no prompt, no cursor) while `--diag` showed
  the buffer full of the right text and the WebGL addon loaded without error.
- **Cause:** not pinned down. WebKit masks the GPU name ("Apple GPU"), so a VM can't be told from a real Mac.
- **Fix:** macOS uses xterm's DOM renderer by default (`renderOpts` in pane.ts); it renders correctly there.
  `--renderer webgl` turns WebGL back on for one launch to test it on real hardware. Windows keeps WebGL.

## GOTCHA: macOS targets can't be cargo-checked on Windows
- `cargo check --target aarch64-apple-darwin` stops at `objc2-exception-helper`'s build script (it compiles
  an Objective-C file and needs `cc`). Check Mac code on the CI macOS job (`build.yml`), not locally.

## GOTCHA: clicks never reach Claude Code on Windows (system ConPTY drops mouse mode)
- **Symptom:** clicking items in Claude Code (e.g. the background-agent list) does nothing in Switchboard, but works in Windows Terminal.
- **Cause:** the ConPTY built into Windows swallows DECSET 1000/1006, so xterm.js never enters mouse-tracking mode (`term.modes.mouseTrackingMode` stays `none`) and never reports clicks.
- **Fix:** ship Microsoft's newer ConPTY (`conpty.dll` + `OpenConsole.exe` from the `Microsoft.Windows.Console.ConPTY` NuGet, the one Windows Terminal uses) next to the exe; portable-pty prefers a sideloaded `conpty.dll`. `tools/fetch-conpty.mjs` (pinned version + sha256) runs in `app:dev`, `npm run release` and CI; `tauri.windows.conf.json` bundles both files.

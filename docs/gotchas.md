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

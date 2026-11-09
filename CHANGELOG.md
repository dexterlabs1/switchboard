# Changelog

Plain-language notes for people using Switchboard. `npm run release` turns "Unreleased" into the new version and the
app shows these in its update window. One line per change, written for the person using it.

## Unreleased

## 0.3.0 — 2026-11-09
- Remote hosts can no longer start with "-", so a host name can never be read as an ssh option.
- Switchboard now runs on macOS (Apple Silicon and Intel): download the .dmg from the release page. Shortcuts use ⌘ where Windows uses Ctrl, panes run your login shell, and the window has the usual Mac traffic lights.

## 0.2.0 — 2026-11-09
- Fixed: a chat opened while the layout was changing could draw at the wrong width (overlapping, garbled lines).
- Switchboard is open source (MIT) and updates now come from GitHub Releases: the installer is downloaded and checked before it runs.
- New chats start in a folder you choose ("Start new chats in this pane's folder" in the command palette); until then, where your chats already run, or your home folder.
- The project chip works for any folder layout: it names the git repo your chat is working in.
- New default macros for new installs: go ahead, no stop and wait, summarize where we are, /clear. Your saved macros are untouched.

## 0.1.4 — 2026-11-09
- Fixed: clicking update closed Switchboard but never reopened it. The update helper now runs, and it keeps a log in %TEMP%\switchboard-update.log.

## 0.1.3 — 2026-11-09
- Clicking update now opens these release notes first, with "later" or "restart & update".

## 0.1.2 — 2026-11-09
- First update delivered through the update button.

## 0.1.1 — 2026-11-09
- Easy updates: an "↑ update" button appears in the title bar when a newer build is ready; one click restarts into it and your chats come back.
- "Check for updates" and "Install update" in the command palette; hover the logo to see your version.
- Double-click a pane's name to rename it (works with a real mouse now).
- Shelf chips are grouped by project, show Claude's last reply on hover, and idle chats get a quiet "park?" hint.
- The new › ▮ app icon.

## 0.1.0 — 2026-11-08
- Several Claude chats tiled in one window: drag to rearrange, ctrl+scroll text size, status and "needs you" lamps.
- Command palette, programmable shortcuts and macros, themes, weekly usage meter.
- Shelf for parking chats, remote panes over SSH, sessions drawer to resume past chats.

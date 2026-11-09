#!/bin/bash
# Live checks of the built Switchboard.app on a macOS runner (or a Mac): launch it, open a shell pane and
# a Claude pane through the CLI, press a few Mac shortcuts with System Events, screenshot every step,
# then quit with Cmd+Q and check nothing is left running. Writes PNGs and logs to OUT.
#   tools/ci/mac_live.sh path/to/Switchboard.app OUT
# Uses a throwaway HOME-side demo folder only; no real chats are involved.
set -u
APP="$1"; OUT="$2"; mkdir -p "$OUT"
BIN="$APP/Contents/MacOS/switchboard"
ID="com.dexterlabs.switchboard"
DEMO="$HOME/switchboard-demo"
mkdir -p "$DEMO" && printf '# demo project\n' > "$DEMO/README.md"
LOG="$OUT/steps.txt"
: > "$LOG"

sw_vers > "$OUT/system.txt"
system_profiler SPDisplaysDataType 2>/dev/null | grep -i -E "resolution|display type" >> "$OUT/system.txt"
echo "claude: $(command -v claude || echo missing) $(claude --version 2>/dev/null)" >> "$OUT/system.txt"

say() { echo "== $*" | tee -a "$LOG"; }
shot() { sleep "${2:-1}"; screencapture -x "$OUT/$1.png" && say "shot $1" || say "screencapture $1 FAILED"; }
front() { osascript -e "tell application id \"$ID\" to activate" >> "$LOG" 2>&1; sleep 0.5; }
# System Events keystrokes need Accessibility for the runner; log (don't fail) if it's not granted.
keys() { front; osascript -e "tell application \"System Events\" to $1" >> "$LOG" 2>&1 && say "keys: $1" || say "keys FAILED: $1"; }
panes() { pgrep -fl "claude|zsh -l|-zsh" | grep -v pgrep | tee -a "$LOG" | wc -l | tr -d ' '; }

say "launch with --shell"
"$BIN" --shell --cwd "$DEMO" > "$OUT/app-stdout.txt" 2>&1 &
PID=$!
sleep 10
if ! kill -0 "$PID" 2>/dev/null; then say "APP EXITED EARLY"; cat "$OUT/app-stdout.txt"; exit 1; fi
shot 1-shell-pane

say "type into the shell pane"
keys 'keystroke "echo hello from switchboard; echo TERM=$TERM LANG=$LANG; tput cols"'
keys 'key code 36'
shot 2-shell-typed 2

say "second launch forwards --new-claude to the running window"
"$BIN" --new-claude --cwd "$DEMO" >> "$OUT/second-launch.txt" 2>&1
echo "second launch exit $?" >> "$LOG"
shot 3-claude-pane 15

say "Cmd+, opens the shortcuts drawer (Mac keycaps)"
keys 'keystroke "," using command down'
shot 4-shortcuts 2
keys 'key code 53'

say "Cmd+Shift+P command palette"
keys 'keystroke "p" using {command down, shift down}'
shot 5-palette 2
keys 'key code 53'

say "Cmd+T new chat"
keys 'keystroke "t" using command down'
shot 6-cmd-t 10

say "processes before closing panes: $(panes)"
say "Cmd+W three times closes every pane"
keys 'keystroke "w" using command down'
sleep 1
keys 'keystroke "w" using command down'
sleep 1
keys 'keystroke "w" using command down'
shot 7-empty 3
sleep 2
say "processes after closing panes: $(panes)"

say "Cmd+Q quits"
keys 'keystroke "q" using command down'
sleep 4
if kill -0 "$PID" 2>/dev/null; then say "STILL RUNNING after Cmd+Q, killing"; kill "$PID"; else say "app exited"; fi
shot 8-after-quit
say "processes after quit: $(panes)"
STATE="$HOME/Library/Application Support/switchboard/state.json"
[ -f "$STATE" ] && say "state saved at ~/Library/Application Support/switchboard/state.json ($(wc -c < "$STATE") bytes)" || say "no state.json"
ls "$HOME/Library/Application Support/switchboard" >> "$LOG" 2>&1
cat "$LOG"

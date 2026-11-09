// Programmable shortcuts: every app action is rebindable, and text macros type a reply or slash
// command into the focused chat (or every chat). Defaults are the replies and commands people type most.
import { closeOverlay, mount } from "./ui";
import { h } from "./util";

export interface Macro {
  id: string;
  label: string;
  text: string;
  enter: boolean;
  target: "focused" | "all";
  keys: string;
}

export interface KeyConfig {
  bindings: Record<string, string[]>; // action id -> combos (overrides defaults)
  macros: Macro[];
}

export interface ActionDef {
  id: string;
  label: string;
  group: string;
  keys: string[];
}

/** App actions and their default keys. Handlers live in main.ts. */
export const ACTIONS: ActionDef[] = [
  // Borrowed conventions: browser tabs (Ctrl+1..9, Ctrl+Tab), VS Code (Ctrl+Shift+P, F1, Ctrl+,),
  // Windows Terminal (Ctrl+Shift+T/W/F, Alt+arrows, Alt+Shift+D/+/-). Unique to Switchboard:
  // Ctrl+Shift+Space (next pane that needs you), Ctrl+Shift+O sessions, Ctrl+Alt macros.
  { id: "open.palette", label: "Command palette (everything, searchable)", group: "Open", keys: ["Ctrl+Shift+P", "F1"] },
  { id: "open.keys", label: "Shortcuts", group: "Open", keys: ["Ctrl+,"] },
  { id: "open.sessions", label: "Sessions: running + resume", group: "Open", keys: ["Ctrl+Shift+O"] },
  { id: "open.remote", label: "Remote machine (SSH)", group: "Open", keys: ["Ctrl+Shift+R"] },
  { id: "open.theme", label: "Themes", group: "Open", keys: [] },
  { id: "usage.refresh", label: "Refresh plan usage", group: "Open", keys: [] },
  { id: "app.homeHere", label: "Start new chats in this pane's folder", group: "Open", keys: [] },
  { id: "window.fullscreen", label: "Full screen", group: "Open", keys: ["F11"] },
  { id: "app.update", label: "Install update (restart into the newest build)", group: "Open", keys: [] },
  { id: "app.checkUpdate", label: "Check for updates", group: "Open", keys: [] },

  { id: "pane.newClaude", label: "New Claude chat", group: "Panes", keys: ["Ctrl+Shift+T"] },
  { id: "pane.newShell", label: "New PowerShell", group: "Panes", keys: ["Ctrl+Shift+N"] },
  { id: "pane.duplicate", label: "Duplicate pane (same kind + folder)", group: "Panes", keys: ["Alt+Shift+D"] },
  { id: "pane.splitRight", label: "Split right (new chat)", group: "Panes", keys: ["Alt+Shift+="] },
  { id: "pane.splitDown", label: "Split down (new chat)", group: "Panes", keys: ["Alt+Shift+-"] },
  { id: "pane.close", label: "Close pane", group: "Panes", keys: ["Ctrl+Shift+W"] },
  { id: "pane.park", label: "Park pane on the shelf", group: "Panes", keys: ["Ctrl+Shift+S"] },
  { id: "shelf.back", label: "Bring back the newest parked chat", group: "Panes", keys: ["Ctrl+Shift+B"] },
  { id: "shelf.parkIdle", label: "Park every chat idle 2h+", group: "Panes", keys: [] },
  { id: "pane.zoom", label: "Zoom pane / restore", group: "Panes", keys: ["Ctrl+Shift+Enter"] },
  { id: "pane.rename", label: "Rename pane", group: "Panes", keys: ["F2"] },
  { id: "pane.color", label: "Color pane", group: "Panes", keys: [] },
  { id: "pane.restart", label: "Restart pane (chat resumes)", group: "Panes", keys: [] },
  { id: "pane.find", label: "Find in scrollback", group: "Panes", keys: ["Ctrl+Shift+F"] },

  { id: "attn.next", label: "Jump to next pane that needs you", group: "Move", keys: ["Ctrl+Shift+Space"] },
  { id: "attn.clear", label: "Mark every pane as seen", group: "Move", keys: [] },
  { id: "focus.next", label: "Next pane", group: "Move", keys: ["Ctrl+Tab"] },
  { id: "focus.prev", label: "Previous pane", group: "Move", keys: ["Ctrl+Shift+Tab"] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `focus.${n}`, label: `Go to pane ${n}`, group: "Move", keys: [`Ctrl+${n}`] })),
  { id: "focus.last", label: "Go to last pane", group: "Move", keys: ["Ctrl+9"] },
  { id: "focus.left", label: "Focus left", group: "Move", keys: ["Ctrl+Left", "Alt+Left"] },
  { id: "focus.right", label: "Focus right", group: "Move", keys: ["Ctrl+Right", "Alt+Right"] },
  { id: "focus.up", label: "Focus up", group: "Move", keys: ["Ctrl+Up", "Alt+Up"] },
  { id: "focus.down", label: "Focus down", group: "Move", keys: ["Ctrl+Down", "Alt+Down"] },

  { id: "layout.columns", label: "Layout: columns", group: "Layout", keys: ["Ctrl+Alt+1"] },
  { id: "layout.rows", label: "Layout: rows", group: "Layout", keys: ["Ctrl+Alt+2"] },
  { id: "layout.grid", label: "Layout: grid", group: "Layout", keys: ["Ctrl+Alt+3"] },
  { id: "layout.main", label: "Layout: main + stack", group: "Layout", keys: ["Ctrl+Alt+4"] },
  { id: "layout.balance", label: "Even out all splits", group: "Layout", keys: ["Ctrl+Alt+0"] },

  { id: "text.bigger", label: "Text bigger (pane)", group: "Text", keys: ["Ctrl+="] },
  { id: "text.smaller", label: "Text smaller (pane)", group: "Text", keys: ["Ctrl+-"] },
  { id: "text.reset", label: "Text size reset (pane)", group: "Text", keys: ["Ctrl+0"] },
  { id: "text.resetAll", label: "Text size reset (all panes)", group: "Text", keys: [] },
];

let n = 0;
const m = (label: string, text: string, keys: string, target: Macro["target"] = "focused", enter = true): Macro => ({
  id: `m${++n}`,
  label,
  text,
  enter,
  target,
  keys,
});

/** Seeded from history.jsonl: his most-sent short replies and slash commands. */
export const DEFAULT_MACROS: Macro[] = [
  m("continue", "continue", "Ctrl+Alt+C"),
  m("yes", "yes", "Ctrl+Alt+Y"),
  m("go ahead", "go ahead", "Ctrl+Alt+G"),
  m("no, stop and wait", "no, stop and wait", "Ctrl+Alt+N"),
  m("summarize where we are", "summarize where we are and what's left", "Ctrl+Alt+S"),
  m("/clear", "/clear", "Ctrl+Alt+L"),
  m("/model picker", "/model", "Ctrl+Alt+M"),
  m("/effort picker", "/effort", "Ctrl+Alt+E"),
  m("/compact", "/compact", "Ctrl+Alt+K"),
  m("/permissions", "/permissions", "Ctrl+Alt+P"),
  m("/tasks", "/tasks", "Ctrl+Alt+T"),
  m("/rc remote control", "/rc", "Ctrl+Alt+R"),
];

// ---------- combos ----------
const CODE_NAMES: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Space: "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  NumpadAdd: "=",
  NumpadSubtract: "-",
  NumpadEnter: "Enter",
};

/** Layout-stable name for the physical key (Shift+1 stays "1", not "!"). */
export function keyName(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  if (CODE_NAMES[c]) return CODE_NAMES[c];
  if (["Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Insert"].includes(c)) return c;
  return null; // modifiers alone, media keys, etc.
}

export function comboFromEvent(e: KeyboardEvent): string | null {
  const k = keyName(e);
  if (!k) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win", k].filter(Boolean).join("+");
}

/** Canonical form so "shift+ctrl+t" and "Ctrl+Shift+T" match. */
export function normalize(combo: string): string {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" style: a trailing empty part means the key was "+"; we store "=" for that key.
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const K = key.length === 1 ? key.toUpperCase() : key;
  return [mods.has("ctrl") && "Ctrl", mods.has("alt") && "Alt", mods.has("shift") && "Shift", mods.has("win") && "Win", K]
    .filter(Boolean)
    .join("+");
}

export function keycaps(combo: string): HTMLElement {
  const wrap = h("span", { class: "caps" });
  if (!combo) {
    wrap.append(h("span", { class: "cap none", text: "—" }));
    return wrap;
  }
  const pretty: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓", Enter: "⏎", Backspace: "⌫", Space: "space", Escape: "esc", Tab: "tab" };
  combo.split("+").forEach((p, i) => {
    if (i) wrap.append(h("span", { class: "plus", text: "+" }));
    wrap.append(h("span", { class: `cap${["Ctrl", "Alt", "Shift", "Win"].includes(p) ? " mod" : ""}`, text: (pretty[p] ?? p).toLowerCase() }));
  });
  return wrap;
}

// ---------- editor ----------
export interface KeyHost {
  config: KeyConfig;
  save(): void;
  /** Called while capturing so the app doesn't act on the keys being recorded. */
  setCapturing(on: boolean): void;
}

export function effectiveBindings(cfg: KeyConfig): { id: string; label: string; group: string; keys: string[]; macro?: Macro }[] {
  const out: { id: string; label: string; group: string; keys: string[]; macro?: Macro }[] = ACTIONS.map((a) => ({
    ...a,
    keys: (cfg.bindings[a.id] ?? a.keys).map(normalize),
  }));
  for (const mac of cfg.macros) out.push({ id: mac.id, label: mac.label, group: "Macros", keys: mac.keys ? [normalize(mac.keys)] : [], macro: mac });
  return out;
}

const KB_ROWS = ["1234567890-=", "QWERTYUIOP[]", "ASDFGHJKL;'", "ZXCVBNM,./"];

export function keysMenu(host: KeyHost) {
  const cfg = host.config;
  const body = h("div", { class: "keys-body" });
  const mapEl = h("div", { class: "kbmap" });
  const modTabs = h("div", { class: "modtabs" });
  const MODS = ["Ctrl+Alt", "Ctrl+Shift", "Alt+Shift", "Ctrl", "Alt"];
  let mod = "Ctrl+Alt";

  const owners = () => {
    const map = new Map<string, string[]>();
    for (const b of effectiveBindings(cfg)) for (const k of b.keys) map.set(k, [...(map.get(k) ?? []), b.label]);
    return map;
  };

  const drawMap = () => {
    modTabs.replaceChildren();
    for (const md of MODS) {
      const t = h("button", { class: `modtab${md === mod ? " on" : ""}`, text: md.toLowerCase() });
      t.addEventListener("click", () => {
        mod = md;
        drawMap();
      });
      modTabs.append(t);
    }
    mapEl.replaceChildren();
    const own = owners();
    KB_ROWS.forEach((row, ri) => {
      const r = h("div", { class: "kbrow" });
      r.style.paddingLeft = `${ri * 0.6}em`;
      for (const ch of row) {
        const combo = normalize(`${mod}+${ch}`);
        const who = own.get(combo);
        const cap = h("span", { class: `kbkey${who ? " bound" : ""}${who && who.length > 1 ? " clash" : ""}`, text: ch.toLowerCase() });
        cap.title = who ? `${combo}\n${who.join("\n")}` : `${combo} — free`;
        r.append(cap);
      }
      mapEl.append(r);
    });
  };

  const capture = (onDone: (combo: string | null) => void, cell: HTMLElement) => {
    cell.replaceChildren(h("span", { class: "recording", text: "press keys… (esc cancels, ⌫ clears)" }));
    host.setCapturing(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return finish(undefined);
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.shiftKey) return finish(null);
      const c = comboFromEvent(e);
      if (c) finish(c);
    };
    const finish = (v: string | null | undefined) => {
      window.removeEventListener("keydown", onKey, true);
      host.setCapturing(false);
      if (v !== undefined) onDone(v);
      draw();
    };
    window.addEventListener("keydown", onKey, true);
  };

  const draw = () => {
    body.replaceChildren();
    const own = owners();
    const groups = new Map<string, ReturnType<typeof effectiveBindings>>();
    for (const b of effectiveBindings(cfg)) groups.set(b.group, [...(groups.get(b.group) ?? []), b]);
    for (const [g, rows] of groups) {
      const sec = h("section", { class: "keys-sec" }, h("h3", { text: g.toLowerCase() }));
      for (const b of rows) {
        const cell = h("button", { class: "bind", title: "Click, then press the new keys" });
        const clash = b.keys.some((k) => (own.get(k)?.length ?? 0) > 1);
        cell.append(keycaps(b.keys[0] ?? ""));
        if (b.keys.length > 1) cell.append(h("span", { class: "alt-keys", text: `+${b.keys.length - 1}` }));
        cell.addEventListener("click", () =>
          capture((combo) => {
            if (b.macro) b.macro.keys = combo ?? "";
            else cfg.bindings[b.id] = combo ? [combo] : [];
            host.save();
          }, cell),
        );
        const row = h("div", { class: `krow${clash ? " clash" : ""}` });
        if (b.macro) {
          const mac = b.macro;
          const label = h("input", { class: "mlabel", value: mac.label, title: "Name" });
          const text = h("input", { class: "mtext", value: mac.text, title: "Text it types" });
          const enter = h("button", { class: `chipbtn${mac.enter ? " on" : ""}`, text: "⏎", title: "Press Enter after typing" });
          const target = h("button", { class: `chipbtn${mac.target === "all" ? " on" : ""}`, text: mac.target === "all" ? "all chats" : "this pane", title: "Send to the focused pane or every Claude chat" });
          const del = h("button", { class: "icon", text: "×", title: "Delete macro" });
          label.addEventListener("change", () => ((mac.label = label.value), host.save()));
          text.addEventListener("change", () => ((mac.text = text.value), host.save()));
          enter.addEventListener("click", () => ((mac.enter = !mac.enter), host.save(), draw()));
          target.addEventListener("click", () => ((mac.target = mac.target === "all" ? "focused" : "all"), host.save(), draw()));
          del.addEventListener("click", () => {
            cfg.macros = cfg.macros.filter((x) => x !== mac);
            host.save();
            draw();
          });
          // Typing in the macro fields must not trigger shortcuts.
          for (const inp of [label, text]) inp.addEventListener("keydown", (e) => e.stopPropagation());
          row.append(label, text, enter, target, cell, del);
          row.classList.add("macro");
        } else {
          const custom = cfg.bindings[b.id] !== undefined;
          row.append(h("span", { class: "klabel", text: b.label }), cell);
          if (custom) {
            const rs = h("button", { class: "icon", text: "↺", title: "Back to default" });
            rs.addEventListener("click", () => {
              delete cfg.bindings[b.id];
              host.save();
              draw();
            });
            row.append(rs);
          }
        }
        if (clash) row.title = "Two shortcuts share these keys; the first one listed wins.";
        sec.append(row);
      }
      if (g === "Macros") {
        const add = h("button", { class: "btn", text: "+ macro" });
        add.addEventListener("click", () => {
          cfg.macros.push({ id: `m${Date.now()}`, label: "new macro", text: "", enter: true, target: "focused", keys: "" });
          host.save();
          draw();
          (body.querySelector(".krow.macro:last-of-type .mtext") as HTMLInputElement | null)?.focus();
        });
        sec.append(h("div", { class: "row" }, add));
      }
      body.append(sec);
    }
    drawMap();
  };

  const resetAll = h("button", { class: "btn", text: "reset all to defaults" });
  resetAll.addEventListener("click", () => {
    cfg.bindings = {};
    cfg.macros = DEFAULT_MACROS.map((x) => ({ ...x }));
    host.save();
    draw();
  });
  const panel = h(
    "aside",
    { class: "drawer keys-menu" },
    h("div", { class: "row spread" }, h("h3", { text: "shortcuts" }), resetAll),
    h(
      "p",
      { class: "hint", text: "Click any key to rebind it. Macros type text into the focused chat (or every chat) and press Enter. Fixed: ctrl+c copies when text is selected, ctrl+v pastes (screenshots go to Claude), shift+enter is a new line, ctrl+scroll sizes text." },
    ),
    h("div", { class: "kbwrap" }, modTabs, mapEl, h("div", { class: "kblegend" }, h("span", { class: "kbkey bound", text: "a" }), " bound ", h("span", { class: "kbkey", text: "a" }), " free ", h("span", { class: "kbkey bound clash", text: "a" }), " clash · hover a key to see what it does")),
    body,
  );
  mount(panel, "right");
  draw();
  panel.setAttribute("tabindex", "-1");
  panel.focus();
  return closeOverlay;
}

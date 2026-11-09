import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as L from "./layout";
import { DEFAULT_ZOOM, IDLE_PARK_MS, paneOptions, renderOpts, SPIN_FRAMES, Pane, type LiveSession, type PaneKind, type PaneSpec, type Status } from "./pane";
import { closeOverlay, confirmModal, hostPicker, mount, overlayOpen, releaseNotesModal, renameModal, sessionsDrawer, type Host, type ReleaseNote } from "./ui";
import { h } from "./util";
import wordmarkDark from "./assets/logo-wordmark.png";
import wordmarkLight from "./assets/logo-wordmark-light.png";
import { StatusLine, type Usage } from "./statusline";
import { ACTIONS, comboFromEvent, DEFAULT_MACROS, effectiveBindings, keysMenu, type KeyConfig, type Macro } from "./keys";
import { openPalette, type PaletteItem } from "./palette";
import { Shelf, type Parked } from "./shelf";
import { applyTheme, DEFAULT_THEME, findTheme, theme, THEMES } from "./themes";
import { isMac, kb, shellName } from "./platform";

// macOS: native traffic lights instead of our window buttons (see style.css).
document.body.classList.toggle("mac", isMac);

interface Saved {
  v: 1;
  nextId: number;
  root: L.Node | null;
  focused: number | null;
  panes: PaneSpec[];
  hosts: Host[];
  claudeCmd: Record<string, string>;
  keys?: KeyConfig;
  theme?: string;
  shelf?: Parked[];
  homeCwd?: string;
  copyOnSelect?: boolean;
}

const win = getCurrentWindow();
const workspace = document.getElementById("workspace")!;
const topbar = document.getElementById("topbar")!;

const panes = new Map<number, Pane>();
let root: L.Node | null = null;
let focused: number | null = null;
let zoomed: number | null = null;
let nextId = 1;
let live: LiveSession[] = [];
const remote = { hosts: [] as Host[], claudeCmd: {} as Record<string, string> };
/** Where new chats start when there is no pane to inherit a folder from. */
let homeCwd = "";
const shelfItems: Parked[] = [];
// Empty slots left behind by parked chats live in the layout tree as negative ids.
const slots = new Map<number, HTMLElement>();
let nextSlot = -1;
/** Pane ids in layout order, without empty slots. */
function paneIds(): number[] {
  return L.leaves(root).filter((id) => id > 0);
}
function slotIds(): number[] {
  return L.leaves(root).filter((id) => id < 0);
}
function slotEl(id: number): HTMLElement {
  let el = slots.get(id);
  if (el) return el;
  const btn = (label: string, key: string, tip: string, fn: () => void) => {
    const b = h("button", { class: "slot-btn", title: tip }, h("span", { class: "k", text: key }), h("span", { text: label }));
    b.addEventListener("click", fn);
    return b;
  };
  el = h(
    "div",
    { class: "pane slot-pane" },
    h(
      "div",
      { class: "slot-inner" },
      h("div", { class: "slot-title", text: "empty slot" }),
      h(
        "div",
        { class: "slot-actions" },
        btn("new chat", "⏎", "Start a new Claude chat here", () => fillSlot(id, { kind: "claude" })),
        btn("fill space", "⌫", "Close this slot and let the neighbours grow", () => removeSlot(id)),
      ),
      h("div", { class: "slot-hint", text: "or drop a pane or a shelf chip here" }),
    ),
  );
  el.dataset.slot = String(id);
  el.tabIndex = 0;
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fillSlot(id, { kind: "claude" });
    else if (e.key === "Backspace" || e.key === "Delete") removeSlot(id);
  });
  slots.set(id, el);
  return el;
}
function removeSlot(id: number) {
  root = L.removeLeaf(root, id);
  slots.delete(id);
  relayout();
  save();
}
/** Put a new pane (or an existing one) where the slot is. */
function fillSlot(slot: number, opts: Partial<PaneSpec> & { kind: PaneKind }) {
  const p = addPane(opts, slot, "right");
  // addPane split the slot; collapse the slot so the new pane takes its place exactly.
  root = L.removeLeaf(root, slot);
  slots.delete(slot);
  relayout();
  setFocus(p.spec.id);
  save();
}
function slotAt(x: number, y: number): number | null {
  const t = document.elementFromPoint(x, y)?.closest(".slot-pane") as HTMLElement | null;
  return t ? Number(t.dataset.slot) : null;
}
const parking = document.getElementById("parking")!;

// ---------- persistence ----------
let saveTimer = 0;
function snapshot(): Saved {
  return {
    v: 1,
    nextId,
    root,
    focused,
    panes: [...panes.values()].map((p) => p.spec),
    hosts: remote.hosts,
    claudeCmd: remote.claudeCmd,
    keys: keyCfg,
    theme: theme().id,
    homeCwd,
    copyOnSelect: paneOptions.copyOnSelect,
    shelf: shelfItems.map((it) => ({ ...it, spec: it.mode === "running" ? panes.get(it.id)?.spec ?? it.spec : it.spec })),
  };
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => invoke("save_state", { json: JSON.stringify(snapshot()) }), 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  await invoke("save_state", { json: JSON.stringify(snapshot()) }).catch(() => {});
}

// ---------- panes ----------
const hooks = {
  onFocus: (p: Pane) => setFocus(p.spec.id, false),
  onBell: (p: Pane) => {
    if (!isLooking(p)) raise(p);
  },
  onExit: () => updateChrome(),
  onChange: save,
  onDragStart: (p: Pane, e: PointerEvent) => startDrag(p, e),
  onSplit: (p: Pane, side: "right" | "bottom", kind: PaneKind) => addPane({ kind }, p.spec.id, side),
  onClose: (p: Pane) => closePane(p.spec.id),
  onPark: (p: Pane) => park(p.spec.id),
  onRename: (p: Pane) => rename(p),
  onTitle: (p: Pane) => {
    // Panes without a registry entry (remote Claude) get status from the terminal title.
    if (p.spec.kind === "ssh" && p.spec.remoteCmd) {
      const s = p.titleStatus();
      if (s) transition(p, s);
    }
  },
};

function makePane(spec: PaneSpec): Pane {
  const p = new Pane(spec, hooks);
  panes.set(spec.id, p);
  return p;
}

/** Split the focused (or given) pane along its longer side. */
function autoSide(target: number | null): L.Side {
  const el = target !== null ? panes.get(target)?.el : null;
  if (!el) return "right";
  return el.offsetWidth >= el.offsetHeight * 1.6 ? "right" : "bottom";
}

function addPane(
  opts: Partial<PaneSpec> & { kind: PaneKind },
  target: number | null = focused,
  side?: L.Side,
): Pane {
  if (zoomed !== null) toggleZoom();
  const id = nextId++;
  const base = target !== null ? panes.get(target)?.spec : undefined;
  const spec: PaneSpec = {
    id,
    cwd: opts.cwd || (base?.kind === "claude" || base?.kind === "shell" ? base.cwd : homeCwd),
    zoom: base?.zoom ?? DEFAULT_ZOOM,
    ...opts,
  };
  const p = makePane(spec);
  root = L.splitAt(root, target, id, side ?? autoSide(target));
  relayout();
  p.start();
  setFocus(id);
  save();
  return p;
}

async function closePane(id: number, force = false) {
  const p = panes.get(id);
  if (!p) return;
  if (!force && p.isAlive && p.status === "busy") {
    if (!(await confirmModal(`"${p.label()}" is still working. Close it?`))) return;
  }
  if (zoomed === id) zoomed = null;
  const order = paneIds();
  const idx = order.indexOf(id);
  root = L.removeLeaf(root, id);
  panes.delete(id);
  p.dispose();
  relayout();
  const rest = paneIds();
  if (rest.length) setFocus(rest[Math.min(idx, rest.length - 1)]);
  else focused = null;
  updateChrome();
  save();
}

function relayout() {
  L.render(root, workspace, (id) => (id < 0 ? slotEl(id) : panes.get(id)!.el), (r) => {
    root = r;
    save();
  });
  workspace.classList.toggle("has-zoom", zoomed !== null);
  paneIds().forEach((id, i) => panes.get(id)?.setIndex(i + 1));
  for (const p of panes.values()) p.el.classList.toggle("zoomed", p.spec.id === zoomed);
  if (!root) {
    workspace.append(
      h(
        "div",
        { class: "empty-state" },
        h("p", { text: "No panes open." }),
        h("p", { class: "hint", text: kb("Ctrl+Shift+T new Claude · Ctrl+Shift+O resume a chat · Ctrl+Shift+R remote machine") }),
      ),
    );
  }
  requestAnimationFrame(() => {
    for (const p of panes.values()) p.refit();
    if (focused !== null) panes.get(focused)?.focus();
  });
}

function setFocus(id: number, moveKeyboard = true) {
  const p = panes.get(id);
  if (!p) return;
  if (focused !== id) {
    focused = id;
    for (const q of panes.values()) q.el.classList.toggle("focused", q.spec.id === id);
    save();
  }
  if (p.attention) {
    p.setAttention(false);
    updateChrome();
  }
  if (moveKeyboard) p.focus();
}

function toggleZoom() {
  zoomed = zoomed === null && focused !== null && panes.size > 1 ? focused : null;
  relayout();
}

function rename(p: Pane) {
  renameModal(p.spec.name ?? "", p.spec.color ?? "", p.live?.title || p.label(), (name, color) => {
    p.spec.name = name || undefined;
    p.spec.color = color || undefined;
    p.refreshHead();
    save();
    p.focus();
  });
}

// ---------- status + attention ----------
const isLooking = (p: Pane) => document.hasFocus() && focused === p.spec.id;

function transition(p: Pane, next: Status, since?: number) {
  const prev = p.status;
  p.setStatus(next, since);
  // Finished a turn, or stopped to ask something, while you weren't looking at it.
  if (prev === "busy" && next !== "busy" && !isLooking(p)) raise(p);
  if (next === "waiting" && prev !== "waiting" && !isLooking(p)) raise(p);
}

function raise(p: Pane) {
  if (p.attention) return;
  p.setAttention(true);
  updateChrome();
  if (!document.hasFocus()) win.requestUserAttention(UserAttentionType.Informational).catch(() => {});
}

function attentionPanes(): Pane[] {
  return paneIds()
    .map((id) => panes.get(id)!)
    .filter((p) => p.attention);
}
/** Shelf chips that want you: a parked running chat that finished, or a reminder that came due. */
function attentionShelf(): Parked[] {
  return shelfItems.filter((it) => it.due || (it.mode === "running" && panes.get(it.id)?.attention));
}

function jumpToNext() {
  const order = paneIds();
  if (!order.some((id) => panes.get(id)?.attention)) {
    const it = attentionShelf()[0];
    if (it) return unpark(it);
  }
  const start = focused !== null ? order.indexOf(focused) : -1;
  for (let i = 1; i <= order.length; i++) {
    const p = panes.get(order[(start + i) % order.length])!;
    if (p.attention) {
      if (zoomed !== null && zoomed !== p.spec.id) {
        zoomed = p.spec.id;
        relayout();
      }
      setFocus(p.spec.id);
      return;
    }
  }
}

listen<LiveSession[]>("sessions", (e) => {
  live = e.payload;
  for (const p of panes.values()) {
    if (p.spec.kind !== "claude") continue;
    const s = live.find((l) => l.paneId === p.spec.id) ?? null;
    p.setLive(s);
    if (!p.isAlive) continue;
    if (s) {
      const st: Status = s.status === "busy" ? "busy" : s.status === "idle" ? "idle" : s.status ? "waiting" : "idle";
      transition(p, st, s.statusUpdatedAt);
    } else if (p.status !== "starting") {
      // Claude quit back to the shell prompt.
      p.setStatus("none");
    }
  }
  updateChrome();
});

// When the window regains focus, the focused pane counts as seen.
window.addEventListener("focus", () => {
  if (focused !== null) setFocus(focused, false);
});

// One shared ticker animates every busy pane's braille spinner (cheap: text swap, no layout).
let spinI = 0;
setInterval(() => {
  spinI = (spinI + 1) % SPIN_FRAMES.length;
  const f = SPIN_FRAMES[spinI];
  document.querySelectorAll<HTMLElement>(".dot.busy").forEach((d) => (d.textContent = f));
}, 90);

// Header clocks ("3m") tick.
setInterval(() => {
  for (const p of panes.values()) p.refreshHead();
}, 30_000);

// ---------- title bar: brand + hotkey menu (TUI style) + window controls ----------
const attnBtn = h("button", { class: "attn-pill", title: kb("Jump to the next pane that needs you (Ctrl+Shift+Space)") });
const updateBtn = h("button", { class: "update-pill" });
updateBtn.hidden = true;
attnBtn.addEventListener("click", jumpToNext);
/** A menu item drawn like a TUI footer hint: the key in accent, the word dim. */
function hot(key: string, label: string, tip: string, fn: () => void) {
  const b = h("button", { class: "hot", title: tip }, h("span", { class: "k", text: key }), h("span", { text: label }));
  b.addEventListener("click", fn);
  return b;
}
const WIN_ICONS = {
  min: '<svg viewBox="0 0 10 10"><path d="M1 5h8"/></svg>',
  max: '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>',
  restore: '<svg viewBox="0 0 10 10"><rect x="1.5" y="3" width="5.5" height="5.5" rx="1"/><path d="M3.5 3V2.2c0-.4.3-.7.7-.7h4.1c.4 0 .7.3.7.7v4.1c0 .4-.3.7-.7.7H7"/></svg>',
  close: '<svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>',
};
function winButton(cls: string, icon: string, tip: string, fn: () => void) {
  const b = h("button", { class: `win ${cls}`, title: tip });
  b.innerHTML = icon;
  b.addEventListener("click", fn);
  return b;
}
const maxBtn = winButton("max", WIN_ICONS.max, "Maximize", () => win.toggleMaximize());
const brand = h("span", { class: "brand", "data-tauri-drag-region": "" });
const wordmark = h("img", { class: "wordmark", alt: "switchboard", draggable: "false", "data-tauri-drag-region": "" });
wordmark.src = wordmarkDark;
brand.append(wordmark);
topbar.append(
  brand,
  h(
    "nav",
    { class: "menu" },
    hot(isMac ? "⌘T" : "^T", "chat", kb("New Claude pane (Ctrl+Shift+T)"), () => addPane({ kind: "claude" })),
    hot(isMac ? "⌘N" : "^N", "shell", kb(`New ${shellName} pane (Ctrl+Shift+N)`), () => addPane({ kind: "shell" })),
    hot(isMac ? "⇧⌘R" : "^R", "remote", kb("Shell or Claude on another machine (Ctrl+Shift+R)"), openHosts),
    hot(isMac ? "⇧⌘O" : "^O", "sessions", kb("Running chats + resume past ones (Ctrl+Shift+O)"), openSessions),
    h("span", { class: "sep", text: "│" }),
    hot("", "cols", kb("Panes side by side (Ctrl+Alt+1)"), () => applyPreset("columns")),
    hot("", "grid", kb("Even grid (Ctrl+Alt+3)"), () => applyPreset("grid")),
    hot("", "main", kb("One big pane + a stack (Ctrl+Alt+4)"), () => applyPreset("main")),
  ),
  h("span", { class: "spacer", "data-tauri-drag-region": "" }),
  updateBtn,
  attnBtn,
  hot("", "theme", "Themes", () => openThemes()),
  hot(isMac ? "⇧⌘P" : "^⇧P", "commands", kb("Command palette: every action, pane and chat (Ctrl+Shift+P or F1)"), () => openCommandPalette()),
  hot(isMac ? "⌘," : "^,", "keys", kb("Shortcuts: see and change every key (Ctrl+,)"), () => openKeys()),
  h(
    "span",
    { class: "win-controls" },
    winButton("min", WIN_ICONS.min, "Minimize", () => win.minimize()),
    maxBtn,
    winButton("close", WIN_ICONS.close, "Close", () => win.close()),
  ),
);
topbar.setAttribute("data-tauri-drag-region", "");
const syncMax = async () => {
  const m = await win.isMaximized().catch(() => false);
  maxBtn.innerHTML = m ? WIN_ICONS.restore : WIN_ICONS.max;
  maxBtn.title = m ? "Restore" : "Maximize";
  document.body.classList.toggle("maximized", m);
  // Full screen hides the traffic lights, so the title bar no longer leaves room for them.
  if (isMac) document.body.classList.toggle("fullscreen", await win.isFullscreen().catch(() => false));
};
win.onResized(() => syncMax()).catch(() => {});
syncMax();

// ---------- status line: plan usage + chat counts ----------
const status = new StatusLine(document.getElementById("statusbar")!);
listen<Usage>("usage", (e) => status.setUsage(e.payload));
invoke<Usage>("refresh_usage").then((u) => status.setUsage(u)).catch(() => {});
status.onRefresh = () => invoke<Usage>("refresh_usage").then((u) => status.setUsage(u)).catch(() => {});

function updateChrome() {
  const n = attentionPanes().length + attentionShelf().length;
  shelf.refresh();
  attnBtn.textContent = n ? `◆ ${n} need${n === 1 ? "s" : ""} you` : "";
  attnBtn.hidden = n === 0;
  const all = [...panes.values()];
  const busy = all.filter((p) => p.status === "busy").length;
  status.setCounts(all.filter((p) => p.spec.kind === "claude" || p.spec.remoteCmd).length, busy, n);
  const title = ["Switchboard", n ? `${n} need you` : "", busy ? `${busy} working` : ""].filter(Boolean).join(" · ");
  if (document.title !== title) {
    document.title = title;
    win.setTitle(title).catch(() => {});
  }
}

function applyPreset(kind: "columns" | "rows" | "grid" | "main") {
  const ids = paneIds();
  if (focused !== null && kind === "main") ids.sort((a, b) => (a === focused ? -1 : b === focused ? 1 : 0));
  root = L.preset(ids, kind);
  zoomed = null;
  relayout();
  save();
}

function openSessions() {
  sessionsDrawer(live, (id) => panes.get(id)?.label() ?? "", {
    show: (id) => setFocus(id),
    resume: (sid, cwd) => addPane({ kind: "claude", sessionId: sid, cwd: cwd || homeCwd }),
    newClaude: () => addPane({ kind: "claude" }),
  });
}

function openHosts() {
  hostPicker(
    remote,
    (host, mode, cmd) =>
      addPane({
        kind: "ssh",
        host: host.target,
        hostLabel: host.label,
        remoteCmd: mode === "claude" ? cmd : undefined,
        cwd: homeCwd,
      }),
    save,
  );
}

// ---------- shelf: park chats for later ----------
function park(id: number) {
  const p = panes.get(id);
  if (!p) return;
  if (zoomed === id) zoomed = null;
  const order = paneIds();
  const idx = order.indexOf(id);
  const slot = nextSlot--;
  root = L.swap(root, id, slot); // the space stays, as an empty slot with "new chat / fill space"
  // A working chat keeps running off-screen; an idle one is closed and resumes on the way back.
  const keepRunning = p.isAlive && (p.status === "busy" || p.status === "starting" || p.spec.kind !== "claude");
  const item: Parked = {
    id,
    mode: keepRunning ? "running" : "saved",
    spec: { ...p.spec },
    title: p.label(),
    parkedAt: Date.now(),
    project: p.live?.project || undefined,
    lastText: p.live?.lastText || undefined,
  };
  if (keepRunning) {
    parking.append(p.el); // stays in the DOM so the terminal keeps rendering what arrives
  } else {
    panes.delete(id);
    p.dispose();
  }
  shelfItems.push(item);
  relayout();
  const rest = paneIds();
  if (rest.length) setFocus(rest[Math.max(0, Math.min(idx, rest.length - 1))]);
  else focused = null;
  shelf.render();
  updateChrome();
  save();
}

function unpark(item: Parked, target: number | null = focused, side?: L.Side) {
  const i = shelfItems.indexOf(item);
  if (i < 0) return;
  shelfItems.splice(i, 1);
  if (zoomed !== null) zoomed = null;
  let p = panes.get(item.id);
  const fresh = !p;
  if (!p) p = makePane({ ...item.spec });
  const freeSlot = target !== null && target < 0 ? target : side === undefined ? slotIds()[0] : undefined;
  if (freeSlot !== undefined) {
    root = L.swap(root, freeSlot, item.id); // drop it into the empty slot
    slots.delete(freeSlot);
  } else
    root = L.splitAt(root, target !== null && panes.has(target) && paneIds().includes(target) ? target : null, item.id, side ?? autoSide(target));
  relayout();
  if (fresh) p.start();
  p.setAttention(false);
  setFocus(item.id);
  shelf.render();
  updateChrome();
  save();
}

const shelf = new Shelf(
  {
    items: shelfItems,
    info: (it) => {
      const lv = it.mode === "running" ? panes.get(it.id)?.live : null;
      return { project: lv?.project || it.project, lastText: lv?.lastText || it.lastText };
    },
    state: (it) => {
      const p = it.mode === "running" ? panes.get(it.id) : undefined;
      if (it.due || p?.attention) return { glyph: "◆", cls: "attn" };
      if (!p) return { glyph: "○", cls: "none" };
      if (p.status === "busy") return { glyph: "⠿", cls: "busy" };
      if (!p.isAlive) return { glyph: "×", cls: "exited" };
      return { glyph: "●", cls: "idle" };
    },
    unpark: (it) => unpark(it),
    startChipDrag: (it, e, chip) => startChipDrag(it, e, chip),
    closeKeepSaved: (it) => {
      const p = panes.get(it.id);
      if (p) {
        it.spec = { ...p.spec };
        panes.delete(it.id);
        p.dispose();
      }
      it.mode = "saved";
      shelf.render();
      updateChrome();
      save();
    },
    forget: (it) => {
      const p = panes.get(it.id);
      if (p) {
        panes.delete(it.id);
        p.dispose();
      }
      shelfItems.splice(shelfItems.indexOf(it), 1);
      shelf.render();
      updateChrome();
      save();
    },
    changed: () => {
      shelf.render();
      updateChrome();
      save();
    },
  },
  document.getElementById("shelf")!,
);

// Reminders come due: light the chip and nudge like a finished chat.
setInterval(() => {
  let fired = false;
  for (const it of shelfItems) {
    if (it.remindAt && !it.due && Date.now() >= it.remindAt) {
      it.due = true;
      fired = true;
    }
  }
  if (fired) {
    shelf.render();
    updateChrome();
    save();
    if (!document.hasFocus()) win.requestUserAttention(UserAttentionType.Informational).catch(() => {});
  }
}, 15_000);

/** Click a chip to bring it back; drag it onto a pane to dock it on that side. */
function startChipDrag(item: Parked, e: PointerEvent, chip: HTMLElement) {
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let drop: { target: Pane; zone: Zone } | null = null;
  let slotDrop: number | null = null;
  chip.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      dragging = true;
      document.body.classList.add("dragging");
      ghost = h("div", { class: "drag-ghost", text: item.title });
      document.body.append(ghost);
    }
    ghost!.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    slotDrop = slotAt(ev.clientX, ev.clientY);
    if (slotDrop !== null) {
      drop = null;
      showSlotMarker(slotDrop);
      return;
    }
    const t = paneAt(ev.clientX, ev.clientY);
    if (!t) {
      drop = null;
      dropMarker.remove();
      return;
    }
    let zone = zoneFor(t.el.getBoundingClientRect(), ev.clientX, ev.clientY);
    if (zone === "center") zone = autoSide(t.spec.id);
    drop = { target: t, zone };
    showMarker(t, zone);
  };
  const end = (ev: PointerEvent) => {
    chip.removeEventListener("pointermove", move);
    chip.removeEventListener("pointerup", end);
    chip.removeEventListener("pointercancel", end);
    document.body.classList.remove("dragging");
    ghost?.remove();
    dropMarker.remove();
    if (ev.type !== "pointerup") return;
    if (!dragging) unpark(item);
    else if (slotDrop !== null) unpark(item, slotDrop);
    else if (drop) unpark(item, drop.target.spec.id, drop.zone as L.Side);
  };
  chip.addEventListener("pointermove", move);
  chip.addEventListener("pointerup", end);
  chip.addEventListener("pointercancel", end);
}

// ---------- keyboard ----------
function neighbor(dir: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): number | null {
  const cur = focused !== null ? panes.get(focused)?.el.getBoundingClientRect() : null;
  if (!cur) return null;
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best: number | null = null;
  let bestD = Infinity;
  for (const p of panes.values()) {
    if (p.spec.id === focused) continue;
    const r = p.el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ok =
      dir === "ArrowLeft" ? r.right <= cur.left + 2 : dir === "ArrowRight" ? r.left >= cur.right - 2 : dir === "ArrowUp" ? r.bottom <= cur.top + 2 : r.top >= cur.bottom - 2;
    if (!ok) continue;
    const along = dir === "ArrowLeft" || dir === "ArrowRight" ? Math.abs(x - cx) : Math.abs(y - cy);
    const across = dir === "ArrowLeft" || dir === "ArrowRight" ? Math.abs(y - cy) : Math.abs(x - cx);
    const d = along + across * 2;
    if (d < bestD) {
      bestD = d;
      best = p.spec.id;
    }
  }
  return best;
}

// Keyboard: every combo resolves through the user's binding table (keys.ts), so it's all remappable.
const keyCfg: KeyConfig = { bindings: {}, macros: DEFAULT_MACROS.map((x) => ({ ...x })) };
let capturing = false;
let comboMap = new Map<string, string>(); // combo -> action/macro id
function rebuildKeys() {
  comboMap = new Map();
  for (const b of effectiveBindings(keyCfg)) for (const k of b.keys) if (!comboMap.has(k)) comboMap.set(k, b.id);
}

function cycleFocus(step: number) {
  const order = paneIds();
  if (!order.length) return;
  const i = focused !== null ? order.indexOf(focused) : -1;
  setFocus(order[(i + step + order.length) % order.length]);
}

function sendMacro(m: Macro) {
  // Macros are chat replies and slash commands: they only ever go to Claude panes (local or remote).
  const isChat = (p: Pane) => p.isAlive && (p.spec.kind === "claude" || !!p.spec.remoteCmd);
  const fp = focused !== null ? panes.get(focused) : undefined;
  const targets = m.target === "all" ? [...panes.values()].filter(isChat) : fp && isChat(fp) ? [fp] : [];
  for (const p of targets) {
    if (m.text) p.send(m.text);
    // A short gap so Claude sees typing, then Enter, rather than one pasted blob it won't submit.
    if (m.enter) setTimeout(() => p.send("\r"), m.text ? 60 : 0);
  }
}

const ACTIONS_RUN: Record<string, (fp: Pane | undefined) => void> = {
  "pane.newClaude": () => addPane({ kind: "claude" }),
  "pane.newShell": () => addPane({ kind: "shell" }),
  "pane.duplicate": (fp) =>
    fp && addPane({ kind: fp.spec.kind, cwd: fp.spec.cwd, host: fp.spec.host, hostLabel: fp.spec.hostLabel, remoteCmd: fp.spec.remoteCmd }),
  "pane.splitRight": (fp) => addPane({ kind: "claude" }, fp?.spec.id ?? null, "right"),
  "pane.splitDown": (fp) => addPane({ kind: "claude" }, fp?.spec.id ?? null, "bottom"),
  "pane.close": (fp) => fp && closePane(fp.spec.id),
  "pane.park": (fp) => fp && park(fp.spec.id),
  "shelf.parkIdle": () => {
    // Park every chat that has sat idle past the threshold (not the one you're looking at).
    for (const id of paneIds()) {
      const p = panes.get(id)!;
      if (id !== focused && p.spec.kind === "claude" && p.status === "idle" && !p.attention && Date.now() - p.statusSince > IDLE_PARK_MS) park(id);
    }
  },
  "shelf.back": () => {
    const it = attentionShelf()[0] ?? shelfItems[shelfItems.length - 1];
    if (it) unpark(it);
  },
  "pane.zoom": () => toggleZoom(),
  "pane.rename": (fp) => fp?.startRename(),
  "pane.color": (fp) => fp && rename(fp),
  "pane.restart": (fp) => fp && fp.restart(),
  "pane.find": (fp) => fp?.openSearch(),
  "attn.next": () => jumpToNext(),
  "attn.clear": () => {
    for (const p of panes.values()) p.setAttention(false);
    updateChrome();
  },
  "focus.next": () => cycleFocus(1),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`focus.${n}`, () => {
      const id = paneIds()[n - 1];
      if (id !== undefined) setFocus(id);
    }]),
  ),
  "focus.last": () => {
    const order = paneIds();
    if (order.length) setFocus(order[order.length - 1]);
  },
  "window.fullscreen": async () => {
    const fs = await win.isFullscreen().catch(() => false);
    win.setFullscreen(!fs).catch(() => {});
  },
  "open.palette": () => openCommandPalette(),
  "focus.prev": () => cycleFocus(-1),
  "focus.left": () => moveFocus("ArrowLeft"),
  "focus.right": () => moveFocus("ArrowRight"),
  "focus.up": () => moveFocus("ArrowUp"),
  "focus.down": () => moveFocus("ArrowDown"),
  "layout.columns": () => applyPreset("columns"),
  "layout.rows": () => applyPreset("rows"),
  "layout.grid": () => applyPreset("grid"),
  "layout.main": () => applyPreset("main"),
  "layout.balance": () => {
    root = L.balance(root);
    relayout();
    save();
  },
  "text.bigger": (fp) => fp?.setZoom(fp.spec.zoom + 1),
  "text.smaller": (fp) => fp?.setZoom(fp.spec.zoom - 1),
  "text.reset": (fp) => fp?.setZoom(DEFAULT_ZOOM),
  "text.resetAll": () => {
    for (const p of panes.values()) p.setZoom(DEFAULT_ZOOM);
  },
  "open.sessions": () => openSessions(),
  "open.remote": () => openHosts(),
  "open.keys": () => openKeys(),
  "open.theme": () => openThemes(),
  "usage.refresh": () => status.onRefresh(),
  "app.copyOnSelect": () => {
    paneOptions.copyOnSelect = !paneOptions.copyOnSelect;
    save();
    status.flash(`copy on select ${paneOptions.copyOnSelect ? "on" : "off"}`);
  },
  "app.homeHere": (fp) => {
    if (!fp || fp.spec.kind === "ssh") return status.flash("focus a local chat or shell first");
    homeCwd = fp.spec.cwd;
    save();
    status.flash(`new chats start in ${homeCwd}`);
  },
  "app.update": () => applyUpdate(),
  "app.checkUpdate": async () => {
    const u = await checkUpdate(true);
    status.flash(!u ? "couldn't check for updates" : u.available ? `update ${u.latest} ready: click ↑ in the title bar` : `switchboard ${u.current} is up to date`);
  },
};

function moveFocus(dir: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") {
  const n = neighbor(dir);
  if (n !== null) setFocus(n);
}

function openCommandPalette() {
  const keyOf = new Map<string, string>();
  for (const b of effectiveBindings(keyCfg)) if (b.keys[0]) keyOf.set(b.id, b.keys[0]);
  const fp = () => (focused !== null ? panes.get(focused) : undefined);
  const items: PaletteItem[] = [];
  // Panes first: "go to" is the most common thing to type.
  paneIds().forEach((id, i) => {
    const p = panes.get(id)!;
    items.push({
      group: "Pane",
      label: p.label(),
      hint: `${i + 1} · ${p.attention ? "needs you" : p.status}`,
      keys: i < 8 ? keyOf.get(`focus.${i + 1}`) : undefined,
      run: () => setFocus(id),
    });
  });
  for (const a of ACTIONS) {
    if (a.id.startsWith("focus.") && /^\d$|^last$/.test(a.id.slice(6))) continue;
    if (a.id === "open.palette") continue;
    items.push({ group: a.group, label: a.label, keys: keyOf.get(a.id), run: () => ACTIONS_RUN[a.id]?.(fp()) });
  }
  for (const m of keyCfg.macros)
    items.push({ group: "Send", label: m.label, hint: m.target === "all" ? "every chat" : "this chat", keys: m.keys || undefined, run: () => sendMacro(m) });
  for (const it of shelfItems)
    items.push({ group: "Shelf", label: it.title, hint: it.note ?? (it.mode === "running" ? "running" : "saved"), run: () => unpark(it) });
  for (const t of THEMES) items.push({ group: "Theme", label: t.name, hint: t.id === theme().id ? "current" : undefined, run: () => setTheme(t) });
  openPalette(items, async () => {
    const liveIds = new Set(live.map((l) => l.sessionId));
    // Dev builds can hide history (window.__sbHideRecent) so screen recordings show no real chats.
    const hide = import.meta.env.DEV && (window as unknown as { __sbHideRecent?: boolean }).__sbHideRecent;
    const recent = hide
      ? []
      : await invoke<{ sessionId: string; cwd: string; title: string }[]>("list_recent", { limit: 40 }).catch(
          (): { sessionId: string; cwd: string; title: string }[] => [],
        );
    return recent
      .filter((r) => !liveIds.has(r.sessionId))
      .map((r) => ({
        group: "Resume",
        label: r.title,
        hint: tildify(r.cwd),
        run: () => addPane({ kind: "claude", sessionId: r.sessionId, cwd: r.cwd || homeCwd }),
      }));
  });
}

function openKeys() {
  keysMenu({
    config: keyCfg,
    save: () => {
      rebuildKeys();
      save();
    },
    setCapturing: (on) => (capturing = on),
  });
}

window.addEventListener(
  "keydown",
  (e) => {
    if (capturing) return;
    if (e.key === "Escape" && overlayOpen()) {
      closeOverlay();
      e.preventDefault();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    const id = comboMap.get(combo);
    if (!id) return;
    // While a drawer is open, let typing and arrow keys reach its inputs.
    const inField = (e.target as HTMLElement | null)?.closest?.("input, textarea:not(.xterm-helper-textarea)");
    if (overlayOpen() && (inField || !id.startsWith("open."))) return;
    const fp = focused !== null ? panes.get(focused) : undefined;
    const macro = keyCfg.macros.find((x) => x.id === id);
    if (macro) sendMacro(macro);
    else ACTIONS_RUN[id]?.(fp);
    e.preventDefault();
    e.stopPropagation();
  },
  { capture: true },
);

// ctrl+shift+wheel: every pane at once (single-pane ctrl+wheel is handled inside the pane). Cmd too on a Mac.
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !(isMac && e.metaKey)) return;
    e.preventDefault();
    if (!e.shiftKey) return;
    const d = e.deltaY || e.deltaX;
    for (const p of panes.values()) p.setZoom(p.spec.zoom + (d < 0 ? 1 : -1));
  },
  { passive: false },
);

// ---------- drag to re-dock ----------
const dropMarker = h("div", { class: "drop-marker" });
type Zone = L.Side | "center";

function zoneFor(r: DOMRect, x: number, y: number): Zone {
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return "center";
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]) as L.Side;
}

function paneAt(x: number, y: number): Pane | null {
  const t = document.elementFromPoint(x, y)?.closest(".pane") as HTMLElement | null;
  return t ? panes.get(Number(t.dataset.id)) ?? null : null;
}

function showSlotMarker(slot: number) {
  const el = slots.get(slot);
  if (!el) return;
  const r = el.getBoundingClientRect();
  Object.assign(dropMarker.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  dropMarker.dataset.zone = "center";
  if (!dropMarker.isConnected) document.body.append(dropMarker);
}

function showMarker(target: Pane, zone: Zone) {
  const r = target.el.getBoundingClientRect();
  const m = { left: r.left, top: r.top, width: r.width, height: r.height };
  if (zone === "left" || zone === "right") m.width = r.width / 2;
  if (zone === "right") m.left = r.left + r.width / 2;
  if (zone === "top" || zone === "bottom") m.height = r.height / 2;
  if (zone === "bottom") m.top = r.top + r.height / 2;
  Object.assign(dropMarker.style, {
    left: `${m.left}px`,
    top: `${m.top}px`,
    width: `${m.width}px`,
    height: `${m.height}px`,
  });
  dropMarker.dataset.zone = zone;
  if (!dropMarker.isConnected) document.body.append(dropMarker);
}

function startDrag(p: Pane, e: PointerEvent) {
  setFocus(p.spec.id, false);
  if (zoomed !== null) return;
  const shelfEl = document.getElementById("shelf")!;
  let toShelf = false;
  let paneSlot: number | null = null;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let drop: { target: Pane; zone: Zone } | null = null;
  // No pointer capture until a real drag starts: capturing on press swallowed the second click of a
  // double-click, so double-click-to-rename never fired. Window listeners follow the pointer instead.

  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      dragging = true;
      document.body.classList.add("dragging");
      p.el.classList.add("drag-src");
      shelfEl.classList.add("droppable");
      ghost = h("div", { class: "drag-ghost", text: p.label() });
      document.body.append(ghost);
    }
    ghost!.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    const sr = shelfEl.getBoundingClientRect();
    toShelf = ev.clientY >= sr.top - 4;
    shelfEl.classList.toggle("over", toShelf);
    if (toShelf) {
      drop = null;
      dropMarker.remove();
      return;
    }
    paneSlot = slotAt(ev.clientX, ev.clientY);
    if (paneSlot !== null) {
      drop = null;
      showSlotMarker(paneSlot);
      return;
    }
    const t = paneAt(ev.clientX, ev.clientY);
    if (!t || t === p) {
      drop = null;
      dropMarker.remove();
      return;
    }
    const zone = zoneFor(t.el.getBoundingClientRect(), ev.clientX, ev.clientY);
    drop = { target: t, zone };
    showMarker(t, zone);
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", esc, true);
    cleanup();
    if (dragging && toShelf && ev.type === "pointerup") {
      park(p.spec.id);
      return;
    }
    if (dragging && paneSlot !== null && ev.type === "pointerup") {
      root = L.swap(L.removeLeaf(root, p.spec.id), paneSlot, p.spec.id);
      slots.delete(paneSlot);
      relayout();
      save();
      setFocus(p.spec.id);
      return;
    }
    if (dragging && drop && ev.type === "pointerup") {
      root =
        drop.zone === "center"
          ? L.swap(root, p.spec.id, drop.target.spec.id)
          : L.dock(root, p.spec.id, drop.target.spec.id, drop.zone);
      relayout();
      save();
    }
    setFocus(p.spec.id);
  };
  const cleanup = () => {
    document.body.classList.remove("dragging");
    shelfEl.classList.remove("droppable", "over");
    p.el.classList.remove("drag-src");
    ghost?.remove();
    dropMarker.remove();
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      drop = null;
      dragging = false;
      cleanup();
      ev.stopPropagation();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("keydown", esc, true);
}

// ---------- file drop: type the paths into the pane under the cursor ----------
getCurrentWebview()
  .onDragDropEvent((ev) => {
    const pl = ev.payload;
    if (pl.type === "over" || pl.type === "drop") {
      const s = window.devicePixelRatio || 1;
      const t = paneAt(pl.position.x / s, pl.position.y / s);
      if (pl.type === "over") {
        if (t) showMarker(t, "center");
        else dropMarker.remove();
        return;
      }
      dropMarker.remove();
      if (!t) return;
      const text = pl.paths.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
      t.term.paste(text + " ");
      setFocus(t.spec.id);
    } else dropMarker.remove();
  })
  .catch(() => {});

// ---------- close window: don't kill working chats by accident ----------
let closing = false;
win
  .onCloseRequested(async (e) => {
    if (closing) return;
    e.preventDefault();
    const busy = [...panes.values()].filter((p) => p.isAlive && p.status === "busy");
    if (busy.length && !(await confirmModal(`${busy.length} chat${busy.length > 1 ? "s are" : " is"} still working. Quit anyway?`, "Quit")))
      return;
    closing = true;
    await saveNow();
    await win.destroy();
  })
  .catch(() => {});

// `--diag` (CI live checks, tools/ci/mac_live.sh): every 2 s write each pane's size, renderer and screen
// text to diag.txt next to state.json, plus any script errors. There is no DevTools protocol on macOS.
const diagErrors: string[] = [];
invoke<string[]>("launch_args")
  .then((args) => {
    if (!args.includes("--diag")) return;
    window.addEventListener("error", (e) => diagErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => diagErrors.push(String(e.reason)));
    const gl = document.createElement("canvas").getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    const glInfo = gl ? `webgl2 ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}` : "no webgl2";
    setInterval(() => {
      const head = `${new Date().toISOString()} ${navigator.userAgent}\nwindow ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} focused=${focused} ${glInfo}`;
      const text = [head, ...[...panes.values()].map((p) => p.diag()), ...diagErrors.map((e) => `error: ${e}`)].join("\n");
      invoke("diag_write", { text }).catch(() => {});
    }, 2000);
  })
  .catch(() => {});

// Dev-only handle for driving the app over CDP in tests (tools/cdp.js eval 4831 ...).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sb = {
    panes,
    addPane,
    closePane,
    setFocus,
    applyPreset,
    toggleZoom,
    jumpToNext,
    releaseNotesModal,
    get root() {
      return root;
    },
    get focused() {
      return focused;
    },
  };
}

let homeDir = "";
/** Shorten a path under the home folder to ~ for hints. */
function tildify(p: string) {
  return homeDir && p.toLowerCase().startsWith(homeDir.toLowerCase()) ? "~" + p.slice(homeDir.length) : p;
}

// ---------- easy update ----------
// `npm run release` publishes a GitHub release with the installer + latest.json; we notice and offer it.
interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes?: ReleaseNote[];
}
let update: UpdateInfo | null = null;
let lastUpdateCheck = 0;
async function checkUpdate(force = false) {
  if (!force && Date.now() - lastUpdateCheck < 10 * 60_000) return update;
  lastUpdateCheck = Date.now();
  update = await invoke<UpdateInfo>("update_check").catch(() => null);
  if (update) wordmark.title = `Switchboard ${update.current}`;
  updateBtn.hidden = !update?.available;
  if (update?.available) {
    updateBtn.textContent = `↑ update ${update.latest}`;
    updateBtn.title = `Switchboard ${update.latest} is out (you have ${update.current}). Click for what's new; your chats resume after the restart.`;
  }
  return update;
}
async function applyUpdate() {
  const u = await checkUpdate(true);
  if (!u?.available) {
    status.flash(u ? `switchboard ${u.current} is the latest build` : "couldn't check for updates");
    return;
  }
  const busy = [...panes.values()].filter((p) => p.isAlive && p.status === "busy").length;
  if (!(await releaseNotesModal(u.current, u.latest, u.notes ?? [], busy))) return;
  const label = updateBtn.textContent;
  updateBtn.textContent = "downloading…";
  updateBtn.disabled = true;
  try {
    await invoke("update_apply");
  } catch (e) {
    updateBtn.textContent = label;
    updateBtn.disabled = false;
    status.flash(`update failed: ${e}`);
    return;
  }
  closing = true;
  await saveNow();
  await win.destroy();
}
updateBtn.addEventListener("click", () => applyUpdate());
setInterval(() => checkUpdate(), 60 * 60_000);
window.addEventListener("focus", () => checkUpdate());

// ---------- themes ----------
function setTheme(t: ReturnType<typeof findTheme>, persist = true) {
  applyTheme(t);
  wordmark.src = t.light ? wordmarkLight : wordmarkDark;
  for (const p of panes.values()) p.applyTheme(t);
  if (persist) save();
}

function openThemes() {
  const start = theme();
  let chosen = start;
  const list = h("div", { class: "list themes" });
  const rows: HTMLElement[] = [];
  THEMES.forEach((t) => {
    const sw = h("span", { class: "swatch-strip" });
    for (const c of [t.ui["--bg"], t.ui["--panel"], t.ui["--text"], t.ui["--key"], t.ui["--busy"], t.ui["--ok"], t.ui["--lamp"]]) {
      const d = h("span");
      d.style.background = c;
      sw.append(d);
    }
    const sample = h("span", { class: "theme-sample" });
    sample.style.background = t.ui["--panel"];
    sample.style.color = t.ui["--text"];
    sample.innerHTML = `<span style="color:${t.ui["--key"]}">week</span> <span style="color:${t.ui["--key"]}">████</span><span style="color:${t.ui["--empty"]}">░░░░</span> <span style="color:${t.ui["--busy"]}">⠹</span> <span style="color:${t.ui["--lamp"]}">◆</span>`;
    const row = h("button", { class: `item theme-row${t.id === start.id ? " on" : ""}` }, sw, h("span", { class: "item-main" }, h("span", { class: "item-title", text: t.name })), sample);
    row.addEventListener("mouseenter", () => setTheme(t, false));
    row.addEventListener("focus", () => setTheme(t, false));
    row.addEventListener("click", () => {
      chosen = t;
      setTheme(t);
      closeOverlay();
    });
    rows.push(row);
    list.append(row);
  });
  list.addEventListener("mouseleave", () => setTheme(chosen, false));
  const panel = h("div", { class: "modal" }, h("h3", { text: "theme" }), list, h("p", { class: "hint", text: "Hover or arrow to preview · Enter to keep · Esc to go back" }));
  panel.addEventListener("keydown", (e) => {
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[(i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length].focus();
    }
  });
  const scrim = mount(panel, "center");
  // Leaving without picking restores what was there.
  new MutationObserver((_, obs) => {
    if (!scrim.isConnected) {
      setTheme(chosen, false);
      obs.disconnect();
    }
  }).observe(document.body, { childList: true });
  rows[THEMES.indexOf(start)]?.focus();
}

// ---------- command line (Stream Deck / Start Menu) ----------
// switchboard.exe --new-claude [--continue] [--cwd DIR] | --shell [--cwd DIR]
async function handleArgs(args: string[]) {
  const has = (f: string) => args.includes(f);
  const at = args.indexOf("--cwd");
  const cwd = at >= 0 && args[at + 1] ? args[at + 1] : homeCwd;
  if (has("--shell")) {
    addPane({ kind: "shell", cwd });
  } else if (has("--new-claude")) {
    if (has("--continue")) {
      // The latest chat in that folder that isn't already open somewhere.
      const recent = await invoke<{ sessionId: string; cwd: string }[]>("list_recent", { limit: 40 }).catch(() => []);
      const liveIds = new Set(live.map((l) => l.sessionId));
      const pick = recent.find((r) => r.cwd.toLowerCase() === cwd.toLowerCase() && !liveIds.has(r.sessionId));
      addPane(pick ? { kind: "claude", cwd, sessionId: pick.sessionId } : { kind: "claude", cwd });
    } else addPane({ kind: "claude", cwd });
  }
}
listen<string[]>("cli", (e) => handleArgs(e.payload));

// ---------- boot ----------
async function boot() {
  const args0 = await invoke<string[]>("launch_args").catch((): string[] => []);
  const r = args0.indexOf("--renderer");
  if (r >= 0 && ["dom", "webgl"].includes(args0[r + 1])) renderOpts.webgl = args0[r + 1] === "webgl";
  let saved: Saved | null = null;
  try {
    const raw = await invoke<string | null>("load_state");
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  // Default folder: the saved choice, else where the saved chats ran, else the home folder.
  homeDir = await invoke<string>("home_dir").catch(() => "");
  const used = new Map<string, number>();
  for (const sp of saved?.panes ?? []) if (sp.kind !== "ssh" && sp.cwd) used.set(sp.cwd, (used.get(sp.cwd) ?? 0) + 1);
  homeCwd = saved?.homeCwd || [...used].sort((a, b) => b[1] - a[1])[0]?.[0] || homeDir;
  paneOptions.copyOnSelect = saved?.copyOnSelect ?? true;
  if (saved?.v === 1) {
    remote.hosts = saved.hosts ?? [];
    remote.claudeCmd = saved.claudeCmd ?? {};
    if (saved.keys) {
      keyCfg.bindings = saved.keys.bindings ?? {};
      keyCfg.macros = saved.keys.macros ?? keyCfg.macros;
    }
  }
  rebuildKeys();
  setTheme(findTheme(saved?.theme ?? DEFAULT_THEME), false);
  const specs = saved?.panes ?? [];
  const ids = new Set(specs.map((s) => s.id));
  const tree = saved?.root && L.leaves(saved.root).every((id) => id < 0 || ids.has(id)) ? saved.root : null;
  nextSlot = Math.min(-1, ...L.leaves(tree).filter((id) => id < 0).map((id) => id - 1));
  const parked = (saved?.shelf ?? []).filter((it) => it.mode === "saved" || ids.has(it.id));
  shelfItems.push(...parked);
  nextId = Math.max(saved?.nextId ?? 1, ...specs.map((s) => s.id + 1), ...parked.map((it) => it.id + 1));
  if ((specs.length || parked.length) && (tree || parked.length)) {
    const inTree = new Set(L.leaves(tree));
    const running = new Set(parked.filter((it) => it.mode === "running").map((it) => it.id));
    for (const s of specs) {
      if (!inTree.has(s.id) && !running.has(s.id)) continue; // stale entry
      const p = makePane({ ...s, zoom: s.zoom || DEFAULT_ZOOM });
      if (running.has(s.id)) parking.append(p.el);
    }
    root = tree;
    relayout();
    // Start each after layout so the PTY opens at the pane's real size; claude panes resume their chat.
    await new Promise((r) => requestAnimationFrame(r));
    await Promise.all([...panes.values()].map((p) => p.start()));
    // Anything still running that this layout doesn't know about is an orphan from a reload.
    invoke("pty_prune", { keep: [...panes.keys()] }).catch(() => {});
    const leaves0 = paneIds();
    if (leaves0.length) setFocus(saved!.focused !== null && leaves0.includes(saved!.focused) ? saved!.focused : leaves0[0]);
  } else {
    const first = await invoke<string[]>("launch_args").catch((): string[] => []);
    if (!first.includes("--new-claude") && !first.includes("--shell")) addPane({ kind: "claude" }, null, "right");
  }
  await handleArgs(await invoke<string[]>("launch_args").catch((): string[] => []));
  shelf.render();
  updateChrome();
  checkUpdate(true);
}
setTimeout(() => win.show().catch(() => {}), 1500); // safety net if boot stalls
// The window starts hidden so it never flashes white; show it once the first frame is laid out.
boot()
  .catch((e) => console.error(e))
  .finally(() => requestAnimationFrame(() => win.show().then(() => win.setFocus()).catch(() => {})));

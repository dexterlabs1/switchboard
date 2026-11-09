import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { openUrl } from "./util";
import { theme, type Theme } from "./themes";
import { isMac, kb } from "./platform";

export type PaneKind = "claude" | "shell" | "ssh";
export type Status = "starting" | "busy" | "idle" | "waiting" | "exited" | "none";

/** What gets saved per pane. */
export interface PaneSpec {
  id: number;
  kind: PaneKind;
  cwd: string;
  sessionId?: string;
  host?: string;
  hostLabel?: string;
  remoteCmd?: string;
  zoom: number;
  name?: string;
  color?: string;
}

/** Mirrors sessions.rs LiveSession. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  entrypoint: string;
  status: string;
  statusUpdatedAt: number;
  paneId: number | null;
  title: string;
  model: string;
  effort: string;
  ctxTokens: number;
  lastText?: string;
  project?: string;
}

export interface PaneHooks {
  onFocus(p: Pane): void;
  onBell(p: Pane): void;
  onExit(p: Pane): void;
  onChange(): void; // something worth saving changed
  onDragStart(p: Pane, e: PointerEvent): void;
  onSplit(p: Pane, side: "right" | "bottom", kind: PaneKind): void;
  onClose(p: Pane): void;
  onPark(p: Pane): void;
  onRename(p: Pane): void;
  onTitle(p: Pane): void;
}

export const DEFAULT_ZOOM = 15;
/** App-wide pane options (set from saved state in main.ts). */
export const paneOptions = { copyOnSelect: true };
/** GPU (WebGL) text rendering. Off on macOS: in WKWebView on the CI Mac the WebGL canvas stayed blank
 *  while the buffer held the text (docs/gotchas.md). `--renderer dom|webgl` overrides it for a launch. */
export const renderOpts = { webgl: !isMac };
/** A chat idle this long gets a quiet "park?" hint in its header. */
export const IDLE_PARK_MS = 2 * 60 * 60 * 1000;
const FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, Monaco, monospace';

/** Status glyphs; busy panes get an animated braille spinner from the app's shared ticker. */
const GLYPH: Record<string, string> = { idle: "●", attn: "◆", waiting: "◆", exited: "×", starting: "○", none: "·" };
export const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Claude Code's spinner glyphs; a title starting with one of these means "working" (remote panes).
const SPINNER = /^[⠀-⣿·✢✳✶✻✽*]/;

const MODEL_NAMES: Record<string, string> = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
};
export function modelLabel(m: string): string {
  if (!m) return "";
  if (MODEL_NAMES[m]) return MODEL_NAMES[m];
  const g = /claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return g ? `${g[1][0].toUpperCase()}${g[1].slice(1)} ${g[2]}.${g[3]}` : m.replace(/^claude-/, "");
}

export function ago(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const ICON = {
  splitR: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>',
  splitD: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 8h13"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  park: '<svg viewBox="0 0 16 16"><path d="M8 3v7M5 7.5l3 3 3-3M3 13h10"/></svg>',
};

export class Pane {
  readonly el = el("div", "pane");
  readonly head = el("div", "pane-head");
  readonly body = el("div", "pane-body");
  /** xterm mounts here; padding lives on the body so FitAddon measures a padding-free parent. */
  private host = el("div", "term-host");
  readonly term: Terminal;
  private fit = new FitAddon();
  private search = new SearchAddon();
  private searchBox: HTMLDivElement | null = null;
  private titleEl = el("span", "title");
  private dot = el("span", "dot");
  private idxEl = el("span", "idx");
  private strip: HTMLDivElement | null = null;
  private sshInfo: { user: string; hostname: string } | null = null;
  private gotData = false;
  private kindEl = el("span", "kind");
  private chips = el("span", "chips");
  private timeEl = el("span", "since");
  private parkHint = el("button", "park-hint", "park?");
  private alive = false;
  private disposed = false;
  private resizeTimer = 0;

  status: Status = "none";
  renderer = "dom";
  /** Bytes of output received from the process (for the `--diag` report). */
  received = 0;
  attention = false;
  live: LiveSession | null = null;
  oscTitle = "";
  statusSince = Date.now();

  constructor(public spec: PaneSpec, private hooks: PaneHooks) {
    this.el.dataset.id = String(spec.id);
    this.buildHead();
    this.body.append(this.host);
    if (spec.kind === "ssh") {
      // Connection info lives in the header itself, right after the status dot.
      this.strip = el("div", "remote-strip");
      this.dot.after(this.strip);
      this.el.append(this.head, this.body);
      invoke<{ user: string; hostname: string }>("ssh_info", { host: spec.host })
        .then((i) => {
          this.sshInfo = i;
          this.refreshStrip();
        })
        .catch(() => {});
    } else this.el.append(this.head, this.body);

    this.term = new Terminal({
      fontFamily: FONT,
      fontSize: spec.zoom,
      lineHeight: 1.1,
      scrollback: 20000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: this.termTheme(theme()),
      ...(isMac ? { macOptionClickForcesSelection: true } : { windowsPty: { backend: "conpty", buildNumber: 26200 } }),
      rescaleOverlappingGlyphs: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
    this.term.open(this.host);
    if (renderOpts.webgl) try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        gl.dispose();
        this.renderer = "dom (webgl context lost)";
      });
      this.term.loadAddon(gl);
      this.renderer = "webgl";
    } catch (e) {
      this.renderer = `dom (${e})`; // DOM renderer fallback
    }

    this.term.onData((d) => this.write(d));
    this.term.onBinary((d) => this.write(d));
    this.term.onResize(({ cols, rows }) => {
      if (this.alive) invoke("pty_resize", { id: spec.id, cols, rows }).catch(() => {});
    });
    this.term.onBell(() => hooks.onBell(this));
    this.term.onTitleChange((t) => {
      this.oscTitle = t;
      hooks.onTitle(this);
      this.refreshHead();
    });
    this.term.textarea?.addEventListener("focus", () => hooks.onFocus(this));
    this.el.addEventListener("pointerdown", () => hooks.onFocus(this), true);
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));

    // ctrl+wheel zooms this pane, ctrl+shift+wheel is handled by the app (all panes). On a Mac also
    // cmd+wheel; a trackpad pinch arrives as ctrl+wheel.
    this.body.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !(isMac && e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) return; // bubbles to window via app handler
        const d = e.deltaY || e.deltaX;
        this.setZoom(this.spec.zoom + (d < 0 ? 1 : -1));
      },
      { capture: true, passive: false },
    );
    // Right click: copy if there's a selection, else paste (Windows Terminal behaviour).
    // Copy on select: when a mouse selection ends, copy it and leave it highlighted.
    this.host.addEventListener("mouseup", (e) => {
      if (e.button !== 0 || !paneOptions.copyOnSelect) return;
      setTimeout(() => {
        const s = this.term.hasSelection() ? this.term.getSelection() : "";
        if (s.trim()) invoke("clipboard_set", { text: s }).catch(() => {});
      }, 0);
    });
    this.body.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.term.hasSelection()) this.copySelection();
      else this.paste();
    });

    // Window drags and divider drags fire this every frame. Re-fitting each time resizes the PTY,
    // and Claude Code repaints its whole screen per resize (the flicker). Hold the terminal at its
    // current size while the drag is live and fit once it settles.
    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => requestAnimationFrame(() => this.refit()), 120);
    }).observe(this.host);
  }

  private buildHead() {
    const left = el("div", "head-left");
    left.append(this.idxEl, this.dot, this.kindEl, this.titleEl, this.chips, this.timeEl, this.parkHint);
    this.parkHint.title = "Idle for a while: park it on the shelf (it resumes when you bring it back)";
    this.parkHint.hidden = true;
    this.parkHint.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.parkHint.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hooks.onPark(this);
    });
    const right = el("div", "head-right");
    const btn = (html: string, tip: string, fn: (e: MouseEvent) => void) => {
      const b = el("button", "icon");
      b.innerHTML = html;
      b.title = tip;
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn(e);
      });
      right.append(b);
    };
    btn(ICON.splitR, "Split right: new Claude (shift-click: shell)", (e) =>
      this.hooks.onSplit(this, "right", e.shiftKey ? "shell" : "claude"),
    );
    btn(ICON.splitD, "Split down: new Claude (shift-click: shell)", (e) =>
      this.hooks.onSplit(this, "bottom", e.shiftKey ? "shell" : "claude"),
    );
    btn(ICON.park, kb("Park on the shelf (Ctrl+Shift+S): keeps running if busy, resumes later if idle"), () => this.hooks.onPark(this));
    btn(ICON.close, kb("Close pane (Ctrl+Shift+W)"), () => this.hooks.onClose(this));
    this.head.append(left, right);
    this.head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.hooks.onDragStart(this, e);
    });
    // Double-click anywhere on the name side of the header renames (not just on the text itself).
    left.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".park-hint, .title-edit")) return;
      e.stopPropagation();
      this.startRename();
    });
    this.refreshHead();
  }

  /** Best label for the pane: user name > Claude title > terminal title > kind. */
  label(): string {
    if (this.spec.name) return this.spec.name;
    if (this.live?.title) return this.live.title;
    if (this.oscTitle && this.spec.kind !== "claude") {
      const t = this.oscTitle.replace(SPINNER, "").trim();
      // PowerShell titles itself with its own exe path; that says nothing useful.
      if (!/(^|\\)(windows)?(powershell|pwsh|ssh)(\.exe)?$/i.test(t) && !(isMac && /^-?(zsh|bash|fish|sh)$/.test(t))) return t;
    }
    if (this.spec.kind === "claude") return this.live?.name || "Claude";
    if (this.spec.kind === "ssh") return this.spec.hostLabel || this.spec.host || "remote";
    return isMac ? "Shell" : "PowerShell";
  }

  refreshHead() {
    this.titleEl.textContent = this.label();
    this.titleEl.title = this.label() + (this.live ? `\n${this.live.cwd}\n${this.live.sessionId}` : "");
    const k = this.spec.kind;
    this.kindEl.textContent = k === "shell" ? (isMac ? "sh" : "ps") : "";
    this.kindEl.hidden = k !== "shell";
    this.el.classList.toggle("remote", k === "ssh");
    this.refreshStrip();
    const st = this.attention ? "attn" : this.status;
    this.dot.className = `dot ${st}`;
    if (st !== "busy") this.dot.textContent = GLYPH[st] ?? "·";
    this.dot.title = this.attention ? "Needs you" : this.status;
    this.el.classList.toggle("attn", this.attention);
    this.el.style.setProperty("--pane-color", this.spec.color || "transparent");
    this.el.classList.toggle("colored", !!this.spec.color);

    // model · effort · context, plain dim text like a TUI status field
    const bits: string[] = [];
    if (this.live) {
      if (this.live.project) bits.push(this.live.project);
      const m = modelLabel(this.live.model).toLowerCase();
      if (m) bits.push(m);
      if (this.live.effort) bits.push(this.live.effort);
      if (this.live.ctxTokens) bits.push(`${Math.round(this.live.ctxTokens / 1000)}k ctx`);
    }
    this.chips.textContent = bits.join(" · ");
    this.timeEl.textContent = this.status === "busy" || this.status === "idle" ? ago(this.statusSince) : "";
    this.parkHint.hidden = !(this.spec.kind === "claude" && this.status === "idle" && !this.attention && Date.now() - this.statusSince > IDLE_PARK_MS);
    if (this.live?.lastText) this.titleEl.title = `${this.label()}\n\nlast reply: ${this.live.lastText}`;
  }

  /** Rename in place: the title turns into a text field. Enter saves, Esc cancels, empty = automatic. */
  startRename() {
    if (this.head.querySelector(".title-edit")) return;
    const auto = this.spec.name ? "" : this.label();
    const input = el("input", "title-edit");
    input.value = this.spec.name ?? auto;
    input.placeholder = this.live?.title || "name this pane";
    input.spellcheck = false;
    this.titleEl.hidden = true;
    this.titleEl.after(input);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      if (commit) {
        const v = input.value.trim();
        // Leaving the automatic title untouched shouldn't freeze it into a fixed name.
        this.spec.name = v && v !== auto ? v : v === "" ? undefined : this.spec.name;
        this.hooks.onChange();
      }
      input.remove();
      this.titleEl.hidden = false;
      this.refreshHead();
      this.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  /** Position number shown in the header (Ctrl+1..9 jumps to it). */
  setIndex(n: number) {
    this.idxEl.textContent = n <= 9 ? String(n) : "";
    this.idxEl.title = n <= 8 ? kb(`Ctrl+${n}`) : n === 9 ? kb("Ctrl+9") : "";
  }

  /** The connection line under a remote pane's header: who, where, and whether it's up. */
  refreshStrip() {
    if (!this.strip) return;
    const host = this.spec.hostLabel || this.spec.host || "remote";
    const who = this.sshInfo?.user ? `${this.sshInfo.user}@${host}` : host;
    const addr = this.sshInfo?.hostname && this.sshInfo.hostname !== host ? this.sshInfo.hostname : "";
    const state = !this.alive ? "disconnected · enter reconnects" : this.gotData ? "connected" : "connecting…";
    const bits: (string | [string, string])[] = [["rs-arrow", "⇄"], ["rs-host", who]];
    if (addr) bits.push(addr);
    if (this.spec.remoteCmd) bits.push(this.spec.remoteCmd);
    bits.push(["rs-state", state]);
    this.strip.replaceChildren();
    bits.forEach((b, i) => {
      if (i > 1) this.strip!.append(el("span", "rs-sep", "·"));
      if (typeof b === "string") this.strip!.append(el("span", "", b));
      else this.strip!.append(el("span", b[0], b[1]));
    });
    this.strip.className = `remote-strip${!this.alive ? " off" : this.gotData ? "" : " connecting"}`;
    this.strip.title = `SSH session to ${this.spec.host}`;
  }

  /** Remote panes get their terminal background tinted toward the theme's remote colour. */
  termTheme(t: Theme) {
    return t.term;
  }

  applyTheme(t: Theme) {
    this.term.options.theme = this.termTheme(t);
  }

  setLive(live: LiveSession | null) {
    this.live = live;
    if (live && live.sessionId && this.spec.sessionId !== live.sessionId) {
      this.spec.sessionId = live.sessionId;
      if (live.cwd) this.spec.cwd = live.cwd;
      this.hooks.onChange();
    }
    this.refreshHead();
  }

  setStatus(s: Status, since?: number) {
    if (s !== this.status) {
      this.status = s;
      this.statusSince = since || Date.now();
    } else if (since) this.statusSince = since;
    this.refreshHead();
  }

  setAttention(a: boolean) {
    if (this.attention === a) return;
    this.attention = a;
    this.refreshHead();
  }

  setZoom(px: number) {
    const z = Math.max(8, Math.min(40, Math.round(px)));
    if (z === this.spec.zoom) return;
    this.spec.zoom = z;
    this.term.options.fontSize = z;
    this.refit();
    this.hooks.onChange();
  }

  refit() {
    if (this.disposed || !this.host.offsetWidth || !this.host.offsetHeight) return;
    try {
      this.fit.fit();
    } catch {
      /* not attached yet */
    }
  }

  focus() {
    this.term.focus();
  }

  /** A resize that lands while the process is still starting is dropped (no PTY yet); send the
   *  current size once it exists, or the program draws for a width the pane no longer has. */
  private syncSize(sent: { cols: number; rows: number }) {
    const { cols, rows } = this.term;
    if (cols !== sent.cols || rows !== sent.rows) invoke("pty_resize", { id: this.spec.id, cols, rows }).catch(() => {});
  }

  /** Re-attach to this pane's running process if there is one (webview reload), else spawn it. */
  async start() {
    this.refit();
    // One channel per call: when Rust drops an unused channel (attach found nothing), Tauri closes
    // it on this side too, so reusing it for the spawn would silently lose all output.
    const channel = () => {
      const ch = new Channel<{ t: "data"; d: string } | { t: "exit"; code: number }>();
      ch.onmessage = (m) => {
        if (m.t === "data") {
          this.received += m.d.length;
          this.term.write(m.d);
          if (!this.gotData) {
            this.gotData = true;
            this.refreshStrip();
          }
        } else this.exited(m.code);
      };
      return ch;
    };
    const size = { cols: this.term.cols, rows: this.term.rows };
    const replay = await invoke<string | null>("pty_attach", { id: this.spec.id, ...size, onEvent: channel() }).catch(() => null);
    if (replay !== null) {
      this.alive = true;
      this.gotData = replay.length > 0;
      this.term.write(replay);
      this.syncSize(size);
      this.refreshHead();
      return;
    }
    this.status = this.spec.kind === "claude" ? "starting" : "none";
    this.alive = true; // before the await, so an instant exit is still reported
    try {
      await invoke("pty_spawn", {
        id: this.spec.id,
        kind: this.spec.kind,
        cwd: this.spec.cwd,
        resume: this.spec.kind === "claude" ? this.spec.sessionId ?? null : null,
        host: this.spec.host ?? null,
        remoteCmd: this.spec.remoteCmd ?? null,
        ...size,
        onEvent: channel(),
      });
      this.syncSize(size);
    } catch (e) {
      this.term.write(`

[31mCould not start: ${e}[0m

`);
      this.alive = false;
    }
    this.refreshHead();
  }

  private exited(code: number) {
    if (!this.alive) return;
    this.alive = false;
    this.gotData = false;
    this.live = null;
    this.setStatus("exited");
    this.term.write(`\r\n\x1b[90m[exited ${code}] Enter restarts · ${kb("Ctrl+Shift+W")} closes\x1b[0m\r\n`);
    this.hooks.onExit(this);
  }

  /** Kill and start fresh (a Claude pane resumes its chat). */
  async restart() {
    if (this.alive) {
      this.alive = false;
      await invoke("pty_kill", { id: this.spec.id }).catch(() => {});
    }
    this.live = null;
    this.term.reset();
    this.start();
  }

  get isAlive() {
    return this.alive;
  }

  private write(d: string) {
    if (!this.alive) {
      if (d === "\r" && !this.disposed) {
        this.term.reset();
        this.start();
      }
      return;
    }
    invoke("pty_write", { id: this.spec.id, data: d }).catch(() => {});
  }

  /** Send raw input to the process (no paste wrapping). */
  send(d: string) {
    this.write(d);
  }

  copySelection() {
    const s = this.term.getSelection();
    if (s) invoke("clipboard_set", { text: s }).catch(() => {});
    this.term.clearSelection();
  }

  async paste() {
    // A local Claude pane reads images from the clipboard itself; its paste-image key is Alt+V on
    // Windows and Ctrl+V on macOS.
    if (this.spec.kind === "claude" && (await invoke<boolean>("clipboard_has_image").catch(() => false))) {
      this.write(isMac ? "\x16" : "\x1bv");
      return;
    }
    const text = await invoke<string | null>("clipboard_text").catch(() => null);
    if (text) this.term.paste(text);
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();
    if (isMac) {
      // Cmd is the app's (copy, paste, select all); Ctrl and Option keys belong to the terminal,
      // so Ctrl+C interrupts and Ctrl+V reaches Claude Code as its paste-image key.
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (k === "c") {
          e.preventDefault();
          if (this.term.hasSelection()) this.copySelection();
          return false;
        }
        if (k === "v") {
          e.preventDefault();
          this.paste();
          return false;
        }
        if (k === "a") {
          e.preventDefault();
          this.term.selectAll();
          return false;
        }
      }
      if (e.metaKey) return false; // never typed into the terminal; menu shortcuts still run
    } else if (e.ctrlKey && !e.altKey && k === "c" && this.term.hasSelection()) {
      e.preventDefault();
      this.copySelection();
      return false;
    }
    if (!isMac && e.ctrlKey && !e.altKey && k === "v") {
      e.preventDefault();
      this.paste();
      return false;
    }
    // Shift+Enter = newline in Claude's prompt (sent as Meta+Enter, which Claude reads as newline).
    if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === "Enter" && this.spec.kind !== "shell") {
      e.preventDefault();
      this.write("\x1b\r");
      return false;
    }
    return true;
  }

  openSearch() {
    if (this.searchBox) {
      this.searchBox.querySelector("input")?.focus();
      return;
    }
    const box = el("div", "searchbox");
    const input = el("input");
    input.placeholder = "Find in scrollback";
    const opts = {
      decorations: {
        matchBackground: "#5a4a2a",
        activeMatchBackground: "#d97757",
        matchOverviewRuler: "#e2b867",
        activeMatchColorOverviewRuler: "#d97757",
      },
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (e.shiftKey) this.search.findPrevious(input.value, opts);
        else this.search.findNext(input.value, opts);
      } else if (e.key === "Escape") this.closeSearch();
    });
    input.addEventListener("input", () => this.search.findNext(input.value, { ...opts, incremental: true }));
    box.append(input);
    this.body.append(box);
    this.searchBox = box;
    input.focus();
  }

  closeSearch() {
    this.search.clearDecorations();
    this.searchBox?.remove();
    this.searchBox = null;
    this.focus();
  }

  /** State for the `--diag` report (CI live checks): sizes, renderer, and the visible screen text. */
  diag(): string {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const host = this.host.getBoundingClientRect();
    const canvases = [...this.host.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`).join(",");
    return [
      `pane ${this.spec.id} ${this.spec.kind} alive=${this.alive} status=${this.status} renderer=${this.renderer} received=${this.received}`,
      `  host ${Math.round(host.width)}x${Math.round(host.height)} term ${this.term.cols}x${this.term.rows} font ${this.term.options.fontSize}px canvases [${canvases}] rows-dom=${this.host.querySelectorAll(".xterm-rows > div").length}`,
      ...lines.map((l) => `  | ${l}`),
    ].join("\n");
  }

  /** Remote/shell panes have no registry entry; infer Claude's state from its terminal title. */
  titleStatus(): Status | null {
    if (!this.oscTitle) return null;
    return SPINNER.test(this.oscTitle) && !/^✳/.test(this.oscTitle) ? "busy" : "idle";
  }

  dispose() {
    this.disposed = true;
    if (this.alive) invoke("pty_kill", { id: this.spec.id }).catch(() => {});
    this.alive = false;
    this.term.dispose();
    this.el.remove();
  }
}

// Overlays: sessions drawer, remote host picker, confirm modal, rename, help.
import { invoke } from "@tauri-apps/api/core";
import { ago, modelLabel, type LiveSession } from "./pane";
import { h } from "./util";

let current: HTMLElement | null = null;

export function closeOverlay() {
  current?.remove();
  current = null;
}
export function overlayOpen() {
  return !!current;
}

export function mount(panel: HTMLElement, cls: string): HTMLElement {
  closeOverlay();
  const scrim = h("div", { class: `scrim ${cls}` }, panel);
  scrim.addEventListener("pointerdown", (e) => {
    if (e.target === scrim) closeOverlay();
  });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeOverlay();
    }
  });
  document.body.append(scrim);
  current = scrim;
  return scrim;
}

export function confirmModal(message: string, okLabel = "Close anyway"): Promise<boolean> {
  return new Promise((resolve) => {
    const ok = h("button", { class: "btn danger", text: okLabel });
    const cancel = h("button", { class: "btn", text: "Cancel" });
    const panel = h("div", { class: "modal" }, h("p", { text: message }), h("div", { class: "row end" }, cancel, ok));
    mount(panel, "center");
    const done = (v: boolean) => {
      closeOverlay();
      resolve(v);
    };
    ok.addEventListener("click", () => done(true));
    cancel.addEventListener("click", () => done(false));
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    cancel.focus();
  });
}

const COLORS = ["", "#d97757", "#e2b867", "#8fbf6a", "#6cc0b8", "#6fa3d8", "#c493cf", "#e5675e"];

export function renameModal(
  name: string,
  color: string,
  placeholder: string,
  save: (name: string, color: string) => void,
) {
  const input = h("input", { value: name, placeholder });
  let picked = color;
  const swatches = h("div", { class: "swatches" });
  for (const c of COLORS) {
    const s = h("button", { class: `swatch${c === picked ? " on" : ""}`, title: c || "No color" });
    s.style.setProperty("--c", c || "transparent");
    if (!c) s.classList.add("none");
    s.addEventListener("click", () => {
      picked = c;
      swatches.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on"));
      s.classList.add("on");
    });
    swatches.append(s);
  }
  const ok = h("button", { class: "btn primary", text: "Save" });
  const panel = h(
    "div",
    { class: "modal" },
    h("label", { text: "Pane name (empty = automatic)" }),
    input,
    h("label", { text: "Color" }),
    swatches,
    h("div", { class: "row end" }, ok),
  );
  mount(panel, "center");
  const done = () => {
    save(input.value.trim(), picked);
    closeOverlay();
  };
  ok.addEventListener("click", done);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done();
  });
  input.focus();
  input.select();
}

interface Recent {
  sessionId: string;
  cwd: string;
  title: string;
  modifiedMs: number;
  project: string;
}

export function sessionsDrawer(
  live: LiveSession[],
  paneTitle: (paneId: number) => string,
  actions: { show(paneId: number): void; resume(sessionId: string, cwd: string): void; newClaude(): void },
) {
  const filter = h("input", { placeholder: "Filter sessions", class: "filter" });
  const liveList = h("div", { class: "list" });
  const recentList = h("div", { class: "list" });
  const liveIds = new Set(live.map((l) => l.sessionId));

  const renderLive = (q: string) => {
    liveList.replaceChildren();
    const rows = live.filter((l) => match(q, l.title, l.name, l.cwd));
    if (!rows.length) liveList.append(h("div", { class: "empty", text: "No running sessions" }));
    for (const l of rows) {
      const where =
        l.paneId !== null ? "in a pane" : l.entrypoint === "sdk-cli" ? "remote control (headless)" : "another terminal";
      const row = h(
        "button",
        { class: `item${l.paneId === null ? " muted" : ""}` },
        h("span", { class: `dot ${l.status}` }),
        h(
          "span",
          { class: "item-main" },
          h("span", { class: "item-title", text: l.paneId !== null ? paneTitle(l.paneId) : l.title || l.name }),
          h("span", { class: "item-sub", text: `${where} · ${modelLabel(l.model)} · ${l.status} ${ago(l.statusUpdatedAt)}` }),
        ),
      );
      if (l.paneId !== null) {
        const id = l.paneId;
        row.addEventListener("click", () => {
          closeOverlay();
          actions.show(id);
        });
      } else {
        row.disabled = true;
        row.title = "Running outside Switchboard. It can be resumed here once it ends.";
      }
      liveList.append(row);
    }
  };

  let recent: Recent[] = [];
  const renderRecent = (q: string) => {
    recentList.replaceChildren();
    const rows = recent.filter((r) => match(q, r.title, r.cwd, r.project));
    if (!rows.length) recentList.append(h("div", { class: "empty", text: recent.length ? "No match" : "Loading…" }));
    for (const r of rows.slice(0, 60)) {
      const running = liveIds.has(r.sessionId);
      const row = h(
        "button",
        { class: `item${running ? " muted" : ""}` },
        h(
          "span",
          { class: "item-main" },
          h("span", { class: "item-title", text: r.title }),
          h("span", { class: "item-sub", text: `${shortCwd(r.cwd || r.project)} · ${ago(r.modifiedMs)} ago${running ? " · running" : ""}` }),
        ),
      );
      if (running) {
        row.disabled = true;
        row.title = "Already running";
      } else
        row.addEventListener("click", () => {
          closeOverlay();
          actions.resume(r.sessionId, r.cwd);
        });
      recentList.append(row);
    }
  };

  const newBtn = h("button", { class: "btn primary", text: "New Claude chat" });
  newBtn.addEventListener("click", () => {
    closeOverlay();
    actions.newClaude();
  });
  const panel = h(
    "aside",
    { class: "drawer" },
    h("div", { class: "row" }, filter, newBtn),
    h("h3", { text: "Running" }),
    liveList,
    h("h3", { text: "Resume" }),
    recentList,
  );
  mount(panel, "right");
  filter.addEventListener("input", () => {
    renderLive(filter.value);
    renderRecent(filter.value);
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (panel.querySelector(".item:not([disabled])") as HTMLButtonElement | null)?.click();
  });
  renderLive("");
  renderRecent("");
  filter.focus();
  invoke<Recent[]>("list_recent", { limit: 80 }).then((r) => {
    recent = r;
    renderRecent(filter.value);
  });
}

export interface Host {
  target: string;
  label: string;
  source: string;
  os: string;
  online: boolean | null;
}

export function hostPicker(
  saved: { hosts: Host[]; claudeCmd: Record<string, string> },
  open: (host: Host, mode: "shell" | "claude", cmd: string) => void,
  persist: () => void,
) {
  const list = h("div", { class: "list" });
  const addInput = h("input", { placeholder: "Add host: user@name or IP (Enter)", class: "filter" });
  let found: Host[] = [];

  const draw = () => {
    list.replaceChildren();
    const seen = new Set<string>();
    const all = [...saved.hosts, ...found].filter((x) => (seen.has(x.target) ? false : (seen.add(x.target), true)));
    if (!all.length) list.append(h("div", { class: "empty", text: "Looking for hosts…" }));
    for (const host of all) {
      const cmd = h("input", {
        class: "cmd",
        value: saved.claudeCmd[host.target] ?? "claude",
        title: "Command that starts Claude on that machine",
      });
      cmd.addEventListener("change", () => {
        saved.claudeCmd[host.target] = cmd.value.trim() || "claude";
        persist();
      });
      const sh = h("button", { class: "btn", text: "Shell" });
      const cl = h("button", { class: "btn primary", text: "Claude" });
      sh.addEventListener("click", () => {
        closeOverlay();
        open(host, "shell", "");
      });
      cl.addEventListener("click", () => {
        closeOverlay();
        open(host, "claude", cmd.value.trim() || "claude");
      });
      const status = host.online === null ? "" : host.online ? "online" : "offline";
      const row = h(
        "div",
        { class: `host${host.online === false ? " muted" : ""}` },
        h("span", { class: `dot ${host.online ? "idle" : host.online === false ? "exited" : "none"}` }),
        h(
          "span",
          { class: "item-main" },
          h("span", { class: "item-title", text: host.label }),
          h("span", {
            class: "item-sub",
            text: [host.target !== host.label ? host.target : "", host.os, host.source === "manual" ? "added" : host.source, status]
              .filter(Boolean)
              .join(" · "),
          }),
        ),
        cmd,
        sh,
        cl,
      );
      if (host.source === "manual") {
        const rm = h("button", { class: "icon", title: "Forget host", text: "×" });
        rm.addEventListener("click", () => {
          saved.hosts = saved.hosts.filter((x) => x.target !== host.target);
          persist();
          draw();
        });
        row.append(rm);
      }
      list.append(row);
    }
  };

  addInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const t = addInput.value.trim();
    if (!/^[A-Za-z0-9@._:-]+$/.test(t)) return;
    saved.hosts.push({ target: t, label: t, source: "manual", os: "", online: null });
    addInput.value = "";
    persist();
    draw();
  });
  const panel = h(
    "aside",
    { class: "drawer wide" },
    h("h3", { text: "Remote machines (SSH)" }),
    h("p", {
      class: "hint",
      text: "Hosts from ~/.ssh/config and Tailscale. Needs SSH key login on the other machine. The text box is the command that starts Claude there.",
    }),
    addInput,
    list,
  );
  mount(panel, "right");
  addInput.focus();
  draw();
  invoke<Host[]>("list_hosts").then((r) => {
    found = r;
    draw();
  });
}

export function helpOverlay() {
  const keys: [string, string][] = [
    ["Ctrl+Shift+T", "New Claude pane"],
    ["Ctrl+Shift+N", "New PowerShell pane"],
    ["Ctrl+Shift+R", "Remote machine (SSH shell or Claude)"],
    ["Ctrl+Shift+O", "Sessions: running + resume past chats"],
    ["Ctrl+Shift+Space", "Jump to the next pane that needs you"],
    ["Ctrl+Shift+Enter", "Zoom pane to full window and back"],
    ["Ctrl+Shift+W", "Close pane"],
    ["Ctrl+Shift+F", "Find in scrollback"],
    ["Alt+Arrows", "Move focus between panes"],
    ["Ctrl+Scroll", "Text size of this pane"],
    ["Ctrl+Shift+Scroll", "Text size of every pane"],
    ["Ctrl+= / Ctrl+- / Ctrl+0", "Text size of this pane (bigger / smaller / reset)"],
    ["Ctrl+Alt+1…4", "Layout: columns / rows / grid / main + stack"],
    ["F2", "Rename / color the pane"],
    ["Ctrl+C", "Copy when text is selected, otherwise interrupt"],
    ["Ctrl+V / right-click", "Paste (screenshots go straight to Claude)"],
    ["Shift+Enter", "New line in Claude's prompt"],
    ["Drag a pane header", "Drop on an edge to dock there, on the middle to swap"],
    ["Drop files on a pane", "Types their paths"],
  ];
  const grid = h("div", { class: "keys" });
  for (const [k, d] of keys) grid.append(h("kbd", { text: k }), h("span", { text: d }));
  mount(h("div", { class: "modal help" }, h("h3", { text: "Shortcuts" }), grid), "center");
  (current?.querySelector(".modal") as HTMLElement | null)?.setAttribute("tabindex", "-1");
  (current?.querySelector(".modal") as HTMLElement | null)?.focus();
}

function match(q: string, ...fields: string[]) {
  if (!q) return true;
  const n = q.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(n));
}

function shortCwd(c: string) {
  return c.replace(/^C:\\dev\\?/i, "dev\\").replace(/^C--dev-?/, "dev ");
}

export interface ReleaseNote {
  version: string;
  date: string;
  items: string[];
}

/** The update window: what's new between your version and the new one, then later / restart & update. */
export function releaseNotesModal(current: string, latest: string, notes: ReleaseNote[], busy: number): Promise<boolean> {
  return new Promise((resolve) => {
    const fmtDate = (d: string) => {
      const t = Date.parse(d);
      return t ? new Date(t + 12 * 3600e3).toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase() : d;
    };
    const body = h("div", { class: "rn-body" });
    if (!notes.length) body.append(h("p", { class: "rn-empty", text: "No notes for this build." }));
    for (const n of notes) {
      const list = h("ul", { class: "rn-list" });
      for (const it of n.items) list.append(h("li", { text: it }));
      body.append(h("section", { class: "rn-ver" }, h("h4", {}, h("span", { class: "rn-v", text: n.version }), h("span", { class: "rn-d", text: fmtDate(n.date) })), list));
    }
    const later = h("button", { class: "btn", text: "later" });
    const go = h("button", { class: "btn primary", text: "restart & update  ⏎" });
    const warn = busy
      ? h("p", { class: "rn-warn", text: `${busy} chat${busy > 1 ? "s are" : " is"} still working and will be interrupted (they resume after the restart).` })
      : h("p", { class: "rn-ok", text: "Your layout and chats come back after the restart." });
    const panel = h(
      "div",
      { class: "modal release-notes" },
      h("div", { class: "rn-head" }, h("span", { class: "rn-title", text: "update ready" }), h("span", { class: "rn-from", text: `${current}  →  ${latest}` })),
      body,
      warn,
      h("div", { class: "row end" }, later, go),
    );
    mount(panel, "center");
    const done = (v: boolean) => {
      closeOverlay();
      resolve(v);
    };
    later.addEventListener("click", () => done(false));
    go.addEventListener("click", () => done(true));
    panel.tabIndex = -1;
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    go.focus();
  });
}

// The shelf: a bottom bar of parked chats. "running" items keep their process alive off-screen
// (a long agent run that doesn't need a pane); "saved" items were closed and resume on unpark.
import type { PaneSpec } from "./pane";
import { ago } from "./pane";
import { closeOverlay, mount } from "./ui";
import { h } from "./util";
import { isMac } from "./platform";

export interface Parked {
  id: number; // pane id
  mode: "running" | "saved";
  spec: PaneSpec; // for "saved"; for "running" the live Pane owns the spec
  title: string;
  parkedAt: number;
  remindAt?: number;
  due?: boolean;
  note?: string;
  project?: string;
  lastText?: string;
}

export interface ChipState {
  glyph: string; // status glyph
  cls: string; // busy | idle | attn | none
}

export interface ShelfHost {
  items: Parked[];
  /** Fresh project/last reply for a parked item (running ones update live). */
  info(item: Parked): { project?: string; lastText?: string };
  state(item: Parked): ChipState;
  unpark(item: Parked): void;
  startChipDrag(item: Parked, e: PointerEvent, chip: HTMLElement): void;
  closeKeepSaved(item: Parked): void;
  forget(item: Parked): void;
  changed(): void;
}

export class Shelf {
  readonly el: HTMLElement;
  constructor(private host: ShelfHost, el: HTMLElement) {
    this.el = el;
  }

  render() {
    const items = this.host.items;
    this.el.replaceChildren();
    this.el.classList.toggle("empty", items.length === 0);
    this.el.append(h("span", { class: "shelf-label", text: "shelf" }));
    if (!items.length) {
      this.el.append(h("span", { class: "shelf-hint", text: `park a chat here: drag its header down, ↓ in the header, or ${isMac ? "⇧⌘S" : "ctrl+shift+s"}` }));
      return;
    }
    // Group chips by project so a busy shelf stays readable; each project gets a stable colour.
    const groups = new Map<string, Parked[]>();
    for (const it of items) {
      const proj = this.host.info(it).project || "";
      groups.set(proj, [...(groups.get(proj) ?? []), it]);
    }
    const ordered = [...groups.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
    for (const [proj, list] of ordered) {
      if (groups.size > 1 || proj) {
        const tag = h("span", { class: "shelf-group", text: proj || "other" });
        tag.style.setProperty("--proj", projColor(proj));
        this.el.append(tag);
      }
      for (const it of list) this.el.append(this.chip(it, proj));
    }
  }

  private chip(it: Parked, proj: string): HTMLElement {
      const st = this.host.state(it);
      const chip = h(
        "button",
        { class: `chip-park ${st.cls}${it.due ? " due" : ""}${it.mode === "running" ? " running" : ""}` },
        h("span", { class: `dot ${st.cls}`, text: st.glyph }),
        h("span", { class: "chip-title", text: it.title }),
        h("span", { class: "chip-meta", text: it.remindAt && !it.due ? `⏰ ${until(it.remindAt)}` : ago(it.parkedAt) }),
      );
      chip.dataset.id = String(it.id);
      chip.addEventListener("pointerdown", (e) => {
        if (e.button === 0) this.host.startChipDrag(it, e, chip);
      });
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.hidePreview();
        this.menu(it, chip);
      });
      chip.style.setProperty("--proj", projColor(proj));
      chip.addEventListener("mouseenter", () => {
        clearTimeout(this.previewTimer);
        this.previewTimer = window.setTimeout(() => this.showPreview(it, chip), 280);
      });
      chip.addEventListener("mouseleave", () => this.hidePreview());
      chip.addEventListener("pointerdown", () => this.hidePreview());
      return chip;
  }

  private previewTimer = 0;
  private card: HTMLElement | null = null;

  /** Hover card: where the chat left off (Claude's last reply), project, note, how long it's been parked. */
  private showPreview(it: Parked, chip: HTMLElement) {
    this.hidePreview();
    const info = this.host.info(it);
    const st = this.host.state(it);
    const card = h(
      "div",
      { class: "preview-card" },
      h(
        "div",
        { class: "pc-head" },
        h("span", { class: `dot ${st.cls}`, text: st.glyph }),
        h("span", { class: "pc-title", text: it.title }),
      ),
      h(
        "div",
        { class: "pc-meta" },
        info.project ? h("span", { class: "pc-proj", text: info.project }) : null,
        h("span", { text: it.mode === "running" ? "running off-screen" : "closed · resumes on click" }),
        h("span", { text: ago(it.parkedAt) === "now" ? "parked just now" : `parked ${ago(it.parkedAt)} ago` }),
      ),
      it.note ? h("div", { class: "pc-note", text: `note: ${it.note}` }) : null,
      info.lastText ? h("div", { class: "pc-last" }, h("span", { class: "pc-label", text: "last reply" }), h("p", { text: info.lastText })) : h("div", { class: "pc-empty", text: "no reply yet" }),
      h("div", { class: "pc-hint", text: "click: bring back · drag onto a pane · right-click: snooze, note" }),
    );
    const pc = info.project ? projColor(info.project) : "var(--line-strong)";
    card.style.setProperty("--proj", pc);
    document.body.append(card);
    const r = chip.getBoundingClientRect();
    const w = card.offsetWidth;
    card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    card.style.bottom = `${innerHeight - r.top + 8}px`;
    this.card = card;
  }

  private hidePreview() {
    clearTimeout(this.previewTimer);
    this.card?.remove();
    this.card = null;
  }

  /** Update glyphs/classes without rebuilding (called on every status tick). */
  refresh() {
    for (const it of this.host.items) {
      const chip = this.el.querySelector<HTMLElement>(`.chip-park[data-id="${it.id}"]`);
      if (!chip) continue;
      const st = this.host.state(it);
      chip.className = `chip-park ${st.cls}${it.due ? " due" : ""}${it.mode === "running" ? " running" : ""}`;
      const dot = chip.querySelector(".dot")!;
      dot.className = `dot ${st.cls}`;
      if (st.cls !== "busy") dot.textContent = st.glyph;
    }
  }

  private menu(it: Parked, chip: HTMLElement) {
    const r = chip.getBoundingClientRect();
    const opt = (label: string, fn: () => void) => {
      const b = h("button", { class: "menu-item", text: label });
      b.addEventListener("click", () => {
        closeOverlay();
        fn();
      });
      return b;
    };
    const remind = (ms: number) => () => {
      it.remindAt = Date.now() + ms;
      it.due = false;
      this.host.changed();
    };
    const tomorrow9 = () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime() - Date.now();
    };
    const note = h("input", { class: "menu-note", value: it.note ?? "", placeholder: "note: why it's parked / next step" });
    note.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        it.note = note.value.trim() || undefined;
        this.host.changed();
        closeOverlay();
      }
    });
    const menu = h(
      "div",
      { class: "ctx-menu" },
      opt("bring back", () => this.host.unpark(it)),
      h("div", { class: "menu-sep", text: "remind me" }),
      opt("in 30 minutes", remind(30 * 60e3)),
      opt("in 1 hour", remind(60 * 60e3)),
      opt("in 3 hours", remind(3 * 60 * 60e3)),
      opt("tomorrow 9:00", () => remind(tomorrow9())()),
      it.remindAt ? opt("cancel reminder", () => ((it.remindAt = undefined), (it.due = false), this.host.changed())) : null,
      h("div", { class: "menu-sep", text: "note (enter saves)" }),
      note,
      h("div", { class: "menu-sep", text: "" }),
      it.mode === "running" ? opt("stop it, keep the chat saved", () => this.host.closeKeepSaved(it)) : null,
      opt("forget (chat stays in sessions)", () => this.host.forget(it)),
    );
    const scrim = mount(menu, "ctx");
    menu.style.left = `${Math.min(r.left, innerWidth - 280)}px`;
    menu.style.bottom = `${innerHeight - r.top + 6}px`;
    scrim.style.background = "transparent";
  }
}

const PROJ_COLORS = ["var(--key)", "var(--busy)", "var(--ok)", "var(--remote)", "#c493cf", "#e58f6a", "#6cc0b8", "#d6b36a"];
export function projColor(name: string): string {
  if (!name) return "var(--line-strong)";
  let x = 0;
  for (const c of name) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return PROJ_COLORS[x % PROJ_COLORS.length];
}

function until(t: number) {
  const s = Math.max(0, (t - Date.now()) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

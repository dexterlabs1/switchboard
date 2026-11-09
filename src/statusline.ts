// The status line under the title bar: plan usage as ASCII meters + chat counts.
import { h } from "./util";

export interface Limit {
  label: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string;
  active: boolean;
}
export interface Usage {
  ok: boolean;
  error: string;
  plan: string;
  limits: Limit[];
  fetchedAt: number;
}

const PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const WINDOW_MS: Record<string, number> = { weekly: 7 * 86400e3, session: 5 * 3600e3 };

function fmtReset(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const d = new Date(t);
  const day = d.toLocaleDateString(undefined, { weekday: "short" }).toLowerCase();
  let hr = d.getHours();
  const ap = hr >= 12 ? "p" : "a";
  hr = hr % 12 || 12;
  const mm = d.getMinutes().toString().padStart(2, "0");
  const left = Math.max(0, t - Date.now());
  const dd = Math.floor(left / 86400e3);
  const hh = Math.floor((left % 86400e3) / 3600e3);
  const mins = Math.floor((left % 3600e3) / 60e3);
  const rel = dd ? `${dd}d ${hh}h` : hh ? `${hh}h ${mins}m` : `${mins}m`;
  return `${day} ${hr}:${mm}${ap} · ${rel}`;
}

/** `▕████▍░░░│░░░▏` with a pace tick at the share of the window already elapsed. */
function meter(pct: number, pace: number | null, cells: number): HTMLElement {
  const bar = h("span", { class: "meter" });
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * cells;
  const full = Math.floor(filled);
  const part = Math.round((filled - full) * 8);
  const tick = pace === null ? -1 : Math.min(cells - 1, Math.floor(pace * cells));
  const lvl = pct >= 90 ? "hot" : pct >= 75 ? "warm" : "ok";
  bar.append(h("span", { class: "edge", text: "▕" }));
  for (let i = 0; i < cells; i++) {
    let ch = "░";
    let cls = "empty";
    if (i < full) {
      ch = "█";
      cls = lvl;
    } else if (i === full && part > 0) {
      ch = PARTIAL[part] || "█";
      cls = `${lvl} part`;
    }
    if (i === tick && cls === "empty") {
      ch = "│";
      cls = "tick";
    }
    bar.append(h("span", { class: cls, text: ch }));
  }
  bar.append(h("span", { class: "edge", text: "▏" }));
  return bar;
}

export class StatusLine {
  onRefresh: () => void = () => {};
  private usageEl = h("button", { class: "usage" });
  private countsEl = h("span", { class: "counts" });
  private planEl = h("span", { class: "plan" });
  private usage: Usage | null = null;

  constructor(host: HTMLElement) {
    host.append(this.usageEl, h("span", { class: "spacer" }), this.countsEl, this.planEl);
    this.usageEl.addEventListener("click", () => {
      this.usageEl.classList.add("refreshing");
      this.onRefresh();
    });
    // Reset countdowns tick once a minute.
    setInterval(() => this.render(), 60_000);
    window.addEventListener("resize", () => this.render());
  }

  /** Show a short message in the status line for a few seconds. */
  flash(text: string) {
    const msg = h("span", { class: "flash", text });
    this.countsEl.before(msg);
    setTimeout(() => msg.remove(), 4000);
  }

  setUsage(u: Usage) {
    this.usage = u;
    this.usageEl.classList.remove("refreshing");
    this.render();
  }

  setCounts(chats: number, busy: number, attention: number) {
    this.countsEl.replaceChildren();
    const part = (n: number, word: string, cls: string) =>
      h("span", { class: cls }, h("b", { text: String(n) }), ` ${word}`);
    this.countsEl.append(part(chats, chats === 1 ? "chat" : "chats", "c"));
    if (busy) this.countsEl.append(h("span", { class: "dot-sep", text: "·" }), part(busy, "working", "busy"));
    if (attention)
      this.countsEl.append(h("span", { class: "dot-sep", text: "·" }), part(attention, attention === 1 ? "needs you" : "need you", "attn"));
  }

  private render() {
    const u = this.usage;
    this.usageEl.replaceChildren();
    if (!u) {
      this.usageEl.append(h("span", { class: "dim", text: "usage …" }));
      return;
    }
    this.planEl.textContent = u.plan ? u.plan : "";
    if (!u.ok && !u.limits.length) {
      this.usageEl.append(h("span", { class: "dim", text: `usage: ${u.error}` }));
      this.usageEl.title = "Click to retry";
      return;
    }
    const shown = u.limits.filter((l) => l.active || l.percent > 0);
    const wide = window.innerWidth > 1100;
    shown.forEach((l, i) => {
      const t = Date.parse(l.resetsAt);
      const win = WINDOW_MS[l.group];
      const pace = t && win ? Math.min(1, Math.max(0, 1 - (t - Date.now()) / win)) : null;
      const first = i === 0;
      const seg = h(
        "span",
        { class: `seg ${l.severity !== "normal" ? "sev" : ""}` },
        h("span", { class: "lbl", text: l.label }),
        meter(l.percent, pace, first && wide ? 28 : 12),
        h("span", { class: "pct", text: `${Math.round(l.percent)}%` }),
      );
      if (first && l.resetsAt) seg.append(h("span", { class: "reset", text: `resets ${fmtReset(l.resetsAt)}` }));
      this.usageEl.append(seg);
    });
    if (!shown.length) this.usageEl.append(h("span", { class: "dim", text: "usage: no limits reported" }));
    if (u.error) this.usageEl.append(h("span", { class: "dim", text: `(${u.error})` }));
    const ago = Math.round((Date.now() - u.fetchedAt) / 60000);
    this.usageEl.title = `Plan usage (same numbers as /usage). │ marks an even pace through the window.\nUpdated ${ago ? `${ago} min ago` : "just now"} · click to refresh`;
  }
}

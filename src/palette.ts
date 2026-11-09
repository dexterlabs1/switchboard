// Command palette (Ctrl+Shift+P / F1): one searchable list of every action, macro, theme, pane,
// and recent chat, each showing its shortcut so the keys teach themselves.
import { keycaps } from "./keys";
import { closeOverlay, mount } from "./ui";
import { h } from "./util";

export interface PaletteItem {
  label: string;
  hint?: string; // dim text on the right (folder, "macro", ...)
  keys?: string;
  group: string;
  run(): void;
}

/** Subsequence match with bonuses for word starts and consecutive hits. -1 = no match. */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  let s = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q.toLowerCase()) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    s += 1;
    if (i === prev + 1) s += 3;
    if (i === 0 || " :/-_(".includes(t[i - 1])) s += 4;
    prev = i;
    ti = i + 1;
  }
  return s - t.length * 0.01;
}

export function openPalette(items: PaletteItem[], more?: () => Promise<PaletteItem[]>) {
  const input = h("input", { class: "pal-input", placeholder: "Type a command, a pane, a chat to resume…" });
  const list = h("div", { class: "pal-list" });
  let all = items;
  let shown: PaletteItem[] = [];
  let sel = 0;

  const draw = () => {
    const q = input.value.trim();
    shown = all
      .map((it) => ({ it, s: score(q, `${it.group}: ${it.label} ${it.hint ?? ""}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .slice(0, 60)
      .map((x) => x.it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren();
    shown.forEach((it, i) => {
      const row = h(
        "button",
        { class: `pal-row${i === sel ? " on" : ""}` },
        h("span", { class: "pal-group", text: it.group.toLowerCase() }),
        h("span", { class: "pal-label", text: it.label }),
        it.hint ? h("span", { class: "pal-hint", text: it.hint }) : null,
        it.keys ? keycaps(it.keys) : null,
      );
      row.addEventListener("mousemove", () => {
        if (sel !== i) {
          sel = i;
          mark();
        }
      });
      row.addEventListener("click", () => pick(i));
      list.append(row);
    });
    if (!shown.length) list.append(h("div", { class: "empty", text: "Nothing matches" }));
  };
  const mark = () => {
    list.querySelectorAll(".pal-row").forEach((r, i) => r.classList.toggle("on", i === sel));
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  };
  const pick = (i: number) => {
    const it = shown[i];
    if (!it) return;
    closeOverlay();
    it.run();
  };

  input.addEventListener("input", () => {
    sel = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(shown.length - 1, sel + 1);
      mark();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
      mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel);
    } else if (e.key === "Escape") closeOverlay();
  });
  mount(h("div", { class: "palette" }, input, list), "center pal-scrim");
  draw();
  input.focus();
  more?.().then((extra) => {
    all = [...all, ...extra];
    draw();
  });
}

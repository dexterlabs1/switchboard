// Themes drive both the chrome (CSS variables) and every terminal's palette.
import type { ITheme } from "@xterm/xterm";

export interface Theme {
  id: string;
  name: string;
  light?: boolean;
  ui: Record<string, string>;
  term: ITheme;
}

type Ui = {
  bg: string; panel: string; head: string; headFocus: string; line: string; lineStrong: string;
  text: string; bright: string; dim: string; faint: string; lamp: string; key: string;
  busy: string; ok: string; bad: string; sel: string; hover: string; empty: string; remote?: string;
};

function make(id: string, name: string, u: Ui, ansi: string[], light = false): Theme {
  const ui: Record<string, string> = {
    "--bg": u.bg, "--panel": u.panel, "--head": u.head, "--head-focus": u.headFocus, "--line": u.line,
    "--line-strong": u.lineStrong, "--text": u.text, "--bright": u.bright, "--dim": u.dim, "--faint": u.faint,
    "--lamp": u.lamp, "--key": u.key, "--busy": u.busy, "--ok": u.ok, "--bad": u.bad, "--sel": u.sel,
    "--hover": u.hover, "--empty": u.empty, "--remote": u.remote ?? u.key,
  };
  const [black, red, green, yellow, blue, magenta, cyan, white, bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = ansi;
  return {
    id,
    name,
    light,
    ui,
    term: {
      background: u.panel, foreground: u.text, cursor: u.lamp, cursorAccent: u.panel, selectionBackground: u.sel,
      black, red, green, yellow, blue, magenta, cyan, white,
      brightBlack: bBlack, brightRed: bRed, brightGreen: bGreen, brightYellow: bYellow,
      brightBlue: bBlue, brightMagenta: bMagenta, brightCyan: bCyan, brightWhite: bWhite,
      scrollbarSliderBackground: light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.10)",
      scrollbarSliderHoverBackground: light ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.18)",
      scrollbarSliderActiveBackground: light ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.26)",
    },
  };
}

export const THEMES: Theme[] = [
  make(
    "graphite",
    "graphite",
    { bg: "#111010", panel: "#191817", head: "#1d1c1a", headFocus: "#242220", line: "#2a2826", lineStrong: "#3d3a36", text: "#dedad3", bright: "#f5f3ef", dim: "#8d877f", faint: "#5f5a54", lamp: "#d97757", key: "#4fc1cf", busy: "#e2b867", ok: "#8fbf6a", bad: "#e5675e", sel: "#4a453f", hover: "#2c2a27", empty: "#34312d", remote: "#7fa8e8" },
    ["#191817", "#e5675e", "#8fbf6a", "#e2b867", "#6fa3d8", "#c493cf", "#6cc0b8", "#d6d2cb", "#6d6862", "#f08a80", "#a9d685", "#f0cd85", "#92bce6", "#d6aee0", "#8ad6ce", "#f5f3ef"],
  ),
  make(
    "ink",
    "ink (cool dark)",
    { bg: "#0b0d12", panel: "#11141b", head: "#151923", headFocus: "#1b2030", line: "#222838", lineStrong: "#343c52", text: "#d5dae6", bright: "#f2f5fb", dim: "#8690a8", faint: "#575f75", lamp: "#ff8a5c", key: "#7aa2f7", busy: "#e0af68", ok: "#9ece6a", bad: "#f7768e", sel: "#2e3650", hover: "#1e2433", empty: "#262d40", remote: "#d29bff" },
    ["#11141b", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5", "#565f89", "#ff8fa3", "#b5e48c", "#f2c97d", "#9ab8ff", "#cdb4ff", "#a3e1ff", "#e9edfb"],
  ),
  make(
    "phosphor",
    "phosphor (green crt)",
    { bg: "#050805", panel: "#0a0f0a", head: "#0d140d", headFocus: "#122012", line: "#183018", lineStrong: "#245024", text: "#7dff8a", bright: "#c8ffcc", dim: "#3fae4c", faint: "#2a6e32", lamp: "#ffb000", key: "#9dffb0", busy: "#d6ff6a", ok: "#7dff8a", bad: "#ff6a5a", sel: "#1d4a22", hover: "#132313", empty: "#143014", remote: "#5ad1ff" },
    ["#0a0f0a", "#ff6a5a", "#7dff8a", "#d6ff6a", "#5ad1ff", "#c48cff", "#6affd6", "#b6ffbe", "#2a6e32", "#ff8f82", "#a6ffb0", "#e6ff9a", "#8fe0ff", "#dab3ff", "#9fffe6", "#e6ffe8"],
  ),
  make(
    "amber",
    "amber (crt)",
    { bg: "#0b0700", panel: "#110b02", head: "#160f04", headFocus: "#1f1606", line: "#33240a", lineStrong: "#553c10", text: "#ffb43c", bright: "#ffd890", dim: "#b07a22", faint: "#6e4c14", lamp: "#ff5e3a", key: "#ffd26a", busy: "#ffe08a", ok: "#ffc45c", bad: "#ff5e3a", sel: "#4a330c", hover: "#21170a", empty: "#2b1f08", remote: "#9fd0ff" },
    ["#110b02", "#ff5e3a", "#ffc45c", "#ffe08a", "#ffb43c", "#ff9a5c", "#ffd26a", "#ffcf80", "#6e4c14", "#ff7f5e", "#ffd480", "#fff0b0", "#ffc870", "#ffb488", "#ffe29a", "#fff2d6"],
  ),
  make(
    "dusk",
    "dusk (plum)",
    { bg: "#120f14", panel: "#18141b", head: "#1d1821", headFocus: "#251f2b", line: "#2d2633", lineStrong: "#433a4c", text: "#e2dbe8", bright: "#f7f3fa", dim: "#958a9e", faint: "#645a6c", lamp: "#ff9e64", key: "#c3a6ff", busy: "#f0c674", ok: "#a8d58a", bad: "#ff7a90", sel: "#3f3548", hover: "#2a2330", empty: "#30293a", remote: "#7fc8ff" },
    ["#18141b", "#ff7a90", "#a8d58a", "#f0c674", "#8fb2ff", "#c3a6ff", "#8ad8d0", "#d9d0e0", "#645a6c", "#ff9aab", "#c0e6a6", "#f6d896", "#aac6ff", "#d8c4ff", "#a8e6e0", "#f7f3fa"],
  ),
  make(
    "paper",
    "paper (light)",
    { bg: "#ece8e1", panel: "#f7f4ee", head: "#efebe4", headFocus: "#e6e1d8", line: "#d9d3c8", lineStrong: "#c2baad", text: "#2b2723", bright: "#0f0d0b", dim: "#6f685f", faint: "#9a9287", lamp: "#c4532f", key: "#147a87", busy: "#a76d00", ok: "#3f7d20", bad: "#c23b30", sel: "#d8cfbf", hover: "#e2ddd3", empty: "#ddd6ca", remote: "#2a5ea8" },
    ["#2b2723", "#c23b30", "#3f7d20", "#a76d00", "#2a5ea8", "#8a3f9e", "#147a87", "#6f685f", "#5a534b", "#d9483c", "#4f9a2a", "#c78400", "#3b74c9", "#a654bd", "#1a95a5", "#2b2723"],
    true,
  ),
];

export const DEFAULT_THEME = "graphite";
let current: Theme = THEMES[0];

export function theme(): Theme {
  return current;
}

export function findTheme(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Apply to the chrome; the caller pushes `term` into each terminal. */
export function applyTheme(t: Theme) {
  current = t;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.ui)) root.style.setProperty(k, v);
  root.style.colorScheme = t.light ? "light" : "dark";
  root.dataset.theme = t.id;
}

/** Blend two #rrggbb colours (t = share of b). */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

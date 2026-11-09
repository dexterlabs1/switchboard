// The one place that knows which OS we run on. Shortcuts are written Windows-style in the code
// ("Ctrl+Shift+T"); on macOS the defaults move to Cmd (Ctrl stays with the terminal: Ctrl+C, Ctrl+R…)
// and keys are shown with the Mac symbols.

export const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Name of the plain shell a pane runs. */
export const shellName = isMac ? "shell" : "PowerShell";

/** Mac defaults that aren't a straight Ctrl→Cmd swap: the shortcuts Mac apps use for these. */
const MAC_DEFAULTS: Record<string, string> = {
  "Ctrl+Shift+T": "Cmd+T",
  "Ctrl+Shift+N": "Cmd+N",
  "Ctrl+Shift+W": "Cmd+W",
  "Ctrl+Shift+F": "Cmd+F",
  F11: "Ctrl+Cmd+F",
  // Cmd+Tab belongs to macOS; browsers use Ctrl+Tab on the Mac too.
  "Ctrl+Tab": "Ctrl+Tab",
  "Ctrl+Shift+Tab": "Ctrl+Shift+Tab",
};

/** A default binding for this platform. */
export function platformCombo(combo: string): string {
  if (!isMac) return combo;
  if (MAC_DEFAULTS[combo]) return MAC_DEFAULTS[combo];
  const parts = combo.split("+");
  const key = parts.pop()!;
  return [...parts.map((p) => (p === "Ctrl" ? "Cmd" : p)), key].join("+");
}

const MAC_GLYPH: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };

/** One modifier as shown on a keycap ("Cmd" → "⌘" on a Mac). */
export function modLabel(m: string): string {
  return isMac ? MAC_GLYPH[m] ?? m : m;
}

/** A shortcut as text for tooltips and hints: "Ctrl+Shift+T" here, "⌘T" on a Mac. Also takes
 *  free text with several combos ("Ctrl+= / Ctrl+-") and the "Ctrl+Scroll" style. */
export function kb(text: string): string {
  if (!isMac) return text;
  return text.replace(/\b((?:(?:Ctrl|Alt|Shift|Cmd)\+)+)([^\s/+()]+)/g, (_whole, mods: string, key: string) => {
    const parts = platformCombo(`${mods}${key}`).split("+");
    const k = parts.pop()!;
    const glyphs = ["Ctrl", "Alt", "Shift", "Cmd"].filter((m) => parts.includes(m)).map((m) => MAC_GLYPH[m]).join("");
    return `${glyphs}${k === "Scroll" ? " scroll" : k}`;
  });
}

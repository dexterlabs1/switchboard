// Layout = binary split tree. Leaves hold pane ids; splits hold a direction and the share of the
// first child. "h" = side by side, "v" = stacked. All tree operations are pure.

export type Node =
  | { t: "leaf"; id: number }
  | { t: "split"; dir: "h" | "v"; ratio: number; a: Node; b: Node };

export type Side = "left" | "right" | "top" | "bottom";

export function leaves(n: Node | null): number[] {
  if (!n) return [];
  return n.t === "leaf" ? [n.id] : [...leaves(n.a), ...leaves(n.b)];
}

export function removeLeaf(n: Node | null, id: number): Node | null {
  if (!n) return null;
  if (n.t === "leaf") return n.id === id ? null : n;
  const a = removeLeaf(n.a, id);
  const b = removeLeaf(n.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

/** Put `newId` beside `targetId` on `side`. With no target (empty tree) the new leaf is the root. */
export function splitAt(n: Node | null, targetId: number | null, newId: number, side: Side): Node {
  const leaf: Node = { t: "leaf", id: newId };
  if (!n) return leaf;
  if (targetId === null || !leaves(n).includes(targetId)) {
    return wrap({ t: "leaf", id: -1 }, leaf, side, n);
  }
  const go = (x: Node): Node => {
    if (x.t === "leaf") return x.id === targetId ? wrap(x, leaf, side) : x;
    return { ...x, a: go(x.a), b: go(x.b) };
  };
  return go(n);
}

function wrap(target: Node, leaf: Node, side: Side, whole?: Node): Node {
  const t = whole ?? target;
  const dir = side === "left" || side === "right" ? "h" : "v";
  const first = side === "left" || side === "top";
  return { t: "split", dir, ratio: 0.5, a: first ? leaf : t, b: first ? t : leaf };
}

export function swap(n: Node | null, x: number, y: number): Node | null {
  if (!n) return null;
  if (n.t === "leaf") return n.id === x ? { t: "leaf", id: y } : n.id === y ? { t: "leaf", id: x } : n;
  return { ...n, a: swap(n.a, x, y)!, b: swap(n.b, x, y)! };
}

/** Move `dragged` next to `target` on `side` (re-dock). */
export function dock(n: Node | null, dragged: number, target: number, side: Side): Node | null {
  if (dragged === target) return n;
  return splitAt(removeLeaf(n, dragged), target, dragged, side);
}

/** Even out every split (ratio 0.5). */
export function balance(n: Node | null): Node | null {
  if (!n || n.t === "leaf") return n;
  return { ...n, ratio: 0.5, a: balance(n.a)!, b: balance(n.b)! };
}

/** Preset layouts built from an ordered list of pane ids. */
export function preset(ids: number[], kind: "columns" | "rows" | "grid" | "main"): Node | null {
  if (!ids.length) return null;
  const chain = (xs: number[], dir: "h" | "v"): Node => {
    if (xs.length === 1) return { t: "leaf", id: xs[0] };
    return { t: "split", dir, ratio: 1 / xs.length, a: { t: "leaf", id: xs[0] }, b: chain(xs.slice(1), dir) };
  };
  if (kind === "columns") return chain(ids, "h");
  if (kind === "rows") return chain(ids, "v");
  if (kind === "main") {
    if (ids.length === 1) return chain(ids, "h");
    return { t: "split", dir: "h", ratio: 0.55, a: { t: "leaf", id: ids[0] }, b: chain(ids.slice(1), "v") };
  }
  // grid: rows of ceil(sqrt(n)) columns
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: number[][] = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(ids.slice(i, i + cols));
  const rowNodes = rows.map((r) => chain(r, "h"));
  const stack = (xs: Node[]): Node =>
    xs.length === 1 ? xs[0] : { t: "split", dir: "v", ratio: 1 / xs.length, a: xs[0], b: stack(xs.slice(1)) };
  return stack(rowNodes);
}

/**
 * Render the tree into `host`, re-using the persistent pane elements (moving an xterm element keeps
 * its terminal alive). `onChange` fires after a divider drag ends.
 */
export function render(
  root: Node | null,
  host: HTMLElement,
  paneEl: (id: number) => HTMLElement,
  onChange: (root: Node) => void,
) {
  host.replaceChildren();
  if (!root) return;
  const build = (n: Node): HTMLElement => {
    if (n.t === "leaf") return paneEl(n.id);
    const box = document.createElement("div");
    box.className = `split ${n.dir}`;
    const a = build(n.a);
    const b = build(n.b);
    const slotA = document.createElement("div");
    const slotB = document.createElement("div");
    slotA.className = slotB.className = "slot";
    slotA.append(a);
    slotB.append(b);
    const setRatio = (r: number) => {
      slotA.style.flex = `${r} 1 0`;
      slotB.style.flex = `${1 - r} 1 0`;
    };
    setRatio(n.ratio);
    const div = document.createElement("div");
    div.className = "divider";
    div.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      div.classList.add("active");
      const rect = box.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const r =
          n.dir === "h" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        n.ratio = Math.min(0.9, Math.max(0.1, r));
        setRatio(n.ratio);
      };
      const up = () => {
        div.classList.remove("active");
        div.removeEventListener("pointermove", move);
        div.removeEventListener("pointerup", up);
        onChange(root);
      };
      div.addEventListener("pointermove", move);
      div.addEventListener("pointerup", up);
    });
    // Double-click a divider to even the split.
    div.addEventListener("dblclick", () => {
      n.ratio = 0.5;
      setRatio(0.5);
      onChange(root);
    });
    box.append(slotA, div, slotB);
    return box;
  };
  host.append(build(root));
}

import { invoke } from "@tauri-apps/api/core";

export function openUrl(uri: string) {
  if (/^https?:\/\//i.test(uri)) invoke("open_url", { url: uri }).catch(() => {});
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

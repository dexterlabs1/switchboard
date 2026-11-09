// npm run app:dev — the dev build ("Switchboard Dev", own identifier and state). tauri.dev.conf.json
// replaces the window list, which would drop the macOS overlay title bar from tauri.macos.conf.json,
// so on a Mac a second config puts it back. Extra args pass through to `tauri dev`.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configs = ["src-tauri/tauri.dev.conf.json"];
if (process.platform === "darwin") configs.push("src-tauri/tauri.dev.macos.conf.json");
const args = ["tauri", "dev", ...configs.flatMap((c) => ["--config", c]), ...process.argv.slice(2)];
if (process.platform === "win32") spawnSync(process.execPath, [join(root, "tools", "fetch-conpty.mjs"), "--dev"], { cwd: root, stdio: "inherit" });
const r = spawnSync("npx", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);

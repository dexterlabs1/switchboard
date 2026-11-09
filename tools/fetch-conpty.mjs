// Fetch Microsoft's ConPTY (conpty.dll + OpenConsole.exe, MIT, Microsoft-signed) into src-tauri/conpty/.
// portable-pty loads a conpty.dll sitting next to the exe in preference to the one built into Windows. The
// built-in one swallows mouse-tracking requests (DECSET 1000/1006), so clicks in Claude Code never arrive;
// this is the same ConPTY Windows Terminal and VS Code ship. Pinned version + sha256, so builds are repeatable.
//   node tools/fetch-conpty.mjs           fetch if missing
//   node tools/fetch-conpty.mjs --dev     also copy next to target/debug/switchboard.exe (npm run app:dev does this)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.25.260930003";
const SHA256 = "02b07b349af66d801159bdf9e440d4a1ce78bb951f37fc8609731665afdae7ee";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "conpty");
const FILES = { "runtimes/win-x64/native/conpty.dll": "conpty.dll", "build/native/runtimes/x64/OpenConsole.exe": "OpenConsole.exe" };

if (process.platform !== "win32") process.exit(0);
const have = Object.values(FILES).every((f) => existsSync(join(out, f))) && existsSync(join(out, "VERSION")) &&
  readFileSync(join(out, "VERSION"), "utf8").trim() === VERSION;
if (!have) {
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/${VERSION}/microsoft.windows.console.conpty.${VERSION}.nupkg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`conpty: download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== SHA256) throw new Error(`conpty: checksum mismatch (${got})`);
  const tmp = mkdtempSync(join(tmpdir(), "conpty-"));
  const pkg = join(tmp, "conpty.zip");
  writeFileSync(pkg, buf);
  // Windows' own bsdtar reads zips; a Git Bash GNU tar on PATH would take "C:" for a remote host.
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", "conpty.zip", ...Object.keys(FILES)], { cwd: tmp });
  mkdirSync(out, { recursive: true });
  for (const [src, dst] of Object.entries(FILES)) copyFileSync(join(tmp, src), join(out, dst));
  writeFileSync(join(out, "VERSION"), VERSION + "\n");
  console.log(`conpty: ${VERSION} → ${out}`);
}
if (process.argv.includes("--dev")) {
  const dbg = join(root, "src-tauri", "target", "debug");
  mkdirSync(dbg, { recursive: true });
  for (const f of Object.values(FILES)) {
    try { copyFileSync(join(out, f), join(dbg, f)); } catch { /* in use by a running dev build: already there */ }
  }
}

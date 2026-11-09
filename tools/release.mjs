// npm run release — ship a new version: bump, build the installer, publish a GitHub release with the
// installer + latest.json. Every running Switchboard then shows "↑ update" with these notes.
//   npm run release              → 0.2.0 → 0.2.1
//   npm run release -- minor     → 0.2.1 → 0.3.0
//   npm run release -- --local   → build + latest.json only (bundle/nsis), nothing committed or published;
//                                  test it with SWITCHBOARD_UPDATE_DIR=<that folder>
// Write the user-facing notes under "## Unreleased" in CHANGELOG.md first. Needs `gh` signed in.
// The macOS build is not made here: publishing the release starts .github/workflows/release-mac.yml,
// which builds the universal .dmg + .app.tar.gz, uploads them and adds `platforms.darwin-universal`
// to this release's latest.json (Macs see the update once that is done, ~15 min later).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = "dexterlabs1/switchboard";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const local = args.includes("--local");
const part = args.includes("major") ? "major" : args.includes("minor") ? "minor" : "patch";
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: "inherit", ...opts });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();

const VERSION_FILES = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CHANGELOG.md"];
if (!local) {
  // The release must match committed source: only the changelog may be pending.
  const dirty = out("git status --porcelain")
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.endsWith("CHANGELOG.md"));
  if (dirty.length) throw new Error(`commit your changes first:\n${dirty.join("\n")}`);
  out("gh auth status");
}

const pkgPath = join(root, "package.json");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const next = part === "major" ? `${maj + 1}.0.0` : part === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = "[^"]+"/m, `version = "${next}"`));
console.log(`release: ${next} (${part}${local ? ", local" : ""})`);

// CHANGELOG.md: stamp "## Unreleased" with this version, open a fresh Unreleased section, and
// collect every version's notes for the app's update window.
const clPath = join(root, "CHANGELOG.md");
const today = new Date().toISOString().slice(0, 10);
let cl = readFileSync(clPath, "utf8");
if (!/^## Unreleased\s*$/m.test(cl)) throw new Error("CHANGELOG.md needs a '## Unreleased' section");
const unreleased = cl.split(/^## Unreleased\s*$/m)[1].split(/^## /m)[0].trim();
if (!unreleased) console.warn("release: warning: Unreleased has no notes");
cl = cl.replace(/^## Unreleased\s*$/m, ["## Unreleased", "", `## ${next} — ${today}`].join("\n"));
writeFileSync(clPath, cl);
// Walk the file line by line: "## x.y.z — date" starts a version, "- item" lines are its notes.
const changelog = [];
for (const raw of cl.split(/\r?\n/)) {
  const head = /^## (\d+\.\d+\.\d+) — (\S+)/.exec(raw);
  if (head) changelog.push({ version: head[1], date: head[2], items: [] });
  else if (raw.startsWith("## ")) changelog.push(null); // "Unreleased": skip its items
  else if (raw.startsWith("- ") && changelog.length && changelog[changelog.length - 1])
    changelog[changelog.length - 1].items.push(raw.slice(2).trim());
}
const notes = changelog.filter(Boolean);

sh("npm run tauri build");

const dir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `Switchboard_${next}_x64-setup.exe`;
const instPath = join(dir, installer);
if (!existsSync(instPath)) throw new Error(`installer not found: ${installer}`);
const sha256 = createHash("sha256").update(readFileSync(instPath)).digest("hex");
const url = `https://github.com/${REPO}/releases/download/v${next}/${installer}`;
// Top-level installer/url/sha256 = the Windows build (what 0.1.x/0.2.0 clients read). CI adds
// platforms["darwin-universal"] after the release is published.
const latest = {
  version: next,
  installer,
  url,
  sha256,
  bytes: statSync(instPath).size,
  builtAt: new Date().toISOString(),
  platforms: { "windows-x86_64": { installer, url, sha256 } },
  changelog: notes,
};
const latestPath = join(dir, "latest.json");
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");
console.log(`release: wrote ${latestPath}`);
if (local) process.exit(0);

sh(`git add ${VERSION_FILES.join(" ")}`);
sh(`git commit -m "Release ${next}"`);
sh(`git tag v${next}`);
sh(`git push origin HEAD v${next}`);
const notesFile = join(mkdtempSync(join(tmpdir(), "sb-release-")), "notes.md");
const mine = notes.find((n) => n.version === next)?.items ?? [];
writeFileSync(
  notesFile,
  [
    ...mine.map((i) => `- ${i}`),
    "",
    `**Download:** \`${installer}\` below (Windows 10/11, per-user, no admin).`,
    `macOS: \`Switchboard_${next}_universal.dmg\` (Apple Silicon and Intel) is added below a few minutes after this release appears.`,
    "Already installed? Switchboard offers this update itself.",
  ].join("\n"),
);
sh(`gh release create v${next} "${instPath}" "${latestPath}" --repo ${REPO} --title "Switchboard ${next}" --notes-file "${notesFile}"`);
console.log(`release: published https://github.com/${REPO}/releases/tag/v${next}`);

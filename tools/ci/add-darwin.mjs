// Add the macOS build to a release's latest.json (CI, after `npm run release` published it on Windows).
//   node tools/ci/add-darwin.mjs <latest.json> <Switchboard_x.y.z_universal.app.tar.gz> <tag>
// The top level stays the Windows build, which is all that 0.1.x/0.2.0 clients read.
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const REPO = "dexterlabs1/switchboard";
const [file, tar, tag] = process.argv.slice(2);
if (!file || !tar || !tag) throw new Error("usage: add-darwin.mjs <latest.json> <app.tar.gz> <tag>");
const latest = JSON.parse(readFileSync(file, "utf8"));
const version = tag.replace(/^v/, "");
if (latest.version !== version) throw new Error(`latest.json is for ${latest.version}, the release is ${version}`);
const installer = basename(tar);
if (!/^Switchboard_[\d.]+_universal\.app\.tar\.gz$/.test(installer)) throw new Error(`unexpected archive name ${installer}`);
const bytes = readFileSync(tar);
latest.platforms ??= {};
// Releases made before `platforms` existed: list the Windows build there too.
latest.platforms["windows-x86_64"] ??= { installer: latest.installer, url: latest.url, sha256: latest.sha256 };
latest.platforms["darwin-universal"] = {
  installer,
  url: `https://github.com/${REPO}/releases/download/${tag}/${installer}`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: statSync(tar).size,
};
writeFileSync(file, JSON.stringify(latest, null, 2) + "\n");
console.log(JSON.stringify(latest.platforms, null, 2));

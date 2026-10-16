// Emits build-manifest.json for one archived local build (VERSIONING.md §4.7).
//
//   node scripts/build-manifest.mjs <kind> <core> <buildId> <filename> <dir>
//
// `kind`: firefox | chromium | android. The remaining identity comes from Git
// and the environment; the toolchain entries are read here for consistency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [kind, core, buildIdValue, filename, dir] = process.argv.slice(2);
if (!kind || !core || !buildIdValue || !filename || !dir) {
  console.error("usage: build-manifest.mjs <kind> <core> <buildId> <filename> <dir>");
  process.exit(2);
}

const file = join(resolve(root, dir), filename.split("/").pop());
const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");

let commit = "no-git";
let dirty = false;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["diff", "--quiet", "--no-ext-diff"], { cwd: root });
  execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root });
} catch {
  dirty = true;
}

let patchDigest = "clean";
if (dirty) {
  try {
    const patch = execFileSync("git", ["diff", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const patchPath = join(resolve(root, dir), "source.patch");
    writeFileSync(patchPath, patch);
    patchDigest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
  } catch (error) {
    patchDigest = `unavailable (${String(error).slice(0, 80)})`;
  }
}

let java = "n/a";
if (kind === "android") {
  try { java = execFileSync("java", ["-version"], { encoding: "utf8" }).split("\n")[0].trim() || "n/a"; } catch { /* java absent */ }
}

const manifest = {
  product: "pboard",
  version: core,
  buildId: buildIdValue,
  utcTime: new Date().toISOString(),
  gitCommitSha: commit,
  dirty,
  sourcePatchDigest: patchDigest,
  target: {
    platform: { firefox: "firefox-extension", chromium: "chromium-extension", android: "android" }[kind] ?? kind,
    architecture: "universal",
    signing: kind === "android" ? "debug" : "unsigned"
  },
  toolchain: { node: process.version, ...(kind === "android" ? { java } : {}) },
  outputs: [{ filename, path: file, sha256 }]
};

const target = join(resolve(root, dir), "build-manifest.json");
if (existsSync(target)) {
  console.error(`build-manifest.mjs: refusing to overwrite ${target}`);
  process.exit(1);
}
writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");

// Version reference synchronization, implementing VERSIONING.md.
//
// VERSION is canonical ("X.Y.Z" or "X.Y.Z-dev"); this script derives and writes
// every platform reference from it. It never invents a version and never
// creates tags. `versionName` is the core `X.Y.Z` (the `-dev` marker is a
// build-channel flag, not part of the Android display version); `versionCode`
// follows scripts/version.mjs's documented adapter (core slot 999 stable).
// The local dev build ID/counter is applied by scripts/build-apk.mjs at build
// time and by the release pipeline at release time; this file never embeds it.
//
// Usage:
//   node scripts/sync-version.mjs                  sync from VERSION (no bump)
//   node scripts/sync-version.mjs X.Y.Z-dev        select a development core, then sync
//   node scripts/sync-version.mjs --next <kind>    select the next dev core (compat alias)
//   node scripts/sync-version.mjs --check          verify all references match (read-only)
//
// Synchronized files:
//   manifest.json, manifest.chromium.json  (Firefox/Chromium manifests)
//   package.json + package-lock.json       (npm version + lockfile)
//   apps/android/package.json              (Android npm package)
//   apps/android/android/app/build.gradle  (versionName + versionCode)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { androidVersionCode } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = resolve(root, "VERSION");

/** Canonical state from VERSION: core numbers plus the dev-selection flag. */
function readVersionState() {
  const text = readFileSync(versionFile, "utf8").trim();
  const stable = text.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const dev = text.match(/^(\d+)\.(\d+)\.(\d+)-dev$/);
  if (stable) return { core: [Number(stable[1]), Number(stable[2]), Number(stable[3])], dev: false };
  if (dev) return { core: [Number(dev[1]), Number(dev[2]), Number(dev[3])], dev: true };
  console.error(`VERSION must be X.Y.Z or X.Y.Z-dev; found: ${text}`);
  process.exit(1);
}

function coreText(state) {
  return state.core.join(".");
}

function compareCores(left, right) {
  const [lm, ln, lp] = left;
  const [rm, rn, rp] = right;
  return lm - rm || ln - rn || lp - rp;
}

/** The public display version for platform metadata: core minus the -dev flag. */
function displayVersion(state) {
  return coreText(state);
}

function bumpCore(core, kind) {
  const [major, minor, patch] = core;
  if (kind === "major") return [major + 1, 0, 0];
  if (kind === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

function writeVersionState(state) {
  writeFileSync(versionFile, `${coreText(state)}${state.dev ? "-dev" : ""}\n`);
}

/** Stable versionCode: core*1000 + 999 per the adapter. Refuses regressions. */
function stableVersionCode(core) {
  return androidVersionCode(`${core[0]}.${core[1]}.${core[2]}`);
}

/**
 * versionCode policy (contract §8):
 *  - stable selection/release set: versionCode = core*1000 + 999 (adopting the
 *    adapter value when it exceeds the file's current code, else refusing a
 *    regression);
 *  - dev-core selection: only versionName moves; the code stays untouched —
 *    dev builds stamp their slot at build time and restore it afterwards.
 */
function nextVersionCode(gradle, state) {
  const current = gradle.match(/versionCode\s+(\d+)/);
  if (!current) throw new Error("versionCode not found in apps/android/android/app/build.gradle");
  if (state.dev) return { code: Number(current[1]), bumped: false };
  const adapterCode = stableVersionCode(state.core);
  const monotonic = Number(current[1]) < adapterCode ? adapterCode : Number(current[1]);
  if (monotonic < Number(current[1])) {
    console.error(`Android versionCode regression refused: ${monotonic} < ${current[1]}`);
    process.exit(1);
  }
  return { code: monotonic, bumped: monotonic !== Number(current[1]) };
}

function writeJsonVersion(path, version) {
  const text = readFileSync(path, "utf8");
  const out = text.replace(/^(\s*"version"\s*):\s*"[^"]*"/m, `$1: "${version}"`);
  if (out === text) throw new Error(`Could not update the version in ${path}`);
  writeFileSync(path, out);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const nextIdx = args.indexOf("--next");
let explicit = null;
if (nextIdx !== -1) {
  const kind = args[nextIdx + 1];
  if (!["patch", "minor", "major"].includes(kind)) {
    console.error("--next must be patch, minor, or major");
    process.exit(2);
  }
  explicit = { kind };
} else if (args.length > 0 && !args.includes("--check")) {
  const target = args[0];
  if (!/^(\d+)\.(\d+)\.(\d+)-dev$/.test(target)) {
    console.error("argument must be X.Y.Z-dev (a development core selection)");
    process.exit(2);
  }
  explicit = { core: target.split("-")[0].split(".").map(Number) };
}

let state = readVersionState();
// The regression baseline is the *committed* VERSION (§3: Git is the source of
// truth for code identity), not the already-selected working state — a dev-core
// bump writes VERSION before the reference sync runs.
let previousCore = state.core;
try {
  const committed = execFileSync("git", ["show", "HEAD:VERSION"], { cwd: root, encoding: "utf8" }).trim();
  const committedDev = committed.match(/^(\d+)\.(\d+)\.(\d+)-dev$/);
  if (committedDev) previousCore = [Number(committedDev[1]), Number(committedDev[2]), Number(committedDev[3])];
  else if (/^\d+\.\d+\.\d+$/.test(committed)) previousCore = committed.split(".").map(Number);
} catch { /* no git or no VERSION at HEAD: keep the working state as the baseline */ }
if (explicit?.kind) {
  state = { core: bumpCore(state.core, explicit.kind), dev: true };
  if (!checkOnly) {
    writeVersionState(state);
    console.log(`development core selected: ${coreText(state)}-dev`);
  }
} else if (explicit?.core) {
  state = { core: explicit.core, dev: true };
  if (!checkOnly) {
    // Refuse a development core at or below the last selected core (§2.8, §9.6):
    // distributed test builds keep their upgrade ordering.
    if (compareCores(state.core, previousCore) <= 0) {
      console.error(`Refusing a development core that does not advance: ${previousCore.join(".")} → ${coreText(state)}`);
      process.exit(1);
    }
    writeVersionState(state);
    console.log(`development core selected: ${coreText(state)}-dev`);
  }
}

const version = displayVersion(state);

const targets = [
  resolve(root, "manifest.json"),
  resolve(root, "manifest.chromium.json"),
  resolve(root, "package.json"),
  resolve(root, "package-lock.json"),
  resolve(root, "apps/android/package.json")
];

let changed = [];
const note = (file) => changed.push(file);

for (const target of targets) {
  const rel = target.slice(root.length + 1);
  if (target.endsWith("package-lock.json")) {
    const lock = JSON.parse(readFileSync(target, "utf8"));
    if (lock.version !== version || lock.packages[""].version !== version) {
      if (!checkOnly) {
        lock.version = version;
        lock.packages[""].version = version;
        writeFileSync(target, JSON.stringify(lock, null, 2) + "\n");
        console.log(`wrote ${rel}`);
      }
      note(`${rel} (lockfile root/package version)`);
    }
    continue;
  }
  const json = JSON.parse(readFileSync(target, "utf8"));
  if (json.version !== version) {
    if (!checkOnly) {
      writeJsonVersion(target, version);
      console.log(`wrote ${rel}`);
    }
    note(rel);
  }
}

// Release-metadata assertion pins the expected display version.
{
  const rel = "tests/releaseMetadata.test.ts";
  const target = resolve(root, rel);
  const text = readFileSync(target, "utf8");
  if (!text.includes(`expect(packageMetadata.version).toBe("${version}");`)) {
    if (checkOnly) {
      changed.push(`${rel} (assertion pins a different version)`);
    } else {
      const updated = text.replace(
        /expect\(packageMetadata\.version\)\.toBe\("[\d.]+"\)/,
        `expect(packageMetadata.version).toBe("${version}")`
      );
      if (updated === text) throw new Error(`Could not update the version assertion in ${rel}`);
      writeFileSync(target, updated);
      console.log(`wrote ${rel}`);
    }
  }
}

// Android adapter: versionName = display version; versionCode per the adapter.
{
  const gradlePath = resolve(root, "apps/android/android/app/build.gradle");
  const gradle = readFileSync(gradlePath, "utf8");
  const nameMatch = gradle.match(/versionName\s+"([\d.]+)"/);
  const nameText = nameMatch?.[1];
  const { code, bumped } = nextVersionCode(gradle, state);
  const needsName = nameText !== version;
  if (needsName || bumped) {
    if (checkOnly) {
      changed.push(`apps/android/android/app/build.gradle (versionName ${version}, adapter versionCode ${code})`);
    } else {
      if (!bumped) {
        // Pure rename with no versionCode movement (dev-core selection before
        // any build): keep the file's existing code rather than consuming it.
        const existingCode = gradle.match(/versionCode\s+(\d+)/);
        const updated = gradle.replace(/^(\s*)versionName\s+"[\d.]+"/m, `$1versionName "${version}"`);
        writeFileSync(gradlePath, updated);
        changed.push(`apps/android/android/app/build.gradle (versionName ${version}, versionCode ${existingCode?.[1]})`);
      } else {
        const nameLine = gradle.replace(/^(\s*)versionName\s+"[\d.]+"/m, `$1versionName "${version}"`);
        const updated = nameLine.replace(/^(\s*)versionCode\s+\d+/m, `$1versionCode ${code}`);
        writeFileSync(gradlePath, updated);
        changed.push(`apps/android/android/app/build.gradle (versionName ${version}, versionCode ${code})`);
        console.log(`versionCode set to ${code} (adapter: core*1000 + 999 for stable)`);
      }
    }
  }
}

if (checkOnly) {
  if (changed.length) {
    console.error("Version references out of sync:");
    for (const file of changed) console.error(`  - ${file}`);
    process.exit(1);
  }
  console.log(`All version references match VERSION (${version})`);
  process.exit(0);
}

if (!changed.length) console.log(`Version already synchronized: ${version}`);
else console.log(`Synchronized to ${version}`);
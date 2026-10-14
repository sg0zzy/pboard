// Single source of truth for versioning: the root VERSION file.
//
//   node scripts/sync-version.mjs            apply VERSION to all manifests
//   node scripts/sync-version.mjs --check    exit 1 if any reference differs
//   node scripts/sync-version.mjs --next <patch|minor|major>
//                                            bump VERSION, then apply
//
// Synchronized files:
//   manifest.json, manifest.chromium.json  (Firefox/Chromium manifests)
//   package.json + package-lock.json       (npm version + lockfileVersion)
//   apps/android/package.json              (Android npm package)
//   apps/android/android/app/build.gradle  (versionName + versionCode)
//
// The Android versionCode is monotonically increasing; it is stored in the
// gradle file and never reset by version bumps (major/minor/patch).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = resolve(root, "VERSION");

function readVersion() {
  const text = readFileSync(versionFile, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(text)) {
    console.error(`VERSION must be MAJOR.MINOR.PATCH (e.g. 0.10.1); found: ${text}`);
    process.exit(1);
  }
  return text;
}

function bump(version, kind) {
  let [major, minor, patch] = version.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function nextAndroidVersionCode(gradle) {
  const match = gradle.match(/^(\s*)versionCode\s+(\d+)(\s*)$/m);
  if (!match) throw new Error("versionCode not found in apps/android/android/app/build.gradle");
  return `${match[1]}versionCode ${Number(match[2]) + 1}${match[3]}`;
}

function setGradleVersion(gradle, versionName, newVersionCodeLine) {
  let updated = gradle.replace(/^(\s*)versionName\s+"[\d.]+"/m, `$1versionName "${versionName}"`);
  if (!updated.includes(newVersionCodeLine.trim())) {
    updated = updated.replace(/^(\s*)versionCode\s+\d+/m, newVersionCodeLine.trimEnd());
  }
  return updated;
}

function writeJsonVersion(path, version) {
  const text = readFileSync(path, "utf8");
  // Replace only the top-level "version" value, preserving all other keys
  // and formatting so npm metadata stays untouched.
  const out = text.replace(/^(\s*"version"\s*):\s*"[^"]*"/m, `$1: "${version}"`);
  if (out === text) return false;
  writeFileSync(path, out);
  return true;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const nextIdx = args.indexOf("--next");
let nextKind = null;
if (nextIdx !== -1) {
  nextKind = args[nextIdx + 1];
  if (!["patch", "minor", "major"].includes(nextKind)) {
    console.error("--next must be patch, minor, or major");
    process.exit(1);
  }
}

let version = readVersion();
if (nextKind) {
  version = bump(version, nextKind);
  writeFileSync(versionFile, `${version}\n`);
  console.log(`VERSION bumped to ${version}`);
}

const targets = [
  { path: resolve(root, "manifest.json") },
  { path: resolve(root, "manifest.chromium.json") },
  { path: resolve(root, "package.json"), npm: true },
  { path: resolve(root, "package-lock.json"), lock: true },
  { path: resolve(root, "apps/android/package.json"), npm: true },
  { path: resolve(root, "tests/releaseMetadata.test.ts"), testAssertion: true },
];

let changed = [];
const note = (file) => changed.push(file);
for (const target of targets) {
  const rel = target.path.slice(root.length + 1);
  if (target.testAssertion) {
    // tests/releaseMetadata.test.ts pins the expected version in an assertion.
    const text = readFileSync(target.path, "utf8");
    if (text.includes(`expect(packageMetadata.version).toBe("${version}");`)) continue;
    if (!checkOnly) {
      const updated = text.replace(
        /expect\(packageMetadata\.version\)\.toBe\("[\d.]+"\)/,
        `expect(packageMetadata.version).toBe("${version}")`
      );
      if (updated === text) throw new Error(`Could not update version assertion in ${rel}`);
      writeFileSync(target.path, updated);
      console.log(`wrote ${rel}`);
    }
    note(rel);
    continue;
  }
  if (target.lock) {
    const lock = JSON.parse(readFileSync(target.path, "utf8"));
    const current = [lock.version, lock.packages[""].version];
    if (current.some((v) => v !== version)) {
      if (!checkOnly) {
        lock.version = version;
        lock.packages[""].version = version;
        writeFileSync(target.path, JSON.stringify(lock, null, 2) + "\n");
        console.log(`wrote ${rel}`);
      }
      note(`${rel} (lockfile root/package version)`);
    }
    continue;
  }
  const json = JSON.parse(readFileSync(target.path, "utf8"));
  if (json.version !== version) {
    if (!checkOnly) {
      writeJsonVersion(target.path, version);
      console.log(`wrote ${rel}`);
    }
    note(rel);
  }
}

// Android gradle: versionName = VERSION, versionCode = +1
const gradlePath = resolve(root, "apps/android/android/app/build.gradle");
const gradle = readFileSync(gradlePath, "utf8");
const versionCodeMatch = gradle.match(/versionCode\s+(\d+)/);
if (!versionCodeMatch) throw new Error("versionCode not found in build.gradle");
const newVersionCode = Number(versionCodeMatch[1]) + 1;
const versionNameMatch = gradle.match(/versionName\s+"([\d.]+)"/);
const needsGradleChange = versionNameMatch?.[1] !== version;
if (needsGradleChange) {
  if (checkOnly) {
    // Read-only mode: do not consume a versionCode bump.
    changed.push(`apps/android/android/app/build.gradle (versionName ${version}, currently ${versionNameMatch?.[1]})`);
  } else {
  const updated = setGradleVersion(
    gradle,
    version,
    nextAndroidVersionCode(gradle)
  );
  writeFileSync(gradlePath, updated);
  changed.push(`apps/android/android/app/build.gradle (versionName ${version}, versionCode ${newVersionCode})`);
  console.log(`versionCode incremented to ${newVersionCode}`);
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

if (!changed.length && !nextKind) {
  console.log(`Version already synchronized: ${version}`);
} else {
  console.log(`Synchronized to VERSION ${version}`);
}
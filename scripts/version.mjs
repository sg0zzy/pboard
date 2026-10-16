// Repository version helpers implementing VERSIONING.md.
//
// The canonical version file is VERSION. Two states:
//   "0.9.7"        stable core, no development build selected
//   "0.9.8-dev"    a development core has been explicitly selected
// The build system appends the local `-dev.N` counter and build identity at
// build time; version selection never embeds a build count (contract §3).
//
// CLI (wrapped by scripts/version.sh):
//   read          print the next build's version and identity as JSON
//   canonical     print the canonical version string the next build carries
//   bump patch|minor|major    select the next development core; no release
//   set X.Y.Z-dev             select a development core explicitly
//   next-dev                  allocate the next dev build number (atomic, local)
//   android-code              Android versionCode for the next dev build (§8)
//   --check                   all platform references match VERSION
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = resolve(root, "VERSION");
const buildStateDir = resolve(root, ".build-state");

function readVersionState() {
  const text = readFileSync(versionFile, "utf8").trim();
  const stable = text.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const dev = text.match(/^(\d+)\.(\d+)\.(\d+)-dev$/);
  if (stable) {
    return { core: { major: Number(stable[1]), minor: Number(stable[2]), patch: Number(stable[3]) }, dev: false };
  }
  if (dev) {
    return { core: { major: Number(dev[1]), minor: Number(dev[2]), patch: Number(dev[3]) }, dev: true };
  }
  throw new Error(`VERSION must be X.Y.Z or X.Y.Z-dev; found: ${text}`);
}

/** Full build version `X.Y.Z-dev.N`; `X.Y.Z` when no dev core is selected. */
export function currentBuildVersion() {
  const state = readVersionState();
  if (!state.dev) return { version: coreText(state), isDev: false, state };
  const counter = localCounter(state);
  return { version: `${coreText(state)}-dev.${counter.n}`, isDev: true, state };
}

/** Like `currentBuildVersion` but without consuming a counter slot (display only). */
export function previewBuildVersion() {
  const state = readVersionState();
  if (!state.dev) return `stable ${coreText(state)} (no development core selected)`;
  return `${coreText(state)}-dev.N (N allocated per build)`;
}

function coreText(state) {
  return `${state.core.major}.${state.core.minor}.${state.core.patch}`;
}

// ---------------------------------------------------------------------------
// Local dev counter: gitignored state directory, atomic locked increment.
// One workstation's counter is local identity only (contract §4.3): CI and
// other machines have their own counters; build IDs distinguish artifacts and
// dev.N is never claimed globally unique. The counter resets when the core
// changes (§4.4, §5).
// ---------------------------------------------------------------------------

/** Test seam: inject a counter instead of touching disk. */
export function overrideCounter(counter) {
  overridden = counter;
}
let overridden = null;

function localCounter(state) {
  if (overridden) return overridden;
  return allocateCounter(state);
}

function counterPath() {
  return resolve(buildStateDir, "dev-counter.json");
}

function sleepSync(ms) {
  // Real blocking sleep via the event loop being empty at module scope isn't
  // available synchronously; ExecSync of a short child sleep is portable and
  // cheap enough relative to the 5s lock timeout.
  execFileSync("sleep", [String(ms / 1000)]);
}

function allocateCounter(state) {
  const core = coreText(state);
  mkdirSync(buildStateDir, { recursive: true });
  const lockDir = resolve(buildStateDir, "dev-counter.lock");
  const started = Date.now();
  // mkdir is atomic O_EXCL: a locked loop blocks concurrent invocations.
  while (true) {
    try { mkdirSync(lockDir); break; }
    catch {
      if (Date.now() - started > 5_000) {
        throw new Error("dev-counter lock timeout; remove .build-state/dev-counter.lock if no other build is running");
      }
      sleepSync(50);
    }
  }
  try {
    const path = counterPath();
    let counter = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { core, n: 0 };
    if (counter.core !== core) counter = { core, n: 0 };
    counter.n += 1;
    const temp = resolve(buildStateDir, `dev-counter.json.tmp-${process.pid}`);
    writeFileSync(temp, JSON.stringify(counter));
    renameSync(temp, path);
    return counter;
  } finally {
    rmSync(lockDir, { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Git identity: HEAD SHA and whether the worktree carries uncommitted changes.
// ---------------------------------------------------------------------------

export function gitIdentity() {
  let sha = "no-git";
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* no git */ }
  let dirty = false;
  try {
    execFileSync("git", ["diff", "--quiet", "--no-ext-diff"], { cwd: root });
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root });
  } catch {
    dirty = true;
  }
  return { sha, dirty };
}

/** UTC millisecond timestamp + random suffix: unique build ID (contract §4.2). */
export function buildId() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14) + String(now.getMilliseconds()).padStart(3, "0");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${suffix}`;
}

/** Artifact root for one build: dist/dev|stable/<version>/<buildId>/ (§4.6). */
export function artifactDir(version, id) {
  const channel = version.includes("-dev.") ? "dev" : "stable";
  return resolve(root, "dist", channel, version, id);
}

/** Never overwrite an existing build path (§4.6): fail on ID collision. */
export function ensureFreshArtifactDir(version, id) {
  const dir = artifactDir(version, id);
  if (existsSync(dir)) throw new Error(`Build ID collision; refusing to overwrite ${dir}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Android adapter (contract §8): versionCode = (core)*1000 + slot.
// core = major*100000 + minor*1000 + patch; dev slots 1..998, stable slot 999.
// Bounds: major<=20, minor<=99, patch<=999; Play cap 2,100,000,000 checked.
// ---------------------------------------------------------------------------

export function androidVersionCode(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/);
  if (!match) throw new Error(`Android adapter: unsupported version string: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 20 || minor > 99 || patch > 999) {
    throw new Error(`Android adapter: core ${major}.${minor}.${patch} exceeds the documented bounds (major<=20, minor<=99, patch<=999); re-document the scheme before distributing`);
  }
  const devN = match[4] === undefined ? null : Number(match[4]);
  if (devN !== null && (devN < 1 || devN > 998 || !Number.isInteger(devN))) {
    throw new Error(`Android adapter: dev.N=${devN} outside its slot range 1..998; advance the core or re-document the allocation before distributing`);
  }
  const code = (major * 100_000 + minor * 1_000 + patch) * 1_000 + (devN === null ? 999 : devN);
  if (code > 2_100_000_000) throw new Error(`Android adapter: versionCode ${code} exceeds the Play cap`);
  return code;
}

// ---------------------------------------------------------------------------
// Selection: bump / set select a development core. They never create release
// tags and never run incidentally (§5, §9.3). Stable releases remain explicit
// release-pipeline operations.
// ---------------------------------------------------------------------------

function writeVersionState(state) {
  writeFileSync(versionFile, `${coreText(state)}${state.dev ? "-dev" : ""}\n`);
}

function selectNextCore(kind) {
  const state = readVersionState();
  const core = { ...state.core };
  if (kind === "patch") core.patch += 1;
  if (kind === "minor") { core.minor += 1; core.patch = 0; }
  if (kind === "major") { core.major += 1; core.minor = 0; core.patch = 0; }
  return { core, dev: true };
}

/** Rewrites every platform reference from the canonical state (adapter script). */
function syncReferences(state) {
  const version = state.dev ? `${coreText(state)}-dev` : coreText(state);
  execFileSync(process.execPath, [resolve(root, "scripts", "sync-version.mjs"), version], { stdio: "inherit", cwd: root });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isCliEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isCliEntry) runCli();

function runCli() {
  const command = process.argv[2];

  if (command === "--check") {
    const { version } = currentBuildVersion();
    execFileSync(process.execPath, [resolve(root, "scripts", "sync-version.mjs"), "--check", version], { stdio: "inherit", cwd: root });
  } else if (command === "read") {
    console.log(JSON.stringify(readVersionState()));
  } else if (command === "canonical") {
    console.log(currentBuildVersion().version);
  } else if (command === "preview") {
    console.log(previewBuildVersion());
  } else if (command === "build-id") {
    console.log(buildId());
  } else if (command === "bump") {
    const kind = process.argv[3];
    if (kind !== "patch" && kind !== "minor" && kind !== "major") {
      console.error("usage: version.mjs bump patch|minor|major");
      process.exit(2);
    }
    const state = selectNextCore(kind);
    writeVersionState(state);
    syncReferences(state);
    console.log(`development core selected: ${coreText(state)}-dev (local counter resets; next build is dev.1)`);
  } else if (command === "set") {
    const target = process.argv[3];
    if (!/^(\d+)\.(\d+)\.(\d+)-dev$/.test(target ?? "")) {
      console.error("usage: version.mjs set X.Y.Z-dev");
      process.exit(2);
    }
    const [major, minor, patch] = target.split("-")[0].split(".").map(Number);
    writeVersionState({ core: { major, minor, patch }, dev: true });
    syncReferences({ core: { major, minor, patch }, dev: true });
    console.log(`development core selected: ${target}`);
  } else if (command === "next-dev") {
    const state = readVersionState();
    if (!state.dev) {
      console.error("no development core selected; run version.mjs bump <kind> or set X.Y.Z-dev first");
      process.exit(1);
    }
    console.log(localCounter(state).n);
  } else if (command === "android-code") {
    const { version, isDev } = currentBuildVersion();
    if (!isDev) {
      console.error("no development core selected; stable versions are set by the release pipeline");
      process.exit(1);
    }
    console.log(androidVersionCode(version));
  } else {
    console.error("usage: version.mjs read | canonical | bump patch|minor|major | set X.Y.Z-dev | next-dev | android-code | --check");
    process.exit(2);
  }
}

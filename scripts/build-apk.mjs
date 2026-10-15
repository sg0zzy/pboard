// Local Android debug APK build implementing VERSIONING.md's local-build rules.
//
//   node scripts/build-apk.mjs              dev build (frontends + cap sync + gradle)
//   node scripts/build-apk.mjs --install    ... then adb install -r
//   node scripts/build-apk.mjs --run        ... then install and launch
//   node scripts/build-apk.mjs --skip-frontend   Gradle-only rebuild of the previous bundle
//   node scripts/build-apk.mjs --stable-apk      build the *stable* versionName/versionCode
//                                                (no dev suffix/slot; for release prep only)
//
// Build identity (contract §4):
//   - version: X.Y.Z-dev.N when VERSION selects a dev core (N = local atomic counter,
//     reset per core, gitignored state); plain X.Y.Z only with --stable-apk.
//   - each invocation creates a new unique build ID (UTC ms + suffix) and writes the
//     APK into dist/dev/<version>/<buildId>/ (copy; the Gradle output stays in place
//     for adb install), together with build-manifest.json and the source patch/diff
//     snapshot. Existing paths are never overwritten; collision fails the build.
//   - dirty worktrees build fine; the manifest records dirty=true, the commit SHA and
//     a `git diff` snapshot (source.patch, trimmed of secrets is impossible to
//     guarantee — the patch stays local in dist/, which is gitignored).
//   - dev builds never tag, never commit, never bump VERSION (§4.4).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildId, currentBuildVersion, ensureFreshArtifactDir, gitIdentity, androidVersionCode } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = resolve(root, "apps", "android");
const nativeDir = resolve(androidDir, "android");
const gradleApk = resolve(nativeDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");

const args = process.argv.slice(2);
const install = args.includes("--install");
const run = args.includes("--run");
const skipFrontend = args.includes("--skip-frontend");
const stableApk = args.includes("--stable-apk");

function fail(message) {
  console.error(`build-apk: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`==> ${message}`);
}

function runStep(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(`"${command} ${commandArgs.join(" ")}" failed with exit code ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Build identity and non-overwriting artifact directory
// ---------------------------------------------------------------------------

const { version, isDev } = currentBuildVersion();
if (!isDev && !stableApk) {
  fail(`VERSION (${version}) has no development core selected. Run \`node scripts/version.mjs bump patch\` (or set X.Y.Z-dev) first, or pass --stable-apk for the release-prep build.`);
}
const identity = gitIdentity();
const id = buildId();
let artifactDirPath = null;
if (isDev) {
  try { artifactDirPath = ensureFreshArtifactDir(version, id); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}
console.log(`build ${version} (${identity.sha.slice(0, 12)}${identity.dirty ? " dirty" : ""}) id=${id}`);

// ---------------------------------------------------------------------------
// Toolchain discovery
// ---------------------------------------------------------------------------

const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!androidHome || !existsSync(androidHome)) {
  fail("ANDROID_HOME is not set or does not point to an Android SDK. Set it, e.g. export ANDROID_HOME=\"$HOME/Android/Sdk\".");
}

// Local gradle.properties wins over the environment where unset (Android Studio convention).
const gradlePropertiesPath = resolve(nativeDir, "gradle.properties");
if (existsSync(gradlePropertiesPath)) {
  for (const line of readFileSync(gradlePropertiesPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^(sdk\.dir|java\.home)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "sdk.dir" && !process.env.ANDROID_HOME) process.env.ANDROID_HOME = value.trim();
    if (key === "java.home" && !process.env.JAVA_HOME) process.env.JAVA_HOME = value.trim();
  }
}

const javaCommand = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
const javaVersion = spawnSync(javaCommand, ["-version"], { encoding: "utf8" });
if (javaVersion.status !== 0) {
  fail("java is not available. Install JDK 21 and set JAVA_HOME, e.g. /usr/lib/jvm/java-21-openjdk-amd64.");
}
const versionText = `${javaVersion.stderr} ${javaVersion.stdout}`;
if (!/version "2[1-9]|version "[3-9]\d?/.test(versionText)) {
  fail(`JDK 21+ is required; found: ${versionText.split("\n")[0].trim()}`);
}
if (process.env.JAVA_HOME) {
  const javaHome = resolve(process.env.JAVA_HOME);
  if (!existsSync(javaHome)) fail(`JAVA_HOME does not exist: ${javaHome}`);
  process.env.JAVA_HOME = javaHome;
}
process.env.ANDROID_HOME = resolve(process.env.ANDROID_HOME ?? "");
if (!existsSync(join(process.env.ANDROID_HOME, "platforms"))) {
  fail(`No platforms directory under ANDROID_HOME (${process.env.ANDROID_HOME}). Install SDK platform android-36 (see apps/android/README.md).`);
}

const adb = join(process.env.ANDROID_HOME, "platform-tools", existsSync(join(process.env.ANDROID_HOME, "platform-tools", "adb.exe")) ? "adb.exe" : "adb");
if ((install || run) && !existsSync(adb)) fail(`adb not found at ${adb}; install Android SDK platform-tools.`);

// ---------------------------------------------------------------------------
// Build steps: frontend, cap sync, versionCode injection, gradle
// ---------------------------------------------------------------------------

if (!skipFrontend) {
  step("Building the Android frontend (typecheck + vite build)");
  runStep("npm", ["run", "build"], { cwd: androidDir });
  step("Syncing the Capacitor native project");
  const capCli = resolve(androidDir, "node_modules", "@capacitor", "cli", "bin", "capacitor");
  if (!existsSync(capCli)) fail("Capacitor CLI not found; run `npm ci` in apps/android.");
  runStep(process.execPath, [capCli, "sync", "android"], { cwd: androidDir });
} else {
  step("Skipping frontend build and cap sync (--skip-frontend)");
}

// Dev builds stamp the adapted dev versionName/versionCode directly over the
// gradle file at build time and restore it afterwards, so no tracked-file
// version bump is committed per build (contract §4.4). Track the previous
// content, always restore in a finally path.
const gradlePath = resolve(nativeDir, "app", "build.gradle");
const gradleOriginal = readFileSync(gradlePath, "utf8");
const buildCode = isDev
  ? androidVersionCode(version)
  // Stable prep build: keep the adapter code already in the file.
  : Number(gradleOriginal.match(/versionCode\s+(\d+)/)?.[1] ?? "0");

function restoreGradle() {
  if (readFileSync(gradlePath, "utf8") !== gradleOriginal) {
    writeFileSync(gradlePath, gradleOriginal);
    console.log("restored the gradle version fields (dev identity stays in the APK output metadata only)");
  }
}
process.on("exit", restoreGradle);
process.on("SIGINT", () => { restoreGradle(); process.exit(130); });
process.on("SIGTERM", () => { restoreGradle(); process.exit(143); });

{
  const nameLine = gradleOriginal.replace(/^(\s*)versionName\s+"[\d.]+"/m, `$1versionName "${version}"`);
  const bothLines = nameLine.replace(/^(\s*)versionCode\s+\d+/m, `$1versionCode ${buildCode}`);
  if (bothLines === gradleOriginal) fail("Could not stamp the build version into app/build.gradle");
  writeFileSync(gradlePath, bothLines);
  console.log(`stamped versionName "${version}", versionCode ${buildCode} for this build only`);
}

const gradlew = resolve(nativeDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
if (!existsSync(gradlew)) fail(`Gradle wrapper not found at ${gradlew}`);
step("Assembling the debug APK with Gradle (first run downloads Gradle + dependencies)");
runStep(gradlew, ["assembleDebug", "--console=plain", `--project-cache-dir=${join(nativeDir, ".gradle")}`], {
  cwd: nativeDir,
  env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME }
});
restoreGradle();

if (!existsSync(gradleApk)) fail(`Gradle reported success but the APK is missing: ${gradleApk}`);
console.log(`APK: ${gradleApk}`);

// ---------------------------------------------------------------------------
// Archive the build under its unique versioned path with a manifest (§4.6-4.8)
// ---------------------------------------------------------------------------

if (artifactDirPath) {
  const apkCopy = join(artifactDirPath, `pboard-android-${version}-${id}-debug.apk`);
  copyFileSync(gradleApk, apkCopy);
  const patchPath = join(artifactDirPath, "source.patch");
  let patchDigest = "clean";
  if (identity.dirty) {
    try {
      const patch = execFileSync("git", ["diff", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      writeFileSync(patchPath, patch);
      patchDigest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
    } catch (error) {
      patchDigest = `unavailable (${String(error).slice(0, 80)})`;
    }
  }
  const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const manifest = {
    product: "pboard-android",
    version,
    buildId: id,
    utcTime: new Date().toISOString(),
    gitCommitSha: identity.sha,
    dirty: identity.dirty,
    sourcePatchDigest: patchDigest,
    target: { platform: "android", architecture: "universal", signing: "debug" },
    toolchain: {
      node: process.version,
      java: versionText.split("\n")[0].trim(),
    },
    outputs: [{ filename: basename(apkCopy), path: apkCopy, sha256: sha256(apkCopy) }]
  };
  writeFileSync(join(artifactDirPath, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`archived build in ${artifactDirPath}`);
}

// ---------------------------------------------------------------------------
// Optional adb install / launch
// ---------------------------------------------------------------------------

if (!install && !run) process.exit(0);

step("Checking for a connected device");
const devices = spawnSync(adb, ["devices"], { encoding: "utf8" });
if (devices.status !== 0) fail("adb devices failed.");
const serials = devices.stdout
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("List of"))
  .map((line) => line.split("\t")[0])
  .filter((serial) => Boolean(serial));
if (serials.length === 0) {
  fail("No device/emulator connected. Enable USB debugging, connect, and accept the authorization prompt.");
}
const serial = serials[0];
if (serials.length > 1) console.log(`Multiple devices found; using the first: ${serial} (others: ${serials.slice(1).join(", ")})`);

step(`Installing the APK on ${serial}`);
runStep(adb, ["-s", serial, "install", "-r", gradleApk]);

if (!run) process.exit(0);

step("Launching it.stefanogozzi.pboard/.MainActivity");
runStep(adb, ["-s", serial, "shell", "am", "start", "-n", "it.stefanogozzi.pboard/.MainActivity"]);
console.log("Done.");
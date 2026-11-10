// Android SDK and JDK discovery for the managed builder. See BUILD.md.
// Order: ANDROID_HOME, ANDROID_SDK_ROOT, conventional host locations, then `sdk.dir` from the
// Gradle properties file. A candidate that exists but is incomplete is reported, never skipped.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, dirname, isAbsolute } from 'node:path';
import { homedir, platform as hostPlatform } from 'node:os';
import { spawnSync } from 'node:child_process';

export const ANDROID_PLATFORM = 'android-36';
// The android build path invokes aapt (badging) and apksigner (certificate), and Gradle's
// packaging step needs zipalign; all three must be present in the build-tools version in use.
export const REQUIRED_BUILD_TOOLS = ['aapt', 'apksigner', 'zipalign'];
const LOCAL_PROPERTIES = join('apps', 'android', 'android', 'local.properties');

const isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
// Ascending order; the newest build-tools directory is the one the build actually invokes.
const compareVersions = (a, b) => a.localeCompare(b, 'en', { numeric: true });

export function conventionalSdkPaths({ platform = hostPlatform(), home = homedir() } = {}) {
  // Defaults written by Android Studio on each host it supports.
  return [
    { source: '$HOME/Android/Sdk', dir: join(home, 'Android', 'Sdk') },
    ...(platform === 'darwin' ? [{ source: '$HOME/Library/Android/sdk', dir: join(home, 'Library', 'Android', 'sdk') }] : []),
    { source: '/usr/lib/android-sdk', dir: '/usr/lib/android-sdk' }
  ];
}

export function gradleSdkDir(projectRoot) {
  const file = resolvePath(projectRoot, LOCAL_PROPERTIES);
  if (!existsSync(file)) return { file, dir: undefined, reason: 'file does not exist' };
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(text => /^\s*sdk\.dir\s*=/.test(text));
  if (!line) return { file, dir: undefined, reason: 'no sdk.dir property' };
  // Gradle properties escape ':' '=' ' ' '!' '#' and '\\'.
  const value = line.slice(line.indexOf('=') + 1).trim().replace(/\\([\\:=\s!#])/g, '$1');
  if (!value) return { file, dir: undefined, reason: 'empty sdk.dir property' };
  return { file, dir: isAbsolute(value) ? value : resolvePath(dirname(file), value) };
}

export function androidSdkCandidates({ env = process.env, platform = hostPlatform(), home = homedir(), projectRoot, conventional = conventionalSdkPaths({ platform, home }) } = {}) {
  const candidates = [];
  // Explicit variables outrank guesses: ANDROID_HOME is the location Gradle itself prefers, and
  // AGP still reads ANDROID_SDK_ROOT as its deprecated alias.
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const value = (env[name] ?? '').trim();
    candidates.push(value
      ? { source: name, where: `${name} (${isAbsolute(value) ? value : resolvePath(value)})`, dir: isAbsolute(value) ? value : resolvePath(value) }
      : { source: name, where: `${name} is not set`, dir: undefined });
  }
  // Conventional install locations, checked only after the variables: no export needed on a
  // machine where Android Studio installed the SDK in its default place.
  for (const { source, dir } of conventional) candidates.push({ source, where: `${source} (${dir})`, dir });
  // Last: `sdk.dir` from apps/android/android/local.properties. Gradle reads that file, so
  // honouring it keeps a local Gradle build and the managed build pointed at the same SDK
  // instead of disagreeing about which SDK is authoritative.
  if (projectRoot) {
    const local = gradleSdkDir(projectRoot);
    candidates.push(local.dir
      ? { source: 'apps/android/android/local.properties', where: `sdk.dir in ${local.file} (${local.dir})`, dir: local.dir }
      : { source: 'apps/android/android/local.properties', where: `sdk.dir in ${local.file}: ${local.reason}`, dir: undefined });
  }
  return candidates;
}

export function validateAndroidSdk(dir, { requireAdb = false } = {}) {
  const missing = [];
  if (!existsSync(join(dir, 'platforms', ANDROID_PLATFORM))) missing.push(`platforms/${ANDROID_PLATFORM} is missing`);
  const buildToolsRoot = join(dir, 'build-tools');
  const versions = isDirectory(buildToolsRoot)
    ? readdirSync(buildToolsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(compareVersions)
    : [];
  const newest = versions.at(-1);
  let buildTools;
  if (!newest) missing.push('build-tools has no installed version');
  else {
    buildTools = join(buildToolsRoot, newest);
    const absent = REQUIRED_BUILD_TOOLS.filter(tool => !existsSync(join(buildTools, tool)));
    if (absent.length) missing.push(`build-tools/${newest} lacks ${absent.join(', ')}`);
  }
  let adb;
  if (requireAdb) {
    adb = join(dir, 'platform-tools', 'adb');
    if (!existsSync(adb)) missing.push('platform-tools/adb is missing (required by --install/--run)');
  }
  return missing.length ? { ok: false, missing } : { ok: true, buildTools, adb };
}

function notFoundMessage(checked) {
  return [
    'No Android SDK found. Set ANDROID_HOME (preferred) or ANDROID_SDK_ROOT to the SDK root, for example:',
    '  export ANDROID_HOME="$HOME/Android/Sdk"',
    'Checked, in order:',
    ...checked.map(line => `  - ${line}`),
    `The SDK must contain platforms/${ANDROID_PLATFORM} and build-tools/<version> with ${REQUIRED_BUILD_TOOLS.join(', ')}; platform-tools/adb is only needed for --install/--run.`
  ].join('\n');
}

function incompleteSdkMessage({ source, dir }, missing, unchecked) {
  return [
    `Android SDK at ${dir} (from ${source}) cannot be used: ${missing.join('; ')}.`,
    `Install the missing pieces, or point ANDROID_HOME at a complete SDK, for example: sdkmanager --sdk_root="${dir}" "platforms;${ANDROID_PLATFORM}" "build-tools;36.0.0"`,
    // Later candidates are named so the error does not hide an SDK the user might rather fix.
    ...(unchecked.length ? ['It is the first candidate present; these later locations were not tried:', ...unchecked.map(line => `  - ${line}`)] : []),
    'An existing SDK is reported instead of being skipped silently, so a stale installation cannot be used by accident.'
  ].join('\n');
}

export function resolveAndroidSdk(options = {}) {
  const { requireAdb = false } = options;
  const candidates = androidSdkCandidates(options);
  const checked = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.dir) { checked.push(candidate.where); continue; }
    if (!isDirectory(candidate.dir)) { checked.push(`${candidate.where}: directory does not exist`); continue; }
    const result = validateAndroidSdk(candidate.dir, { requireAdb });
    if (!result.ok) throw Error(incompleteSdkMessage(candidate, result.missing, candidates.slice(index + 1).map(c => c.where)));
    return { sdk: candidate.dir, buildTools: result.buildTools, adb: result.adb, source: candidate.source };
  }
  throw Error(notFoundMessage(checked));
}

const spawnJavaVersion = (file, env) => spawnSync(file, ['-version'], { encoding: 'utf8', env });

export function resolveJava({ env = process.env, spawn = spawnJavaVersion } = {}) {
  // JAVA_HOME is authoritative when set (an explicit choice for Gradle and the shell alike);
  // otherwise use whatever `java` the PATH resolves to, exactly as Gradle would.
  const fromJavaHome = !!env.JAVA_HOME;
  const source = fromJavaHome ? `JAVA_HOME (${env.JAVA_HOME})` : 'java on PATH';
  const file = fromJavaHome ? join(env.JAVA_HOME, 'bin', 'java') : 'java';
  const result = spawn(file, { ...process.env, ...env });
  if (result.error || result.status === null) {
    if (fromJavaHome) throw Error(`JAVA_HOME is set to ${env.JAVA_HOME} but ${file} could not be executed (${result.error?.code ?? 'not executable'}). JDK 21 or newer is required; point JAVA_HOME at a JDK 21+ installation or unset it to use the java on PATH.`);
    throw Error('No java found: JAVA_HOME is not set and no "java" executable is on PATH. JDK 21 or newer is required; install one or set JAVA_HOME to a JDK 21+ installation.');
  }
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  if (result.status !== 0) throw Error(`${source}: ${file} -version failed (exit ${result.status}): ${line || 'no output'}`);
  const match = text.match(/version "(\d+)(?:\.([^"]*))?"/);
  if (!match) throw Error(`JDK 21 or newer is required: could not read a version from ${source} (${file}), which reported: ${line || 'no output'}`);
  const major = Number(match[1]);
  if (major < 21) throw Error(`JDK 21 or newer is required: ${source} reports "${line}" (major ${major}). Install JDK 21 or newer${fromJavaHome ? ', or unset JAVA_HOME to use a newer java on PATH' : ' and put it on PATH'}.`);
  return { java: file, version: line, source };
}

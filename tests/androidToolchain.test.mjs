import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANDROID_PLATFORM, REQUIRED_BUILD_TOOLS, conventionalSdkPaths, gradleSdkDir,
  androidSdkCandidates, validateAndroidSdk, resolveAndroidSdk, resolveJava
} from '../scripts/android-toolchain.mjs';

let fixture;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'pboard-android-toolchain-')); });
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

// Minimal SDK shape: a platform directory plus one build-tools version with the invoked tools.
function sdk(name, { platform = ANDROID_PLATFORM, buildTools = '36.0.0', tools = REQUIRED_BUILD_TOOLS, adb = false } = {}) {
  const dir = join(fixture, name);
  mkdirSync(dir, { recursive: true });
  if (platform) { mkdirSync(join(dir, 'platforms', platform), { recursive: true }); }
  if (buildTools) {
    mkdirSync(join(dir, 'build-tools', buildTools), { recursive: true });
    for (const tool of tools) writeFileSync(join(dir, 'build-tools', buildTools, tool), '');
  }
  if (adb) {
    mkdirSync(join(dir, 'platform-tools'), { recursive: true });
    writeFileSync(join(dir, 'platform-tools', 'adb'), '');
  }
  return dir;
}
// A home with no conventional SDK, so only explicitly supplied sources can match.
const emptyHome = () => { const home = join(fixture, 'home'); mkdirSync(home, { recursive: true }); return home; };
const nowhere = () => join(fixture, 'absent');

describe('Android SDK discovery order', () => {
  it('checks ANDROID_HOME, ANDROID_SDK_ROOT, conventional locations then Gradle local.properties', () => {
    const home = emptyHome();
    expect(conventionalSdkPaths({ platform: 'linux', home }).map(c => c.source))
      .toEqual(['$HOME/Android/Sdk', '/usr/lib/android-sdk']);
    expect(conventionalSdkPaths({ platform: 'darwin', home }).map(c => c.source))
      .toEqual(['$HOME/Android/Sdk', '$HOME/Library/Android/sdk', '/usr/lib/android-sdk']);
    const projectRoot = join(fixture, 'ordered-project');
    mkdirSync(join(projectRoot, 'apps', 'android', 'android'), { recursive: true });
    const candidates = androidSdkCandidates({ env: {}, home, platform: 'linux', projectRoot });
    expect(candidates.map(c => c.source)).toEqual([
      'ANDROID_HOME', 'ANDROID_SDK_ROOT', '$HOME/Android/Sdk', '/usr/lib/android-sdk', 'apps/android/android/local.properties'
    ]);
  });
  it('prefers ANDROID_HOME over the deprecated alias and over conventions', () => {
    const home = emptyHome();
    const preferred = sdk('preferred');
    mkdirSync(join(home, 'Android'), { recursive: true });
    mkdirSync(join(home, 'Android', 'Sdk'), { recursive: true });
    const resolved = resolveAndroidSdk({ env: { ANDROID_HOME: preferred, ANDROID_SDK_ROOT: sdk('alias') }, home, platform: 'linux' });
    expect(resolved).toMatchObject({ sdk: preferred, source: 'ANDROID_HOME' });
  });
  it('falls back to ANDROID_SDK_ROOT only when ANDROID_HOME is unset', () => {
    const alias = sdk('alias');
    const resolved = resolveAndroidSdk({ env: { ANDROID_HOME: '', ANDROID_SDK_ROOT: alias }, home: emptyHome(), platform: 'linux' });
    expect(resolved).toMatchObject({ sdk: alias, source: 'ANDROID_SDK_ROOT' });
  });
  it('finds the conventional $HOME/Android/Sdk without any exported variable', () => {
    const home = emptyHome();
    const conventional = sdk(join('home', 'Android', 'Sdk'));
    const resolved = resolveAndroidSdk({ env: {}, home, platform: 'linux', conventional: conventionalSdkPaths({ platform: 'linux', home }) });
    expect(resolved).toMatchObject({ sdk: conventional, source: '$HOME/Android/Sdk' });
  });
  it('finds $HOME/Library/Android/sdk on darwin', () => {
    const home = emptyHome();
    const conventional = sdk(join('home', 'Library', 'Android', 'sdk'));
    const resolved = resolveAndroidSdk({ env: {}, home, platform: 'darwin', conventional: conventionalSdkPaths({ platform: 'darwin', home }) });
    expect(resolved).toMatchObject({ sdk: conventional, source: '$HOME/Library/Android/sdk' });
  });
  it('honours sdk.dir from Gradle local.properties as the last source', () => {
    const projectRoot = join(fixture, 'project');
    mkdirSync(join(projectRoot, 'apps', 'android', 'android'), { recursive: true });
    const gradle = sdk('gradle-sdk');
    writeFileSync(join(projectRoot, 'apps', 'android', 'android', 'local.properties'), `# local\nsdk.dir=${gradle}\n`);
    const resolved = resolveAndroidSdk({ env: {}, home: emptyHome(), platform: 'linux', projectRoot, conventional: [] });
    expect(resolved).toMatchObject({ sdk: gradle, source: 'apps/android/android/local.properties' });
  });
  it('unescapes and resolves a relative sdk.dir the way Gradle properties do', () => {
    const projectRoot = join(fixture, 'project');
    const native = join(projectRoot, 'apps', 'android', 'android');
    mkdirSync(native, { recursive: true });
    // Gradle properties escape ':' so the value is not read as a key separator.
    writeFileSync(join(native, 'local.properties'), 'sdk.dir=./es\\:caped\n');
    expect(gradleSdkDir(projectRoot).dir).toBe(join(native, 'es:caped'));
  });
  it('ignores a local.properties without sdk.dir', () => {
    const projectRoot = join(fixture, 'project');
    const native = join(projectRoot, 'apps', 'android', 'android');
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'local.properties'), 'other=1\n');
    expect(gradleSdkDir(projectRoot)).toMatchObject({ dir: undefined, reason: 'no sdk.dir property' });
  });
});

describe('Android SDK validation', () => {
  it('accepts an SDK with the required platform and build-tools', () => {
    const dir = sdk('good', { adb: true });
    expect(validateAndroidSdk(dir)).toMatchObject({ ok: true, buildTools: join(dir, 'build-tools', '36.0.0') });
    expect(validateAndroidSdk(dir, { requireAdb: true })).toMatchObject({ ok: true, adb: join(dir, 'platform-tools', 'adb') });
  });
  it('names the missing platform and the directory it inspected', () => {
    const dir = sdk('no-platform', { platform: null });
    let message = '';
    try { resolveAndroidSdk({ env: { ANDROID_HOME: dir }, home: emptyHome(), platform: 'linux', conventional: [] }); }
    catch (e) { message = e.message; }
    expect(message).toContain(`Android SDK at ${dir}`);
    expect(message).toContain('platforms/android-36 is missing');
  });
  it('names each absent build-tools executable', () => {
    const dir = sdk('no-aapt', { tools: ['apksigner', 'zipalign'] });
    expect(() => resolveAndroidSdk({ env: { ANDROID_HOME: dir }, home: emptyHome(), platform: 'linux', conventional: [] }))
      .toThrow(/build-tools\/36\.0\.0 lacks aapt(?!2)/);
    expect(validateAndroidSdk(dir).missing.join()).toBe('build-tools/36.0.0 lacks aapt');
  });
  it('reports an empty build-tools directory instead of guessing', () => {
    const dir = sdk('empty-tools', { buildTools: null });
    mkdirSync(join(dir, 'build-tools'));
    expect(validateAndroidSdk(dir).missing.join()).toContain('build-tools has no installed version');
  });
  it('uses the newest build-tools version', () => {
    const dir = sdk('two-versions', { buildTools: '35.0.0' });
    mkdirSync(join(dir, 'build-tools', '36.0.0'), { recursive: true });
    for (const tool of REQUIRED_BUILD_TOOLS) writeFileSync(join(dir, 'build-tools', '36.0.0', tool), '');
    expect(validateAndroidSdk(dir).buildTools).toBe(join(dir, 'build-tools', '36.0.0'));
  });
  it('requires adb only when device commands are requested', () => {
    const dir = sdk('no-adb');
    expect(validateAndroidSdk(dir).ok).toBe(true);
    expect(validateAndroidSdk(dir, { requireAdb: true }).missing.join()).toContain('platform-tools/adb is missing');
  });
  it('never falls back to another SDK when the first candidate is incomplete', () => {
    const broken = sdk('broken', { platform: null });
    const usable = sdk('usable');
    let message = '';
    try { resolveAndroidSdk({ env: { ANDROID_HOME: broken, ANDROID_SDK_ROOT: usable }, home: emptyHome(), platform: 'linux', conventional: [] }); }
    catch (e) { message = e.message; }
    expect(message).toContain(`Android SDK at ${broken}`);
    // The error must still say a later source exists, so the developer can point the build at it.
    expect(message).toContain(usable);
    expect(message).toContain('ANDROID_SDK_ROOT');
  });
});

describe('Android SDK failure message', () => {
  it('gives the variables to set and every path checked when nothing is found', () => {
    const home = emptyHome();
    const projectRoot = join(fixture, 'project');
    mkdirSync(join(projectRoot, 'apps', 'android', 'android'), { recursive: true });
    // Fix the conventional list so the assertions do not depend on this host's directories.
    const conventional = [
      { source: '$HOME/Android/Sdk', dir: join(home, 'Android', 'Sdk') },
      { source: '/usr/lib/android-sdk', dir: join(fixture, 'usr-lib-android-sdk') }
    ];
    const options = { env: { ANDROID_HOME: '', ANDROID_SDK_ROOT: nowhere() }, home, platform: 'linux', projectRoot, conventional };
    expect(androidSdkCandidates(options)).toHaveLength(5);
    let message = '';
    try { resolveAndroidSdk(options); } catch (e) { message = e.message; }
    expect(message).toContain('No Android SDK found');
    expect(message).toContain('export ANDROID_HOME="$HOME/Android/Sdk"');
    expect(message).toContain('ANDROID_HOME is not set');
    expect(message).toContain(nowhere());
    expect(message).toContain(conventional[0].dir);
    expect(message).toContain(join(fixture, 'usr-lib-android-sdk'));
    expect(message).toContain(join(projectRoot, 'apps', 'android', 'android', 'local.properties'));
    expect(message).toContain(`platforms/${ANDROID_PLATFORM}`);
    expect(message).toContain(REQUIRED_BUILD_TOOLS.join(', '));
  });
});

describe('JDK discovery', () => {
  const fakeJava = (stderr, extra = {}) => (file, env) => ({ status: 0, stdout: '', stderr, file, env, ...extra });
  it('prefers JAVA_HOME over java on PATH', () => {
    const calls = [];
    const spawn = (file, env) => { calls.push(file); return { status: 0, stdout: '', stderr: 'openjdk version "21.0.13" 2026-01-20\n' }; };
    const resolved = resolveJava({ env: { JAVA_HOME: '/opt/jdk-21', PATH: '/usr/bin' }, spawn });
    expect(resolved).toMatchObject({ java: '/opt/jdk-21/bin/java', source: 'JAVA_HOME (/opt/jdk-21)' });
    expect(resolved.version).toBe('openjdk version "21.0.13" 2026-01-20');
    expect(calls).toEqual(['/opt/jdk-21/bin/java']);
  });
  it('uses java on PATH when JAVA_HOME is unset', () => {
    const spawn = fakeJava('openjdk version "24.0.1" 2026-04-15\n');
    expect(resolveJava({ env: { PATH: '/usr/bin' }, spawn })).toMatchObject({ java: 'java', source: 'java on PATH' });
  });
  it('rejects a JDK older than 21 saying so, not "no java found"', () => {
    const spawn = fakeJava('openjdk version "17.0.11" 2024-04-16\n');
    expect(() => resolveJava({ env: { JAVA_HOME: '/opt/jdk-17' }, spawn }))
      .toThrow(/JDK 21 or newer is required: JAVA_HOME \(\/opt\/jdk-17\).*17\.0\.11/);
  });
  it('distinguishes an unrunnable JAVA_HOME from a missing java', () => {
    const missing = () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } });
    expect(() => resolveJava({ env: {}, spawn: missing }))
      .toThrow(/No java found: JAVA_HOME is not set and no "java" executable is on PATH/);
    expect(() => resolveJava({ env: { JAVA_HOME: '/opt/gone' }, spawn: missing }))
      .toThrow(/JAVA_HOME is set to \/opt\/gone but \/opt\/gone\/bin\/java could not be executed \(ENOENT\)/);
  });
});

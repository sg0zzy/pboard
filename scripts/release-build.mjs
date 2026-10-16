// Unprivileged official packaging. Invoked only after trusted reservation validation.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { official, extensionVersion, releaseReadiness } from './release-policy.mjs';
import { androidVersionCode } from './version.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const [target, version, sha] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(root, 'project-standards.json')));
releaseReadiness(config); official(version);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== sha || git('status', '--porcelain', '--untracked-files=all')) throw Error('Official build requires clean exact tagged source');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, env: { ...process.env, PBOARD_STAGE: '1' }, stdio: 'inherit' });
const channel = version.includes('-dev.') ? 'beta' : 'stable';
execFileSync(process.execPath, ['scripts/sync-version.mjs', '--check'], { cwd: root, stdio: 'inherit' });
const staging = join(root, 'official-output'); mkdirSync(staging);
const outputs = [];
const archive = (path, name, fields) => {
  const bytes = readFileSync(path);
  writeFileSync(join(staging, name), bytes, { flag: 'wx' });
  outputs.push({ filename: name, bytes: bytes.length, sha256: hash(bytes), target, ...fields });
};
let environment = { node: process.version, os: process.platform, architecture: process.arch, lockSha256: hash(readFileSync(join(root, target === 'android-release' ? 'apps/android/package-lock.json' : 'package-lock.json'))), npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim() };
if (target === 'firefox' || target === 'chromium') {
  run('npm', ['run', 'typecheck']); run('npm', ['test']);
  run('npm', ['run', target === 'firefox' ? 'build' : 'build:chromium']);
  if (target === 'firefox') run('npm', ['run', 'lint:firefox']);
  run('npm', ['run', `package:${target}`]);
  const core = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  const path = join(root, `web-ext-artifacts/pboard-${target === 'chromium' ? 'chromium-' : ''}${core}.zip`);
  const files = unzipSync(readFileSync(path));
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  manifest.version = extensionVersion(version);
  if (target === 'chromium') manifest.version_name = version;
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const final = join(root, 'web-ext-artifacts/official.zip'); writeFileSync(final, zipSync(files));
  const checked = JSON.parse(Buffer.from(unzipSync(readFileSync(final))['manifest.json']).toString());
  if (checked.version !== extensionVersion(version)) throw Error('Package version mismatch');
  archive(final, `Pboard-${version}-${target}-universal.zip`, { productVersion: version, packageVersion: checked.version, signing: 'unsigned-upload-archive' });
  if (target === 'firefox') {
    // Complete tracked reviewer source; excludes ignored env/credentials and generated outputs.
    const source = join(root, 'web-ext-artifacts/pboard-source.zip');
    execFileSync('git', ['archive', '--format=zip', `--output=${source}`, 'HEAD']);
    archive(source, `Pboard-${version}-source.zip`, { signing: 'checksum-only' });
  }
} else if (target === 'android-release') {
  const native = join(root, 'apps/android/android');
  const path = join(native, 'app/build.gradle');
  const original = readFileSync(path, 'utf8');
  const code = androidVersionCode(version);
  if (code <= config.signing['android-release'].highestHistoricalCode) throw Error('Android code must exceed reviewed historical/submitted high-water mark');
  try {
    writeFileSync(path, original.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`).replace(/versionCode\s+\d+/, `versionCode ${code}`));
    const app = join(root, 'apps/android');
    run('npm', ['run', 'typecheck'], app); run('npm', ['test'], app); run('npm', ['run', 'build'], app);
    run(process.execPath, [join(app, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], app);
    run(join(native, 'gradlew'), ['assembleRelease', '--console=plain', '--no-daemon'], native);
    archive(join(native, 'app/build/outputs/apk/release/app-release-unsigned.apk'), `Pboard-${version}-android-universal-unsigned.apk`, { productVersion: version, packageVersion: version, versionCode: code, signing: 'unsigned-intermediate' });
    const java = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0];
    environment = { ...environment, java: java.trim() || 'JDK 21 (setup-java)', gradleWrapperSha256: hash(readFileSync(join(native, 'gradle/wrapper/gradle-wrapper.properties'))), androidPlatform: '36' };
  } finally { writeFileSync(path, original); }
} else throw Error('Unknown official target');
writeFileSync(join(staging, 'build-info.json'), JSON.stringify({ schema: 1, version, developmentCore: version.split('-')[0], channel, state: target === 'android-release' ? 'awaiting_signature' : 'succeeded', gitCommitSha: sha, dirty: false, source: { digest: hash(Buffer.from(git('ls-tree', '-r', 'HEAD'))), algorithm: 'sha256', scope: 'Git tracked tree path/mode/blob inventory; clean checkout; locked dependencies; no private env files' }, environment, standardsCommit: JSON.parse(readFileSync(join(root, 'dev-standards.lock.json'))).commit, configurationSha256: hash(readFileSync(join(root, 'project-standards.json'))), startedAt: process.env.BUILD_STARTED_AT, completedAt: new Date().toISOString(), run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, targets: [{ id: target, required: true, outcome: target === 'android-release' ? 'awaiting_signature' : 'succeeded' }], outputs }, null, 2) + '\n');

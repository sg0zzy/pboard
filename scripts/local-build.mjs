// Build an immutable private copy of dirty inputs, using only this repository's tools.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, symlinkSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir, platform, arch, release } from 'node:os';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { validateConfig } from './release-policy.mjs';
import { parseEnv } from 'node:util';
import { createBuild, updateBuild, runRetention, withArtifactLock, ARTIFACTS_DIR } from './artifact-retention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const run = (command, args, cwd, env) => execFileSync(command, args, { cwd, env, stdio: 'inherit' });
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function sourceSnapshot(destination) {
  const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
  const excluded = /(^|\/)(node_modules|local_artifacts|dist|web-ext-artifacts|\.git|\.delta|\.build-state|\.gradle|build)(\/|$)|(^|\/)(\.env(?:\..*)?|local\.properties|google-services\.json)$|\.(?:keystore|jks|p12|pem|key)$/i;
  const inventory = [];
  for (const name of files) {
    if (excluded.test(name) && name !== '.env.example') continue;
    const path = join(root, name);
    if (!existsSync(path)) { inventory.push([name, 'deleted']); continue; }
    const s = lstatSync(path);
    if (!s.isFile()) throw Error(`Unsupported source input (symlink/submodule): ${name}`);
    const data = readFileSync(path);
    inventory.push([name, hash(data), s.mode & 0o777]);
    if (destination) {
      const target = join(destination, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data, { mode: s.mode & 0o777 });
    }
  }
  // Vite's effective public client parameter is passed privately, never archived as an env file.
  const buildEnv = { ...process.env };
  let publicOAuth;
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    if (parsed.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET !== undefined) publicOAuth = parsed.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET;
  }
  if (buildEnv.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET === undefined && publicOAuth !== undefined) buildEnv.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET = publicOAuth;
  // Do not record the value or its digest separately; only the aggregate identity.
  inventory.push(['effective-public-oauth-input', hash(buildEnv.VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET ?? '')]);
  return { digest: hash(JSON.stringify(inventory)), buildEnv };
}

export function buildLocal(targets, options = {}) {
  if (!['linux', 'darwin'].includes(process.platform)) throw Error('Managed builds require a POSIX Linux/macOS host (Windows: use WSL)');
  const config = validateConfig(json(join(root, 'project-standards.json')));
  if (!targets.length) targets = config.matrix.local.required;
  targets = [...new Set(targets)];
  if (targets.some(t => !config.matrix.local.required.includes(t))) throw Error('Local targets: firefox, chromium, android');
  if (options.skipFrontend) throw Error('Reusing an old frontend cannot prove source identity; build without --skip-frontend');
  if (!existsSync(join(root, 'node_modules'))) throw Error('Run npm ci at the repository root');
  const core = readFileSync(join(root, 'VERSION'), 'utf8').trim().replace(/-dev$/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(core)) throw Error('Invalid VERSION');
  const id = `${core}-local.${BigInt('0x' + randomUUID().replaceAll('-', '')).toString()}`;
  const dir = createBuild({ buildId: id, version: id, developmentCore: core, channel: process.env.CI ? 'ci' : 'local', targets: targets.map(id => ({ id, required: true, outcome: 'pending' })) });
  const scratch = mkdtempSync(join(tmpdir(), 'pboard-build-'));
  const snapshot = join(scratch, 'source');
  mkdirSync(snapshot, { mode: 0o700 });
  const outputs = [], outcomes = targets.map(id => ({ id, required: true, outcome: 'pending' }));
  try {
    const { digest, buildEnv } = sourceSnapshot(snapshot);
    const env = { ...buildEnv, PBOARD_STAGE: '1' };
    for (const deps of ['node_modules', 'apps/android/node_modules']) if (existsSync(join(root, deps))) {
      mkdirSync(dirname(join(snapshot, deps)), { recursive: true });
      symlinkSync(join(root, deps), join(snapshot, deps), 'dir');
    }
    const gitCommitSha = git('rev-parse', 'HEAD').trim();
    const info = {
      gitCommitSha, dirty: !!git('status', '--porcelain', '--untracked-files=all').trim(),
      source: { algorithm: 'sha256', digest, scope: 'Canonical path/content/mode inventory of tracked and relevant untracked inputs, deletions, effective public OAuth input; excludes secrets, outputs, caches, dependencies, Git internals. Dependencies identified by locks. Compiles private snapshot.' },
      standardsCommit: json(join(root, 'dev-standards.lock.json')).commit,
      configurationSha256: hash(readFileSync(join(root, 'project-standards.json'))),
      environment: { os: platform(), architecture: arch(), kernel: release(), node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), dependencyLocks: Object.fromEntries(['package-lock.json', 'apps/android/package-lock.json'].map(p => [p, hash(readFileSync(join(snapshot, p)))])) },
      options: { targets, testOnly: true },
      ci: process.env.CI ? { run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, event: process.env.GITHUB_EVENT_NAME, eventSha: process.env.GITHUB_SHA, head: process.env.PR_HEAD_SHA, base: process.env.PR_BASE_SHA, revisionPolicy: 'proposed-merge for PR; event SHA for push' } : undefined
    };
    updateBuild(dir, info);
    const archive = (path, target, extension, packageVersion, extra = {}) => {
      const filename = `Pboard-${id}-${target}-universal.${extension}`;
      copyFileSync(path, join(dir, filename), 1);
      const bytes = readFileSync(join(dir, filename));
      outputs.push({ filename, target, bytes: bytes.length, sha256: hash(bytes), packageVersion, ...extra });
      console.log(`ARTIFACT ${target}: local_artifacts/${id}/${filename}`);
    };
    for (const target of targets) {
      try {
        if (target === 'android') {
          if (!existsSync(join(root, 'apps/android/node_modules'))) throw Error('Run npm ci in apps/android');
          const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
          if (!sdk || !existsSync(sdk)) throw Error('Android requires ANDROID_HOME and JDK 21');
          const java = spawnSync(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java', ['-version'], { encoding: 'utf8' });
          if (java.status !== 0 || !/version "(?:2[1-9]|[3-9]\d)/.test(java.stderr)) throw Error('JDK 21 or newer is required');
          info.environment.java = java.stderr.split('\n')[0].trim();
          info.environment.gradleWrapper = hash(readFileSync(join(snapshot, 'apps/android/android/gradle/wrapper/gradle-wrapper.properties')));
          info.environment.androidPlatform = '36';
          const gradle = join(snapshot, 'apps/android/android/app/build.gradle');
          const code = Number(readFileSync(gradle, 'utf8').match(/versionCode\s+(\d+)/)[1]);
          writeFileSync(gradle, readFileSync(gradle, 'utf8').replace(/versionName\s+"[^"]*"/, `versionName "${id}"`));
          const app = join(snapshot, 'apps/android');
          run('npm', ['run', 'build'], app, env);
          run(process.execPath, [join(app, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], app, env);
          const native = join(app, 'android');
          run(join(native, 'gradlew'), ['assembleDebug', '--console=plain', '--no-daemon'], native, env);
          const apk = join(native, 'app/build/outputs/apk/debug/app-debug.apk');
          const tools = execFileSync('bash', ['-c', 'ls -d "$1"/build-tools/* | sort -V | tail -1', 'bash', sdk], { encoding: 'utf8' }).trim();
          const badging = execFileSync(join(tools, 'aapt'), ['dump', 'badging', apk], { encoding: 'utf8' });
          if (!badging.includes(`versionName='${id}'`) || !badging.includes(`versionCode='${code}'`) || !badging.includes("name='it.stefanogozzi.pboard'")) throw Error('APK identity mismatch');
          const signature = execFileSync(join(tools, 'apksigner'), ['verify', '--print-certs', apk], { encoding: 'utf8' });
          const signer = signature.match(/certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1];
          if (!signer) throw Error('APK signer unavailable');
          archive(apk, target, 'apk', id, { versionCode: code, signing: 'debug-test-only', certificateSha256: signer });
        } else {
          run('npm', ['run', target === 'firefox' ? 'build' : 'build:chromium'], snapshot, env);
          if (target === 'firefox') run('npm', ['run', 'lint:firefox'], snapshot, env);
          run('npm', ['run', `package:${target}`], snapshot, env);
          const packageVersion = json(join(snapshot, 'package.json')).version;
          archive(join(snapshot, `web-ext-artifacts/pboard-${target === 'chromium' ? 'chromium-' : ''}${packageVersion}.zip`), target, 'zip', packageVersion, { signing: 'unsigned-upload-archive', productVersion: id });
          // Preserve existing unpacked-extension developer installation paths as intermediates.
          const dist = target === 'firefox' ? 'dist' : 'dist/chromium';
          withArtifactLock(ARTIFACTS_DIR, () => {
          if (target === 'firefox') {
            // Preserve Chromium's separate staging tree while replacing Firefox intermediates.
            const chromium = join(root, 'dist/chromium');
            if (existsSync(chromium)) cpSync(chromium, join(scratch, 'chromium-staging'), { recursive: true });
            rmSync(join(root, 'dist'), { recursive: true, force: true });
            cpSync(join(snapshot, dist), join(root, dist), { recursive: true });
            if (existsSync(join(scratch, 'chromium-staging'))) cpSync(join(scratch, 'chromium-staging'), chromium, { recursive: true });
          } else {
            rmSync(join(root, dist), { recursive: true, force: true });
            cpSync(join(snapshot, dist), join(root, dist), { recursive: true });
          }
          });
        }
        outcomes.find(t => t.id === target).outcome = 'succeeded';
      } catch (e) {
        outcomes.find(t => t.id === target).outcome = 'failed';
        outcomes.find(t => t.id === target).reason = `${target} compilation/package verification failed; see terminal output`;
        throw e;
      } finally { updateBuild(dir, { targets: outcomes, outputs, environment: info.environment }); }
    }
    // The digest identifies captured bytes even if the working tree changes during compilation.
    updateBuild(dir, { targets: outcomes, outputs }, true);
  } catch (e) {
    for (const t of outcomes) if (t.outcome === 'pending') { t.outcome = 'skipped'; t.reason = 'Earlier required target failed'; }
    updateBuild(dir, { state: 'failed', targets: outcomes, outputs, failure: 'Build failed; retained partial outputs; no retention performed' });
    throw e;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // A maintenance failure preserves successful compilation state and returns a failing status.
  try { runRetention(config.retention); } catch (e) { throw Error(`Build succeeded at ${dir}; retention maintenance failed: ${e.message}`); }
  return { dir, outputs };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) console.log('usage: node scripts/local-build.mjs [firefox chromium android]');
    else buildLocal(args);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

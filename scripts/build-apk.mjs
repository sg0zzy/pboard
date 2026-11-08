// Android local build / explicitly requested device installation. See BUILD.md.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocal } from './local-build.mjs';
import { resolveAndroidSdk } from './android-toolchain.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
try {
  if (args.some(a => !['--install', '--run', '--stable-apk', '--skip-frontend'].includes(a))) throw Error('usage: build-apk.mjs [--install|--run]');
  if (args.includes('--stable-apk')) throw Error('Local APKs are test-only. Official stable packaging runs in the tagged release workflow.');
  const { dir, outputs } = buildLocal(['android'], { skipFrontend: args.includes('--skip-frontend') });
  const apk = join(dir, outputs[0].filename);
  console.log(`APK: ${apk}`);
  if (args.includes('--install') || args.includes('--run')) {
    // Device commands need adb specifically; the SDK resolution is the same as the build's, so
    // an install cannot silently target a different SDK than the APK came from.
    const { adb } = resolveAndroidSdk({ projectRoot: root, requireAdb: true });
    execFileSync(adb, ['install', '-r', apk], { stdio: 'inherit' });
    if (args.includes('--run')) execFileSync(adb, ['shell', 'am', 'start', '-n', 'it.stefanogozzi.pboard/.MainActivity'], { stdio: 'inherit' });
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }

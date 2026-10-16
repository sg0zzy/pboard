// VERSION authority and preserved Android package mapping; see VERSIONING.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { official, compareVersion, extensionVersion } from './release-policy.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export const VERSION_FILES = ['VERSION', 'manifest.json', 'manifest.chromium.json', 'package.json', 'package-lock.json', 'apps/android/package.json', 'apps/android/package-lock.json', 'apps/android/android/app/build.gradle'];

export function readVersionState() {
  const selected = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
  const core = selected.replace(/-dev$/, ''); official(core);
  if (core.includes('-')) throw Error('VERSION must be X.Y.Z or X.Y.Z-dev');
  const [major, minor, patch] = core.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw Error('VERSION fields exceed safe integer range');
  return { core: { major, minor, patch }, dev: selected.endsWith('-dev') };
}
export function androidVersionCode(version) {
  official(version);
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-dev\.([1-9]\d*))?$/);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const n = match[4] === undefined ? 999 : Number(match[4]);
  if (major > 20 || minor > 99 || patch > 999 || n < 1 || n > (match[4] ? 998 : 999)) throw Error('Android encoded version range exhausted; review mapping before allocation');
  const code = (major * 100000 + minor * 1000 + patch) * 1000 + n;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000) throw Error('Android versionCode exceeds 1..2100000000');
  return code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, argument, flag, ...extra] = process.argv.slice(2), state = readVersionState();
    if (extra.length || (flag !== undefined && flag !== '--dry-run') ||
        (flag && !['bump', 'set'].includes(command)) ||
        (argument !== undefined && !['bump', 'set', 'android-code'].includes(command))) throw Error('Unexpected arguments');
    let core = Object.values(state.core).join('.');
    if (command === 'show') console.log(`VERSION: ${core}${state.dev ? '-dev' : ''}\nLocal builds: ${core}-local.N\nBeta numbers: allocated by Beta Release workflow; no local reservation`);
    else if (command === 'read') console.log(JSON.stringify(state));
    else if (command === 'canonical') console.log(`${core}${state.dev ? '-dev' : ''}`);
    else if (command === 'preview') console.log(`${core}-local.N (collision-resistant local identity at build time)`);
    else if (command === '--check') execFileSync(process.execPath, ['scripts/sync-version.mjs', '--check'], { cwd: root, stdio: 'inherit' });
    else if (command === 'android-code') console.log(androidVersionCode(argument ?? core));
    else if (command === 'bump' || command === 'set') {
      if (command === 'bump') {
        if (!['patch', 'minor', 'major'].includes(argument)) throw Error('Select patch, minor or major');
        const c = state.core; c[argument] += 1;
        if (argument === 'major') c.minor = c.patch = 0;
        if (argument === 'minor') c.patch = 0;
        core = Object.values(c).join('.');
      } else {
        if (!argument?.endsWith('-dev')) throw Error('set requires X.Y.Z-dev');
        core = official(argument.slice(0, -4));
        if (core.includes('-')) throw Error('Invalid development core');
      }
      const current = Object.values(readVersionState().core).join('.');
      if (compareVersion(core, current) <= 0) throw Error(`Development core must exceed current ${current}`);
      // Validate both release adapters before editing anything; local bumps reserve no codes.
      androidVersionCode(`${core}-dev.1`); androidVersionCode(core); extensionVersion(core);
      const config = JSON.parse(readFileSync(resolve(root, 'project-standards.json')));
      const tags = execFileSync('git', ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const reservations = [...tags.map(tag => config.history.historicalAliases[tag] ?? tag.replace(/^v/, '')), ...config.history.reservations];
      for (const previous of reservations) {
        official(previous);
        if (compareVersion(core, previous) <= 0) throw Error(`Development core must exceed known reservation ${previous}`);
      }
      console.log(`VERSION: ${current} -> ${core}-dev${flag ? ' (dry-run)' : ''}`);
      if (!flag) {
        const originals = new Map(VERSION_FILES.map(p => [p, readFileSync(resolve(root, p))]));
        try {
          execFileSync(process.execPath, [resolve(root, 'scripts/sync-version.mjs'), `${core}-dev`], { cwd: root, stdio: 'inherit' });
          execFileSync(process.execPath, [resolve(root, 'scripts/sync-version.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
        } catch {
          for (const [p, bytes] of originals) writeFileSync(resolve(root, p), bytes);
          throw Error('Version update failed; original metadata restored');
        }
      }
    } else throw Error('usage: version.mjs show|read|canonical|preview|--check|bump patch|minor|major [--dry-run]|set X.Y.Z-dev [--dry-run]|android-code [VERSION]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

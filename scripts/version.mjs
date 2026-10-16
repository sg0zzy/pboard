// VERSION authority and preserved Android package mapping; see VERSIONING.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { official } from './release-policy.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
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
    const [command, argument] = process.argv.slice(2), state = readVersionState();
    let core = Object.values(state.core).join('.');
    if (command === 'read') console.log(JSON.stringify(state));
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
      execFileSync(process.execPath, ['scripts/sync-version.mjs', `${core}-dev`], { cwd: root, stdio: 'inherit' });
    } else throw Error('usage: version.mjs read|canonical|preview|--check|bump patch|minor|major|set X.Y.Z-dev|android-code [VERSION]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

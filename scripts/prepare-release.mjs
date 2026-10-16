// Explicit stable metadata preparation with rollback; Git commit/tag/push remain human operations.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { official, assertForward, releaseReadiness } from './release-policy.mjs';
import { remoteInventory } from './release-control.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2), version = args[0], apply = args[1] === '--apply';
try {
  if (args.length !== 2 || !['--dry-run', '--apply'].includes(args[1])) throw Error('usage: scripts/release.sh X.Y.Z --dry-run|--apply');
  official(version); if (version.includes('-')) throw Error('Select a stable core');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const planned = ['VERSION', 'manifest.json', 'manifest.chromium.json', 'package.json', 'package-lock.json', 'apps/android/package.json', 'apps/android/package-lock.json', 'apps/android/android/app/build.gradle'];
  console.log(JSON.stringify({ version, edits: planned, checks: ['full remote high-water inventory', 'clean intended source', 'signing/history readiness', 'npm run check', 'Android typecheck/tests and managed debug APK'], commit: 'human-reviewed dedicated release commit if metadata differs', tag: `annotated v${version} on reviewed commit (human operation)`, remoteActions: 'none; separately authorized tag push starts stable workflow' }, null, 2));
  if (!apply) process.exit(0);
  if (git('status', '--porcelain', '--untracked-files=all')) throw Error('Stable preparation requires a clean intended source tree');
  releaseReadiness(JSON.parse(readFileSync(join(root, 'project-standards.json'))));
  assertForward(version, (await remoteInventory()).versions);
  const originals = new Map(planned.map(p => [p, readFileSync(join(root, p))]));
  try {
    writeFileSync(join(root, 'VERSION'), `${version}\n`);
    execFileSync(process.execPath, ['scripts/sync-version.mjs'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'typecheck'], { cwd: join(root, 'apps/android'), stdio: 'inherit' });
    execFileSync('npm', ['test'], { cwd: join(root, 'apps/android'), stdio: 'inherit' });
    execFileSync(join(root, 'scripts/build_android.sh'), [], { cwd: root, stdio: 'inherit' });
    console.log('Prepared metadata for review. No Git objects or remote state were changed.');
  } catch (e) {
    for (const [p, bytes] of originals) writeFileSync(join(root, p), bytes);
    throw Error('Preparation failed; version metadata restored. Local diagnostic artifacts remain for inspection.');
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }

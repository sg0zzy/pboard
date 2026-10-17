// Repository-owned release entry points. Remote mutations require an explicit --apply.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { official, assertForward, nextBeta, extensionVersion } from './release-policy.mjs';
import { readVersionState, androidVersionCode, VERSION_FILES } from './version.mjs';
import { remoteInventory, releaseInventory } from './release-control.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const config = () => JSON.parse(readFileSync(join(root, 'project-standards.json')));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const node = (...args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
const clean = () => { if (git('status', '--porcelain', '--untracked-files=all')) throw Error('Release tagging requires a clean intended source tree; preserve and review existing work first'); };
function repository() {
  const c = config(), repo = c.repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repo) throw Error('Repository configuration/environment mismatch');
  const origin = git('remote', 'get-url', 'origin');
  const pushUrls = git('remote', 'get-url', '--push', '--all', 'origin').split('\n');
  const allowed = [`https://github.com/${repo}`, `https://github.com/${repo}.git`, `git@github.com:${repo}`, `git@github.com:${repo}.git`];
  if (process.env.GH_HOST && process.env.GH_HOST !== 'github.com' || !allowed.includes(origin) || pushUrls.length !== 1 || !allowed.includes(pushUrls[0])) throw Error('origin fetch/push URLs and GitHub host must match the configured GitHub repository');
  return repo;
}
function platformVersion(version) {
  extensionVersion(version);
  const code = androidVersionCode(version);
  if (code <= config().signing['android-release'].highestHistoricalCode) throw Error('Android code does not exceed reviewed historical/submission inventory');
}
function localReservations() {
  const c = config();
  return git('for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/').split('\n').filter(Boolean)
    .map(name => official(c.history.historicalAliases[name] ?? name.replace(/^v/, '')));
}
function mode(args) {
  const flags = args.filter(a => a.startsWith('--'));
  if (flags.length > 1 || flags.some(f => !['--dry-run', '--apply'].includes(f))) throw Error('Choose --dry-run or --apply');
  return { apply: flags[0] === '--apply', values: args.filter(a => !a.startsWith('--')) };
}
async function stable(args) {
  const { apply, values: [command, version, ...extra] } = mode(args);
  if (extra.length || !['prepare', 'tag', 'publish'].includes(command)) throw Error('usage: release.sh prepare|tag|publish X.Y.Z [--dry-run|--apply]');
  official(version ?? '');
  if (version.includes('-')) throw Error('Stable selection must be explicit X.Y.Z');
  extensionVersion(version); androidVersionCode(version);
  const tag = `v${version}`;
  console.log(JSON.stringify({ command, version, tag, sourceSha: git('rev-parse', 'HEAD'), edits: command === 'prepare' ? VERSION_FILES : [],
    checks: ['clean intended source', 'production signer/history readiness', 'full remote and local high-water inventory', 'platform mappings', 'required root/Android checks before tagging'],
    commit: command === 'prepare' ? 'dedicated metadata commit if needed' : 'existing reviewed commit',
    remoteActions: command === 'publish' ? 'atomic push of main and this tag to origin; starts Stable Release workflow' : 'none',
    dryRun: !apply }, null, 2));
  if (!apply) return;
  clean(); repository();
  const inventory = await releaseInventory();
  if (command === 'publish') {
    if (git('branch', '--show-current') !== 'main') throw Error('Publish requires the current main branch');
    if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag' || git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', 'HEAD')) throw Error('Publish requires the annotated release tag on current HEAD');
    node('scripts/verify-release-tag.mjs', tag);
    node('scripts/sync-version.mjs', '--check');
    const remoteTag = inventory.tags.find(t => t.ref === `refs/tags/${tag}`);
    if (remoteTag) {
      if (remoteTag.object.sha !== git('rev-parse', `refs/tags/${tag}`)) throw Error('Remote tag differs; immutable reservation must not move');
      console.log('Identical tag already reserved remotely. No push performed; inspect/rerun its existing stable workflow.');
      return;
    }
    platformVersion(version);
    assertForward(version, inventory.versions);
    assertForward(version, localReservations(), true);
    // Atomic update and create-only tag (no force/ref replacement). Server-side
    // workflow validation rechecks ordering under the shared beta/stable lock.
    try { execFileSync('git', ['-c', 'push.followTags=false', '-c', 'remote.origin.mirror=false', 'push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: root, stdio: 'inherit' }); }
    catch { throw Error('Push failed or result is uncertain. Inspect remote main/tag and workflow state before retrying; local commit/tag retained. No fallback or force push was attempted'); }
    console.log('Release reservation pushed. Monitor Stable Release; tag creation is not publication success.');
    return;
  }
  platformVersion(version);
  if (localReservations().includes(version)) throw Error(`Local reservation ${tag} already exists; use publish or choose a greater version`);
  assertForward(version, localReservations());
  assertForward(version, (await remoteInventory()).versions);
  const head = git('rev-parse', 'HEAD');
  if (command === 'tag') {
    node('scripts/verify-release-tag.mjs', tag);
    // Reuse all existing mandatory preparation checks without changing metadata.
  }
  node('scripts/prepare-release.mjs', version, '--apply');
  try {
    const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
    if (changed.some(p => !VERSION_FILES.includes(p)) || git('ls-files', '--others', '--exclude-standard')) throw Error('Validation changed unrelated files; inspect before resuming');
    if (command === 'tag' && changed.length) throw Error('Tag requires already committed synchronized metadata; use prepare');
    if (git('rev-parse', 'HEAD') !== head) throw Error('HEAD changed during validation; inspect before resuming');
    if (changed.length) execFileSync('git', ['commit', '--only', '-m', `Release ${tag}`, '--', ...VERSION_FILES], { cwd: root, stdio: 'inherit' });
    clean();
    node('scripts/verify-release-tag.mjs', tag);
    node('scripts/sync-version.mjs', '--check');
    // History may advance during builds. Revalidate before the local reservation.
    assertForward(version, (await remoteInventory()).versions);
    assertForward(version, localReservations());
    git('tag', '-a', tag, '-m', `Pboard ${tag}`, 'HEAD');
    console.log(`Prepared annotated ${tag} on ${git('rev-parse', 'HEAD')}. No push. Next: scripts/release.sh publish ${version} --dry-run`);
  } catch (e) {
    throw Error(`${e.message}\nPreparation stopped at a resumable checkpoint. Inspect VERSION mirrors, index, HEAD and ${tag}; owned metadata/commit may remain. No refs were moved/deleted or pushed. Review/commit pending metadata first if needed, then use tag on the same version if no tag exists, or publish if the tag exists`);
  }
}
async function beta(args) {
  const { apply, values: [command, selector, coreInput, ...extra] } = mode(args);
  if (extra.length || !['next', 'allocate', 'retry'].includes(command)) throw Error('usage: beta-version.sh next [CORE] | allocate [REF [CORE]] | retry TAG [--dry-run|--apply]');
  const selected = readVersionState();
  const currentCore = Object.values(selected.core).join('.');
  const ref = selector ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) throw Error('Invalid source selector');
  const retry = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-dev\.[1-9]\d*$/.test(ref);
  if (command === 'retry' && (!retry || coreInput)) throw Error('retry requires exactly an existing vX.Y.Z-dev.N tag');
  if (command === 'next' && (apply || coreInput)) throw Error('next is a read-only preview; use next [CORE]');
  const core = command === 'next' ? selector ?? currentCore : coreInput ?? (retry ? ref.slice(1).split('-dev.')[0] : currentCore);
  official(core); if (core.includes('-')) throw Error('Beta core must be X.Y.Z');
  if (!selected.dev && !retry && !(command === 'next' ? selector : coreInput)) throw Error('Select a development VERSION or supply an explicit beta core');
  extensionVersion(`${core}-dev.1`); androidVersionCode(`${core}-dev.1`);
  if (command !== 'next') {
    console.log(JSON.stringify({ command, workflow: 'beta-release.yml', workflowRef: 'main', source: ref, core,
      allocation: retry ? 'retry exact immutable tag/source' : 'workflow inventories and reserves the next globally forward beta',
      remoteActions: 'dispatch Beta Release; workflow creates tag, builds, signs and publishes after approvals', dryRun: !apply }, null, 2));
    if (!apply) return;
  }
  const repo = repository();
  const inventory = await releaseInventory();
  if (command === 'next') {
    const candidate = nextBeta(core, [...inventory.versions, ...localReservations()]);
    platformVersion(candidate);
    console.log(candidate); console.error('Preview only; no reservation. Allocation revalidates in the shared workflow.');
    return;
  }
  // Pin remote branch selectors once. Existing beta tags must stay tag selectors
  // so the workflow's immutable-reservation retry path is used, never reallocation.
  const resolved = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`], { encoding: 'utf8' })).sha;
  if (!/^[a-f0-9]{40}$/.test(resolved)) throw Error('Remote source did not resolve to a full commit SHA');
  console.log(`Dispatching reviewed source ${resolved}; tag/version allocation remains in the workflow.`);
  try { execFileSync('gh', ['workflow', 'run', 'beta-release.yml', '--repo', repo, '--ref', 'main', '-f', `ref=${retry ? ref : resolved}`, '-f', `core=${core}`], { cwd: root, stdio: 'inherit' }); }
  catch { throw Error('Dispatch failed or result is uncertain. Inspect Beta Release runs before retrying to avoid a second allocation'); }
  console.log('Dispatch accepted; monitor Beta Release for reservation, build and publication results.');
}
try {
  const [kind, ...args] = process.argv.slice(2);
  if (kind === 'stable') await stable(args);
  else if (kind === 'beta') await beta(args);
  else throw Error('Expected stable or beta');
} catch (e) { console.error(e.message); process.exitCode = 1; }

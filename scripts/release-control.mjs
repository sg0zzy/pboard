// Trusted control-plane code. Never execute selected-source scripts with a write token.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { androidVersionCode } from './version.mjs';
import { assertForward, compareVersion, official, nextBeta, releaseReadiness, historyReservations, historicalVersion, extensionVersion } from './release-policy.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = () => JSON.parse(readFileSync(join(root, 'project-standards.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const repo = () => process.env.GITHUB_REPOSITORY ?? 'sg0zzy/pboard';
const output = values => {
  for (const [key, value] of Object.entries(values)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    else console.log(`${key}=${value}`);
  }
};
export async function remoteInventory() {
  const c = config();
  // Paginate both endpoints, including drafts. Deleted identities require durable ledger records.
  const pages = endpoint => gh('api', '--paginate', endpoint, '--jq', '.[] | @json').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const tags = pages(`repos/${repo()}/git/matching-refs/tags/`);
  const releases = pages(`repos/${repo()}/releases?per_page=100`);
  const unresolved = c.history?.unresolved;
  const versions = new Set(historyReservations(c));
  for (const name of [...tags.map(t => t.ref.replace('refs/tags/', '')), ...releases.map(r => r.tag_name)]) {
    versions.add(historicalVersion(c, name));
  }
  return { versions: [...versions], releases, tags, unresolved };
}
export async function releaseInventory() {
  const inventory = await remoteInventory();
  releaseReadiness(config());
  return inventory;
}
function trustSource(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Expected full committed SHA');
  git('merge-base', '--is-ancestor', sha, 'origin/main');
  const firefox = JSON.parse(git('show', `${sha}:manifest.json`));
  if (firefox.browser_specific_settings?.gecko?.id !== 'project-board@local.invalid') throw Error('Firefox listing identity changed');
  // The release config used by compilation must match the trusted control config.
  if (git('show', `${sha}:project-standards.json`) !== readFileSync(join(root, 'project-standards.json'), 'utf8').trim()) throw Error('Source/config differs from trusted release configuration');
}
function assetBytes(asset) {
  return execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo()}/releases/assets/${asset.id}`], { maxBuffer: 256 * 1024 * 1024 });
}
export function verifyPublished(release, channel, version, sha) {
  if (release.prerelease !== (channel === 'beta') || release.draft) throw Error('Existing release channel/visibility mismatch');
  const manifestAsset = release.assets.find(a => a.name === 'release-manifest.json');
  const sumsAsset = release.assets.find(a => a.name === 'SHA256SUMS.txt');
  if (!manifestAsset || !sumsAsset) throw Error('Existing release lacks mandatory integrity evidence; incident review required');
  const manifestBytes = assetBytes(manifestAsset), manifest = JSON.parse(manifestBytes);
  if (manifest.version !== version || manifest.gitCommitSha !== sha || manifest.configurationSha256 !== hash(join(root, 'project-standards.json')) || manifest.standardsCommit !== JSON.parse(readFileSync(join(root, 'dev-standards.lock.json'))).commit) throw Error('Existing release identity differs');
  const sums = new Map(assetBytes(sumsAsset).toString().trim().split(/\r?\n/).map(line => { const m = line.match(/^([a-f0-9]{64})  ([^/]+)$/); if (!m) throw Error('Invalid published checksums'); return [m[2], m[1]]; }));
  if (sums.get('release-manifest.json') !== createHash('sha256').update(manifestBytes).digest('hex')) throw Error('Published manifest hash mismatch');
  for (const target of config().matrix[channel].required) if (!manifest.targets.some(t => t.id === target && t.outcome === 'succeeded') || !manifest.outputs.some(f => f.target === target)) throw Error('Published mandatory target missing');
  if (release.assets.length !== manifest.outputs.length + 2) throw Error('Published asset inventory differs');
  for (const file of manifest.outputs) {
    const asset = release.assets.find(a => a.name === file.filename);
    if (!asset || asset.state !== 'uploaded' || sums.get(file.filename) !== file.sha256) throw Error('Published mandatory asset missing/mismatched');
    const bytes = assetBytes(asset);
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Published bytes differ; incident review required');
    if (file.target === 'android-release' && file.certificateSha256 !== config().signing['android-release'].certificateSha256.toLowerCase()) throw Error('Published Android signer differs');
  }
}
function record(state, values) {
  mkdirSync(join(root, 'release-record'), { recursive: true });
  writeFileSync(join(root, 'release-record/state.json'), JSON.stringify({ state, ...values, standardsCommit: JSON.parse(readFileSync(join(root, 'dev-standards.lock.json'))).commit, configurationSha256: hash(join(root, 'project-standards.json')), run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, utc: new Date().toISOString() }, null, 2));
}
async function validate(channel, selector, requestedCore) {
  let sha, version, tag;
  const inventory = await releaseInventory();
  if (channel === 'beta') {
    // Resolve the remote branch or full SHA exactly once, using validated arguments.
    if (!/^(?:[a-f0-9]{40}|[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(selector) || selector.includes('..')) throw Error('Invalid source selector');
    sha = JSON.parse(gh('api', `repos/${repo()}/commits/${encodeURIComponent(selector)}`)).sha;
    // Full trusted-main history already contains every eligible ancestor. No persisted Git credential is needed.
    trustSource(sha);
    const selected = git('show', `${sha}:VERSION`);
    const core = requestedCore || selected.replace(/-dev$/, '');
    if (!requestedCore && !selected.endsWith('-dev')) throw Error('Select an explicit beta core or a development VERSION');
    const retry = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-dev\.[1-9]\d*$/.test(selector);
    version = retry ? official(selector.slice(1)) : nextBeta(core, inventory.versions);
    if (retry) {
      if (version.split('-dev.')[0] !== core) throw Error('Retry core does not match requested beta');
      if (!inventory.releases.some(r => r.tag_name === selector && !r.draft)) assertForward(version, inventory.versions, true);
      const ref = JSON.parse(gh('api', `repos/${repo()}/git/ref/tags/${selector}`));
      if (ref.object.type !== 'tag') throw Error('Beta retry requires an annotated reservation');
      const object = JSON.parse(gh('api', `repos/${repo()}/git/tags/${ref.object.sha}`));
      if (object.object.sha !== sha) throw Error('Retry source differs from reserved tag');
    }
    extensionVersion(version);
    const code = androidVersionCode(version);
    if (!retry && code <= config().signing['android-release'].highestHistoricalCode) throw Error('Android code does not exceed reviewed historical/submission inventory');
    tag = `v${version}`;
    record('validated', { channel, version, sha, tag });
    // Create-only API; never updates an existing tag. Complete lifecycle has one concurrency group.
    if (!retry) {
    const tagObject = JSON.parse(gh('api', `repos/${repo()}/git/tags`, '-f', `tag=${tag}`, '-f', `message=Pboard ${tag}`, '-f', `object=${sha}`, '-f', 'type=commit'));
    gh('api', `repos/${repo()}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${tagObject.sha}`);
    }
  } else {
    tag = selector;
    version = official(tag.replace(/^v/, ''));
    if (version.includes('-') || tag !== `v${version}`) throw Error('Stable requires vMAJOR.MINOR.PATCH');
    if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') throw Error('Stable tag must be annotated');
    sha = git('rev-parse', `${tag}^{commit}`);
    trustSource(sha);
    if (git('show', `${sha}:VERSION`) !== version) throw Error('Stable source VERSION does not match tag');
    if (!inventory.releases.some(r => r.tag_name === tag && !r.draft)) assertForward(version, inventory.versions, true);
    extensionVersion(version);
    const code = androidVersionCode(version);
    if (!inventory.releases.some(r => r.tag_name === tag && !r.draft) && code <= config().signing['android-release'].highestHistoricalCode) throw Error('Android code does not exceed reviewed historical/submission inventory');
  }
  const refreshed = await remoteInventory();
  const published = refreshed.releases.find(r => r.tag_name === tag && !r.draft);
  if (published) {
    verifyPublished(published, channel, version, sha);
    record('published', { channel, version, sha, tag, recovery: 'verified identical existing publication; no rebuild or mutation' });
    output({ channel, version, sha, tag, already_published: 'true' });
    return;
  }
  assertForward(version, refreshed.versions, true);
  record('tag_reserved', { channel, version, sha, tag });
  output({ channel, version, sha, tag });
}
async function publish(channel, version, sha, directory, stageOnly = false) {
  const inventory = await releaseInventory();
  official(version); trustSource(sha);
  const tag = `v${version}`;
  if (!inventory.releases.some(r => r.tag_name === tag && !r.draft)) assertForward(version, inventory.versions, true);
  const remoteTag = JSON.parse(gh('api', `repos/${repo()}/git/ref/tags/${tag}`));
  if (remoteTag.object.type !== 'tag') throw Error('Expected annotated tag');
  const tagObject = JSON.parse(gh('api', `repos/${repo()}/git/tags/${remoteTag.object.sha}`));
  if (tagObject.object.sha !== sha) throw Error('Tag/source mismatch');
  const manifests = readdirSync(directory, { recursive: true }).filter(n => n.endsWith('build-info.json')).map(n => ({ path: join(directory, n), info: JSON.parse(readFileSync(join(directory, n))) }));
  const files = [], targets = [];
  for (const { path, info } of manifests) {
    if (info.version !== version || info.gitCommitSha !== sha || info.dirty !== false || info.state !== 'succeeded' || info.configurationSha256 !== hash(join(root, 'project-standards.json')) || info.standardsCommit !== JSON.parse(readFileSync(join(root, 'dev-standards.lock.json'))).commit) throw Error('Invalid release manifest source/config/state');
    for (const entry of info.outputs) {
      if (entry.filename !== basename(entry.filename) || entry.filename.startsWith('.')) throw Error('Unsafe asset path');
      const pathOnDisk = join(dirname(path), entry.filename);
      if (statSync(pathOnDisk).size !== entry.bytes || hash(pathOnDisk) !== entry.sha256) throw Error('Transport checksum mismatch');
      if (files.some(f => f.filename === entry.filename)) throw Error('Duplicate release asset');
      if (entry.target === 'android-release' && entry.certificateSha256 !== config().signing['android-release'].certificateSha256.toLowerCase()) throw Error('Wrong Android signer');
      files.push({ ...entry, pathOnDisk });
    }
    targets.push(...info.targets);
  }
  for (const target of config().matrix[channel].required) if (!targets.some(t => t.id === target && t.outcome === 'succeeded') || !files.some(f => f.target === target)) throw Error(`Missing mandatory target: ${target}`);
  const priorStable = inventory.releases.filter(r => !r.draft && !r.prerelease && r.tag_name !== tag).sort((a, b) => compareVersion(historicalVersion(config(), b.tag_name), historicalVersion(config(), a.tag_name)))[0];
  const range = priorStable ? `${priorStable.tag_name}..${sha}` : sha;
  if (priorStable) git('merge-base', '--is-ancestor', `${priorStable.tag_name}^{commit}`, sha); // Divergence requires reviewed reconciliation.
  const notes = `Pboard ${version}\n\nSource: ${sha}\nBaseline: ${priorStable?.tag_name ?? 'initial reachable history (including root)'}\nRange: ${range}\n\n${git('log', '--format=- %h %s', range)}\n\nPackages: Firefox/Chromium ZIPs are unsigned store-upload archives, not signed installable extensions. Android APK is release-signed. External delivery is manual/disabled.\n`;
  const staging = join(root, 'release-staging'); mkdirSync(staging, { recursive: true });
  const manifest = { schema: 1, project: 'pboard', version, channel, tag, gitCommitSha: sha, dirty: false, state: 'staged', standardsCommit: JSON.parse(readFileSync(join(root, 'dev-standards.lock.json'))).commit, configurationSha256: hash(join(root, 'project-standards.json')), previousStable: priorStable?.tag_name ?? null, range, targets, builds: manifests.map(m => m.info), outputs: files.map(({ pathOnDisk, ...f }) => f) };
  writeFileSync(join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(staging, 'SHA256SUMS.txt'), [...files.map(f => `${f.sha256}  ${f.filename}`), `${hash(join(staging, 'release-manifest.json'))}  release-manifest.json`].join('\n') + '\n');
  writeFileSync(join(staging, 'release-notes.md'), notes);
  const existing = inventory.releases.find(r => r.tag_name === tag);
  if (stageOnly) {
    output({ manifestSha256: hash(join(staging, 'release-manifest.json')), notesSha256: hash(join(staging, 'release-notes.md')) });
    return;
  }
  const reviewed = join(root, 'reviewed-release-plan');
  for (const file of ['release-manifest.json', 'SHA256SUMS.txt', 'release-notes.md']) if (!existsSync(join(reviewed, file)) || hash(join(reviewed, file)) !== hash(join(staging, file))) throw Error('Release plan changed or missing approval evidence; regenerate and review before publication');
  if (existing && !existing.draft) {
    verifyPublished(existing, channel, version, sha);
    record('published', { channel, version, sha, tag, recovery: 'verified existing immutable bytes' });
    return;
  }
  // Publication ordering is checked again under the shared beta/stable lifecycle lock.
  assertForward(version, inventory.releases.filter(r => !r.draft).map(r => historicalVersion(config(), r.tag_name)));
  if (!existing) gh('release', 'create', tag, '--verify-tag', '--draft', '--title', `Pboard ${version}`, '--notes-file', join(staging, 'release-notes.md'));
  record('staged', { channel, version, sha, tag, previousStable: priorStable?.tag_name });
  // Reconcile identical draft assets and upload only missing files; conflicts never clobber.
  const release = JSON.parse(gh('api', `repos/${repo()}/releases/tags/${tag}`));
  const wanted = [...files.map(f => ({ name: f.filename, path: f.pathOnDisk, sha256: f.sha256 })), ...['release-manifest.json', 'SHA256SUMS.txt'].map(name => ({ name, path: join(staging, name), sha256: hash(join(staging, name)) }))];
  for (const asset of release.assets) {
    const expected = wanted.find(f => f.name === asset.name);
    if (!expected || asset.state !== 'uploaded' || createHash('sha256').update(assetBytes(asset)).digest('hex') !== expected.sha256) throw Error('Conflicting/incomplete draft asset; audited manual reconciliation required');
  }
  const missing = wanted.filter(f => !release.assets.some(a => a.name === f.name));
  record('staged', { channel, version, sha, tag, recovery: { verifiedExistingAssets: release.assets.map(a => a.name), missingAssets: missing.map(a => a.name) } });
  if (missing.length) gh('release', 'upload', tag, ...missing.map(f => f.path));
  const uploaded = JSON.parse(gh('api', `repos/${repo()}/releases/tags/${tag}`));
  const expected = [...files.map(f => ({ name: f.filename, hash: f.sha256 })), ...['release-manifest.json', 'SHA256SUMS.txt'].map(name => ({ name, hash: hash(join(staging, name)) }))];
  if (uploaded.assets.length !== expected.length) throw Error('Mandatory upload count mismatch');
  for (const f of expected) {
    const asset = uploaded.assets.find(a => a.name === f.name);
    if (!asset || asset.state !== 'uploaded') throw Error(`Missing uploaded asset: ${f.name}`);
    // Verify actual uploaded bytes before visibility change; do not rely only on API receipt.
    const data = assetBytes(asset);
    if (createHash('sha256').update(data).digest('hex') !== f.hash) throw Error('Uploaded bytes differ');
  }
  const fresh = await remoteInventory();
  assertForward(version, fresh.versions, true);
  gh('api', '--method', 'PATCH', `repos/${repo()}/releases/${uploaded.id}`, '-F', 'draft=false', '-F', `prerelease=${channel === 'beta'}`, '-f', `make_latest=${channel === 'beta' ? 'false' : 'true'}`);
  record('published', { channel, version, sha, tag });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'validate') await validate(...args);
    else if (command === 'stage') await publish(...args, true);
    else if (command === 'publish') await publish(...args);
    else if (command === 'preflight') await releaseInventory();
    else if (command === 'inventory') console.log(JSON.stringify(await remoteInventory(), null, 2));
    else throw Error('usage: release-control.mjs preflight|inventory|validate CHANNEL SELECTOR [CORE]|publish CHANNEL VERSION SHA DIRECTORY');
  } catch (e) { record('failed', { command, reason: e.message }); console.error(e.message); process.exitCode = 1; }
}

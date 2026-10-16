// Repository-owned artifact transactions. Legacy/unknown layouts are never collected.
import { mkdirSync, lstatSync, realpathSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './release-policy.mjs';
import { randomUUID, createHash } from 'node:crypto';

export const ARTIFACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../local_artifacts');
export const RETENTION_DEFAULT = 10;
export const MANAGER = 'pboard-local-builds';
const stat = p => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function safeRoot(root, create = false) {
  root = resolve(root);
  if (create && !stat(root)) {
    if (realpathSync(dirname(root)) !== dirname(root)) throw Error('Artifact root parent must not contain symlinks');
    mkdirSync(root);
  }
  if (!stat(root)) return root;
  if (!stat(root).isDirectory() || stat(root).isSymbolicLink() || realpathSync(root) !== root) throw Error('Artifact root must be a canonical directory without symlinks');
  return root;
}
export function withArtifactLock(root, operation) {
  root = safeRoot(root, true);
  const lock = join(root, '.retention.lock');
  const start = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > 5000) throw Error('artifact lock timeout; inspect active processes before recovering the lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return operation(root); } finally { rmSync(lock, { recursive: true }); }
}
export function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
export function readManaged(dir) {
  const ds = stat(dir), ms = stat(join(dir, 'build-info.json'));
  if (!ds?.isDirectory() || ds.isSymbolicLink() || !ms?.isFile() || ms.isSymbolicLink()) return null;
  try {
    const m = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8'));
    if (m.schema !== 1 || m.manager !== MANAGER || m.buildId !== basename(dir) || typeof m.version !== 'string' || !['in_progress', 'succeeded', 'failed'].includes(m.state)) return null;
    if (!Array.isArray(m.outputs) || !Array.isArray(m.targets)) return null;
    if (m.state === 'succeeded') {
      if (!Number.isSafeInteger(m.completionSequence) || m.completionSequence < 1 || !Number.isFinite(Date.parse(m.completedAt)) || !m.outputs.length) return null;
      if (!m.targets.length || m.targets.some(t => t.required && t.outcome !== 'succeeded')) return null;
      for (const o of m.outputs) {
        if (typeof o.filename !== 'string' || o.filename !== basename(o.filename) || o.filename.startsWith('.') || !/^[a-f0-9]{64}$/.test(o.sha256) || !Number.isSafeInteger(o.bytes) || o.bytes <= 0) return null;
        const s = stat(join(dir, o.filename));
        if (!s?.isFile() || s.isSymbolicLink() || s.size !== o.bytes) return null;
      }
    }
    return { manifest: m, dev: ds.dev, ino: ds.ino };
  } catch { return null; }
}
export function inspectBuilds(root = ARTIFACTS_DIR) {
  root = safeRoot(root);
  if (!stat(root)) return [];
  const entries = readdirSync(root).filter(n => !n.startsWith('.')).map(name => {
    const path = join(root, name), managed = readManaged(path);
    return { path, ...managed, protected: !!stat(join(path, '.keep')), reason: !managed ? 'unknown/malformed/legacy' : managed.manifest.state };
  });
  const counts = new Map();
  for (const e of entries) if (e.manifest?.state === 'succeeded') counts.set(e.manifest.completionSequence, (counts.get(e.manifest.completionSequence) ?? 0) + 1);
  for (const e of entries) {
    if ((counts.get(e.manifest?.completionSequence) ?? 0) > 1) e.reason = 'ambiguous completion sequence';
    e.eligible = e.reason === 'succeeded' && !e.protected;
  }
  return entries;
}
export function retentionCandidates(root = ARTIFACTS_DIR) {
  return inspectBuilds(root).filter(e => e.eligible).map(e => ({ ...e, buildId: e.manifest.buildId, utcTime: e.manifest.completedAt })).sort((a, b) => a.manifest.completionSequence - b.manifest.completionSequence);
}
export function buildsToDelete(candidates, keep) {
  if (!Number.isSafeInteger(keep) || keep < 0) throw Error('Retention must be a nonnegative integer');
  return candidates.slice(0, Math.max(0, candidates.length - keep)).map(e => e.path);
}
export function runRetention(keep = RETENTION_DEFAULT, root = ARTIFACTS_DIR) {
  return withArtifactLock(root, root => {
    const candidates = retentionCandidates(root), targets = new Set(buildsToDelete(candidates, keep)), deleted = [];
    for (const candidate of candidates.filter(e => targets.has(e.path))) {
      safeRoot(root);
      const current = readManaged(candidate.path);
      if (!current || current.dev !== candidate.dev || current.ino !== candidate.ino || current.manifest.state !== 'succeeded' || stat(join(candidate.path, '.keep'))) continue;
      // Move under the same lock to a private direct child, then revalidate before deleting.
      const tomb = join(root, `.collect-${randomUUID()}`);
      renameSync(candidate.path, tomb);
      const moved = stat(tomb);
      if (!moved?.isDirectory() || moved.isSymbolicLink() || moved.ino !== current.ino || moved.dev !== current.dev || stat(join(tomb, '.keep'))) {
        renameSync(tomb, candidate.path);
        continue;
      }
      rmSync(tomb, { recursive: true }); // Node unlinks internal symlinks, never traverses them.
      deleted.push(candidate.path);
    }
    return deleted;
  });
}
export function createBuild(manifest, root = ARTIFACTS_DIR) {
  return withArtifactLock(root, root => {
    if (!/^[a-zA-Z0-9._-]+$/.test(manifest.buildId) || manifest.buildId.startsWith('.')) throw Error('Invalid build ID');
    const dir = join(root, manifest.buildId);
    mkdirSync(dir); // Exclusive direct-child reservation.
    atomicJson(join(dir, 'build-info.json'), { ...manifest, schema: 1, manager: MANAGER, state: 'in_progress', startedAt: new Date().toISOString(), targets: manifest.targets ?? [], outputs: [] });
    return dir;
  });
}
export function updateBuild(dir, update, success = false) {
  return withArtifactLock(dirname(dir), root => {
    if (dirname(resolve(dir)) !== root) throw Error('Build must be a direct child');
    const record = readManaged(dir);
    if (!record || record.manifest.state !== 'in_progress') throw Error('Expected owned in-progress build');
    const m = { ...record.manifest, ...update };
    if (success) {
      if (!m.outputs.length || m.targets.some(t => t.required && t.outcome !== 'succeeded')) throw Error('Mandatory target incomplete');
      for (const o of m.outputs) {
        if (o.filename !== basename(o.filename) || o.filename.startsWith('.')) throw Error('Invalid artifact path');
        const path = join(dir, o.filename), s = stat(path);
        if (!s?.isFile() || s.isSymbolicLink() || s.size !== o.bytes || createHash('sha256').update(readFileSync(path)).digest('hex') !== o.sha256) throw Error('Artifact integrity failure');
      }
      const sequencePath = join(root, '.completion-sequence.json');
      const prior = existsSync(sequencePath) ? JSON.parse(readFileSync(sequencePath, 'utf8')).sequence : 0;
      if (!Number.isSafeInteger(prior) || prior < 0) throw Error('Invalid completion sequence');
      const highest = Math.max(0, ...inspectBuilds(root).map(e => e.manifest?.completionSequence ?? 0));
      m.completionSequence = Math.max(prior, highest) + 1;
      if (!Number.isSafeInteger(m.completionSequence)) throw Error('Completion sequence exhausted');
      atomicJson(sequencePath, { sequence: m.completionSequence });
      m.state = 'succeeded'; m.completedAt = new Date().toISOString();
    }
    atomicJson(join(dir, 'build-info.json'), m);
    return m;
  });
}
export function protectBuild(id, root = ARTIFACTS_DIR) {
  return withArtifactLock(root, root => {
    if (id !== basename(id) || id.startsWith('.') || !readManaged(join(root, id))) throw Error('Unknown managed build');
    writeFileSync(join(root, id, '.keep'), '', { flag: 'wx' });
  });
}
export function removeBuild(id, confirmation, root = ARTIFACTS_DIR) {
  return withArtifactLock(root, root => {
    if (id !== basename(id) || id.startsWith('.')) throw Error('Select one direct managed build ID');
    const path = join(root, id), record = readManaged(path);
    if (!record) throw Error('Unknown/malformed/legacy builds cannot be removed by this interface');
    const plan = { buildId: id, state: record.manifest.state, protected: !!stat(join(path, '.keep')), action: 'explicitly remove this build including protection' };
    if (confirmation === undefined) return plan;
    if (confirmation !== id) throw Error('Confirmation must repeat the exact build ID');
    const current = readManaged(path);
    if (!current || current.ino !== record.ino || current.dev !== record.dev) throw Error('Build identity changed; inspect again');
    const tomb = join(root, `.remove-${randomUUID()}`);
    renameSync(path, tomb);
    const moved = stat(tomb);
    if (!moved?.isDirectory() || moved.isSymbolicLink() || moved.ino !== record.ino || moved.dev !== record.dev) {
      renameSync(tomb, path); throw Error('Build identity changed; no deletion performed');
    }
    rmSync(tomb, { recursive: true });
    return { ...plan, removed: true };
  });
}
export function runCli() {
  const args = process.argv.slice(2);
  if (args[0] === '--remove') {
    if (args.length === 3 && args[2] === '--dry-run') console.log(JSON.stringify(removeBuild(args[1]), null, 2));
    else if (args.length === 4 && args[2] === '--confirm') console.log(JSON.stringify(removeBuild(args[1], args[3]), null, 2));
    else throw Error('usage: --remove BUILD_ID --dry-run | --remove BUILD_ID --confirm BUILD_ID');
    return;
  }
  if (args[0] === '--protect' && args.length === 2) { protectBuild(args[1]); return; }
  const match = args.join(' ').match(/^(--dry-run|--run)(?: --keep (0|[1-9]\d*))?$/);
  if (!match) throw Error('usage: artifact-retention.mjs --dry-run|--run [--keep N] | --protect BUILD_ID');
  const config = validateConfig(JSON.parse(readFileSync(new URL('../project-standards.json', import.meta.url), 'utf8')));
  const keep = match[2] === undefined ? config.retention ?? RETENTION_DEFAULT : Number(match[2]);
  if (!Number.isSafeInteger(keep) || keep < 0) throw Error('Invalid retention');
  if (match[1] === '--dry-run' && !stat(ARTIFACTS_DIR)) { console.log(JSON.stringify({ keep, plan: [] })); return; }
  const plan = withArtifactLock(ARTIFACTS_DIR, root => {
    const candidates = retentionCandidates(root), deletes = new Set(buildsToDelete(candidates, keep));
    return inspectBuilds(root).map(e => ({ path: basename(e.path), buildId: e.manifest?.buildId, sequence: e.manifest?.completionSequence, protected: e.protected, action: deletes.has(e.path) ? 'delete' : 'retain', reason: e.protected ? '.keep' : e.reason }));
  });
  console.log(JSON.stringify({ keep, plan }, null, 2));
  if (match[1] === '--run') for (const path of runRetention(keep)) console.log(`deleted ${basename(path)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

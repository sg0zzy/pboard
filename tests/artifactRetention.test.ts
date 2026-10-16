// Destructive acceptance tests use fresh temporary storage only.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBuild, updateBuild, runRetention, retentionCandidates, protectBuild, inspectBuilds, removeBuild } from '../scripts/artifact-retention.mjs';
let fixture: string, storage: string;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'pboard-retention-test-')); storage = join(fixture, 'local_artifacts'); });
afterEach(() => rmSync(fixture, { recursive: true, force: true }));
function start(id: string) { return createBuild({ buildId: id, version: '0.10.3-local.1', targets: [{ id: 'test', required: true, outcome: 'pending' }] }, storage); }
function complete(dir: string) {
  writeFileSync(join(dir, 'test.zip'), 'artifact');
  return updateBuild(dir, { targets: [{ id: 'test', required: true, outcome: 'succeeded' }], outputs: [{ filename: 'test.zip', bytes: 8, sha256: createHash('sha256').update('artifact').digest('hex') }] }, true);
}
const edit = (dir: string, fields: object) => {
  const file = join(dir, 'build-info.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...fields }));
};
describe('managed local artifacts', () => {
  it('reserves exclusive direct children and refuses an identity collision', () => {
    const dir = start('first'); expect(basename(dir)).toBe('first');
    expect(() => start('first')).toThrow();
    expect(() => start('../escape')).toThrow();
    expect(() => updateBuild(dir, {}, true)).toThrow(/incomplete/);
  });
  it('keeps exactly 10 newest successful unprotected builds and reports a nonmutating plan', () => {
    const dirs = Array.from({ length: 12 }, (_, n) => { const dir = start(`b${n}`); complete(dir); return dir; });
    const plan = retentionCandidates(storage); expect(plan).toHaveLength(12); expect(existsSync(dirs[0])).toBe(true);
    expect(runRetention(10, storage)).toEqual(dirs.slice(0, 2)); expect(runRetention(10, storage)).toEqual([]);
  });
  it('orders by completion sequence when completion reverses start order and clocks disagree', () => {
    const first = start('started-first'), second = start('started-second');
    complete(second); complete(first);
    edit(second, { completedAt: '2099-01-01T00:00:00Z' }); edit(first, { completedAt: '2000-01-01T00:00:00Z' });
    expect(runRetention(1, storage)).toEqual([second]);
  });
  it('protects .keep entries of any type and replans stale dry-run selections', () => {
    const old = start('old'); complete(old); const next = start('next'); complete(next);
    expect(retentionCandidates(storage)).toHaveLength(2); protectBuild('old', storage);
    expect(runRetention(0, storage)).toEqual([next]); expect(existsSync(old)).toBe(true);
    rmSync(join(old, '.keep')); symlinkSync(join(fixture, 'missing'), join(old, '.keep'));
    expect(runRetention(0, storage)).toEqual([]);
  });
  it('excludes in-progress, failed, malformed and legacy layouts', () => {
    const active = start('active'), failed = start('failed'); updateBuild(failed, { state: 'failed' });
    const malformed = start('malformed'); complete(malformed); edit(malformed, { manager: 'unknown' });
    mkdirSync(join(storage, 'legacy', 'nested'), { recursive: true });
    expect(runRetention(0, storage)).toEqual([]);
    expect(inspectBuilds(storage).every(e => !e.eligible)).toBe(true); expect(existsSync(active)).toBe(true);
  });
  it('retains duplicate completion sequences and rejects malformed output paths', () => {
    const a = start('a'), b = start('b'), c = start('c'); complete(a); complete(b); complete(c);
    edit(b, { completionSequence: 1 });
    edit(c, { outputs: [{ filename: '../outside', bytes: 1, sha256: 'a'.repeat(64) }] });
    expect(runRetention(0, storage)).toEqual([]);
  });
  it('validates integrity before success and never changes a completed build', () => {
    const a = start('a'); writeFileSync(join(a, 'bad.zip'), 'x');
    expect(() => updateBuild(a, { targets: [{ id: 'test', required: true, outcome: 'succeeded' }], outputs: [{ filename: 'bad.zip', bytes: 1, sha256: 'a'.repeat(64) }] }, true)).toThrow(/integrity/);
    complete(a); expect(() => updateBuild(a, { state: 'failed' })).toThrow(/in-progress/);
  });
  it('rejects negative/NaN retention; keep zero deletes the newest success', () => {
    const a = start('a'); complete(a);
    expect(() => runRetention(-1, storage)).toThrow(); expect(() => runRetention(NaN, storage)).toThrow();
    expect(runRetention(0, storage)).toEqual([a]);
  });
  it('refuses symlinked roots/children and unlinks internal links without following them', () => {
    mkdirSync(storage); const outside = join(fixture, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'preserve');
    symlinkSync(outside, join(storage, 'external'));
    const a = start('a'); complete(a); symlinkSync(outside, join(a, 'link'));
    expect(runRetention(0, storage)).toEqual([a]); expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('preserve');
    const alias = join(fixture, 'alias'); symlinkSync(storage, alias);
    expect(() => runRetention(0, alias)).toThrow(/symlinks/);
  });
  it('requires exact selection and confirmation for manual protected/failed recovery', () => {
    const failed = start('failed'); updateBuild(failed, { state: 'failed' }); protectBuild('failed', storage);
    expect(removeBuild('failed', undefined, storage).protected).toBe(true); expect(existsSync(failed)).toBe(true);
    expect(() => removeBuild('failed', 'another', storage)).toThrow(/Confirmation/);
    expect(removeBuild('failed', 'failed', storage).removed).toBe(true);
    expect(() => removeBuild('../outside', '../outside', storage)).toThrow();
    mkdirSync(join(storage, 'unknown')); expect(() => removeBuild('unknown', 'unknown', storage)).toThrow(/Unknown/);
  });
  it('fails closed on stale locks', { timeout: 10000 }, () => {
    start('a'); mkdirSync(join(storage, '.retention.lock'));
    expect(() => runRetention(0, storage)).toThrow(/lock timeout/);
  });
  it('serializes separate concurrent processes sharing storage', () => {
    const module = new URL('../scripts/artifact-retention.mjs', import.meta.url).href;
    const child = `import {createBuild,updateBuild} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {createHash} from 'node:crypto'; const root=process.argv[1], id=process.argv[2];const d=createBuild({buildId:id,version:'0.10.3-local.1',targets:[{id:'test',required:true,outcome:'pending'}]},root);writeFileSync(join(d,'x'),'x');updateBuild(d,{targets:[{id:'test',required:true,outcome:'succeeded'}],outputs:[{filename:'x',bytes:1,sha256:createHash('sha256').update('x').digest('hex')}]},true);`;
    // Parent test starts both children before awaiting either exit.
    const orchestrator = `import {spawn} from 'node:child_process'; const code=process.argv[1],root=process.argv[2]; await Promise.all(['a','b'].map(id=>new Promise((ok,bad)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,root,id],{stdio:'inherit'});p.on('exit',c=>c===0?ok():bad(Error('child failed')))})));`;
    execFileSync(process.execPath, ['--input-type=module', '-e', orchestrator, child, storage]);
    const sequences = retentionCandidates(storage).map(c => JSON.parse(readFileSync(join(c.path, 'build-info.json'), 'utf8')).completionSequence);
    expect(sequences).toEqual([1, 2]); expect(runRetention(1, storage)).toHaveLength(1);
  });
});

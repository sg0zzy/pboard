// Isolated Git repositories and fake GitHub/npm processes: no network, real release refs or builds.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
let root, bin, env;
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8' }).trim();
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n');
const run = (script, ...args) => spawnSync('bash', [join(root, 'scripts', script), ...args], { cwd: tmpdir(), env, encoding: 'utf8' });
const mirrorFiles = ['VERSION', 'manifest.json', 'manifest.chromium.json', 'package.json', 'package-lock.json', 'apps/android/package.json', 'apps/android/package-lock.json', 'apps/android/android/app/build.gradle'];
const snapshot = () => mirrorFiles.map(f => readFileSync(join(root, f), 'utf8'));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pboard-release-cli-')); bin = join(root, 'fake-bin'); mkdirSync(bin);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'apps/android/android/app'), { recursive: true });
  for (const file of ['version.sh', 'release.sh', 'beta-version.sh', 'version.mjs', 'release-cli.mjs', 'release-control.mjs', 'release-policy.mjs', 'prepare-release.mjs', 'sync-version.mjs', 'verify-release-tag.mjs']) {
    cpSync(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  }
  for (const name of mirrorFiles) cpSync(new URL(`../${name}`, import.meta.url), join(root, name));
  // A fixed historical fixture keeps transition tests independent of the real VERSION.
  writeFileSync(join(root, 'VERSION'), '0.10.2\n');
  for (const name of mirrorFiles.slice(1, -1)) {
    const metadata = JSON.parse(readFileSync(join(root, name)));
    metadata.version = '0.10.2';
    if (name.endsWith('package-lock.json')) metadata.packages[''].version = '0.10.2';
    save(name, metadata);
  }
  const gradle = join(root, mirrorFiles.at(-1));
  writeFileSync(gradle, readFileSync(gradle, 'utf8').replace(/versionCode\s+\d+/, 'versionCode 10002999').replace(/versionName\s+"[^"]*"/, 'versionName "0.10.2"'));
  const c = JSON.parse(readFileSync(new URL('../project-standards.json', import.meta.url)));
  c.history.reviewed = true;
  Object.assign(c.signing['android-release'], { historyReviewed: true, highestHistoricalCode: 0, certificateSha256: 'a'.repeat(64) });
  save('project-standards.json', c); save('remote-fixture.json', { tags: [], releases: [] });
  writeFileSync(join(root, '.gitignore'), 'fake-bin/\nremote-fixture.json\napi-audit.jsonl\ncommands.jsonl\n');
  writeFileSync(join(root, 'scripts/build_android.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(bin, 'npm'), `#!${process.execPath}\nif(process.env.FAIL_CHECK)process.exit(1);\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
const root=${JSON.stringify(root)}, a=process.argv.slice(2), state=JSON.parse(readFileSync(join(root,'remote-fixture.json')));
appendFileSync(join(root,'api-audit.jsonl'),JSON.stringify(a)+'\\n');
if(a[0]==='workflow'){ if(process.env.FAIL_DISPATCH)process.exit(1); process.exit(0); }
const endpoint=a.find(x=>x.startsWith('repos/'));
if(endpoint.endsWith('/git/matching-refs/tags/'))for(const t of state.tags)console.log(JSON.stringify(t));
else if(endpoint.includes('/releases?'))for(const r of state.releases)console.log(JSON.stringify(r));
else if(endpoint.includes('/commits/'))console.log(JSON.stringify({sha:'a'.repeat(40)}));
else throw Error('Unexpected or mutating API');
`, { mode: 0o700 });
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import {spawnSync} from 'node:child_process';import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2);
if(process.env.FAIL_TAG && a[0]==='tag' && a.includes('-a'))process.exit(1);
if(a.includes('push')){appendFileSync(${JSON.stringify(join(root, 'commands.jsonl'))},JSON.stringify(a)+'\\n');process.exit(0);}
const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o700 });
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }; delete env.GITHUB_REPOSITORY;
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('remote', 'add', 'origin', 'https://github.com/sg0zzy/pboard.git');
  git('add', '.'); git('commit', '-m', 'fixture');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function inventory(versions) {
  save('remote-fixture.json', { tags: versions.map(v => ({ ref: `refs/tags/v${v}`, object: { sha: 'b'.repeat(40) } })), releases: [] });
}
function audit() { return existsSync(join(root, 'api-audit.jsonl')) ? readFileSync(join(root, 'api-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []; }

describe('version Bash interface', () => {
  it.each([['patch', '0.10.3'], ['minor', '0.11.0'], ['major', '1.0.0']])('bumps %s, synchronizes every mirror and leaves refs unchanged', (kind, core) => {
    const head = git('rev-parse', 'HEAD'), code = readFileSync(join(root, mirrorFiles.at(-1)), 'utf8').match(/versionCode\s+(\d+)/)[1];
    const result = run('version.sh', 'bump', kind); expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'VERSION'), 'utf8').trim()).toBe(`${core}-dev`);
    for (const file of mirrorFiles.slice(1, -1)) expect(JSON.parse(readFileSync(join(root, file))).version).toBe(core);
    expect(readFileSync(join(root, mirrorFiles.at(-1)), 'utf8')).toContain(`versionCode ${code}`);
    expect(run('version.sh', '--check').status).toBe(0); expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('tag')).toBe(''); expect(audit()).toEqual([]);
  });
  it('supports show and a fully nonmutating bump preview', () => {
    const before = snapshot(); expect(run('version.sh', 'show').stdout).toContain('0.10.2');
    expect(run('version.sh', 'bump', 'minor', '--dry-run').status).toBe(0);
    expect(snapshot()).toEqual(before); expect(git('status', '--porcelain')).toBe('');
  });
  it('refuses regression against an uncommitted selection, malformed input, and adapter overflow without edits', () => {
    expect(run('version.sh', 'set', '0.12.0-dev').status).toBe(0);
    const before = snapshot();
    for (const args of [['set','0.11.0-dev'], ['set','01.13.0-dev'], ['set','21.0.0-dev'], ['bump','minor','--bogus'], ['show','extra']]) expect(run('version.sh',...args).status).toBe(1);
    expect(snapshot()).toEqual(before);
  });
  it('keeps failed local and durable reservations in the development-core floor', () => {
    git('tag','-a','v0.11.0-dev.9','-m','failed beta');
    expect(run('version.sh','bump','patch').stderr).toContain('known reservation');
    const c=JSON.parse(readFileSync(join(root,'project-standards.json')));c.history.reservations=['0.12.0'];save('project-standards.json',c);
    expect(run('version.sh','set','0.12.0-dev').stderr).toContain('known reservation');
    expect(run('version.sh','set','0.13.0-dev','--dry-run').status).toBe(0);
  });
  it('restores all metadata when synchronization fails part way through', () => {
    writeFileSync(join(root, 'apps/android/package.json'), '{broken'); const before = snapshot();
    expect(run('version.sh', 'bump', 'patch').stderr).toContain('original metadata restored');
    expect(snapshot()).toEqual(before);
  });
});

describe('stable Bash interface', () => {
  it('defaults to a source/ref/index/remote nonmutating plan, even with dirty work', () => {
    writeFileSync(join(root, 'notes.txt'), 'preserve');
    const head = git('rev-parse', 'HEAD'), index = git('write-tree'), before = snapshot();
    const r = run('release.sh','prepare','0.11.0'); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain('dedicated metadata commit');
    expect(git('rev-parse','HEAD')).toBe(head); expect(git('write-tree')).toBe(index); expect(snapshot()).toEqual(before); expect(audit()).toEqual([]);
    expect(run('release.sh','prepare','0.11.0','--apply').stderr).toContain('clean intended source'); expect(readFileSync(join(root,'notes.txt'),'utf8')).toBe('preserve');
  });
  it('prepares a dedicated metadata commit and annotated tag, with no push', () => {
    const previous = git('rev-parse','HEAD');
    const r=run('release.sh','prepare','0.11.0','--apply'); expect(r.status,r.stderr).toBe(0);
    expect(git('rev-parse','HEAD^')).toBe(previous); expect(git('cat-file','-t','refs/tags/v0.11.0')).toBe('tag');
    expect(git('rev-parse','v0.11.0^{commit}')).toBe(git('rev-parse','HEAD')); expect(git('status','--porcelain')).toBe('');
    expect(existsSync(join(root,'commands.jsonl'))).toBe(false);
    expect(run('release.sh','prepare','0.11.0','--apply').stderr).toContain('already exists');
  });
  it('restores metadata and creates no tag/commit on required validation failure', () => {
    const head=git('rev-parse','HEAD'), before=snapshot(); env.FAIL_CHECK='1';
    expect(run('release.sh','prepare','0.11.0','--apply').status).toBe(1);
    expect(snapshot()).toEqual(before); expect(git('rev-parse','HEAD')).toBe(head); expect(git('tag')).toBe('');
  });
  it('does not commit again when the selected version is already committed', () => {
    const head=git('rev-parse','HEAD');
    const r=run('release.sh','tag','0.10.2','--apply'); expect(r.status,r.stderr).toBe(0);
    expect(git('rev-parse','HEAD')).toBe(head); expect(git('cat-file','-t','refs/tags/v0.10.2')).toBe('tag');
  });
  it('blocks malformed, reserved, superseded and unready release selections before edits', () => {
    const before=snapshot(); inventory(['0.12.0-dev.1']);
    expect(run('release.sh','prepare','0.11.0','--apply').stderr).toContain('does not exceed');
    expect(run('release.sh','prepare','01.11.0','--apply').status).toBe(1);
    const c=JSON.parse(readFileSync(join(root,'project-standards.json')));c.history.reviewed=false;save('project-standards.json',c);git('add','project-standards.json');git('commit','-m','unready');
    expect(run('release.sh','prepare','0.11.0','--apply').stderr).toContain('Release blocked'); expect(snapshot()).toEqual(before);
  });
  it('publishes only the explicit branch/tag atomically after revalidation', () => {
    expect(run('release.sh','prepare','0.11.0','--apply').status).toBe(0);
    expect(run('release.sh','publish','0.11.0','--dry-run').status).toBe(0);expect(existsSync(join(root,'commands.jsonl'))).toBe(false);
    const r=run('release.sh','publish','0.11.0','--apply');expect(r.status,r.stderr).toBe(0);
    const args=JSON.parse(readFileSync(join(root,'commands.jsonl'),'utf8'));expect(args).toContain('--atomic');expect(args).toContain('refs/heads/main:refs/heads/main');expect(args).toContain('refs/tags/v0.11.0:refs/tags/v0.11.0');expect(args).not.toContain('--force');
  });
  it('leaves a resumable version commit after tag failure and resumes without another commit', () => {
    env.FAIL_TAG='1';
    const r=run('release.sh','prepare','0.11.0','--apply');expect(r.status).toBe(1);expect(r.stderr).toContain('resumable checkpoint');
    expect(git('tag')).toBe('');expect(git('status','--porcelain')).toBe('');expect(readFileSync(join(root,'VERSION'),'utf8').trim()).toBe('0.11.0');
    const checkpoint=git('rev-parse','HEAD');delete env.FAIL_TAG;
    const resumed=run('release.sh','tag','0.11.0','--apply');expect(resumed.status,resumed.stderr).toBe(0);expect(git('rev-parse','HEAD')).toBe(checkpoint);
  });
  it('reconciles identical remote tags as a no-op and refuses conflicting tag objects', () => {
    expect(run('release.sh','prepare','0.11.0','--apply').status).toBe(0);
    save('remote-fixture.json',{tags:[{ref:'refs/tags/v0.11.0',object:{sha:git('rev-parse','refs/tags/v0.11.0')}}],releases:[]});
    const same=run('release.sh','publish','0.11.0','--apply');expect(same.status,same.stderr).toBe(0);expect(same.stdout).toContain('No push performed');
    inventory(['0.11.0']);expect(run('release.sh','publish','0.11.0','--apply').stderr).toContain('Remote tag differs');expect(existsSync(join(root,'commands.jsonl'))).toBe(false);
  });
  it('does not publish from a feature branch or to an unrelated remote', () => {
    expect(run('release.sh','prepare','0.11.0','--apply').status).toBe(0);
    git('checkout','-b','feature');expect(run('release.sh','publish','0.11.0','--apply').stderr).toContain('current main');
    git('checkout','main');git('remote','set-url','--push','origin','https://github.com/example/other.git');
    expect(run('release.sh','publish','0.11.0','--apply').stderr).toContain('configured GitHub repository');
    git('config','--unset-all','remote.origin.pushurl');git('remote','set-url','origin','https://github.com/example/other.git');
    expect(run('release.sh','publish','0.11.0','--apply').stderr).toContain('configured GitHub repository');expect(existsSync(join(root,'commands.jsonl'))).toBe(false);
  });
  it('rejects a newer reservation appearing between preparation and push', () => {
    expect(run('release.sh','prepare','0.11.0','--apply').status).toBe(0);inventory(['0.12.0-dev.1']);
    expect(run('release.sh','publish','0.11.0','--apply').stderr).toContain('does not exceed');expect(existsSync(join(root,'commands.jsonl'))).toBe(false);
  });
});

describe('beta Bash interface', () => {
  it('previews without network, edits or refs; does not consume beta numbers', () => {
    const before=snapshot();const r=run('beta-version.sh','allocate','main','0.11.0');expect(r.status,r.stderr).toBe(0);
    expect(r.stdout).toContain('workflow inventories');expect(audit()).toEqual([]);expect(snapshot()).toEqual(before);expect(git('tag')).toBe('');
  });
  it('uses complete reservations for next and refuses older cores', () => {
    inventory(['0.10.2','0.11.0-dev.2','0.11.0-dev.10']);
    expect(run('beta-version.sh','next','0.11.0').stdout.trim()).toBe('0.11.0-dev.11');
    expect(run('beta-version.sh','next','0.10.3').stderr).toContain('does not exceed');expect(git('tag')).toBe('');
  });
  it('dispatches trusted main workflow with a pinned SHA and explicit core, without local tags', () => {
    const before=snapshot();const r=run('beta-version.sh','allocate','reviewed-branch','0.11.0','--apply');expect(r.status,r.stderr).toBe(0);
    const call=audit().find(a=>a[0]==='workflow');expect(call).toEqual(['workflow','run','beta-release.yml','--repo','sg0zzy/pboard','--ref','main','-f',`ref=${'a'.repeat(40)}`,'-f','core=0.11.0']);
    expect(snapshot()).toEqual(before);expect(git('tag')).toBe('');
  });
  it('keeps exact beta tag selectors on retry and rejects malformed retries', () => {
    const r=run('beta-version.sh','retry','v0.11.0-dev.4','--apply');expect(r.status,r.stderr).toBe(0);
    expect(audit().find(a=>a[0]==='workflow')).toContain('ref=v0.11.0-dev.4');
    expect(run('beta-version.sh','retry','v0.11.0-local.1','--apply').status).toBe(1);
  });
  it('blocks dispatch with unreconciled history and does not retry an indeterminate dispatch', () => {
    env.FAIL_DISPATCH='1';expect(run('beta-version.sh','allocate','main','0.11.0','--apply').stderr).toContain('Inspect Beta Release runs');
    expect(audit().filter(a=>a[0]==='workflow')).toHaveLength(1);
    const c=JSON.parse(readFileSync(join(root,'project-standards.json')));c.history.reviewed=false;save('project-standards.json',c);
    expect(run('beta-version.sh','allocate','main','0.11.0','--apply').stderr).toContain('Release blocked');expect(audit().filter(a=>a[0]==='workflow')).toHaveLength(1);
  });
});

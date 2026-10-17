// Publication fault tests: isolated files and fake Git/GitHub executables; no refs or network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
let root, input, config;
const sha = 'a'.repeat(40), pin = 'e3111c4e9dc652f833a5f2ba5232c292646e7969';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pboard-release-gates-'));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin')); input = join(root, 'verified'); mkdirSync(input);
  for (const file of ['release-control.mjs', 'release-policy.mjs', 'version.mjs']) cpSync(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  config = JSON.parse(readFileSync(new URL('../project-standards.json', import.meta.url)));
  config.history.unresolved = [];
  Object.assign(config.signing['android-release'], { historyReviewed: true, highestHistoricalCode: 0, certificateSha256: 'a'.repeat(64) });
  save(join(root, 'project-standards.json'), config); save(join(root, 'dev-standards.lock.json'), { commit: pin });
  writeFileSync(join(root, 'bin/git'), `#!${process.execPath}\nimport {readFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[0]==='cat-file')console.log('tag');else if(a[0]==='rev-parse')console.log('${sha}');else if(a[0]==='show' && a[1].endsWith(':VERSION'))console.log('0.10.3');else if(a[0]==='show' && a[1].endsWith(':manifest.json'))console.log(JSON.stringify({browser_specific_settings:{gecko:{id:'project-board@local.invalid'}}}));else if(a[0]==='show')process.stdout.write(readFileSync('project-standards.json'));else if(a[0]==='log')console.log('- fixture change');\n`, { mode: 0o700 });
  writeFileSync(join(root, 'bin/gh'), `#!${process.execPath}\nimport {appendFileSync,existsSync,readFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync('api-audit.jsonl',JSON.stringify(a)+'\\n');if(a[0]!=='api'||a.includes('POST')||a.includes('PATCH')||a.includes('-f')||a.includes('-F'))throw Error('Remote mutation forbidden in fixture');const endpoint=a.find(x=>x.startsWith('repos/'));if(endpoint.endsWith('/git/matching-refs/tags/'))console.log(JSON.stringify({ref:'refs/tags/v0.10.3'}));else if(endpoint.includes('/releases?')){if(existsSync('published.json'))console.log(JSON.stringify(JSON.parse(readFileSync('published.json','utf8'))));}else if(endpoint.includes('/releases/assets/'))process.stdout.write(readFileSync('asset-'+endpoint.split('/').pop()+'.bin'));else if(endpoint.includes('/git/ref/tags/'))console.log(JSON.stringify({object:{type:'tag',sha:'b'.repeat(40)}}));else if(endpoint.includes('/git/tags/'))console.log(JSON.stringify({object:{sha:'${sha}'}}));else throw Error('Unexpected API request');\n`, { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function build(target, changes = {}) {
  const dir = join(input, target); mkdirSync(dir);
  const bytes = Buffer.from(`fixture-${target}`), filename = `${target}.zip`; writeFileSync(join(dir, filename), bytes);
  save(join(dir, 'build-info.json'), { version: '0.10.3', gitCommitSha: sha, dirty: false, state: 'succeeded', standardsCommit: pin, configurationSha256: digest(readFileSync(join(root, 'project-standards.json'))), targets: [{ id: target, required: true, outcome: 'succeeded' }], outputs: [{ target, filename, bytes: bytes.length, sha256: digest(bytes), certificateSha256: 'a'.repeat(64) }], ...changes });
}
function run(command) {
  return spawnSync(process.execPath, ['scripts/release-control.mjs', command, 'stable', '0.10.3', sha, input], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
}
describe('release aggregate gates (simulated remote)', () => {
  it('checks the historical Android code floor for direct stable workflow entry', () => {
    config.signing['android-release'].highestHistoricalCode = 10003999;
    save(join(root, 'project-standards.json'), config);
    const result = spawnSync(process.execPath, ['scripts/release-control.mjs', 'validate', 'stable', 'v0.10.3'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Android code does not exceed');
  });
  it('blocks an unpublished release superseded by a newer draft reservation before staging', () => {
    save(join(root, 'published.json'), { tag_name: 'v0.11.0-dev.1', draft: true });
    expect(run('stage').stderr).toContain('does not exceed reservation');
    expect(existsSync(join(root, 'release-staging'))).toBe(false);
  });
  it('blocks a missing mandatory target before creating any draft', () => {
    build('firefox'); const result = run('stage'); expect(result.status).toBe(1); expect(result.stderr).toContain('Missing mandatory target');
    expect(readFileSync(join(root, 'api-audit.jsonl'), 'utf8')).not.toContain('PATCH');
  });
  it('rejects transport corruption and wrong source identity', () => {
    build('firefox'); writeFileSync(join(input, 'firefox/firefox.zip'), 'corrupt');
    expect(run('stage').stderr).toContain('Transport checksum mismatch');
    rmSync(join(input, 'firefox'), { recursive: true }); build('firefox', { dirty: true });
    expect(run('stage').stderr).toContain('Invalid release manifest');
  });
  it('rejects a wrong Android certificate', () => {
    for (const t of config.matrix.stable.required) build(t);
    const path = join(input, 'android-release/build-info.json'), info = JSON.parse(readFileSync(path));
    info.outputs[0].certificateSha256 = 'b'.repeat(64); save(path, info);
    expect(run('stage').stderr).toContain('Wrong Android signer');
  });
  it('stages complete notes/checksums without remote writes and requires identical reviewed plan', () => {
    for (const t of config.matrix.stable.required) build(t);
    const result = run('stage'); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'release-staging/SHA256SUMS.txt'))).toBe(true);
    expect(readFileSync(join(root, 'release-staging/release-notes.md'), 'utf8')).toContain('initial reachable history');
    expect(run('publish').stderr).toContain('missing approval evidence');
  });
  it('verifies identical published bytes as a read-only no-op and rejects corruption', () => {
    for (const t of config.matrix.stable.required) build(t);
    const staged = run('stage'); expect(staged.status, staged.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, 'release-staging/release-manifest.json')));
    const entries = [...manifest.outputs.map(o => ({ name: o.filename, path: join(input, o.target, o.filename) })), ...['release-manifest.json', 'SHA256SUMS.txt'].map(name => ({ name, path: join(root, 'release-staging', name) }))];
    const assets = entries.map((entry, i) => { cpSync(entry.path, join(root, `asset-${i}.bin`)); return { name: entry.name, id: i, state: 'uploaded' }; });
    save(join(root, 'published.json'), { prerelease: false, draft: false, assets });
    const code = `import {verifyPublished} from './scripts/release-control.mjs';import {readFileSync} from 'node:fs';verifyPublished(JSON.parse(readFileSync('published.json')),'stable','0.10.3','${sha}');`;
    const check = () => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
    expect(check().status).toBe(0);
    writeFileSync(join(root, 'asset-0.bin'), 'changed'); expect(check().stderr).toContain('Published bytes differ');
    const calls = readFileSync(join(root, 'api-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls.every(call => call[0] === 'api' && !call.includes('PATCH') && !call.includes('-f') && !call.includes('-F'))).toBe(true);
  });

});

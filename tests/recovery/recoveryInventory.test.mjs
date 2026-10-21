import { expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const script = fileURLToPath(new URL('scripts/recovery/run.mjs', root));
const inventory = JSON.parse(readFileSync(new URL('scripts/recovery/scenarios.json', root), 'utf8'));
it('maps every approved scenario once, including permanent-device-loss recovery and authority separation', () => {
  const contract = readFileSync(new URL(inventory.contract, root), 'utf8');
  const ids = [...contract.matchAll(/^\| ((?:[MSCDAR]|PR)\d{2}) \|/gm)].map(m => m[1]);
  expect(ids).toHaveLength(55); expect(new Set(ids).size).toBe(ids.length);
  expect(inventory.scenarios.map(s => s.id)).toEqual(ids);
  expect(ids).toContain('PR01'); expect(ids).toContain('PR02');
  for (const scenario of inventory.scenarios) {
    expect(['partial', 'gap', 'known-gap']).toContain(scenario.status);
    expect(scenario.reason).toBeTruthy();
    expect(scenario.nextJob).toBeGreaterThan(1);
    for (const path of scenario.evidence) expect(existsSync(new URL(path, root))).toBe(true);
  }
});
it('keeps expected failures visible as gaps rather than counting them as acceptance', () => {
  const source = readFileSync(new URL('tests/recovery/recovery.test.ts', root), 'utf8');
  const known = [...source.matchAll(/it\.fails\('\[([^\]]+)\]/g)].map(m => m[1]).sort();
  expect(known).toEqual([]);
  expect(inventory.scenarios.filter(s => s.status === 'known-gap').map(s => s.id).sort()).toEqual(known);
});
it('can inspect local coverage without launching any test/browser or contacting a service', () => {
  const result = spawnSync(process.execPath, [script, '--inventory'], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0); expect(result.stdout).toContain('Approved scenarios: 55');
  expect(result.stdout).not.toContain('CHECK ');
});
it('strict inventory fails closed while required scenarios remain incomplete', () => {
  const result = spawnSync(process.execPath, [script, '--inventory', '--strict'], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(1);
});
it.each([['--url=wss://example.test/ws'], ['--public'], ['--browser', '--browser']])('rejects unsupported or duplicate options before running checks: %j', args => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(1); expect(result.stdout).not.toContain('CHECK ');
});

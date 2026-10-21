import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../services/pboard-signaling/run-collaboration-test.mjs', import.meta.url));
function run(...args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 }); }
it('describes both commands without starting a browser or requiring Rust', () => {
  const result = run('--help');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('demo:collaboration');
  expect(result.stdout).toContain('No Rust or Google login needed');
});
it.each([
  'ws://127.0.0.1:8787/ws',
  'https://relay.example/ws',
  'wss://user:secret@relay.example/ws',
  'wss://relay.example/ws?token=secret',
  'wss://relay.example/ws#secret',
  'wss://relay.example/other',
])('rejects insecure or ambiguous endpoints before starting probes: %s', endpoint => {
  const result = run(`--url=${endpoint}`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Use a WSS endpoint ending in /ws');
  expect(result.stdout).not.toContain('Pboard disposable');
});
it.each(['--interactive --duration=-1', '--interactive --duration=3601', '--duration=3', '--interative'])('rejects invalid launch options before starting probes: %s', options => {
  const result = run(...options.split(' '));
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Pboard disposable');
});

/** Local staged recovery checks. No real accounts/profiles or public endpoints. */
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run test:recovery [-- --browser] [--strict]\nDefault: controlled component/known-gap tests and local Rust security tests.\n--browser: add fresh-device recovery and same/different-account native Chromium fixtures.\n--strict: fail while any approved scenario lacks full acceptance evidence.\n--inventory: validate/display scenario coverage only.\nNo real Google account, installed profile, public relay or deployment is accessed.');
  process.exit(0);
}
if (args.some(arg => !['--browser', '--strict', '--inventory'].includes(arg)) || new Set(args).size !== args.length) {
  console.error('Unknown or duplicate option; use --help'); process.exit(1);
}
const inventory = JSON.parse(await readFile(join(root, 'scripts/recovery/scenarios.json'), 'utf8'));
const contract = await readFile(join(root, inventory.contract), 'utf8');
const identifiers = [...contract.matchAll(/^\| ((?:[MSCDAR]|PR)\d{2}) \|/gm)].map(m => m[1]);
if (inventory.version !== 1 || identifiers.length !== new Set(identifiers).size || JSON.stringify(identifiers) !== JSON.stringify(inventory.scenarios.map(s => s.id))) throw Error('Scenario inventory differs from the approved contract');
for (const scenario of inventory.scenarios) {
  if (!['partial', 'gap', 'known-gap'].includes(scenario.status) || !Number.isInteger(scenario.nextJob) || !scenario.reason) throw Error('Invalid/unreviewed scenario evidence status');
  for (const path of scenario.evidence) await readFile(join(root, path));
}
const counts = Object.fromEntries(['partial', 'known-gap', 'gap'].map(status => [status, inventory.scenarios.filter(s => s.status === status).length]));
console.log(`Approved scenarios: ${identifiers.length}; partial=${counts.partial}, known-gap=${counts['known-gap']}, gap=${counts.gap}. Full acceptance remains incomplete.`);
if (args.includes('--inventory')) { if (args.includes('--strict')) process.exitCode = 1; }
else {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node 24+ required; run nvm use');
  const work = await mkdtemp(join(tmpdir(), 'pboard-recovery-'));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PBOARD_|VITE_PBOARD_|CARGO_TARGET_DIR$)/.test(key)));
  if (process.env.PBOARD_CHROMIUM_BIN) environment.PBOARD_CHROMIUM_BIN = process.env.PBOARD_CHROMIUM_BIN;
  let child, interrupted = false, forced;
  function killOwned(target, signal) {
    if (!target?.pid) return;
    try { if (process.platform === 'win32') target.kill(signal); else process.kill(-target.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const stop = () => { interrupted = true; const target = child; killOwned(target, 'SIGTERM'); forced = setTimeout(() => killOwned(target, 'SIGKILL'), 5000); forced.unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const steps = [];
  async function run(label, command, argv, extra = {}) {
    if (interrupted) throw Error('Recovery checks interrupted');
    console.log(`CHECK ${label}`);
    const result = await new Promise((done, reject) => {
      child = spawn(command, argv, { cwd: root, env: { ...environment, ...extra }, stdio: 'inherit', detached: process.platform !== 'win32' });
      const target = child;
      let timer = setTimeout(() => { interrupted = true; killOwned(target, 'SIGKILL'); }, 600_000);
      child.once('error', error => { clearTimeout(timer); clearTimeout(forced); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(forced); done({ code, signal }); });
    });
    child = undefined; steps.push({ label, success: result.code === 0 && !result.signal });
    if (result.code !== 0 || result.signal || interrupted) throw Error(`${label} failed; no acceptance success claimed`);
  }
  try {
    await run('controlled recovery and explicit expected-failure regressions', process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/recovery', 'tests/conflictResolutionControls.test.tsx', 'tests/sync.test.ts', 'tests/accountPreferences.test.ts', 'tests/securityAdversarial.test.ts', 'tests/securityProtocol.test.ts', 'tests/runtimeSecurityDiagnostics.test.ts', 'tests/runtimePendingRecovery.test.ts', 'tests/googleIdentitySharing.test.ts', 'tests/serviceAdmission.test.ts', 'tests/liveMutationSigning.test.ts', 'tests/privatePersistenceEnrollment.test.ts', 'tests/driveSyncControls.test.tsx', 'tests/authorityRecovery.test.ts', 'tests/pendingWorkControls.test.tsx', 'tests/boardGrants.test.ts', 'tests/experimentalSignaling.test.ts']);
    await run('real local Rust authentication, quotas and protocol', 'cargo', ['test', '--locked', '--manifest-path', 'services/pboard-signaling/Cargo.toml']);
    if (args.includes('--browser')) {
      const target = join(root, 'services/pboard-signaling/target/recovery-fixture');
      await run('isolated synthetic-Google binary (never deployed)', 'cargo', ['build', '--locked', '--manifest-path', 'services/pboard-signaling/Cargo.toml', '--features', 'test-google-fixture', '--target-dir', target]);
      const binary = join(work, 'pboard-signaling');
      await copyFile(join(target, 'debug/pboard-signaling'), binary);
      const base = { PBOARD_BOARD_GRANTS: '1', PBOARD_SIGNALING_TEST_BINARY: binary };
      const probe = [join(root, 'services/pboard-signaling/secure-browser-smoke.mjs')];
      await run('native source-device destruction/private restore/no authority transfer', process.execPath, probe, { ...base, PBOARD_PRIVATE_RECOVERY: '1' });
      await run('native different-account enrollment/reconnect/revocation', process.execPath, probe, { ...base, PBOARD_GOOGLE_IDENTITY_SHARING: '1', PBOARD_RECOVERY_FAULTS: '1' });
      await run('native same-account enrollment/reconnect', process.execPath, probe, { ...base, PBOARD_GOOGLE_IDENTITY_SHARING: '1', PBOARD_M02_SAME_ACCOUNT: '1', PBOARD_RECOVERY_FAULTS: '1' });
      await run('preserved native legacy Drive signaling/snapshots/images', process.execPath, probe, { ...base, PBOARD_BOARD_GRANTS: '0', PBOARD_M02_USE_DRIVE: '1' });
    }
    console.log('Harness checks completed. Expected failures reproduce known gaps; they are NOT passing acceptance scenarios.');
    if (args.includes('--strict')) { process.exitCode = 1; console.error('Full acceptance incomplete; strict recovery gate remains closed.'); }
  } catch (error) { process.exitCode = 1; console.error(error.message); }
  finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    // Only safe labels/outcomes. No snapshots, credentials, diffs or private keys.
    const report = { version: 1, createdAt: new Date().toISOString(), fullAcceptance: false, fixtureGoogle: true, browserRequested: args.includes('--browser'), steps, coverage: counts };
    console.log(JSON.stringify(report));
    await rm(work, { recursive: true, force: true });
  }
}

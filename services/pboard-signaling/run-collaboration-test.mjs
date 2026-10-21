/** One-command disposable test bundle. No real profiles, accounts or server changes. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run test:collaboration [-- --url=wss://host/ws]\nnpm run demo:collaboration [-- --headless --duration=10]\nRequires Node 24+, npm ci, and Chromium (or PBOARD_CHROMIUM_BIN). No Rust or Google login needed for public WSS.');
  process.exit(0);
}
for (const arg of args) if (!['--interactive', '--headless'].includes(arg) && !arg.startsWith('--duration=') && !arg.startsWith('--url=')) throw Error('Unknown option; use --help');
const interactive = args.includes('--interactive');
const duration = Number(args.find(arg => arg.startsWith('--duration='))?.slice(11) ?? 0);
if (!Number.isInteger(duration) || duration < 0 || duration > 3600 || (!interactive && duration)) throw Error('--duration must be 0–3600 seconds and requires interactive mode');
const endpoint = new URL(args.find(arg => arg.startsWith('--url='))?.slice(6) ?? 'wss://pboard.cecosl.ovh/ws');
if (endpoint.protocol !== 'wss:' || endpoint.pathname !== '/ws' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Use a WSS endpoint ending in /ws, without credentials, query or fragment');
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node 24+ is required; run nvm use');
// Do not inherit legacy modes, private server config or unrelated test overrides.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PBOARD_|VITE_PBOARD_)/.test(key)));
if (process.env.PBOARD_CHROMIUM_BIN) environment.PBOARD_CHROMIUM_BIN = process.env.PBOARD_CHROMIUM_BIN;
Object.assign(environment, { PBOARD_BOARD_GRANTS: '1', PBOARD_M03_RELAY_URL: endpoint.href,
  PBOARD_TEST_INTERACTIVE: interactive ? '1' : '0', PBOARD_TEST_HEADLESS: args.includes('--headless') ? '1' : '0', PBOARD_TEST_DURATION: String(duration) });
let child;
const forward = () => child?.kill('SIGTERM');
process.on('SIGINT', forward); process.on('SIGTERM', forward);
async function run(script) {
  const code = await new Promise((done, reject) => {
    child = spawn(process.execPath, [resolve(root, 'services/pboard-signaling', script), ...(script === 'automatic-smoke.mjs' ? [endpoint.href] : [])], { cwd: root, env: environment, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code, signal) => done(signal ? 1 : code));
  });
  child = undefined;
  if (code !== 0) throw Error(`${script} failed (exit ${code}); no success is claimed`);
}
try {
  console.log(`Pboard disposable ${interactive ? 'visible demo' : 'automated two-device test'} → ${endpoint.href}`);
  console.log('Fresh authority/device keys; existing boards untouched. Board grants replace Google-account enrollment in this test.');
  await run('automatic-smoke.mjs');
  await run('secure-browser-smoke.mjs');
  console.log('PASS: disposable collaboration test completed. No installed profiles or remote configuration were changed.');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  process.off('SIGINT', forward); process.off('SIGTERM', forward);
}

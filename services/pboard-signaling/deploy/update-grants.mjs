// Operator command: validates public enrollment exports locally before updating
// the explicitly selected SSH host. Never accepts private keys or OAuth tokens.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] !== '--host' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(args[1] || '') || args.length < 3) {
  throw Error('Usage: node deploy/update-grants.mjs --host SSH_ALIAS approved-export.json [other-export.json ...]');
}
const host = args[1];
const work = await mkdtemp(join(tmpdir(), 'pboard-public-grants-'));
function run(command, args, options = {}) {
  const child = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error(`${command} failed (exit ${child.status}); existing grants were preserved or rollback was attempted`);
}
try {
  const output = join(work, 'grants.json');
  run(process.execPath, [fileURLToPath(new URL('../merge-grants.mjs', import.meta.url)), '--out', output, ...args.slice(2)], { stdio: 'inherit' });
  // The stdin stream contains only the public allowlist produced by merge-grants.
  // Validate as the service account before replacing the live file atomically.
  run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `set -eu
test "$(id -u)" = 0
stage=$(mktemp /etc/pboard-signaling/.grants-check.XXXXXX)
trap 'rm -f "$stage"' EXIT
cat > "$stage"
chown root:pboard-signaling "$stage"
chmod 0640 "$stage"
runuser -u pboard-signaling -- env PBOARD_SIGNALING_GRANTS="$stage" /opt/pboard-signaling/pboard-signaling --check-config
cp -p /etc/pboard-signaling/grants.json /etc/pboard-signaling/grants.previous.json
mv "$stage" /etc/pboard-signaling/grants.json
if ! systemctl restart pboard-signaling || ! curl --fail --silent --output /dev/null --retry 5 --retry-connrefused --retry-delay 1 --max-time 2 http://127.0.0.1:8787/healthz; then
  cp -p /etc/pboard-signaling/grants.previous.json /etc/pboard-signaling/grants.json
  systemctl restart pboard-signaling
  exit 1
fi
`], { input: await readFile(output, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
  console.log('Approved public grants installed; relay restarted. Restart live collaboration on enrolled clients.');
} finally {
  await rm(work, { recursive: true, force: true });
}

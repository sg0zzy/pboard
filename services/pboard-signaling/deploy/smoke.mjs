// Initial-install diagnostic only: requires a deny-all relay, temporarily grants
// two generated diagnostic keys, exercises forwarding, then restores deny-all.
// This tests the deployed relay, not Google login, WebRTC or RxDB replication.
import { SDP, ICE } from '../signaling-fixtures.mjs';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [host, url] = process.argv.slice(2);
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host || '') || !url) {
  throw Error('Usage: node deploy/smoke.mjs SSH_ALIAS wss://hostname/ws (or explicit loopback ws://127.0.0.1:PORT/ws)');
}
const endpoint = new URL(url);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !(endpoint.protocol === 'wss:' || (endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) throw Error('Secure endpoint required');
// An empty legacy grants file no longer means the whole service is idle. Never
// restart an automatic-admission service to install legacy diagnostic grants.
await new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  const timer = setTimeout(() => { ws.close(); reject(Error('Relay probe timeout')); }, 8000);
  ws.onerror = () => { clearTimeout(timer); reject(Error('Relay connection failed')); };
  ws.onmessage = ({ data }) => {
    clearTimeout(timer); ws.close();
    const welcome = JSON.parse(data);
    if (welcome.supportedVersions?.includes(2)) reject(Error('Automatic relay enabled: use automatic-smoke.mjs without SSH or server restarts'));
    else resolve();
  };
});
function ssh(command, input) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], { input, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error('SSH diagnostic operation failed; inspect service state privately');
  return r.stdout.trim();
}
const original = ssh(`python3 -c 'import json,hashlib; b=open("/etc/pboard-signaling/grants.json","rb").read(); assert json.loads(b)=={"rooms":{}},"Diagnostic requires deny-all configuration"; print(hashlib.sha256(b).hexdigest())'`);
assert.match(original, /^[a-f0-9]{64}$/);
const work = await mkdtemp(join(tmpdir(), 'pboard-deployed-smoke-'));
const sockets = [];
let diagnosticHash;
function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { crv: 'P-256', kty: 'EC', x, y };
  return { privateKey, jwk, id: createHash('sha256').update(JSON.stringify(jwk)).digest('base64url') };
}
const room = 'pboard-deployment-diagnostic';
const a = device(), b = device();
async function connect(d, targetRoom = room, expect = 'authenticated') {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const queue = [], pending = [];
  ws.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    if (pending.length) pending.shift()(value); else queue.push(value);
  };
  const next = async () => {
    if (queue.length) return queue.shift();
    let timer;
    try { return await Promise.race([
      new Promise(resolve => pending.push(resolve)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Relay receive timeout')), 8000); })
    ]); } finally { clearTimeout(timer); }
  };
  const send = value => ws.send(JSON.stringify(value));
  const w = await next(); assert.equal(w.type, 'welcome');
  const bytes = JSON.stringify(['pboard-ws-auth-v1', w.challenge, w.session, targetRoom, d.id]);
  send({ type: 'authenticate', version: 1, room: targetRoom, deviceKeyId: d.id,
    signature: sign('sha256', Buffer.from(bytes), { key: d.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
  const result = await next();
  if (expect === 'unauthorized') { assert.equal(result.code, expect); ws.close(); return; }
  assert.equal(result.type, expect);
  send({ type: 'join' }); assert.equal((await next()).type, 'joined');
  return { ws, next, send, session: w.session };
}
try {
  const grant = d => ({ publicKey: d.jwk, expiresAt: Date.now() + 120000 });
  const config = { rooms: { [room]: { [a.id]: grant(a), [b.id]: grant(b) } } };
  const file = join(work, 'public.json');
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  // Hash the exact normalized bytes produced by the shared merge tool so cleanup
  // cannot overwrite a concurrent operator update.
  const merged = join(work, 'merged.json');
  const mergedResult = spawnSync(process.execPath, [fileURLToPath(new URL('../merge-grants.mjs', import.meta.url)), '--out', merged, file], { stdio: 'inherit' });
  assert.equal(mergedResult.status, 0);
  const { readFile } = await import('node:fs/promises');
  diagnosticHash = createHash('sha256').update(await readFile(merged)).digest('hex');
  const install = spawnSync(process.execPath, [fileURLToPath(new URL('update-grants.mjs', import.meta.url)), '--host', host, file], { stdio: 'inherit' });
  assert.equal(install.status, 0);
  await connect(device(), room, 'unauthorized');
  await connect(a, 'unknown-room', 'unauthorized');
  const first = await connect(a), second = await connect(b);
  assert.equal((await first.next()).type, 'peer_joined');
  for (const [sender, receiver, to, payload] of [
    [first, second, b.id, { type: 'offer', sdp: SDP }],
    [second, first, a.id, { type: 'answer', sdp: SDP }],
    [first, second, b.id, { candidate: { candidate: ICE } }],
  ]) {
    sender.send({ type: 'signal', to, session: receiver.session, data: payload });
    const signal = await receiver.next();
    assert.equal(signal.type, 'signal'); assert.equal(signal.session, sender.session);
    assert.deepEqual(signal.data, payload);
  }
  second.ws.close(); assert.equal((await first.next()).type, 'peer_left');
  const rejoined = await connect(b); assert.notEqual(rejoined.session, second.session);
  assert.equal((await first.next()).type, 'peer_joined');
  console.log('PASS deployed relay: unknown device/room denied; authenticated offer/answer/ICE forwarding; presence; disconnect and reconnect.');
} finally {
  for (const ws of sockets) ws.close();
  if (diagnosticHash) {
    ssh(`set -eu
current=$(sha256sum /etc/pboard-signaling/grants.json | cut -d ' ' -f1)
if test "$current" = '${diagnosticHash}'; then
  previous=$(sha256sum /etc/pboard-signaling/grants.previous.json | cut -d ' ' -f1)
  test "$previous" = '${original}'
  mv /etc/pboard-signaling/grants.previous.json /etc/pboard-signaling/grants.json
  systemctl restart pboard-signaling
elif test "$current" != '${original}'; then
  echo 'Concurrent grant update detected; preserved it. Inspect state manually.' >&2
  exit 1
fi`);
  }
  await rm(work, { recursive: true, force: true });
}

/** Linux-only isolated relay experiment; public grants on disk, keys in RAM.
 * node benchmark.mjs [100 500 1000 2000] -- binary must already be built.
 * Optional PBOARD_BENCH_SSH runs that backend on an explicitly authorized host;
 * clients stay local and use an SSH tunnel. Never relax the public service. */
import { SDP } from './signaling-fixtures.mjs';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const here = fileURLToPath(new URL('.', import.meta.url));
const targets = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [100, 500, 1000, 2000];
if (targets.some(n => !Number.isInteger(n) || n < 2 || n > 2000)) throw Error('Use peer counts between 2 and 2000');
const remote = process.env.PBOARD_BENCH_SSH;
const port = Number(process.env.PBOARD_BENCH_PORT ?? 18787);
const localPort = remote ? port + 1 : port;
const idleMs = Number(process.env.PBOARD_BENCH_IDLE_MS ?? 30000);
if (!Number.isInteger(port) || port < 1024 || port > 65534 || !Number.isFinite(idleMs) || idleMs < 20000 || idleMs > 60000) throw Error('Invalid benchmark port/idle bounds');
const binary = process.env.PBOARD_BENCH_BINARY ?? (remote ? '/opt/pboard-signaling/pboard-signaling' : join(here, 'target/release/pboard-signaling'));
const helper = await readFile(join(here, 'benchmark-server.py'), 'utf8');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const url = `ws://127.0.0.1:${localPort}/ws`;
async function connect(url, device) {
  const ws = new WebSocket(url); const peers = new Map();
  const waiting = new Map(); let welcome; let heartbeat;
  const joined = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Error('join timeout')); }, 10_000);
    ws.onerror = () => { clearTimeout(timer); reject(Error('websocket failed')); };
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.type === 'welcome') {
        welcome = m;
        const bytes = Buffer.from(JSON.stringify(['pboard-ws-auth-v1', m.challenge, m.session, device.room, device.id]));
        ws.send(JSON.stringify({ type: 'authenticate', version: 1, room: device.room, deviceKeyId: device.id,
          signature: sign('sha256', bytes, { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }));
      } else if (m.type === 'authenticated') ws.send('{"type":"join"}');
      else if (m.type === 'joined') {
        for (const p of m.peers) peers.set(p.peerId, p.session);
        clearTimeout(timer); heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 15_000);
        resolve();
      } else if (m.type === 'peer_joined') peers.set(m.peerId, m.session);
      else if (m.type === 'peer_left') { if (peers.get(m.peerId) === m.session) peers.delete(m.peerId); }
      else if (m.type === 'signal') waiting.get('negotiation')?.();
      else if (m.type === 'error') { clearTimeout(timer); reject(Error(m.code)); }
    };
  });
  ws.onclose = () => clearInterval(heartbeat);
  await joined;
  return { ws, peers, welcome, waiting, close: () => { clearInterval(heartbeat); ws.close(); } };
}
for (const count of targets) {
  const devices = Array.from({ length: count }, (_, i) => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { x, y } = publicKey.export({ format: 'jwk' }); const jwk = { crv: 'P-256', kty: 'EC', x, y };
    return { id: createHash('sha256').update(JSON.stringify(jwk)).digest('base64url'), jwk, privateKey, room: `bench-${Math.floor(i / 32)}` };
  });
  const rooms = {};
  for (const d of devices) (rooms[d.room] ??= {})[d.id] = { publicKey: d.jwk, expiresAt: Date.now() + 600_000 };
  const child = remote
    ? spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remote, `python3 -u -c ${quote(helper)}`], { stdio: ['pipe', 'pipe', 'inherit'] })
    : spawn('python3', ['-u', join(here, 'benchmark-server.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function response() {
    let timer;
    try {
      const { value, done } = await Promise.race([lines.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('benchmark control timeout')), 15000); })]);
      if (done) throw Error('benchmark control closed');
      const result = JSON.parse(value); if (result.error) throw Error(result.error); return result;
    } finally { clearTimeout(timer); }
  }
  const stats = async () => { child.stdin.write('"stats"\n'); return response(); };
  child.stdin.write(JSON.stringify({ binary, count, port, grants: { rooms } }) + '\n');
  let tunnel;
  const sockets = [];
  try {
    const ready = await response();
    if (remote) tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${port}`, remote], { stdio: 'ignore' });
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://127.0.0.1:${localPort}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (i > 100 || child.exitCode !== null || (tunnel && tunnel.exitCode !== null)) throw Error('isolated server/tunnel failed');
      await pause(50);
    }
    const baseline = await stats(); const begin = performance.now();
    for (const device of devices) { sockets.push(await connect(url, device)); await pause(40); }
    const connectMs = performance.now() - begin;
    const before = await stats(); const idleStart = performance.now(); await pause(idleMs);
    const loaded = await stats(); const idleSeconds = (performance.now() - idleStart) / 1000;
    const latency = [];
    for (let n = 0; n < 20; n++) {
      const probe = 'negotiation'; const start = performance.now();
      const received = new Promise(resolve => sockets[1].waiting.set(probe, resolve));
      sockets[0].ws.send(JSON.stringify({ type: 'signal', to: devices[1].id, session: sockets[1].welcome.session, data: { type: 'offer', sdp: SDP } }));
      await Promise.race([received, pause(2000).then(() => { throw Error('forwarding timeout'); })]);
      latency.push(performance.now() - start); await pause(50);
    }
    const churnStart = performance.now();
    for (let i = 0; i < Math.min(50, count); i++) {
      const closed = once(sockets[i].ws, 'close'); sockets[i].close(); await closed;
      sockets[i] = await connect(url, devices[i]); await pause(40);
    }
    latency.sort((a, b) => a - b);
    const activeConnections = sockets.filter(s => s.ws.readyState === WebSocket.OPEN).length;
    if (activeConnections !== count) throw Error('connections lost during idle/churn');
    console.log(JSON.stringify({ profile:remote ? 'isolated VPS relay core over SSH; synthetic operator grants; no TLS/Google/WebRTC' : 'isolated local relay core; synthetic operator grants; no TLS/Google/WebRTC', sha256: ready.sha256, pacingMs:40, idleSeconds, peers: count, activeConnections,
      baselineRssKiB: baseline.rssKiB, loadedRssKiB: loaded.rssKiB, incrementalKiBPerPeer: (loaded.rssKiB - baseline.rssKiB) / count,
      connectMs, idleCpuPercentOneCore: 100 * (loaded.cpu - before.cpu) / idleSeconds,
      connectCpuSeconds: before.cpu - baseline.cpu, latencyMedianMs: latency[10], latencyP95Ms: latency[18], churnMs: performance.now() - churnStart }));
  } finally {
    for (const s of sockets) s.close();
    tunnel?.kill('SIGTERM');
    child.stdin.end('"stop"\n');
    if (child.exitCode === null) await once(child, 'exit');
  }
}

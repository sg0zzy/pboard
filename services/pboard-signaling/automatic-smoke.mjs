/** Standalone public-relay check: no SSH, account, Drive or operator grants.
 * Generated identities authorize only their own short-lived diagnostic namespace.
 * This is relay validation, not a WebRTC/RxDB test. No private keys leave memory. */
import { SDP, ICE } from './signaling-fixtures.mjs';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
const url = new URL(process.argv[2] || 'wss://pboard.cecosl.ovh/ws');
if (url.username || url.password || url.search || url.hash || !(url.protocol === 'wss:' ||
    (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw Error('WSS or explicit loopback URL required');
const digest = bytes => createHash('sha256').update(bytes).digest('base64url');
const signature = (key, bytes) => sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const jwk = { crv: 'P-256', kty: 'EC', x, y };
  return { jwk, privateKey, id: digest(JSON.stringify(jwk)) };
}
const authority = device(), a = device(), b = device();
const boardId = `diagnostic-${randomUUID()}`, topic = `pboard-collab-${boardId}-cards`;
function authorization(root) {
  const payload = { protocol: 2, boardId, driveProjectFileId: '', driveFolderId: '',
    authorityKeyId: root.id, epoch: 1, issuedAt: Date.now(), expiresAt: Date.now() + 30_000,
    devices: [a, b].map((d, i) => ({ deviceKeyId: d.id, publicKey: d.jwk, role: i ? 'editor' : 'owner' })) };
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  const bytes = Buffer.from(JSON.stringify(normalize(payload)));
  const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length);
  const manifestSignature = signature(root.privateKey, Buffer.concat([Buffer.from('pboard-manifest-v2'), size, bytes]));
  const room = `pboard-v2-${root.id}-${digest(JSON.stringify(['pboard-ws-room-v2', topic, payload.driveProjectFileId, payload.driveFolderId]))}`;
  return { manifest: normalize(payload), manifestHash: Buffer.concat([Buffer.from('pboard-manifest-v2'),size,bytes]).toString('hex'), room, digest: digest(bytes), authorization: { topic, authority: root.jwk, manifestPayload: bytes.toString('base64url'), manifestSignature } };
}
const credentials = authorization(authority);
const sockets = [];
async function connect(d, proof = credentials, expectedError) {
  const ws = new WebSocket(url); sockets.push(ws);
  const queue = [], pending = [];
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (pending.length) pending.shift()(m); else queue.push(m); };
  async function next() {
    if (queue.length) return queue.shift();
    let timer;
    try { return await Promise.race([new Promise(r => pending.push(r)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Relay receive timeout')), 8000);
    })]); } finally { clearTimeout(timer); }
  }
  const send = m => ws.send(JSON.stringify(m));
  const welcome = await next();
  assert.equal(welcome.type, 'welcome');
  assert(welcome.supportedVersions?.includes(2), 'Relay automatic admission is not enabled');
  const bytes = Buffer.from(JSON.stringify(['pboard-ws-auth-v2', welcome.challenge, welcome.session, proof.room, d.id, proof.digest]));
  send({ type: 'authenticate', version: 2, room: proof.room, deviceKeyId: d.id, signature: signature(d.privateKey, bytes), authorization: proof.authorization });
  const result = await next();
  if (expectedError) { assert.equal(result.code, expectedError); ws.close(); return; }
  assert.equal(result.type, 'authenticated');
  send({ type: 'join' }); assert.equal((await next()).type, 'joined');
  return { ws, next, send, session: welcome.session };
}
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
function signed(d,domain,payload){const bytes=Buffer.from(JSON.stringify(canonical(payload))),size=Buffer.alloc(4);size.writeUInt32LE(bytes.length);return{payload,signature:signature(d.privateKey,Buffer.concat([Buffer.from(domain),size,bytes]))};}
function presence(d){const now=Date.now();return{kind:'pboard-presence',envelope:{manifest:credentials.manifest,presence:signed(d,'pboard-presence-v2',{protocol:2,boardId,collection:'cards',manifestHash:credentials.manifestHash,epoch:1,deviceKeyId:d.id,sessionId:`logical-${d.id}`,issuedAt:now,expiresAt:now+120000})}};}
async function rejectBeforeAuthentication(payload, code) {
  const socket = new WebSocket(url); sockets.push(socket);
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Pre-authentication rejection timed out')), 8000);
      socket.onerror = () => reject(Error('Diagnostic socket failed'));
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'welcome') socket.send(payload);
          else { assert.equal(message.type, 'error'); assert.equal(message.code, code); resolve(); }
        } catch (error) { reject(error); }
      };
    });
  } finally { clearTimeout(timer); socket.close(); }
}
try {
  const base=new URL(url);base.protocol=url.protocol==='wss:'?'https:':'http:';
  await rejectBeforeAuthentication('{"type":"join"}', 'invalid_state');
  await rejectBeforeAuthentication('{"type":"proxy","url":"https://example.invalid"}', 'malformed');
  await rejectBeforeAuthentication('{"type":"join","type":"leave"}', 'malformed');
  assert.equal((await fetch(new URL('/grants/challenge',base),{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.invalid'},body:'{"version":2}'})).status,403);
  const hello=await(await fetch(new URL('/grants/challenge',base),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":2}'})).json();
  assert.equal(hello.version,2,'Authority-challenge publication v2 required');
  const pub={version:2,challenge:hello.challenge,authoritySignature:signature(authority.privateKey,Buffer.from(JSON.stringify(['pboard-grant-publish-v2',hello.challenge,authority.id,boardId,credentials.digest]))),bundle:{version:1,authority:authority.jwk,history:[{payload:credentials.authorization.manifestPayload,signature:credentials.authorization.manifestSignature}]},deviceKeyId:a.id,signature:signature(a.privateKey,Buffer.from(JSON.stringify(['pboard-ws-auth-v2','publish','publish',credentials.room,a.id,credentials.digest])))};
  assert.equal((await fetch(new URL('/grants/publish',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pub)})).status,204);
  await connect(device(), credentials, 'unauthorized');
  const attacker = authorization(device()); attacker.room = credentials.room;
  await connect(a, attacker, 'unauthorized');
  const first = await connect(a), second = await connect(b);
  assert.equal((await first.next()).type, 'peer_joined');
  first.send({type:'signal',to:b.id,session:second.session,data:presence(a)});second.send({type:'signal',to:a.id,session:first.session,data:presence(b)});await first.next();await second.next();
  let sequence=0;
  for (const [from, to, source, target, inner] of [
    [first, second, a, b, { type: 'offer', sdp: SDP }],
    [second, first, b, a, { type: 'answer', sdp: SDP }],
    [first, second, a, b, { candidate: { candidate: ICE } }],
  ]) {
    const now=Date.now();const data=signed(source,'pboard-signal-v2',{protocol:2,boardId,collection:'cards',manifestHash:credentials.manifestHash,epoch:1,fromDeviceKeyId:source.id,fromSessionId:`logical-${source.id}`,toDeviceKeyId:target.id,toSessionId:`logical-${target.id}`,signalId:randomUUID(),issuedAt:now,expiresAt:now+60000,sequence:sequence++,signal:inner});
    from.send({ type: 'signal', to: target.id, session: to.session, data });
    const m = await to.next(); assert.equal(m.type, 'signal'); assert.deepEqual(m.data, data);
  }
  second.ws.close(); assert.equal((await first.next()).type, 'peer_left');
  const rejoined = await connect(b); assert.notEqual(rejoined.session, second.session);
  assert.equal((await first.next()).type, 'peer_joined');
  // Even a valid member may not turn the service into an application-data relay.
  first.send({ type: 'signal', to: b.id, session: rejoined.session, data: { documents: [{ content: 'REJECT_THIS_DIAGNOSTIC_DATA' }] } });
  assert.equal((await first.next()).code, 'invalid_signal');
  assert.equal((await rejoined.next()).type, 'peer_left');
  assert.equal((await fetch(new URL('/grants/publish',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pub)})).status,403);
  console.log('PASS automatic admission over verified transport: pre-authentication/unknown/duplicate-message and untrusted-Origin rejection; nonmember and authority-impersonation rejection; offer/answer/ICE forwarding; presence and reconnect; authorized application-data rejection; publication replay rejection. No SSH, account or operator grant upload.');
} finally { for (const ws of sockets) ws.close(); }

/** Public negative probe: no real credentials, room access or persisted state. */
const endpoint = new URL(process.argv[2] || 'wss://pboard.cecosl.ovh/ws');
if (endpoint.protocol !== 'wss:' || endpoint.pathname !== '/ws' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Use a WSS /ws URL');
endpoint.protocol = 'https:';
const http = (path, body, token) => fetch(new URL(path, endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
const encode = v => new TextEncoder().encode(JSON.stringify(v));
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const publicKey = { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y };
const fingerprint = b64(await crypto.subtle.digest('SHA-256', encode(publicKey)));
for (const token of [undefined, 'invalid-public-identity-probe']) {
  const hello = await http('/identity/challenge', { version: 1 });
  if (!hello.ok) throw Error(`Identity challenge unavailable (${hello.status})`);
  const { challenge } = await hello.json();
  const operation = { publication: null, type: 'sync' };
  const signature = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, encode(['pboard-identity-v1', challenge, fingerprint, operation])));
  const body = { version: 1, challenge, publicKey, operation, signature };
  const denied = await http('/identity/exchange', body, token);
  const code = (await denied.json()).code;
  if (denied.status !== 403 || code !== (token ? 'google_token_rejected' : 'google_token_missing')) throw Error('Unauthenticated identity access was not rejected at the expected boundary');
  const replay = await http('/identity/exchange', body, token);
  if (replay.status !== 403 || (await replay.json()).code !== 'challenge_invalid') throw Error('Identity replay was not rejected');
}
const malformed = await http('/identity/challenge', { version: 1, proxy: 'https://example.test' });
if (malformed.status !== 422) throw Error('Unknown challenge fields were accepted');
console.log('PASS public identity service: enabled over verified TLS; missing/invalid Google credentials rejected; fresh device proof required; consumed challenge replay rejected; unknown fields rejected. No real account or board accessed.');

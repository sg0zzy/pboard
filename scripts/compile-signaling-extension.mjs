// Only invoked by the explicit managed experimental build, never ordinary builds.
import { build } from 'vite';
if (process.env.PBOARD_SIGNALING_DEV_BUILD !== '1' || process.env.PBOARD_STAGE !== '1') throw Error('Use build-signaling-experiment.mjs');
const url = new URL(process.env.VITE_PBOARD_SIGNALING_WS_URL || 'ws://127.0.0.1:8787/ws');
const google = process.env.VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT === '1';
let authority = '';
if (google) {
  const key = JSON.parse(process.env.VITE_PBOARD_SIGNALING_AUTHORITY || 'null');
  if (!key || Object.keys(key).sort().join(',') !== 'crv,kty,x,y' || key.kty !== 'EC' || key.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y)) throw Error('Google enrollment requires a public P-256 authority pin; private keys are forbidden');
  authority = JSON.stringify(key);
}
if (url.username || url.password || url.search || url.hash || !(['wss:'].includes(url.protocol) || (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw Error('Invalid experimental signaling URL');
await build({ configFile: process.argv[2], define: {
  'import.meta.env.DEV': 'true',
  'import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER': JSON.stringify('websocket'),
  'import.meta.env.VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT': JSON.stringify(google ? '1' : '0'),
  'import.meta.env.VITE_PBOARD_SIGNALING_AUTHORITY': JSON.stringify(authority),
  'import.meta.env.VITE_PBOARD_SIGNALING_WS_URL': JSON.stringify(url.href)
} });

/** Negative-only public-service probe. No Google account or valid credential used. */
import { createHash } from 'node:crypto';
const endpoint = new URL(process.argv[2] || 'ws://127.0.0.1:8787/ws');
if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && ['127.0.0.1','localhost'].includes(endpoint.hostname))) throw Error('Use WSS or loopback');
const base = new URL(endpoint); base.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const publicKey = { crv:'P-256', kty:'EC', x:jwk.x, y:jwk.y };
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const hash = bytes => createHash('sha256').update(bytes).digest('base64url');
const device = hash(JSON.stringify(publicKey));
const sign = async bytes => b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,bytes));
async function post(path, body, token) {
 const response=await fetch(new URL(path,base),{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
 return {status:response.status,body:await response.json()};
}
const hello=await post('/experiment/challenge',{});
if(hello.status!==200 || !/^[A-Za-z0-9_-]{43}$/.test(hello.body.challenge)) throw Error('Google enrollment is not active');
const scope='0'.repeat(64);
const request={challenge:hello.body.challenge,kind:'account',scope,driveProjectFileId:'',driveFolderId:'',publicKey,
 signature:await sign(new TextEncoder().encode(JSON.stringify(['pboard-google-enroll-v1',hello.body.challenge,device,'account',scope,'',''])))};
const denied=await post('/experiment/enroll',request,'pboard-invalid-negative-test-token');
if(denied.status!==403 || denied.body.code!=='google_token_rejected') throw Error('Invalid Google credential was not safely rejected, or Google verification is unavailable');
const replay=await post('/experiment/enroll',request,'pboard-invalid-negative-test-token');
if(replay.status!==403 || replay.body.code!=='challenge_invalid') throw Error('Enrollment challenge replay was accepted');
// A valid device signature and self-signed manifest must not bypass Google admission.
const topic='pboard-collab-negative-probe-cards';
const room=`pboard-v2-${device}-${hash(JSON.stringify(['pboard-ws-room-v2',topic,'file','folder']))}`;
const payload=Buffer.from(JSON.stringify({protocol:2,boardId:'negative-probe',driveProjectFileId:'file',driveFolderId:'folder',authorityKeyId:device,epoch:1,issuedAt:Date.now(),expiresAt:Date.now()+300000,devices:[{deviceKeyId:device,publicKey,role:'owner'}]}));
const length=Buffer.alloc(4);length.writeUInt32LE(payload.length);
const manifestSignature=await sign(Buffer.concat([Buffer.from('pboard-manifest-v2'),length,payload]));
const socket=new WebSocket(endpoint);
let timer;
try {
 await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('Signaling rejection timed out')),10000);
  socket.onerror=()=>reject(Error('WebSocket failed'));
  socket.onmessage=async event=>{try{
   const message=JSON.parse(String(event.data));
   if(message.type==='welcome')socket.send(JSON.stringify({type:'authenticate',version:2,room,deviceKeyId:device,
    signature:await sign(Buffer.from(JSON.stringify(['pboard-ws-auth-v2',message.challenge,message.session,room,device,hash(payload)]))),
    authorization:{topic,authority:publicKey,manifestPayload:b64(payload),manifestSignature}}));
   else if(message.type==='error'&&message.code==='unauthorized')resolve();
   else reject(Error('Self-signed authorization was not rejected'));
  }catch(error){reject(error);}};
 });
} finally {clearTimeout(timer);socket.close();}
console.log('PASS: live Google verification rejects invalid credentials; challenge replay and self-signed room bypass are denied. No real Google token used.');

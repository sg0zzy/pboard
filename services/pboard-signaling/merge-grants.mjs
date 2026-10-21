/** Merge explicitly approved public exports; never discover/authorize devices. */
import { readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
const args=process.argv.slice(2);const outIndex=args.indexOf('--out');
if(outIndex<0||!args[outIndex+1])throw Error('Usage: node merge-grants.mjs --out PATH [--replace] PUBLIC_EXPORT.json ...');
const output=args.splice(outIndex,2)[1];const replace=args.includes('--replace');const files=args.filter(x=>x!=='--replace');
if(!files.length)throw Error('Provide at least one approved public export');
const rooms=Object.create(null);
for(const file of files){
 const config=JSON.parse(await readFile(file,'utf8'));
 if(!config.rooms||typeof config.rooms!=='object'||Array.isArray(config.rooms))throw Error('Input must be a relay-grant export');
 for(const [room,grants]of Object.entries(config.rooms)){
  if(!/^[A-Za-z0-9_-]{1,240}$/.test(room)||!grants||Array.isArray(grants)||typeof grants!=='object'||Object.keys(grants).length<1||Object.keys(grants).length>64)throw Error('Invalid room/grant bounds');
  const normalized=Object.create(null);
  for(const id of Object.keys(grants).sort()){
   const grant=grants[id];const key=grant.publicKey;
   if(!key||Object.keys(key).sort().join(',')!=='crv,kty,x,y'||key.crv!=='P-256'||key.kty!=='EC'||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=Date.now())throw Error('Invalid, private or expired public grant');
   const jwk={crv:key.crv,kty:key.kty,x:key.x,y:key.y};createPublicKey({key:jwk,format:'jwk'});
   if(createHash('sha256').update(JSON.stringify(jwk)).digest('base64url')!==id)throw Error('Public key fingerprint mismatch');
   normalized[id]={publicKey:jwk,expiresAt:grant.expiresAt};
  }
  if(rooms[room]&&JSON.stringify(rooms[room])!==JSON.stringify(normalized))throw Error('Conflicting exports for the same room; export the latest manifests again on both devices');
  rooms[room]=normalized;
 }
}
if(Object.keys(rooms).length>1024)throw Error('Too many rooms');
const handle=await open(output,constants.O_WRONLY|constants.O_CREAT|(replace?constants.O_TRUNC:constants.O_EXCL)|constants.O_NOFOLLOW,0o600);
try{await handle.writeFile(JSON.stringify({rooms},null,2)+'\n');}finally{await handle.close();}
console.log('Wrote approved public relay grants. Restart the Rust service to load them.');

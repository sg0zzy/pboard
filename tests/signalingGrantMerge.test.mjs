import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
it('merges explicitly approved public room exports, rejecting stale conflicts, private material and implicit overwrites',()=>{
 const work=mkdtempSync(join(tmpdir(),'pboard-grants-'));
 try{
  const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const {x,y}=publicKey.export({format:'jwk'});
  const jwk={crv:'P-256',kty:'EC',x,y};const id=createHash('sha256').update(JSON.stringify(jwk)).digest('base64url');
  const grant={publicKey:jwk,expiresAt:Date.now()+300000};
  const a=join(work,'a.json'),b=join(work,'b.json'),out=join(work,'grants.json');
  const config={rooms:{'pboard-collab-board-cards':{[id]:grant}}};writeFileSync(a,JSON.stringify(config));
  writeFileSync(b,JSON.stringify({rooms:{...config.rooms,'pboard-account-other-order':{[id]:grant}}}));
  const run=(...args)=>spawnSync(process.execPath,[resolve('services/pboard-signaling/merge-grants.mjs'),'--out',out,...args],{encoding:'utf8'});
  expect(run(a,b).status).toBe(0);expect(Object.keys(JSON.parse(readFileSync(out,'utf8')).rooms)).toHaveLength(2);
  expect(run(a,b).status).not.toBe(0);expect(run('--replace',a,b).status).toBe(0);
  const before=readFileSync(out,'utf8');
  writeFileSync(b,JSON.stringify({rooms:{'pboard-collab-board-cards':{[id]:{...grant,expiresAt:grant.expiresAt+1000}}}}));
  expect(run('--replace',a,b).status).not.toBe(0);expect(readFileSync(out,'utf8')).toBe(before);
  writeFileSync(b,JSON.stringify({rooms:{bad:{[id]:{...grant,publicKey:{...jwk,d:'must-never-export'}}}}}));
  expect(run('--replace',b).status).not.toBe(0);expect(readFileSync(out,'utf8')).toBe(before);
  expect(existsSync(out)).toBe(true);
 }finally{rmSync(work,{recursive:true,force:true});}
});

/** Local-only coherent Rust source capture; never deploys or reads private keys. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
const service=resolve(import.meta.dirname), root=resolve(service,'../..');
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
const output=join(service,'local_artifacts',stamp); mkdirSync(output,{recursive:true,mode:0o700});
const scratch=mkdtempSync(join(tmpdir(),'pboard-rust-source-'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventory=[];
const paths=['Cargo.toml','Cargo.lock',...readdirSync(join(service,'src'),{recursive:true}).filter(name=>name.endsWith('.rs')).map(name=>join('src',name))].sort();
const provenance={state:'building',purpose:'owner-authorized independent board-grant rendezvous opt-in; no production publication',
 sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:true,
 standardsPin:JSON.parse(readFileSync(join(root,'dev-standards.lock.json'),'utf8')).commit,
 features:[],createdAt:new Date().toISOString(),rustc:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),sourceFiles:inventory};
try{
 for(const path of paths){const bytes=readFileSync(join(service,path));inventory.push({path:relative(service,join(service,path)),sha256:digest(bytes)});mkdirSync(resolve(scratch,path,'..'),{recursive:true});writeFileSync(join(scratch,path),bytes);}
 execFileSync('cargo',['build','--locked','--release'],{cwd:scratch,env:{...process.env,CARGO_TARGET_DIR:join(service,'target')},stdio:'inherit'});
 const binary=join(output,'pboard-signaling');copyFileSync(join(service,'target/release/pboard-signaling'),binary);chmodSync(binary,0o755);
 const bytes=readFileSync(binary);Object.assign(provenance,{state:'successful',sha256:digest(bytes),size:bytes.length});
 writeFileSync(join(output,'manifest.json'),JSON.stringify(provenance,null,2)+'\n',{mode:0o600});
 console.log(`Local server artifact: ${output}`);console.log(`SHA-256: ${provenance.sha256}`);
}catch(error){provenance.state='failed';writeFileSync(join(output,'manifest.json'),JSON.stringify(provenance,null,2)+'\n',{mode:0o600});throw error;}
finally{rmSync(scratch,{recursive:true,force:true});}

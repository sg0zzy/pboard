/** Two disposable native Firefox profiles: real grants, DTLS and signed RxDB. */
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { zipSync } from 'fflate';
import { build } from 'vite';
const work=await mkdtemp(join(tmpdir(),'pboard-firefox-webrtc-'));
const drivers=[];let rust;let serverLog='';
const external=process.env.PBOARD_M03_RELAY_URL;
if(external && (new URL(external).protocol!=='wss:'||new URL(external).username||new URL(external).password||new URL(external).search||new URL(external).hash))throw Error('Use an explicit WSS endpoint');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await pause(200);}throw Error(label);}
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function browser(addon){
 const p=await port();const child=spawn(process.env.PBOARD_GECKODRIVER||'geckodriver',['--allow-system-access','--host','127.0.0.1','--port',String(p),'--log','error'],{stdio:'ignore'});let failure;child.on('error',e=>{failure=e;});
 const record={child};drivers.push(record);
 async function request(path,body,method='POST'){
  const response=await fetch(`http://127.0.0.1:${p}${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const result=await response.json();if(!response.ok||result.value?.error)throw Error(result.value?.message||'Firefox WebDriver failed');return result.value;
 }
 await until(async()=>{if(failure)throw failure;try{return!!await request('/status',undefined,'GET');}catch{return false;}},'Geckodriver unavailable');
 const uuid='d93d6119-4704-4e24-9561-b7c02f7ed803',id='pboard-grant-test@local.invalid';
 const result=await request('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{binary:'/usr/bin/firefox',args:['-headless'],prefs:{'extensions.webextensions.uuids':JSON.stringify({[id]:uuid})}}}}});record.session=result.sessionId;record.request=request;
 await request(`/session/${record.session}/moz/addon/install`,{addon:Buffer.from(addon).toString('base64'),temporary:true});
 await request(`/session/${record.session}/url`,{url:`moz-extension://${uuid}/secure-probe.html`});
 const evaluate=async expression=>{
  const result=await request(`/session/${record.session}/execute/async`,{script:`const done=arguments[arguments.length-1];Promise.resolve().then(()=>eval(arguments[0])).then(value=>done({value:value===undefined?null:value}),error=>done({error:error.message}));`,args:[expression]});
  if(result.error)throw Error(result.error);return result.value;
 };
 await until(()=>evaluate('Boolean(window.secureProbe)'),'Firefox runtime did not load');return evaluate;
}
try{
 const relayPort=await port();const grants=join(work,'grants.json');await writeFile(grants,'{"rooms":{}}');
 if(!external){rust=spawn(resolve('services/pboard-signaling/target/debug/pboard-signaling'),{env:{...process.env,PBOARD_SIGNALING_GRANTS:grants,PBOARD_SIGNALING_BIND:`127.0.0.1:${relayPort}`,PBOARD_SIGNALING_BOARD_GRANTS:'1',RUST_LOG:'pboard_signaling=info'},stdio:['ignore','pipe','pipe']});
 rust.stdout.on('data',value=>{serverLog=(serverLog+value).slice(-20000);});rust.stderr.on('data',value=>{serverLog=(serverLog+value).slice(-20000);});
 await until(async()=>{try{return(await fetch(`http://127.0.0.1:${relayPort}/healthz`)).ok;}catch{return false;}},'Rust server did not start');}
 await build({configFile:false,define:{'import.meta.env.DEV':external?'false':'true','import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER':JSON.stringify('drive')},build:{outDir:join(work,'extension'),emptyOutDir:true,target:'esnext',lib:{entry:resolve('services/pboard-signaling/board-grants-probe.ts'),formats:['es'],fileName:'probe'},rolldownOptions:{output:{codeSplitting:false}}}});
 // Disposable loopback fixture only: Firefox MV3 otherwise upgrades ws to wss.
 const manifest={manifest_version:3,...(external?{}:{content_security_policy:{extension_pages:"script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:*"}}),name:'Pboard Firefox grant test',version:'0.1',permissions:['storage'],host_permissions:[external?`https://${new URL(external).hostname}/*`:'http://127.0.0.1/*'],browser_specific_settings:{gecko:{id:'pboard-grant-test@local.invalid',strict_min_version:'142.0'}}};
 const files={'manifest.json':Buffer.from(JSON.stringify(manifest)),'secure-probe.html':Buffer.from('<script type="module" src="probe.js"></script>'),'probe.js':await readFile(join(work,'extension/probe.js')),'secure-config.json':Buffer.from(JSON.stringify({driveUrl:'http://127.0.0.1:0'}))};
 const addon=zipSync(files);const a=await browser(addon),b=await browser(addon);const url=external||`ws://127.0.0.1:${relayPort}/ws`;
 await a('secureProbe.create()');for(const evaluate of [a,b])await evaluate(`secureProbe.configure(${JSON.stringify(url)})`);
 const invitation=await a("secureProbe.runtime.boardCollaboration.initialize('standalone-board')");
 const request=await b(`secureProbe.runtime.boardCollaboration.deviceRequest(${JSON.stringify(JSON.stringify(invitation))})`);
 const approved=await a(`secureProbe.runtime.boardCollaboration.approve(${JSON.stringify(JSON.stringify(request))},${JSON.stringify(request.deviceKeyId)},'editor')`);
 await b(`secureProbe.runtime.boardCollaboration.trust(${JSON.stringify(JSON.stringify(approved))},${JSON.stringify(request.authorityKeyId)})`);
 await a('secureProbe.start()');await b('secureProbe.start()');
 await until(async()=>{const states=await Promise.all([a('secureProbe.runtime.collaborationManager.state()'),b('secureProbe.runtime.collaborationManager.state()')]);if(states.some(s=>s.error)){console.error('SDP structural names only',await a('secureProbe.stats.sdpShape'),await b('secureProbe.stats.sdpShape'));throw Error(states.map(s=>s.error).filter(Boolean).join('; '));}return states.every(s=>s.connectedPeers.length===1);},'Firefox DTLS connection failed');
 const card=await a("secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT Firefox original'})");
 await until(async()=>(await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.id===card.id),'Firefox signed card did not replicate');
 await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT Firefox edited'})`);
 await until(async()=>(await a("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT Firefox edited'),'Firefox edit did not replicate');
 await b('secureProbe.stop()');await b('secureProbe.start()');
 await until(async()=>(await a('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1,'Firefox reconnect failed');
 const audit=await Promise.all([a('secureProbe.stats'),b('secureProbe.stats')]);if(audit.some(s=>s.google||s.leaked||!s.frames))throw Error('Firefox signaling boundary failed');
 await a('secureProbe.stop()');await b('secureProbe.stop()');
 console.log('PASS two native Firefox profiles '+(external?'[production/public WSS]':'[loopback test fixture]')+': authority-approved grants, strict signed presence/SDP, authenticated DTLS, signed RxDB create/edit, reconnect, no Google or board-data signaling.');
}catch(error){console.error(serverLog);throw error;}finally{
 for(const record of drivers){if(record.session)await record.request(`/session/${record.session}`,undefined,'DELETE').catch(()=>{});if(record.child.exitCode===null){const done=once(record.child,'exit');record.child.kill('SIGTERM');await done;}}
 if(rust?.exitCode===null){const done=once(rust,'exit');rust.kill('SIGTERM');await done;}
 await rm(work,{recursive:true,force:true});
}

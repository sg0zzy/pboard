/** Load the actual packaged experimental Chromium sidebar, not a Vite web page. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
const extension=resolve('dist/chromium');
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
const production=process.env.PBOARD_EXPECT_PRODUCTION==='1';
if(production ? manifest.name!=='Pboard' : manifest.name!=='Pboard (signaling experiment)')throw Error('Build first: node scripts/build-signaling-experiment.mjs chromium');
const profile=await mkdtemp(join(tmpdir(),'pboard-dev-ui-'));
const child=spawn(process.env.PBOARD_CHROMIUM_BIN||'chromium',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'],{stdio:'ignore'});
let socket;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<100;i++){if(await fn())return;await pause(100);}throw Error(label);}
try {
 let port;await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return true;}catch{return false;}},'Chromium failed to start');
 let worker;await until(async()=>{worker=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'));return !!worker;},'Extension background did not start');
 const parsed=new URL(worker.url);const origin=parsed.protocol+'//'+parsed.host;
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin+'/sidebar.html')}`,{method:'PUT'})).json();
 socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
 let sequence=0;const waiting=new Map();
 socket.onmessage=event=>{const m=JSON.parse(event.data);waiting.get(m.id)?.(m);waiting.delete(m.id);};
 async function evaluate(expression){const id=++sequence;const promise=new Promise(r=>waiting.set(id,r));socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));const m=await promise;if(m.result?.exceptionDetails)throw Error(JSON.stringify(m.result.exceptionDetails));return m.result?.result?.value;}
 await until(async()=>await evaluate(`Boolean([...document.querySelectorAll('summary')].find(e=>e.textContent.includes('${production?'WebRTC collaboration':'Experimental device enrollment'}')))`),'Experimental sidebar is blank or enrollment UI missing');
 if(production){
  const text=await evaluate('document.body.textContent');
  if(!text.includes('Signaling: Drive (default)')||text.includes('Experimental device enrollment'))throw Error('Production default or enrollment mode changed');
  console.log('PASS: native Chromium production sidebar exposes WebSocket opt-in and retains Drive default.');
 }else{
 const actual=await evaluate(`({text:document.querySelector('#root').textContent.length,diagnostics:[...document.querySelectorAll('summary')].some(e=>e.textContent.includes('Live collaboration diagnostics')),verifiedEmail:!!document.querySelector('input[aria-label="Independently verified Google email"]'),storage:typeof chrome.storage.local.get,importFile:!!document.querySelector('input[type="file"]')})`);
 const google=await evaluate(`Boolean([...document.querySelectorAll('button')].find(e=>e.textContent.includes('Connect / reconnect with Google')))`);
 if(process.env.PBOARD_EXPECT_GOOGLE_ENROLLMENT==='1'&&(!google||actual.importFile||actual.verifiedEmail))throw Error('Expected Google connect UI without manual JSON controls');
 if(actual.text<100||actual.storage!=='function'||(!google&&(!actual.importFile||!actual.verifiedEmail))||!actual.diagnostics)throw Error('Sidebar UI/API check failed');
 console.log('PASS: actual experimental extension background and sidebar render with native Chrome APIs; enrollment controls and diagnostic history present (manual or Google-verified mode). No Google account required for this UI check.');
 }
}finally{
 socket?.close();const ended=once(child,'exit');child.kill('SIGTERM');await ended;await rm(profile,{recursive:true,force:true});
}

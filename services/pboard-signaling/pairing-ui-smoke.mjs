import { exercisePairingUi } from './pairing-ui-scenario.mjs';
/** Actual production sidebar, two native profiles, real public WSS; no runtime mocks. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
const work = await mkdtemp(join(tmpdir(), 'pboard-pairing-ui-'));
const extension = join(work, 'extension'), browsers=[], sockets=[];
const audit = { frames:0, leaked:false, google:0 };
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,seconds=40) { const end=Date.now()+seconds*1000; while(Date.now()<end){if(await fn())return;await pause(150);}throw Error(label); }
async function browser() {
  const profile=await mkdtemp(join(work,'profile-'));
  const child=spawn(process.env.PBOARD_CHROMIUM_BIN||'chromium',['--headless','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--password-store=basic','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'],{stdio:'ignore'});browsers.push(child);
  let port;await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return true;}catch{return false;}},'Browser startup failed');
  let worker;await until(async()=>{worker=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'));return !!worker;},'Extension background did not start');
  const origin=new URL(worker.url).origin==='null'?worker.url.slice(0,worker.url.lastIndexOf('/')):new URL(worker.url).origin;
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin+'/sidebar.html')}`,{method:'PUT'})).json();
  const socket=new WebSocket(target.webSocketDebuggerUrl);sockets.push(socket);await once(socket,'open');
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Network.webSocketFrameSent'){audit.frames++;if(/PRIVATE_PAIRING_CARD|data:image|"documents"/.test(message.params.response.payloadData))audit.leaked=true;}
    if(message.method==='Network.requestWillBeSent'){
      if(message.params.request.url.startsWith('https://www.googleapis.com'))audit.google++;
      if(message.params.request.url.includes('/grants/')&&/PRIVATE_PAIRING_CARD|data:image|"documents"/.test(message.params.request.postData||''))audit.leaked=true;
    }
    pending.get(message.id)?.(message);pending.delete(message.id);
  };
  async function command(method,params={}){const id=++sequence;let timer;const result=new Promise((done,reject)=>{pending.set(id,done);timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser operation timeout'));},45000);});socket.send(JSON.stringify({id,method,params}));try{return await result;}finally{clearTimeout(timer);}}
  await command('Network.enable');
  const evaluate=async expression=>{const message=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(message.result?.exceptionDetails)throw Error('Sidebar operation failed');return message.result?.result?.value;};
  await until(()=>evaluate("Boolean(document.querySelector('.board-collaboration'))"),'Sidebar did not render');
  const click=async label=>evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Button unavailable');button.click();})()`);
  const fill=async(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('Field unavailable');Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate("document.querySelector('.board-collaboration').open=true");
  const reload=async()=>{
    const marker=crypto.randomUUID();await evaluate(`window.__pairingReload=${JSON.stringify(marker)}`);await command('Page.reload');
    await until(async()=>{try{return await evaluate(`window.__pairingReload!==${JSON.stringify(marker)} && Boolean(document.querySelector('.board-collaboration'))`);}catch{return false;}},'Sidebar reload failed');
    await evaluate("document.querySelector('.board-collaboration').open=true");
  };
  return {evaluate,click,fill,reload};
}
try {
  await cp(resolve('dist/chromium'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  if(manifest.name!=='Pboard')throw Error('Build ordinary Chromium first');
  // Fixture represents the user granting this one optional host. Normal manifest
  // remains unchanged; permission-denial/user-gesture behavior has unit coverage.
  manifest.host_permissions=[...new Set([...manifest.host_permissions,'https://pboard.cecosl.ovh/*'])];
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  const a=await browser(),b=await browser();
  await exercisePairingUi(a,b);
  if(!audit.frames||audit.google||audit.leaked)throw Error('Production sidebar signaling boundary failed');
  console.log('PASS actual production sidebar in two native Chromium profiles: real board/card creation; connection codes; no pre-approval content; pending-request reload recovery; matching-code owner approval; automatic board receipt; editor change replicated; sidebar reopen; explicit signed-board copy/edit with original preserved; no Google calls or detected board data in signaling. Optional host permission pre-granted only in disposable test manifest.');
} finally {
  for(const socket of sockets)socket.close();
  for(const child of browsers){if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}}
  await rm(work,{recursive:true,force:true});
}

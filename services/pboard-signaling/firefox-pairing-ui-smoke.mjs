/** Two actual Firefox sidebars, real grant pairing and public WSS. */
import { exercisePairingUi } from './pairing-ui-scenario.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm,readdir,stat,cp } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { zipSync } from 'fflate';
const work=await mkdtemp(join(tmpdir(),'pboard-firefox-pairing-ui-')),drivers=[];
let pages=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await pause(200);}throw Error(label);}
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function browser(addon,id){
 const p=await port();const child=spawn(process.env.PBOARD_GECKODRIVER||'geckodriver',['--allow-system-access','--host','127.0.0.1','--port',String(p),'--log','error'],{stdio:'ignore'});let failure;child.on('error',e=>{failure=e;});
 const record={child};drivers.push(record);
 async function request(path,body,method='POST'){
  const response=await fetch(`http://127.0.0.1:${p}${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const result=await response.json();if(!response.ok||result.value?.error)throw Error(result.value?.message||'Firefox WebDriver failed');return result.value;
 }
 await until(async()=>{if(failure)throw failure;try{return!!await request('/status',undefined,'GET');}catch{return false;}},'Geckodriver unavailable');
 const uuid='d93d6119-4704-4e24-9561-b7c02f7ed803';
 const result=await request('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{binary:process.env.PBOARD_FIREFOX_BIN||'/usr/bin/firefox',args:['-headless'],prefs:{'extensions.webextensions.uuids':JSON.stringify({[id]:uuid})}}}}});record.session=result.sessionId;record.request=request;
 await request(`/session/${record.session}/moz/addon/install`,{addon:Buffer.from(addon).toString('base64'),temporary:true});
 // Firefox opens sidebar_action on install. Close that extra view before opening
 // the full-tab sidebar under test, preserving one replication owner per profile.
 await request(`/session/${record.session}/moz/context`,{context:'chrome'});
 await request(`/session/${record.session}/execute/sync`,{script:'window.SidebarController?.hide();return null;',args:[]});
 await request(`/session/${record.session}/moz/context`,{context:'content'});
 await request(`/session/${record.session}/url`,{url:`moz-extension://${uuid}/sidebar.html`});
 const evaluate=async expression=>{
  const result=await request(`/session/${record.session}/execute/async`,{script:`const done=arguments[arguments.length-1];Promise.resolve().then(()=>eval(arguments[0])).then(value=>done({value:value===undefined?null:value}),error=>done({error:error.message}));`,args:[expression]});
  if(result.error)throw Error(result.error);return result.value;
 };
 await until(()=>evaluate("Boolean(document.querySelector('.board-collaboration'))"),'Firefox sidebar did not render');
 const click=async label=>{
  const xpath=`//button[normalize-space(.)=${JSON.stringify(label)}]`;
  const element=await request(`/session/${record.session}/element`,{using:'xpath',value:xpath});
  await request(`/session/${record.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`,{});
 };
 const fill=async(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await evaluate("document.querySelector('.board-collaboration').open=true");
 const reload=async()=>{await request(`/session/${record.session}/refresh`,{});await until(()=>evaluate("Boolean(document.querySelector('.board-collaboration'))"),'Reload failed');await evaluate("document.querySelector('.board-collaboration').open=true");};
 return {evaluate,click,fill,reload};
}
try{
 const extension=join(work,'extension');await cp(resolve('dist'),extension,{recursive:true,filter:source=>!source.startsWith(resolve('dist/chromium'))});
 const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));if(manifest.name!=='Pboard')throw Error('Build ordinary Firefox first');
 const id=manifest.browser_specific_settings.gecko.id;
 // Narrow optional host permission pre-granted only in this disposable fixture.
 manifest.host_permissions=[...new Set([...manifest.host_permissions,'https://pboard.cecosl.ovh/*'])];
 await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
 await writeFile(join(extension,'pairing-audit.js'),`window.pairingAudit={frames:0,leaked:false,google:0,authBoards:[]};const Native=WebSocket;window.WebSocket=class extends Native{send(data){pairingAudit.frames++;try{const m=JSON.parse(data);if(m.type==='authenticate'&&m.authorization)pairingAudit.authBoards.push(JSON.parse(atob(m.authorization.manifestPayload.replaceAll('-','+').replaceAll('_','/'))).boardId);}catch{}if(/PRIVATE_PAIRING_CARD|data:image|"documents"/.test(String(data)))pairingAudit.leaked=true;super.send(data);}};const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{if(String(input).startsWith('https://www.googleapis.com'))pairingAudit.google++;if(String(input).includes('/grants/')&&/PRIVATE_PAIRING_CARD|data:image|"documents"/.test(String(init?.body)))pairingAudit.leaked=true;return nativeFetch(input,init);};`);
 const html=await readFile(join(extension,'sidebar.html'),'utf8');await writeFile(join(extension,'sidebar.html'),html.replace('<head>','<head><script src="pairing-audit.js"></script>'));
 const files={};for(const name of await readdir(extension,{recursive:true}))if((await stat(join(extension,name))).isFile())files[name]=await readFile(join(extension,name));
 const addon=zipSync(files),a=await browser(addon,id),b=await browser(addon,id);pages=[a,b];
 await exercisePairingUi(a,b);
 const audit=await Promise.all([a.evaluate('window.pairingAudit'),b.evaluate('window.pairingAudit')]);
 if(audit.some(s=>!s.frames||s.google||s.leaked))throw Error('Firefox signaling boundary failed');
 console.log('PASS actual production Firefox sidebars: connection-code enrollment, pending reload, verified owner approval, signed WebRTC/RxDB edits, reopen, explicit signed-board copy and original preservation. No Google calls or detected content in signaling; optional host pre-granted in disposable fixture.');
}catch(error){
 for(const page of pages){try{console.error('Safe Firefox pairing status:',await page.evaluate("[...document.querySelectorAll('.board-pairing > p[role=status]')].map(element=>element.textContent)"));;console.error('Safe auth board match:',await page.evaluate("pairingAudit.authBoards.slice(-4).map(id=>id===window.__expectedPairingBoard)"));}catch{}}
 throw error;
}finally{
 for(const d of drivers){try{if(d.session)await d.request(`/session/${d.session}`,undefined,'DELETE');}catch{}d.child.kill('SIGTERM');}
 await rm(work,{recursive:true,force:true});
}

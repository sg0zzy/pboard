/** Native Firefox packaged-sidebar smoke in a disposable WebDriver profile. */
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { zipSync } from 'fflate';
import { build } from 'vite';
const directory=resolve('dist');
const manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
const production=process.env.PBOARD_EXPECT_PRODUCTION==='1';
if(production ? manifest.name!=='Pboard' : manifest.name!=='Pboard (signaling experiment)')throw Error('Build first: node scripts/build-signaling-experiment.mjs firefox');
const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const driver=spawn(process.env.PBOARD_GECKODRIVER||'geckodriver',['--allow-system-access','--host','127.0.0.1','--port',String(port),'--log','error'],{stdio:'ignore'});
let failure;driver.on('error',error=>{failure=error;});let session;let probeDirectory;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,body,method='POST'){
 const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const result=await response.json();if(!response.ok||result.value?.error)throw Error(result.value?.message||'WebDriver error');return result.value;
}
try {
 for(let i=0;;i++){if(failure)throw failure;try{await request('/status',undefined,'GET');break;}catch(error){if(i>100)throw error;await pause(100);}}
 const uuid='d93d6119-4704-4e24-9561-b7c02f7ed803';
 const created=await request('/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{binary:process.env.PBOARD_FIREFOX_BIN||'/usr/bin/firefox',args:['-headless'],prefs:{'extensions.webextensions.uuids':JSON.stringify({[manifest.browser_specific_settings.gecko.id]:uuid})}}}}});session=created.sessionId;
 const files={};for(const entry of await readdir(directory,{recursive:true,withFileTypes:true})){
  if(!entry.isFile())continue;const path=resolve(entry.parentPath,entry.name);const name=relative(directory,path).replaceAll('\\','/');if(name.startsWith('chromium/')||name.endsWith('.map'))continue;files[name]=await readFile(path);
 }
 if(process.env.PBOARD_TEST_ENROLLMENT_FETCH==='1'){
  probeDirectory=await mkdtemp(join(tmpdir(),'pboard-firefox-fetch-'));
  const authority=JSON.stringify(JSON.parse(await readFile(resolve('services/pboard-signaling/deploy/ovh-authority.public.json'),'utf8')));
  await build({configFile:false,define:{'import.meta.env.DEV':'true','import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER':JSON.stringify('websocket'),'import.meta.env.VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT':JSON.stringify('1'),'import.meta.env.VITE_PBOARD_SIGNALING_WS_URL':JSON.stringify('wss://pboard.cecosl.ovh/ws'),'import.meta.env.VITE_PBOARD_SIGNALING_AUTHORITY':JSON.stringify(authority)},build:{outDir:probeDirectory,target:'esnext',lib:{entry:resolve('services/pboard-signaling/google-fetch-probe.ts'),formats:['es'],fileName:'broker-probe'},rolldownOptions:{output:{codeSplitting:false}}}});
  files['broker-probe.js']=await readFile(join(probeDirectory,'broker-probe.js'));
 }
 if(process.env.PBOARD_TEST_PERMISSION_UPGRADE==='1'){
  const oldManifest={...manifest,host_permissions:manifest.host_permissions.filter(origin=>!origin.includes('pboard.cecosl.ovh'))};
  await request(`/session/${session}/moz/addon/install`,{addon:Buffer.from(zipSync({...files,'manifest.json':new TextEncoder().encode(JSON.stringify(oldManifest))})).toString('base64'),temporary:true});
 }
 await request(`/session/${session}/moz/addon/install`,{addon:Buffer.from(zipSync(files)).toString('base64'),temporary:true});
 await request(`/session/${session}/url`,{url:`moz-extension://${uuid}/sidebar.html`});
 let ready=false;
 for(let i=0;i<100;i++){
  const state=await request(`/session/${session}/execute/sync`,{script:`return {standalone:[...document.querySelectorAll('summary')].some(x=>x.textContent==='WebRTC collaboration'),text:document.getElementById('root')?.textContent.length||0,enrollment:[...document.querySelectorAll('summary')].some(x=>x.textContent.includes('Experimental device enrollment')),file:!!document.querySelector('input[type="file"]'),google:[...document.querySelectorAll('button')].some(x=>x.textContent.includes('Connect / reconnect with Google')),diagnostics:[...document.querySelectorAll('summary')].some(x=>x.textContent.includes('Live collaboration diagnostics')),email:!!document.querySelector('input[aria-label="Independently verified Google email"]')}`,args:[]});
  if(state.text>100&&(production?(state.standalone&&!state.enrollment):(state.enrollment&&(state.google||(state.file&&state.email))&&state.diagnostics))){ready=true;break;}await pause(100);
 }
 if(!ready)throw Error('Firefox experimental sidebar is blank or enrollment controls missing');
 if(production){
  const text=await request(`/session/${session}/execute/sync`,{script:'return document.body.textContent;',args:[]});
  if(!text.includes('Signaling: Drive (default)'))throw Error('Production default changed');
  console.log('PASS: native Firefox production sidebar exposes WebSocket opt-in and retains Drive default.');
 }
 if(process.env.PBOARD_TEST_PERMISSION_UPGRADE==='1'){
  const granted=await request(`/session/${session}/execute/async`,{script:`const done=arguments[arguments.length-1];browser.permissions.contains({origins:['https://pboard.cecosl.ovh/*']}).then(value=>done({granted:value}),()=>done({error:'permission_query_failed'}));`,args:[]});
  console.log('Native Firefox permission after extension host update:',JSON.stringify(granted));
  if(granted.granted!==false)throw Error('Upgrade scenario did not reproduce the missing host permission');
 }
 if(process.env.PBOARD_TEST_ENROLLMENT_FETCH==='1'){
  const probe=await request(`/session/${session}/execute/async`,{script:`const done=arguments[arguments.length-1];
   (async()=>{const options={fetcher:fetch};const results=[];
    for(const kind of ['method','standalone']){try{
     const args=['https://pboard.cecosl.ovh/experiment/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)}];
     const response=await (kind==='method'?options.fetcher(...args):(0,options.fetcher)(...args));
     results.push({kind,status:response.status});
    }catch(error){results.push({kind,name:error.name,message:error.message});}}
    done(results);
   })().catch(error=>done({error:error.name}));`,args:[]});
  console.log('Native Firefox enrollment fetch probe:',JSON.stringify(probe));
  const result=await request(`/session/${session}/execute/async`,{script:`const done=arguments[arguments.length-1];
   (async()=>{const m=await import('moz-extension://${uuid}/broker-probe.js');
    const broker=m.createGoogleBrokerEnrollment({storage:{get:async()=>({}),set:async()=>{}},getAccessToken:async()=>'pboard-invalid-native-firefox-test-token',fetcher:window.fetch,canAccessEndpoint:origin=>browser.permissions.contains({origins:[origin]})});
    let message='unexpected success';try{await broker.security({kind:'account',scope:'0'.repeat(64),file:'',folder:'',role:'owner'});}catch(error){message=error.message;}
    done({message,events:m.collaborationDiagnostics.snapshot().map(entry=>entry.event)});
   })().catch(error=>done({message:error.message}));`,args:[]});
  if(process.env.PBOARD_TEST_PERMISSION_UPGRADE==='1'){
   if(!result.message.includes('browser permission')||!result.events?.includes('google.account.failed.host_permission'))throw Error('Missing upgraded permission was not detected: '+JSON.stringify(result));
   await request(`/session/${session}/execute/sync`,{script:`const button=document.createElement('button');button.id='test-permission-grant';button.textContent='Allow test signaling service';button.onclick=()=>{browser.permissions.request({origins:['https://pboard.cecosl.ovh/*']}).then(granted=>window.testPermissionResult={granted},()=>window.testPermissionResult={error:true});};document.body.prepend(button);`,args:[]});
   const element=await request(`/session/${session}/element`,{using:'css selector',value:'#test-permission-grant'});
   await request(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`,{});
   await request(`/session/${session}/moz/context`,{context:'chrome'});
   let button;
   for(let i=0;i<100;i++){
    button=await request(`/session/${session}/execute/sync`,{script:`return document.getElementById('addon-webext-permissions-notification')?.button||null;`,args:[]});
    if(button)break;await pause(100);
   }
   if(!button)throw Error('Firefox permission prompt did not appear');
   // Headless Firefox cannot scroll its browser-chrome notification into view;
   // activate the native prompt's primary button without changing permission data.
   await request(`/session/${session}/execute/sync`,{script:`document.getElementById('addon-webext-permissions-notification').button.click();`,args:[]});
   await request(`/session/${session}/moz/context`,{context:'content'});
   const restored=await request(`/session/${session}/execute/async`,{script:`const done=arguments[arguments.length-1];browser.permissions.contains({origins:['https://pboard.cecosl.ovh/*']}).then(granted=>done({granted}));`,args:[]});
   if(!restored.granted)throw Error('Firefox service permission was not granted');
   const retry=await request(`/session/${session}/execute/async`,{script:`const done=arguments[arguments.length-1];
    (async()=>{const m=await import('moz-extension://${uuid}/broker-probe.js');const broker=m.createGoogleBrokerEnrollment({storage:{get:async()=>({}),set:async()=>{}},getAccessToken:async()=>'pboard-invalid-native-firefox-test-token',fetcher:window.fetch,canAccessEndpoint:origin=>browser.permissions.contains({origins:[origin]})});
     try{await broker.security({kind:'account',scope:'0'.repeat(64),file:'',folder:'',role:'owner'});done({error:'unexpected success'});}catch(error){done({message:error.message});}
    })().catch(()=>done({error:'retry_failed'}));`,args:[]});
   if(!retry.message?.includes('google_token_rejected'))throw Error('Grant did not restore actual provider HTTP access: '+JSON.stringify(retry));
   console.log('PASS: upgraded Firefox host permission detected; real user-gesture request and native permission prompt restore service access.');
  } else if(!result.message.includes('google_token_rejected')||!result.events?.includes('google.account.challenge_received')||!result.events.includes('google.account.failed.enrollment'))throw Error('Actual Firefox provider did not reach Google verification: '+JSON.stringify(result));
  if(JSON.stringify(result).includes('pboard-invalid-native-firefox-test-token'))throw Error('Credential leaked in native diagnostics');
  if(process.env.PBOARD_TEST_PERMISSION_UPGRADE!=='1')console.log('PASS: real Google enrollment provider uses native Firefox fetch and reaches the OVH verifier; deliberately invalid token rejected with safe phase diagnostics.');
 }
 if(!production)console.log('PASS: native Firefox temporary extension/sidebar renders with enrollment controls and diagnostic history (manual or Google-verified mode) in a disposable profile. No Google account used.');
}finally{
 if(session)await request(`/session/${session}`,undefined,'DELETE').catch(()=>{});
 if(driver.exitCode===null){const done=once(driver,'exit');driver.kill('SIGTERM');await done;}
 if(probeDirectory)await rm(probeDirectory,{recursive:true,force:true});
}

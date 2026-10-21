/** End-to-end protocol-2 enrollment + runtime + RxDB in two real extension profiles.
 * Google HTTP alone is simulated. No authentication or storage-guard doubles. */
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
const root = resolve(import.meta.dirname, '../..');
const work = await mkdtemp(join(tmpdir(), 'pboard-m02-'));
const extension = join(work, 'extension');
const browsers = []; const sockets = []; let rust;
const interactive = process.env.PBOARD_TEST_INTERACTIVE === '1';
const demoDuration = Number(process.env.PBOARD_TEST_DURATION || 0);
let shutdownRequested = false;
const requestShutdown = () => { shutdownRequested = true; };
process.on('SIGINT', requestShutdown); process.on('SIGTERM', requestShutdown);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, reason, timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(shutdownRequested)throw Error('Test interrupted');if(await fn())return;await pause(100);}
  throw Error(reason);
}
const files = new Map([
 ['root-board',{id:'root-board',name:'Pboard',mimeType:'application/vnd.google-apps.folder',parents:['root']}],
 ['folder',{id:'folder',name:'m02-board',mimeType:'application/vnd.google-apps.folder',parents:['root-board']}],
 ['shared',{id:'shared',name:'project.json',mimeType:'application/json',parents:['folder'],contents:JSON.stringify({format:'pboard-project',version:1,exportedAt:new Date().toISOString(),project:{id:'m02-board',name:'M02 secure test',template:'project',revision:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'},items:[]})}],
 ['realtime',{id:'realtime',name:'realtime',mimeType:'application/vnd.google-apps.folder',parents:['folder']}]
]);
let sequence=0;
const standalone=process.env.PBOARD_BOARD_GRANTS==='1';
const privateRecovery=process.env.PBOARD_PRIVATE_RECOVERY==='1';
if(privateRecovery && (!standalone || process.env.PBOARD_M03_RELAY_URL || process.env.PBOARD_GOOGLE_IDENTITY_SHARING==='1'))throw Error('Private recovery fixture requires local independent board mode');
const identitySharing=process.env.PBOARD_GOOGLE_IDENTITY_SHARING==='1';
const recoveryFaults=process.env.PBOARD_RECOVERY_FAULTS==='1';
if(recoveryFaults && (!identitySharing || process.env.PBOARD_M03_RELAY_URL))throw Error('Recovery fault tests require local identity fixture mode');
if(identitySharing && (!standalone || process.env.PBOARD_M03_RELAY_URL))throw Error('Identity fixture requires local independent board-grants mode');
const googleBroker=process.env.PBOARD_M04_GOOGLE_ENROLLMENT==='1';
if(standalone && (googleBroker || process.env.PBOARD_M02_USE_DRIVE==='1'))throw Error('Standalone grant probe uses the local board-grants server');
if(googleBroker && (process.env.PBOARD_M03_RELAY_URL || process.env.PBOARD_M02_USE_DRIVE==='1'))throw Error('Google fixture enrollment uses only the local test-feature server');
const useDrive=process.env.PBOARD_M02_USE_DRIVE==='1';
const externalRelay=process.env.PBOARD_M03_RELAY_URL;
if(interactive && !standalone)throw Error('Interactive demo requires independent board grants');
if(!Number.isInteger(demoDuration)||demoDuration<0||demoDuration>3600)throw Error('Invalid demo duration');
if(externalRelay && (useDrive || new URL(externalRelay).protocol!=='wss:')) throw Error('External relay test requires WSS and the WebSocket provider');
const differentUsers=process.env.PBOARD_M02_SAME_ACCOUNT !== '1';
const owner={id:'owner',type:'user',role:'owner',emailAddress:'owner@example.test'};
let legacyDiscoveryReads=0;let driveStorageAvailable=true;
if(privateRecovery)files.clear();
const drive=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');const email=(req.headers.authorization||'').replace('Bearer ','');let text='';for await(const c of req)text+=c;
  res.setHeader('Content-Type','application/json');
  if(url.pathname.endsWith('/about')){res.end(JSON.stringify({user:{emailAddress:email,displayName:'Test owner'}}));return;}
  if(!driveStorageAvailable){res.statusCode=503;res.end(JSON.stringify({error:{message:'Synthetic private storage outage'}}));return;}
  if(url.pathname.endsWith('/permissions')){res.end(JSON.stringify({permissions:[owner,{id:'editor',type:'user',role:'writer',emailAddress:'editor@example.test'}]}));return;}
  if(googleBroker && req.method==='GET' && !url.searchParams.get('alt') && /\/files\/(shared|folder)$/.test(url.pathname)){const {contents,...metadata}=files.get(url.pathname.split('/').at(-1));res.end(JSON.stringify({...metadata,trashed:false,capabilities:{canEdit:true}}));return;}
  if(url.pathname.endsWith('/files')&&req.method==='GET'){
   const query=url.searchParams.get('q')||'';const name=query.match(/name = '([^']+)'/)?.[1];const parent=query.match(/'([^']+)' in parents/)?.[1];const contains=query.match(/name contains '([^']+)'/)?.[1];
   const space=url.searchParams.get('spaces');
   if(privateRecovery && space==='drive')legacyDiscoveryReads++;
   res.end(JSON.stringify({files:[...files.values()].filter(f=>(!name||f.name===name)&&(!contains||f.name.includes(contains))&&(!parent||f.parents.includes(parent))&&(space!=='appDataFolder'||(f.parents.includes('appDataFolder')&&f.ownerEmail===email))).map(({contents,...f})=>f)}));return;
  }
  if(url.pathname.endsWith('/files')&&req.method==='POST'){
   let metadata,contents='';const boundary=req.headers['content-type']?.match(/boundary=(.*)/)?.[1];
   if(boundary){const parts=text.split(`--${boundary}`).filter(x=>x.includes('Content-Type')).map(x=>x.split('\r\n\r\n')[1].trim());metadata=JSON.parse(parts[0]);contents=parts[1];}
   else metadata=JSON.parse(text);
   const file={...metadata,id:`file-${++sequence}`,parents:metadata.parents||['root'],ownerEmail:email,contents};files.set(file.id,file);res.end(JSON.stringify(file));return;
  }
  const id=url.pathname.split('/').at(-1);const file=files.get(id);
  if(!file||(file.parents.includes('appDataFolder')&&file.ownerEmail!==email)){res.statusCode=404;res.end('{}');return;}
  if(req.method==='DELETE'){files.delete(id);res.end('{}');return;}
  if(req.method==='PATCH')file.contents=text;
  res.end(url.searchParams.get('alt')==='media'?file.contents:JSON.stringify(file));
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
async function browser({profile:existingProfile,url:restoreUrl}={}) {
  const profile = existingProfile || await mkdtemp(join(work, "profile-"));
  if(!resolve(profile).startsWith(work+'/profile-'))throw Error('Only this test run profiles may be reopened');
  if(existingProfile)await rm(join(profile,'DevToolsActivePort'),{force:true});
  const child = spawn(process.env.PBOARD_CHROMIUM_BIN || "chromium", [
    ...(!interactive || process.env.PBOARD_TEST_HEADLESS === '1' ? ['--headless'] : []), "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    "--window-size=620,800", `--window-position=${browsers.length * 650},50`,
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank"
  ], { stdio: "ignore" });
  browsers.push(child);
  let failure;
  child.on("error", (error) => { failure = error; });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await pause(100); }
  }
  if (!port) throw new Error("Chromium did not start its debugging endpoint");
  let target;let restoreOpened=false;
  await until(async () => {
    let targets;try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();}catch{if(child.exitCode!==null||child.signalCode!==null)throw Error('Test browser exited');return false;}
    target = targets.find(target => target.url?.endsWith('/secure-probe.html'));
    if(!target&&restoreUrl&&!restoreOpened){
      if(!/^chrome-extension:\/\/[a-p]{32}\/secure-probe\.html$/.test(restoreUrl))throw Error('Invalid owned probe URL');
      restoreOpened=true;await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(restoreUrl)}`,{method:'PUT'});
    }
    return !!target;
  }, 'extension page did not open');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  const evaluate = async (expression) => {
    const id = ++next;
    const result = new Promise((resolve) => waiting.set(id, resolve));
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
      expression, awaitPromise: true, returnByValue: true
    } }));
    let timer;
    const message = await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => { waiting.delete(id); reject(Error('Browser operation timed out')); }, 30000); })]).finally(() => clearTimeout(timer));
    if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails));
    return message.result?.result?.value;
  };
  Object.assign(evaluate,{process:child,profile,url:target.url});return evaluate;
}

try {
 await new Promise(r=>drive.listen(0,'127.0.0.1',r));
 const driveUrl=`http://127.0.0.1:${drive.address().port}`;
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const wsUrl=externalRelay || `ws://127.0.0.1:${port}/ws`;
 let authority;
 if(googleBroker||identitySharing){
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
  const publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
  authority={kty:'EC',crv:'P-256',x:publicJwk.x,y:publicJwk.y};
  await writeFile(join(work,'authority.key'),Buffer.from(privateJwk.d,'base64url'),{mode:0o600});
 }
 const testBinary=join(work,'pboard-signaling');
 if(!externalRelay&&!useDrive)await copyFile(process.env.PBOARD_SIGNALING_TEST_BINARY||join(root,'services/pboard-signaling/target/debug/pboard-signaling'),testBinary);
 const grantsPath=join(work,'grants.json');await writeFile(grantsPath,JSON.stringify({rooms:{}}));
 async function startRust(){
  rust=spawn(testBinary,{env:{...process.env,PBOARD_SIGNALING_BIND:`127.0.0.1:${port}`,PBOARD_SIGNALING_GRANTS:grantsPath,PBOARD_SIGNALING_AUTOMATIC_ADMISSION:'1',PBOARD_SIGNALING_BOARD_GRANTS:standalone?'1':'0',RUST_LOG:'pboard_signaling=warn',PBOARD_SIGNALING_GOOGLE_IDENTITIES:identitySharing?'1':'0',...(googleBroker||identitySharing?{PBOARD_SIGNALING_GOOGLE_EMAILS:'owner@example.test,editor@example.test',PBOARD_SIGNALING_AUTHORITY_KEY:join(work,'authority.key'),PBOARD_SIGNALING_ENROLLMENT_STATE:join(work,'enrollment.json'),PBOARD_TEST_GOOGLE_BASE:driveUrl+'/drive/v3',PBOARD_TEST_MANIFEST_LIFETIME_MS:'45000'}:{})},stdio:['ignore','pipe','ignore']});
  rust.stdout.on('data',chunk=>{for(const line of String(chunk).split('\n'))if(line.includes('identity_enrollment_rejected')){const reason=line.match(/reason[^a-z_]+([a-z_]+)/)?.[1];console.error('Test identity rejection:',reason||'unclassified');}});
  await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;}catch{return false;}},'Rust did not start');
 }
 async function stopRust(){const done=once(rust,'exit');rust.kill('SIGTERM');await done;rust=undefined;}
 if(googleBroker||(standalone&&!externalRelay))await startRust();
 await mkdir(extension);
 await build({configFile:false,root,define:{'process.env.NODE_ENV':JSON.stringify('production'),'import.meta.env.DEV':standalone&&externalRelay?'false':'true','import.meta.env.VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT':JSON.stringify(googleBroker?'1':'0'),'import.meta.env.VITE_PBOARD_SIGNALING_AUTHORITY':JSON.stringify(googleBroker?JSON.stringify(authority):''),'import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER':JSON.stringify(useDrive?'drive':'websocket'),'import.meta.env.VITE_PBOARD_SIGNALING_WS_URL':JSON.stringify(wsUrl)},build:{outDir:extension,emptyOutDir:false,target:'esnext',lib:{entry:join(root,standalone?'services/pboard-signaling/board-grants-probe.ts':'services/pboard-signaling/secure-probe.ts'),formats:['es'],fileName:'secure-probe',cssFileName:'secure-probe'},rolldownOptions:{output:{codeSplitting:false}}}});
 await writeFile(join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Pboard protocol-2 local test',version:'0.1',permissions:['storage'],host_permissions:['http://127.0.0.1/*',...(externalRelay?[`https://${new URL(externalRelay).host}/*`]:[])],background:{service_worker:'start.js'}}));
 await writeFile(join(extension,'start.js'),`chrome.runtime.onInstalled.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('secure-probe.html')}));`);
 if(interactive){
  for(const file of ['standalone-demo.css','standalone-demo.mjs'])await copyFile(join(root,'services/pboard-signaling',file),join(extension,file));
  await copyFile(join(root,'services/pboard-signaling/standalone-demo.html'),join(extension,'secure-probe.html'));
 }else await writeFile(join(extension,'secure-probe.html'),(standalone?'<link rel="stylesheet" href="secure-probe.css">':'')+'<script type="module" src="secure-probe.js"></script>');
 await writeFile(join(extension,'secure-config.json'),JSON.stringify({driveUrl}));
 let a=await browser();let b=privateRecovery?null:await browser();
 await until(async()=>await a('Boolean(window.secureProbe)')&&(!b||await b('Boolean(window.secureProbe)')),'runtime failed to initialize');
 if(privateRecovery){
  await a('secureProbe.create()');await a(`secureProbe.configure(${JSON.stringify(wsUrl)})`);
  const photo=await a("secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT restored photo',image:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=',mimeType:'image/png',width:1,height:1}})");
  await a("secureProbe.runtime.boardCollaboration.initialize('standalone-board')");
  await a('secureProbe.start()');await a('secureProbe.connectDrive()');
  await a("secureProbe.runtime.driveSyncState.markDirty('standalone-board')");
  await a("secureProbe.runtime.googleDrive.syncProject('standalone-board')");
  const original=await a("(async()=>{const x=await secureProbe.rx.exportProject('standalone-board');return {project:x.project,items:x.items};})()");
  if(!original.project._sec||!original.items[0]?._sec)throw Error('Recovery fixture did not preserve signed source data');
  // The only remaining copy is private Drive. Destroy the original browser's
  // actual profile, including its authority/device key stores, before B exists.
  if((await a('secureProbe.stats')).leaked)throw Error('Source private board leaked into signaling');
  const ended=once(a.process,'exit');a.process.kill('SIGKILL');await ended;
  await rm(a.profile,{recursive:true,force:true});await stopRust();
  b=await browser();await until(async()=>await b('Boolean(window.secureProbe)'),'fresh recovery device did not initialize');
  if((await b('secureProbe.rx.listProjects()')).length)throw Error('Recovery device was not empty');
  await b(`secureProbe.configure(${JSON.stringify(wsUrl)})`);await b('secureProbe.connectDrive()');
  const result=await b('secureProbe.runtime.googleDrive.reconcileAll()');
  if(result.imported!==1)throw Error('Private data was not restored from Drive alone');
  const restored=await b("secureProbe.rx.exportProject('standalone-board')");
  if(!isDeepStrictEqual(restored,original))throw Error('Recovered private contents or original signatures changed');
  const authority=await b("secureProbe.authorityState('standalone-board')");
  if(authority.ownsAuthority||authority.bundle||authority.security)throw Error('Google recovery implicitly granted board authority');
  const available=await b(`secureProbe.rx.hasImage(${JSON.stringify(photo.imageId)})`);
  const stats=await b('secureProbe.stats');
  if(!available||stats.frames||stats.grantHttp)throw Error('Recovery required a signaling server or failed to restore image bytes');
  console.log('PASS [PR01, PR02] native fresh-device private recovery: original profile/key stores deleted; Rust/peers offline; real RxDB and image bytes restored from synthetic account-private Drive; original signatures preserved; no board authority or grant minted; no rendezvous request.');
  if(legacyDiscoveryReads)throw Error('Independent private recovery queried legacy shared Drive discovery');
  console.log('PASS private file recovery uses appDataFolder without legacy shared-file discovery.');
  const conflictIds=await b('secureProbe.showConflictFixture()');
  await b('secureProbe.connectDrive()');
  await until(async()=>await b('Boolean(document.querySelector(".conflict-entry"))'),'Conflict recovery panel did not render');
  await b('document.querySelectorAll(".conflict-recovery details").forEach(element=>element.open=true); document.querySelector(".conflict-entry input[type=radio]").click()');
  await until(async()=>await b('Boolean(document.querySelector(".conflict-entry textarea"))'),'Manual conflict editor did not render');
  await b('Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(document.querySelector(".conflict-entry textarea"),"PRIVATE_BOARD_TEXT native durable manual resolution"); document.querySelector(".conflict-entry textarea").dispatchEvent(new Event("input",{bubbles:true}))');
  await until(async()=>await b(`(async()=> (await secureProbe.rx.listConflicts()).some(c=>c.boardId===${JSON.stringify(conflictIds.boardId)}&&c.drafts.some(d=>d.content==='PRIVATE_BOARD_TEXT native durable manual resolution')))()`),'Manual draft was not durable before process interruption');
  await b(`secureProbe.runtime.driveSyncState.markDirty(${JSON.stringify(conflictIds.boardId)})`);
  await b(`secureProbe.runtime.googleDrive.syncProject(${JSON.stringify(conflictIds.boardId)})`);
  const conflictProfile={profile:b.profile,url:b.url};const conflictExited=once(b.process,'exit');b.process.kill('SIGKILL');await conflictExited;
  b=await browser(conflictProfile);
  await until(async()=>await b('Boolean(window.secureProbe)'),'Conflict recovery browser did not reopen');
  await b(`secureProbe.showConflictFixture(${JSON.stringify(conflictIds)})`);
  await until(async()=>await b('document.querySelector(".conflict-entry textarea")?.value === "PRIVATE_BOARD_TEXT native durable manual resolution"'),'Manual draft did not survive the browser process restart');
  await b('document.querySelectorAll(".conflict-recovery details").forEach(element=>element.open=true); [...document.querySelectorAll(".conflict-entry button")].find(button=>button.textContent==="Save resolution").click()');
  await until(async()=>await b(`(async()=> (await secureProbe.rx.getCard(${JSON.stringify(conflictIds.cardId)}))?.content === 'PRIVATE_BOARD_TEXT native durable manual resolution')()`),'Reviewed manual resolution was not applied to the real RxDB card');
  const resolvedConflict=await b(`secureProbe.rx.reconciliation.inspect({boardId:${JSON.stringify(conflictIds.boardId)},collection:'cards',documentId:${JSON.stringify(conflictIds.cardId)}})`);
  if(resolvedConflict.kind!=='current'||resolvedConflict.variants[0].parents.length!==2)throw Error('Resolution did not reference both original conflict heads');
  const conflictAudit=await b('secureProbe.stats');if(conflictAudit.frames||conflictAudit.grantHttp)throw Error('Private manual conflict recovery attempted signaling');
  console.log('PASS [Job 5 local UI]: actual Chromium editor, durable manual draft, process kill/reopen, explicit resolution applied to real RxDB with both original variants retained; no signaling. Causal branches are a local fixture, not production transport history exchange.');
  await b('secureProbe.connectDrive()');
  await b(`secureProbe.runtime.driveSyncState.markDirty(${JSON.stringify(conflictIds.boardId)})`);
  await b(`secureProbe.runtime.googleDrive.syncProject(${JSON.stringify(conflictIds.boardId)})`);
  const lostProfile=b.profile;const lostExited=once(b.process,'exit');b.process.kill('SIGKILL');await lostExited;await rm(lostProfile,{recursive:true,force:true});
  b=await browser();await until(async()=>await b('Boolean(window.secureProbe)'),'Fresh history-only recovery browser did not initialize');
  await b(`secureProbe.configure(${JSON.stringify(wsUrl)})`);await b('secureProbe.connectDrive()');await b('secureProbe.runtime.googleDrive.reconcileAll()');
  const historyRecovered=await b(`secureProbe.rx.reconciliation.inspect({boardId:${JSON.stringify(conflictIds.boardId)},collection:'cards',documentId:${JSON.stringify(conflictIds.cardId)}})`);
  const recoveredCard=await b(`secureProbe.rx.getCard(${JSON.stringify(conflictIds.cardId)})`);
  if(historyRecovered.kind!=='current'||historyRecovered.variants[0].parents.length!==2||recoveredCard?.content!=='PRIVATE_BOARD_TEXT native durable manual resolution')throw Error('Private Drive did not recover the explicit resolution and causal parents after permanent source-profile loss');
  const recoveredDrafts=await b('secureProbe.rx.journal.drafts.toArray()');
  if(!recoveredDrafts.some(d=>d.content==='PRIVATE_BOARD_TEXT native durable manual resolution'))throw Error('Private Drive did not recover the durable manual draft');
  const recoveredTrust=await b("secureProbe.authorityState('standalone-board')");
  const recoveredAudit=await b('secureProbe.stats');
  if(recoveredTrust.ownsAuthority||recoveredTrust.bundle||recoveredTrust.security||recoveredAudit.frames||recoveredAudit.grantHttp)throw Error('Private history recovery minted shared authority or required a rendezvous');
  console.log('PASS [Job 6 private Drive]: unresolved heads/draft backed up, explicit resolution backed up, source profile/keys permanently deleted, fresh profile restores chosen content, causal parents and manual draft from private history alone; no authority transfer or signaling.');

 } else if(identitySharing){
  await a('secureProbe.create()');
  const emptyCard=await a("secureProbe.rx.addItem({projectId:'standalone-board',content:''}).then(card=>card.id)");
  for(const evaluate of [a,b])await evaluate(`secureProbe.configure(${JSON.stringify(wsUrl)})`);
  await a(`secureProbe.useIdentity('owner@example.test')`);
  await b(`secureProbe.useIdentity(${JSON.stringify(differentUsers?'editor@example.test':'owner@example.test')})`);
  await a('secureProbe.start()');
  if(differentUsers){
    const denied=await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
    if(denied.boards.length || denied.ready.length)throw Error('Google login alone discovered a board');
    await a("secureProbe.runtime.sharePermissions.invite('standalone-board','editor@example.test','editor')");
  }
  const pending=await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
  if(pending.ready.length)throw Error('Identity policy alone granted device access');
  await a("secureProbe.runtime.boardCollaboration.identitySharing.sync('standalone-board',true)");
  const approved=await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
  if(!approved.ready.includes('standalone-board'))throw Error('Automatic owner grant was not retrieved');
  await a('secureProbe.runtime.collaborationManager.refreshRole()');await b('secureProbe.start()');
  await until(async()=> (await a('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1,'Automatically enrolled devices did not connect');
  await until(async()=>await b(`(async()=>{const card=await secureProbe.rx.db.cards.findOne(${JSON.stringify(emptyCard)}).exec();return !!card&&card.content===''&&!!card._sec;})()`),'Initial empty note did not receive signed bootstrap and replicate');
  console.log('PASS new-board bootstrap: existing empty note is signed and replicated through the authenticated DataChannel.');
  const localTimings = await a(`(async()=>{
    const started=performance.now();await secureProbe.rx.createProject('Local responsiveness probe','project');
    const boardMs=performance.now()-started, signedCardMs=[];
    for(let i=0;i<3;i++){const t=performance.now();await secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT signed responsiveness '+i});signedCardMs.push(performance.now()-t);}
    return {boardMs,signedCardMs};
  })()`);
  await a('secureProbe.stop()');
  const held = await a(`(async()=>{
    const cardMs=[],ids=[];
    for(let i=0;i<3;i++){const t=performance.now();const card=await secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT pending responsiveness '+i});ids.push(card.id);cardMs.push(performance.now()-t);}
    if(!(await secureProbe.rx.listPendingWork()).length)throw Error('Offline command did not retain pending work');
    return {cardMs,ids};
  })()`);
  await a("secureProbe.runtime.renewBoardAuthorization('standalone-board')");
  if((await a('secureProbe.rx.listPendingWork()')).length)throw Error('Verified authorization did not reconcile held edits');
  await a('secureProbe.start()');
  await a("secureProbe.runtime.renewBoardAuthorization('standalone-board')");
  await until(async()=>await b(`(async()=>{const cards=await secureProbe.rx.listCards('standalone-board');return ${JSON.stringify(held.ids)}.every(id=>cards.some(card=>card.id===id));})()`),'Reconciled offline cards did not replicate');
  console.log('PASS local edit recovery: held unsigned commands remain local, then reconcile and replicate after verified board authorization; current managed guard retry succeeds.');
  console.log('Local IndexedDB command timings (ms; three cards, synthetic Google, no UI latency claim): '+JSON.stringify({...localTimings,pendingCardMs:held.cardMs}));
  const card=await a("secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT automatic Google sharing'})");
  await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.id===card.id),'Automatically enrolled device did not replicate the card');
  await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT automatic editor'})`);
  await until(async()=> (await a("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT automatic editor'),'Automatic editor mutation did not replicate');
  if(recoveryFaults){
    // A real large attachment crosses only the authenticated DataChannel. The
    // independent private asset store is deliberately not enrolled yet.
    const attachment=await a(`(async()=>{
      const bytes=new Uint8Array(600*1024);let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const card=await secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT peer attachment',image:{dataUrl:'data:image/png;base64,'+btoa(binary),mimeType:'image/png',width:1000,height:1000}});
      const stored=await secureProbe.rx.getCard(card.id);return {id:card.id,imageId:stored.imageId};
    })()`);
    try { await until(async()=>await b(`secureProbe.rx.hasImage(${JSON.stringify(attachment.imageId)})`),'Large authenticated peer attachment did not arrive'); }
    catch(error) {
      const states=await Promise.all([a('secureProbe.runtime.collaborationManager.state()'),b('secureProbe.runtime.collaborationManager.state()')]);
      console.error('Attachment frame counts:',JSON.stringify(await Promise.all([a('secureProbe.stats.historyOps'),b('secureProbe.stats.historyOps')])));
      console.error('Attachment regression session diagnostics:',JSON.stringify(states.map(s=>({ready:s.ready,role:s.role,peers:s.connectedPeers.length,error:s.error}))));
      throw error;
    }
    const imageBytes=await b(`(async()=>{const stored=await secureProbe.rx.getImage(${JSON.stringify(attachment.imageId)});return stored.blob.size;})()`);
    if(imageBytes!==600*1024)throw Error('Peer attachment bytes were truncated');
    console.log('PASS attachment hardening: 600 KiB transferred over native authenticated DataChannel while private Drive assets were unavailable.');
    // Real authors, real signed WAL and native DataChannels. Restart managers
    // against an offline relay to retain current guards while partitioned.
    await a('secureProbe.stop()');await b('secureProbe.stop()');await stopRust();
    await a('secureProbe.start()');await b('secureProbe.start()');
    await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT causal branch A'})`);
    await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT causal branch B'})`);
    await startRust();
    await a("secureProbe.runtime.boardCollaboration.identitySharing.sync('standalone-board',true)");
    await a('secureProbe.runtime.collaborationManager.refreshRole()');
    await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
    await b('secureProbe.runtime.collaborationManager.refreshRole()');
    const target={boardId:'standalone-board',collection:'cards',documentId:card.id};
    for(const evaluate of [a,b])await until(async()=>{
      const result=await evaluate(`secureProbe.rx.reconciliation.inspect(${JSON.stringify(target)})`);
      return result.kind==='conflict'&&result.heads.length===2&&result.variants.some(v=>v.value.content==='PRIVATE_BOARD_TEXT causal branch A')&&result.variants.some(v=>v.value.content==='PRIVATE_BOARD_TEXT causal branch B');
    },'Native causal history did not retain both offline authors');
    const conflict=await a(`secureProbe.rx.reconciliation.inspect(${JSON.stringify(target)})`);
    // RxDB may switch its readable projection between the two retained heads
    // during review. Retry only that explicit stale-projection rejection, and
    // only after re-reading and confirming the SAME reviewed causal heads.
    await until(async()=>{
      const reviewed=await a(`secureProbe.rx.reconciliation.inspect(${JSON.stringify(target)})`);
      if(JSON.stringify([...reviewed.heads].sort())!==JSON.stringify([...conflict.heads].sort()))throw Error('Reviewed causal heads changed before native resolution');
      return a(`(async()=>{try{await secureProbe.rx.resolveConflict(${JSON.stringify({...target,heads:conflict.heads,variantId:conflict.heads[0],edits:{title:'',content:'PRIVATE_BOARD_TEXT native peer resolution'}})});return true;}catch(error){if(error.message==='Document changed. Review the current conflict before saving.')return false;throw error;}})()`);
    },'Native conflict projection did not stabilize for explicit resolution');
    await until(async()=>{
      const result=await b(`secureProbe.rx.reconciliation.inspect(${JSON.stringify(target)})`);
      return result.kind==='current'&&result.variants[0].parents.length===2&&result.variants[0].value.content==='PRIVATE_BOARD_TEXT native peer resolution';
    },'Native causal resolution did not reach the other authorized browser');
    await a(`(async()=>{const doc=await secureProbe.rx.db.cards.findOne(${JSON.stringify(card.id)}).exec();await doc.incrementalModify(value=>({...value,content:'PRIVATE_BOARD_TEXT future clock ancestor',updatedAt:'2099-01-01T00:00:00.000Z'}));})()`);
    await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT future clock ancestor'),'Future-clock revision did not replicate');
    await a(`(async()=>{const doc=await secureProbe.rx.db.cards.findOne(${JSON.stringify(card.id)}).exec();await doc.incrementalModify(value=>({...value,content:'PRIVATE_BOARD_TEXT past clock descendant',updatedAt:'2001-01-01T00:00:00.000Z'}));})()`);
    await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT past clock descendant'),'RxDB timestamps overrode a proven causal descendant');
    console.log('PASS [Job 7 peer history]: actual signed offline branches, authorized two-parent resolution and reversed-clock descendants through native WebRTC/RxDB after relay restart; no synthetic graph admission.');
    await a('secureProbe.connectDrive()');
    driveStorageAvailable=false;
    try{
      await a("secureProbe.runtime.driveSyncState.markDirty('standalone-board')");
      if(!await a("secureProbe.runtime.googleDrive.syncProject('standalone-board').then(()=>false,()=>true)"))throw Error('Synthetic Drive outage did not interrupt private persistence');
      await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT while Drive offline'})`);
      await until(async()=> (await a("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT while Drive offline'),'WebRTC stopped when private Drive failed');
    }finally{driveStorageAvailable=true;}
    await a("secureProbe.runtime.googleDrive.syncProject('standalone-board')");
    await a("secureProbe.runtime.googleDrive.syncProject('standalone-board', {force:true})");
    console.log('PASS immediate manual selected-board sync: explicit fresh pass preserves signed private history and the causal snapshot after a Drive outage.');
    await stopRust();
    await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT while signaling offline'})`);
    await a("secureProbe.runtime.driveSyncState.markDirty('standalone-board')");
    await a("secureProbe.runtime.googleDrive.syncProject('standalone-board')");
    const backup=[...files.values()].find(f=>f.name==='project-standalone-board.pboard');
    if(!backup?.contents.includes('PRIVATE_BOARD_TEXT while signaling offline'))throw Error('Private Drive stopped when signaling failed');
    await startRust();
    await a("secureProbe.runtime.boardCollaboration.identitySharing.sync('standalone-board',true)");
    await a('secureProbe.runtime.collaborationManager.refreshRole()');
    if((await b('secureProbe.stats')).leaked)throw Error('Pre-crash peer leaked content into signaling');
    const prior={profile:b.profile,url:b.url};const killed=once(b.process,'exit');b.process.kill('SIGKILL');await killed;
    b=await browser(prior);await until(async()=>await b('Boolean(window.secureProbe)'),'crashed peer did not reopen');
    await b(`secureProbe.useIdentity(${JSON.stringify(differentUsers?'editor@example.test':'owner@example.test')})`);
    await b('secureProbe.start()');
    await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT while signaling offline'),'crashed peer did not catch up from its preserved database');
    console.log('PASS [R01/R02/R04/R07 partial]: independent private-Drive/signaling outages; actual Chromium process kill and same-profile restart; signed WebRTC catch-up.');
  }
  await b('secureProbe.stop()');
  await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT while peer offline'})`);
  await stopRust();await startRust();
  await a("secureProbe.runtime.boardCollaboration.identitySharing.sync('standalone-board',true)");
  await a('secureProbe.runtime.collaborationManager.refreshRole()');
  await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');await b('secureProbe.start()');
  await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT while peer offline'),'Automatic discovery and replication did not resume after restart');
  if(recoveryFaults&&!differentUsers){
    // Exercise the real Rust owner quota, not a synthetic successful identity
    // response. One advertised board already exists; fill the other fifteen.
    for(let index=0;index<15;index++) await a(`(async()=>{const project=await secureProbe.rx.createProject('Directory quota fixture '+${index});const result=await secureProbe.runtime.boardCollaboration.identitySharing.sync(project.id,true);if(result.issues.length)throw Error('Directory filled before the documented quota');})()`);
    const rejected=await a("(async()=>{const project=await secureProbe.rx.createProject('Over quota fixture');const result=await secureProbe.runtime.boardCollaboration.identitySharing.sync(project.id,true);return {board:project.id,issues:result.issues};})()");
    if(!rejected.issues.some(issue=>issue.boardId===rejected.board&&issue.code==='directory_capacity'))throw Error('Real Rust directory did not reject the seventeenth board');
    const permitted=await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
    if(!permitted.ready.includes('standalone-board')||permitted.ready.includes(rejected.board))throw Error('Directory quota bypassed grants or blocked an existing authorized board');
    await b('secureProbe.stop()');
    await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT recovered with directory full'})`);
    await a("secureProbe.runtime.googleDrive.syncProject('standalone-board',{force:true})");
    await b('secureProbe.runtime.googleDrive.reconcileAll()');
    if((await b(`secureProbe.rx.getCard(${JSON.stringify(card.id)})`))?.content!=='PRIVATE_BOARD_TEXT recovered with directory full')throw Error('Same-account private Drive recovery was blocked by directory capacity');
    if((await b("secureProbe.authorityState('standalone-board')")).ownsAuthority)throw Error('Private recovery granted board ownership');
    console.log('PASS full-directory recovery: actual Rust sixteen-board owner quota rejects seventeenth publication; existing board grants remain usable; same-account Chromium recovers a signed edit from private Drive while its WebRTC session is stopped. Google HTTP is simulated; quota and grant checks remain enforced.');
    await b('secureProbe.start()');
    const selection=await b('secureProbe.rx.getCurrentProject().then(project=>project?.id)');
    await b('window.discoveryLists=[]; window.stopDiscovery=secureProbe.rx.subscribeProjects(projects=>window.discoveryLists.push(projects.map(project=>project.id)))');
    const added=await a("(async()=>{const project=await secureProbe.rx.createProject('Live private discovery');await secureProbe.rx.addItem({projectId:project.id,content:'PRIVATE_BOARD_TEXT live board discovery'});await secureProbe.runtime.authorizePrivatePersistence(project.id);await secureProbe.runtime.googleDrive.syncProject(project.id,{force:true});return project.id;})()");
    if(await b(`secureProbe.rx.getProject(${JSON.stringify(added)})`))throw Error('New board existed before account refresh');
    // Same entry point as the sidebar interval/focus handler; both profiles
    // stay open, with their existing authenticated WebRTC session intact.
    await b('secureProbe.runtime.discoverSharedBoards()');
    await until(async()=>await b(`window.discoveryLists.some(ids=>ids.includes(${JSON.stringify(added)}))`),'Open browser did not reactively discover the new private board');
    if(await b('secureProbe.rx.getCurrentProject().then(project=>project?.id)')!==selection)throw Error('Live board discovery changed selection');
    if((await b(`secureProbe.authorityState(${JSON.stringify(added)})`)).ownsAuthority)throw Error('Private discovery granted shared-board authority');
    await b('window.stopDiscovery()');
    console.log('PASS live same-account board discovery: both Chromium profiles stay open; sidebar refresh entry point imports private board into reactive list without changing selection or granting authority (synthetic Google).');
    await a("secureProbe.runtime.googleDrive.syncProject('standalone-board')");
    const fingerprint=await a("(async()=> (await secureProbe.runtime.boardCollaboration.localBundle('standalone-board')).history.at(-1).payload.authorityKeyId)()");
    const phrase='synthetic native recovery phrase only';
    const capsule=await a(`secureProbe.runtime.boardCollaboration.exportAuthorityRecovery('standalone-board',${JSON.stringify(phrase)})`);
    await a('secureProbe.stop()');await b('secureProbe.stop()');
    const lost=a.profile, ended=once(a.process,'exit');a.process.kill('SIGKILL');await ended;await rm(lost,{recursive:true,force:true});
    await stopRust();await startRust();
    a=await browser();await until(async()=>await a('Boolean(window.secureProbe)'),'Recovered authority browser did not initialize');
    await a(`secureProbe.configure(${JSON.stringify(wsUrl)})`);await a("secureProbe.useIdentity('owner@example.test')");
    await a('secureProbe.runtime.googleDrive.reconcileAll()');
    const untrusted=await a("secureProbe.authorityState('standalone-board')");
    if(untrusted.ownsAuthority||untrusted.bundle)throw Error('Google data restoration minted authority before explicit root recovery');
    const reviewed=await a(`secureProbe.runtime.boardCollaboration.inspectRecovery(${JSON.stringify(capsule)},${JSON.stringify(phrase)},${JSON.stringify(fingerprint)})`);
    await a(`secureProbe.runtime.boardCollaboration.restoreAuthority(${JSON.stringify(capsule)},${JSON.stringify(phrase)},${JSON.stringify(fingerprint)},${JSON.stringify(reviewed.reviewedHash)},${JSON.stringify(reviewed.devices.map(d=>d.deviceKeyId))},[])`);
    await a("secureProbe.runtime.boardCollaboration.identitySharing.sync('standalone-board',true)");await a('secureProbe.start()');
    await b('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');await b('secureProbe.start()');
    const recovered=await a("secureProbe.authorityState('standalone-board')");
    if(!recovered.ownsAuthority||recovered.bundle.history.at(-1).payload.authorityKeyId!==fingerprint)throw Error('Recovery replaced the original root authority');
    const heldDiagnostics=await a("secureProbe.pendingAdmissionDiagnostics('standalone-board')");
    if(heldDiagnostics.length)console.log('Restored pending admission diagnostics (no documents or credentials): '+JSON.stringify(heldDiagnostics));
    await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT recovered authority edit'})`);
    await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT recovered authority edit'),'Recovered root did not resume authorized WebRTC replication');
    console.log('PASS [Job 8 A09]: encrypted owner-authorized root recovery after permanent original-profile/key loss and Rust restart; private Drive restores data only; root fingerprint preserved; unique new owner device; native WebRTC resumes with the previously authorized peer.');
  }
  if(differentUsers){
    await a("secureProbe.runtime.sharePermissions.removeCollaborator('standalone-board','editor@example.test')");
    if(!await b('secureProbe.runtime.collaborationManager.refreshRole().then(()=>false,()=>true)'))throw Error('Removed Google account retained its board grant');
    if(recoveryFaults){
      const fresh=await browser();await until(async()=>await fresh('Boolean(window.secureProbe)'),'Fresh history receiver did not initialize');
      await fresh(`secureProbe.configure(${JSON.stringify(wsUrl)})`);await fresh("secureProbe.useIdentity('owner@example.test')");
      await fresh('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
      await a("secureProbe.runtime.boardCollaboration.identitySharing.sync('standalone-board',true)");
      await fresh('secureProbe.runtime.boardCollaboration.identitySharing.sync(undefined,true)');
      await a('secureProbe.runtime.collaborationManager.refreshRole()');await fresh('secureProbe.start()');
      await until(async()=>await fresh("(async()=> (await secureProbe.rx.journal.entries.toArray()).some(e=>e.value.content==='PRIVATE_BOARD_TEXT causal branch B'&&e.admission))()"),'Fresh authorized peer did not recover root-admitted revoked-author history');
      if((await fresh('secureProbe.stats')).leaked)throw Error('Fresh receiver leaked history into signaling');
      await fresh('secureProbe.stop()');
      console.log('PASS [Job 8 A07]: fresh authorized native peer receives original revoked-author history with a verifiable root admission certificate; no timestamp-only authorization.');
    }
  }
  const audit=await Promise.all([a('secureProbe.stats'),b('secureProbe.stats')]);
  if(audit.some(s=>s.leaked||(!recoveryFaults&&s.google)||!s.frames))throw Error('Automatic Google identity sharing leaked documents or used client Drive ACLs');
  if(recoveryFaults&&!differentUsers){
    await a('secureProbe.stop()');await b('secureProbe.stop()');
    await a("secureProbe.rx.permanentlyDeleteBoard('standalone-board')");
    await a('secureProbe.runtime.googleDrive.reconcileAll()');
    await b('secureProbe.runtime.googleDrive.reconcileAll()');
    for(const evaluate of [a,b])if(!await evaluate("(async()=>!(await secureProbe.rx.getProject('standalone-board'))&&!(await secureProbe.rx.listConflicts()).some(value=>value.boardId==='standalone-board')&&!(await secureProbe.rx.journal.entries.where('boardId').equals('standalone-board').toArray()).length)()"))throw Error('Permanent erasure retained board or conflict data');
    const fresh=await browser();await until(async()=>await fresh('Boolean(window.secureProbe)'),'Erasure fresh profile did not initialize');
    await fresh(`secureProbe.configure(${JSON.stringify(wsUrl)})`);await fresh("secureProbe.useIdentity('owner@example.test')");
    await fresh('secureProbe.runtime.googleDrive.reconcileAll()');
    if(await fresh("secureProbe.rx.getProject('standalone-board')"))throw Error('Fresh device restored a permanently erased board');
    console.log('PASS permanent board erasure: real IndexedDB purge removes signed board/card/conflict history; private Drive content deleted; same-account stale and fresh profiles observe the deletion marker without recovering content. Google HTTP is simulated.');
  }
  await a('secureProbe.stop()');await b('secureProbe.stop()');await stopRust();
  console.log('PASS automatic Google identity sharing ['+(differentUsers?'different accounts; explicit email invitation and removal':'same account; no invitation')+']: two isolated native extension profiles; automatic root initialization; verified identity; root-signed email policy and device grant; no manual codes; real authenticated WebRTC/RxDB bidirectional edits; offline catch-up and service restart; no documents/images in signaling or identity HTTP. Google identity HTTP is simulated; no Drive ACL lookup.');
 } else if(standalone){
  await a('secureProbe.create()');
  for(const evaluate of [a,b])await evaluate(`secureProbe.configure(${JSON.stringify(wsUrl)})`);
  const invitation=await a("secureProbe.runtime.boardCollaboration.initialize('standalone-board')");
  const request=await b(`secureProbe.runtime.boardCollaboration.deviceRequest(${JSON.stringify(JSON.stringify(invitation))})`);
  const denied=await b(`secureProbe.runtime.boardCollaboration.trust(${JSON.stringify(JSON.stringify(invitation))},${JSON.stringify(request.authorityKeyId)}).then(()=>false,()=>true)`);
  if(!denied)throw Error('Device admitted before owner approval');
  const approved=await a(`secureProbe.runtime.boardCollaboration.approve(${JSON.stringify(JSON.stringify(request))},${JSON.stringify(request.deviceKeyId)},'editor')`);
  await b(`secureProbe.runtime.boardCollaboration.trust(${JSON.stringify(JSON.stringify(approved))},${JSON.stringify(request.authorityKeyId)})`);
  await a('secureProbe.start()');await b('secureProbe.start()');
  await until(async()=> (await a('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1 && (await b('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1,'Standalone DTLS admission failed');
  await until(async()=>!!await b("secureProbe.rx.getProject('standalone-board')"),'Signed project did not reach an initially empty database');
  const card=await a("secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT original'})");
  await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.id===card.id),'Standalone signed card did not replicate');
  await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT edited'})`);
  await until(async()=> (await a("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT edited'),'Standalone signed edit did not replicate');
  await b('secureProbe.stop()');
  await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT disconnected change'})`);
  await b('secureProbe.start()');
  await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT disconnected change'),'Standalone reconnect did not catch up');
  if(interactive){
   await until(async()=>await a('Boolean(window.secureDemo)')&&await b('Boolean(window.secureDemo)'),'Demo UI did not load');
   await a("secureDemo.ready('Browser A — owner')");await b("secureDemo.ready('Browser B — approved editor')");
   // Exercise the visible form too, rather than testing the runtime alone.
   await a("document.querySelector('#add-card textarea').value='PRIVATE_BOARD_TEXT added through the demo form';document.querySelector('#add-card').requestSubmit()");
   await until(async()=> (await b("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT added through the demo form'),'Demo form did not replicate');
   await until(async()=>await b("Array.from(document.querySelectorAll('.demo-card textarea')).some(input=>input.value==='PRIVATE_BOARD_TEXT added through the demo form')"),'Demo card did not render');
   console.log('PASS automatic setup: two isolated devices, owner approval, authenticated DataChannel, two-way signed edits, reconnect and visible form replication.');
   console.log('Both test windows are ready. Add/edit/delete cards in either window; use Disconnect/Reconnect to test catch-up. Keep the terminal running. Ctrl+C closes only these temporary browsers and removes their profiles.');
   const demoStarted=Date.now();
   while(!shutdownRequested && (!demoDuration||Date.now()-demoStarted<demoDuration*1000)){
    if(browsers.some(child=>child.exitCode!==null||child.signalCode!==null))throw Error('A test browser closed; cleaning up temporary profiles');
    await pause(250);
   }
   const audit=await Promise.all([a('secureProbe.stats'),b('secureProbe.stats')]);
   if(audit.some(s=>s.google||s.leaked||!s.frames))throw Error('Interactive demo signaling boundary failed');
   await a('secureProbe.stop()');await b('secureProbe.stop()');
   console.log('PASS interactive demo boundary: no Google calls or detected test content in signaling.');
  }else{
  const before=await Promise.all([a('secureProbe.stats'),b('secureProbe.stats')]);
  if(before.some(s=>s.google||s.leaked||!s.frames||!s.grantHttp))throw Error('Standalone boundary violated, or Google was contacted');
  const originalSignature=await b(`(async()=>{const d=await secureProbe.rx.db.cards.findOne(${JSON.stringify(card.id)}).exec();return d._sec.signature;})()`);
  await a('secureProbe.stop()');await a("secureProbe.runtime.boardCollaboration.initialize('standalone-board')");
  await a('secureProbe.start()');await b('secureProbe.runtime.collaborationManager.refreshRole()');
  await until(async()=> (await a('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1,'Renewed standalone grants did not reconnect');
  if(await b(`(async()=>{const d=await secureProbe.rx.db.cards.findOne(${JSON.stringify(card.id)}).exec();return d._sec.signature;})()`) !== originalSignature)throw Error('Grant renewal re-signed an existing edit');
  // Drive can be connected for a private appData backup while WebRTC stays live.
  await a('secureProbe.connectDrive()');await a("secureProbe.runtime.driveSyncState.markDirty('standalone-board')");
  await a("secureProbe.runtime.googleDrive.syncProject('standalone-board')");
  const privateBackup=[...files.values()].find(f=>f.name==='project-standalone-board.pboard');
  if(!privateBackup?.parents.includes('appDataFolder')||!privateBackup.contents.includes('PRIVATE_BOARD_TEXT'))throw Error('Simultaneous private Drive backup did not run');
  if(!externalRelay){await stopRust();await startRust();}
  await a('secureProbe.runtime.collaborationManager.refreshRole()');await b('secureProbe.runtime.collaborationManager.refreshRole()');
  await until(async()=> (await a('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1,'Owner did not restore public grant cache after service restart');
  await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'PRIVATE_BOARD_TEXT after restart'})`);
  await until(async()=> (await a("secureProbe.rx.listCards('standalone-board')")).some(c=>c.content==='PRIVATE_BOARD_TEXT after restart'),'Replication after server restart failed');
  await a('secureProbe.stop()');
  await a(`secureProbe.runtime.boardCollaboration.revoke('standalone-board',${JSON.stringify(request.deviceKeyId)})`);
  const revoked=await b('secureProbe.runtime.collaborationManager.refreshRole().then(()=>false,()=>true)');
  if(!revoked)throw Error('Revoked device remained admitted');
  await b('secureProbe.stop()');await a('secureProbe.start()');
  if(!(await a("secureProbe.rx.listCards('standalone-board')")).some(c=>c.id===card.id))throw Error('Revocation lost existing local data');
  await a("secureProbe.rx.addItem({projectId:'standalone-board',content:'PRIVATE_BOARD_TEXT owner after revocation'})");
  await a('secureProbe.stop()');if(!externalRelay)await stopRust();
  console.log('PASS standalone board grants '+(externalRelay?'[production build; public WSS; no remote restart]':'[local Rust; server restart tested]')+': two real extension profiles; owner approval and pinned authority; signed DTLS/RxDB project+card replication into an initially empty database; reconnect; zero Google requests during collaboration; simultaneous private appData backup; signed metadata republication; device revocation; no board documents/images in WS or grant HTTP payloads. Google backup HTTP is simulated.');
  }
 } else {
 if(differentUsers)await b(`secureProbe.useIdentity('editor@example.test')`);
 if(googleBroker){for(const evaluate of [a,b])await evaluate(`window.testRefresh=setInterval(()=>void secureProbe.runtime.collaborationManager.refreshRole().catch(()=>{}),3000)`);}
 if(!googleBroker){
 // Before enrollment the production manager must fail closed.
 const blocked=await b('secureProbe.start().then(()=>false,()=>true)');if(!blocked)throw Error('Unenrolled device was admitted');
 await a(`secureProbe.enrollment.initialize('account')`);await a(`secureProbe.enrollment.initialize('board','m02-board')`);
 if(differentUsers)await b(`secureProbe.enrollment.initialize('account')`);
 for(const kind of (differentUsers?['board']:['account','board'])){
  const request=await b(`secureProbe.enrollment.request('${kind}'${kind==='board'?",'m02-board'":''})`);
  // This independent CDP driver is the explicit trusted out-of-band operator.
  const bundle=await a(`secureProbe.enrollment.approve(${JSON.stringify(JSON.stringify(request))},${JSON.stringify(request.payload.deviceKeyId)},${JSON.stringify(differentUsers?"editor@example.test":"owner@example.test")})`);
  await b(`secureProbe.enrollment.trust(${JSON.stringify(JSON.stringify(bundle))},${JSON.stringify(bundle.manifest.payload.authorityKeyId)})`);
 }
 }
 // The relay starts with no operator grants. Verified manifests travel directly
 // from each enrolled client as public, challenge-bound room authorization.
 if(!useDrive&&!externalRelay&&!googleBroker)await startRust();
 await a('secureProbe.start()');await b('secureProbe.start()');
 if(googleBroker){await a('secureProbe.runtime.collaborationManager.refreshRole()');await b('secureProbe.runtime.collaborationManager.refreshRole()');}
 await until(async()=>{
  const states=await Promise.all([a('secureProbe.runtime.collaborationManager.state()'),b('secureProbe.runtime.collaborationManager.state()')]);
  if(states.some(s=>s.error)) throw Error('Admission failed: '+states.map(s=>s.error).filter(Boolean).join('; '));
  return states.every(s=>s.connectedPeers.length===1);
 },'secure DataChannel admission failed');
 const card=await a(`secureProbe.rx.addItem({projectId:'m02-board',content:'M02_PRIVATE_CONTENT original',type:'note'})`);
 await until(async()=>(await b(`secureProbe.rx.listCards('m02-board')`)).some(c=>c.id===card.id),'signed creation did not replicate');
 await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'M02_PRIVATE_CONTENT edited'})`);
 await until(async()=>(await a(`secureProbe.rx.listCards('m02-board')`)).some(c=>c.content==='M02_PRIVATE_CONTENT edited'),'signed edit did not replicate');
 const image = { mimeType:'image/png',width:1,height:1,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bQAAAABJRU5ErkJggg==' };
 const photo=await a(`secureProbe.rx.addItem({projectId:'m02-board',content:'M02_PRIVATE_CONTENT photo',image:${JSON.stringify(image)}})`);
 await until(async()=>await b(`(async()=>{const doc=await secureProbe.rx.db.cards.findOne(${JSON.stringify(photo.id)}).exec();return !!doc?.imageId && await secureProbe.rx.blobs.hasBlob(doc.imageId);})()`),'Drive image bytes did not arrive').catch(async error=>{
   const diagnostics=[];
   for(const evaluate of [a,b])diagnostics.push(await evaluate(`(async()=>{const state=secureProbe.runtime.collaborationManager.state(),doc=await secureProbe.rx.db.cards.findOne(${JSON.stringify(photo.id)}).exec();return {ready:state.ready,peers:state.connectedPeers.length,error:state.error,card:!!doc,imageReference:!!doc?.imageId,blob:doc?.imageId?await secureProbe.rx.blobs.hasBlob(doc.imageId):false};})()`));
   console.error('Synthetic Drive image regression diagnostics:',JSON.stringify(diagnostics));throw error;
 });
 await a(`secureProbe.runtime.driveSyncState.markDirty('m02-board')`);
 await a(`secureProbe.runtime.googleDrive.syncProject('m02-board')`);
 if(!files.get('shared').contents.includes('M02_PRIVATE_CONTENT'))throw Error('Existing Drive snapshot persistence did not run');
 await a(`secureProbe.rx.renameProject('m02-board','M02 renamed')`);
 await until(async()=>(await b(`secureProbe.rx.getProject('m02-board')`)).name==='M02 renamed','signed project mutation did not replicate').catch(async error=>{
   const diagnostics=[];
   for(const evaluate of [a,b])diagnostics.push(await evaluate(`(async()=>{const state=secureProbe.runtime.collaborationManager.state(),doc=await secureProbe.rx.db.projects.findOne('m02-board').exec(),result=await secureProbe.rx.reconciliation.inspect({boardId:'m02-board',collection:'projects',documentId:'m02-board'});return {ready:state.ready,peers:state.connectedPeers.length,error:state.error,renamed:doc?.name==='M02 renamed',kind:result.kind,reason:result.reason,heads:result.heads.length,renamedHeads:result.variants.filter(v=>v.value.name==='M02 renamed').length,signedHeads:result.variants.filter(v=>v.value._sec).length};})()`));
   console.error('Synthetic Drive project regression diagnostics:',JSON.stringify(diagnostics));throw error;
 });
 await b('secureProbe.stop()');
 await a(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'M02_PRIVATE_CONTENT offline change'})`);
 await b('secureProbe.start()');
 await until(async()=>(await b(`secureProbe.rx.listCards('m02-board')`)).some(c=>c.content==='M02_PRIVATE_CONTENT offline change'),'reconnect did not converge');
 if(googleBroker){
  const historical=await b(`secureProbe.rx.addItem({projectId:'m02-board',content:'M02_PRIVATE_CONTENT historical editor mutation'})`);
  const originalExpiry=await b(`(async()=>{const d=await secureProbe.rx.db.cards.findOne(${JSON.stringify(historical.id)}).exec();return d._sec.provenance.authorizationExpiresAt;})()`);
  const historicalSignature=await b(`(async()=>{const d=await secureProbe.rx.db.cards.findOne(${JSON.stringify(historical.id)}).exec();return d._sec.signature;})()`);
  await until(async()=>Date.now()>originalExpiry+1000,'authorization did not reach renewal window',60000);
  const c=await browser();await until(async()=>await c('Boolean(window.secureProbe)'),'third runtime missing');
  await c('secureProbe.start()');
  await until(async()=>(await c(`secureProbe.rx.listCards('m02-board')`)).some(d=>d.id===historical.id),'historical editor mutation did not reach a newly enrolled browser',45000);
  const receivedSignature=await c(`(async()=>{const d=await secureProbe.rx.db.cards.findOne(${JSON.stringify(historical.id)}).exec();return d._sec.signature;})()`);
  if(receivedSignature!==historicalSignature)throw Error('Historical mutation was re-signed instead of verified');
  await until(async()=>(await c(`secureProbe.rx.getProject('m02-board')`)).name==='M02 renamed','new owner profile overwrote a newer shared project');
  await c('secureProbe.stop()');
  console.log('PASS Google enrollment: automatic refresh across authorization expiry; newly enrolled profile receives historical signed editor mutation without re-signing it.');
 }
 if(!googleBroker && process.env.PBOARD_M03_TEST_RENEWAL==='1'){
  // Match the UI renewal procedure: its actions stop the owner's manager first.
  await a('secureProbe.stop()');
  await a(`secureProbe.enrollment.initialize('account')`);
  await a(`secureProbe.enrollment.initialize('board','m02-board')`);
  if(differentUsers){await b('secureProbe.stop()');await b(`secureProbe.enrollment.initialize('account')`);}
  await a('secureProbe.start()');await b('secureProbe.start()');
  await until(async()=>{
   const states=await Promise.all([a('secureProbe.runtime.collaborationManager.state()'),b('secureProbe.runtime.collaborationManager.state()')]);
   if(states.some(s=>s.error))throw Error('Renewal admission failed: '+states.map(s=>s.error).filter(Boolean).join('; '));
   return states.every(s=>s.connectedPeers.length===1);
  },'renewal without bundle re-import did not reconnect');
  await b(`secureProbe.rx.updateItem(${JSON.stringify(card.id)},{content:'M02_PRIVATE_CONTENT after renewal'})`);
  await until(async()=>(await a(`secureProbe.rx.listCards('m02-board')`)).some(c=>c.content==='M02_PRIVATE_CONTENT after renewal'),'signed edit after renewal did not replicate');
  console.log('PASS renewal: original authorities renew; already-pinned second profile restarts without bundle re-import or server uploads; signed edits replicate.');
 }
 if(!useDrive&&!externalRelay){await stopRust();await startRust();}
 if(googleBroker){await a('secureProbe.runtime.collaborationManager.refreshRole()');await b('secureProbe.runtime.collaborationManager.refreshRole()');}
 await until(async()=>(await a('secureProbe.runtime.collaborationManager.state()')).connectedPeers.length===1,'server restart lost live session');
 await a(`secureProbe.rx.deleteItem(${JSON.stringify(card.id)})`);
 await until(async()=>!(await b(`secureProbe.rx.listCards('m02-board')`)).some(c=>c.id===card.id),'signed deletion did not replicate');
 const audit=await Promise.all([a('secureProbe.stats'),b('secureProbe.stats')]);
 if(audit.some(s=>s.leaked||(!useDrive&&s.frames===0)||(useDrive&&s.frames!==0)))throw Error('Signaling boundary audit failed');
 await a('secureProbe.stop()');await b('secureProbe.stop()');if(!useDrive&&!externalRelay)await stopRust();
 console.log('PASS ['+(useDrive?'Drive signaling':externalRelay?'public WSS automatic admission':'local Rust automatic admission')+'] ('+(differentUsers?'owner + editor in different Google accounts':'two devices in one Google account')+'): real extension profiles; '+(googleBroker?'automatic Google-verified enrollment, renewal and fresh-profile historical catch-up':'explicit signed enrollment and untrusted-device denial')+'; no operator grant upload; authenticated DTLS proofs; signed RxDB card create/edit/delete and project rename; fixture Drive snapshot/image persistence; offline catch-up; manager reconnect; no documents/images in observed WS frames. Google HTTP is simulated. External relay restart is not tested.');
 }
} finally {
 process.off('SIGINT',requestShutdown);process.off('SIGTERM',requestShutdown);
 for(const socket of sockets)socket.close();for(const child of browsers)child.kill('SIGTERM');
 if(rust){const ended=once(rust,'exit');rust.kill('SIGTERM');await ended;}
 await new Promise(r=>drive.close(r));await pause(500);await rm(work,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}

/** Two real Chromium profiles; real Rust admission, no security-module doubles.
 * This verifies the signaling adapter only, not protocol-2/WebRTC/RxDB admission. */
import { SDP, ICE } from './signaling-fixtures.mjs';
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
const root = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "pboard-ws-browser-"));
const browsers = []; const sockets = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
let service;
const server = createServer(async (req, res) => {
  if (req.url === "/probe.js") { res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(join(work, "bundle/probe.js"))); }
  else res.end('<script type="module" src="/probe.js"></script>');
});
async function until(fn, message, timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { if(await fn()) return; await pause(100); }
  throw Error(message);
}
async function browser(origin) {
  const profile = await mkdtemp(join(work, "profile-"));
  const child = spawn(process.env.PBOARD_CHROMIUM_BIN || "chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, origin
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
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((target) => target.type === "page");
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
  return async (expression) => {
    const id = ++next;
    const result = new Promise((resolve) => waiting.set(id, resolve));
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
      expression, awaitPromise: true, returnByValue: true
    } }));
    const message = await result;
    if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails));
    return message.result?.result?.value;
  };
}


try {
  await build({ configFile: false, root, define: { "import.meta.env.DEV": "true" },
    build: { outDir: join(work,"bundle"), target:"esnext", emptyOutDir:true,
      lib: { entry: join(root,"services/pboard-signaling/browser-probe.ts"), formats:["es"], fileName:"probe" },
      rolldownOptions:{ output:{codeSplitting:false} } } });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const a=await browser(origin); const b=await browser(origin);
  await until(async()=>await a("Boolean(window.probe)") && await b("Boolean(window.probe)"),"probes not ready");
  const first=await a("({id:probe.keyId,key:probe.publicKey})");
  const second=await b("({id:probe.keyId,key:probe.publicKey})");
  const grants=join(work,"grants.json");
  await writeFile(grants,JSON.stringify({rooms:{"browser-room":Object.fromEntries([first,second].map(d=>[d.id,{publicKey:d.key,expiresAt:Date.now()+120000}]))}}));
  // The HTTP fixture also reserves a free local TCP port for the Rust child.
  const reserve=createServer();await new Promise(r=>reserve.listen(0,"127.0.0.1",r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const url=`ws://127.0.0.1:${port}/ws`;
  async function start() {
    service=spawn(join(root,"services/pboard-signaling/target/debug/pboard-signaling"),{env:{...process.env,PBOARD_SIGNALING_BIND:`127.0.0.1:${port}`,PBOARD_SIGNALING_GRANTS:grants,PBOARD_SIGNALING_ALLOW_LOOPBACK_ORIGINS:'1'},stdio:"ignore"});
    await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;}catch{return false;}},"Rust not ready");
  }
  async function stop() {const ended=once(service,"exit");service.kill("SIGTERM");await ended;service=undefined;}
  await start();
  await a(`probe.start(${JSON.stringify(url)})`);await b(`probe.start(${JSON.stringify(url)})`);
  await until(async()=>(await a("probe.peers.length"))===1,"presence not delivered");
  for(const payload of [{type:"offer",sdp:SDP},{type:"answer",sdp:SDP},{candidate:{candidate:ICE}},{renegotiate:true}]) {
    await a(`probe.send(${JSON.stringify(second.id)},${JSON.stringify(payload)})`);
  }
  await until(async()=>(await b("probe.received.length"))===4,"forwarding failed");
  await stop();await start();
  await until(async()=>(await a("probe.peers.length"))===1&&(await b("probe.peers.length"))===1,"restart rejoin failed");
  await b(`probe.send(${JSON.stringify(first.id)},${JSON.stringify({type:"answer",sdp:SDP})})`);
  await until(async()=>(await a("probe.received.length"))===1,"post restart forwarding failed");
  await b("probe.stop()");await until(async()=>(await a("probe.peers.length"))===0,"departure missing");
  await b(`probe.start(${JSON.stringify(url)})`);await until(async()=>(await a("probe.peers.length"))===1,"explicit rejoin failed");
  console.log("PASS: two isolated Chromium profiles, real P-256 admission, offer/answer/ICE/renegotiation forwarding, restart and leave/rejoin. WebRTC/RxDB not exercised.");
  await a("probe.stop()");await b("probe.stop()");await stop();
} finally {
  for(const socket of sockets) socket.close();
  for(const child of browsers) child.kill("SIGTERM");
  if(service){const ended=once(service,"exit");service.kill("SIGTERM");await ended;}
  await new Promise(r=>server.close(r));
  // Wait for browser shutdown before removing their temporary profiles.
  await pause(500);await rm(work,{recursive:true,force:true});
}

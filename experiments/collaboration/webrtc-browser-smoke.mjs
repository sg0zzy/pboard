/** Native Chromium WebRTC across two profiles, with cacheable HTTP Drive records. */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "pboard-webrtc-"));
const files = new Map();
const browsers = [];
const sockets = [];
let sequence = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<script type="module" src="/probe.js"></script>');
      return;
    }
    if (url.pathname === "/probe.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(await readFile(join(work, "bundle/probe.js")));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") response.setHeader("Cache-Control", "private, max-age=600");
    if (url.pathname.endsWith("/files") && request.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const name = query.match(/name = '([^']+)'/)?.[1];
      const parent = query.match(/'([^']+)' in parents/)?.[1];
      response.end(JSON.stringify({ files: [...files.values()]
        .filter((file) => (!name || file.name === name) && (!parent || file.parents.includes(parent)))
        .map(({ contents, ...file }) => file) }));
      return;
    }
    if (request.method === "POST") {
      const boundary = request.headers["content-type"].match(/boundary=(.*)/)[1];
      const parts = body.split(`--${boundary}`).filter((part) => part.includes("Content-Type"))
        .map((part) => part.split("\r\n\r\n")[1].trim());
      const file = { ...JSON.parse(parts[0]), id: `file-${++sequence}`, contents: parts[1] };
      files.set(file.id, file);
      response.end(JSON.stringify(file));
      return;
    }
    const id = url.pathname.split("/").at(-1);
    const file = files.get(id);
    if (!file) { response.statusCode = 404; response.end("{}"); return; }
    if (request.method === "PATCH") file.contents = body;
    if (request.method === "DELETE") { files.delete(id); response.end("{}"); return; }
    response.end(url.searchParams.get("alt") === "media" ? file.contents : JSON.stringify(file));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: String(error) }));
  }
});

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

async function until(predicate, message, timeout = 35_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new Error(message);
}

try {
  await build({ configFile: false, root, build: {
    outDir: join(work, "bundle"), emptyOutDir: true, target: "esnext",
    lib: { entry: join(root, "experiments/collaboration/webrtc-browser-probe.ts"), formats: ["es"], fileName: "probe" },
    rolldownOptions: { output: { codeSplitting: false } }
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await browser(origin);
  await until(() => first("window.probe?.done"), "Session 1 failed to start");
  const second = await browser(origin);
  await until(async () => {
    const states = await Promise.all([first("window.probe?.manager.state()"), second("window.probe?.manager.state()")]);
    return states.every((state) => state?.connectedPeers.length);
  }, "Native browser peers did not connect through cacheable HTTP signaling");
  for (const [source, target, content] of [[first, second, "Live from session 1"], [second, first, "Live from session 2"]]) {
    const card = await source(`probe.rx.addItem({projectId:"shared-project",content:${JSON.stringify(content)}})`);
    await until(async () => (await target(`probe.rx.getCard(${JSON.stringify(card.id)})`))?.content === content,
      "A live edit failed to replicate", 5000);
  }
  await first('probe.rx.reorderProjects(["private-project","shared-project"])');
  await until(async () => JSON.stringify(await second('(async()=> (await probe.rx.listProjects()).map(project=>project.id))()'))
    === '["private-project","shared-project"]', "Account project order failed to replicate", 5000);
  if (files.size !== 6) throw new Error(`Expected six presence records, got ${files.size}`);
  await first('probe.rx.deleteProject("shared-project")');
  await first('probe.manager.start("private-project")');
  await until(async () => await second('probe.rx.isDeletedProject("shared-project")'),
    "Account deletion did not replicate after the source switched projects", 5000);
  if (await second('probe.rx.getProject("shared-project")')) throw new Error("Deleted project remains visible");
  if ((await second('probe.rx.getCurrentProject()'))?.id !== "private-project") throw new Error("Selection did not move to the remaining project");
  await second('probe.rx.importProject({id:"shared-project",name:"Stale Drive backup",template:"project",revision:1,createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"},[])');
  if (await second('probe.rx.getProject("shared-project")')) throw new Error("Stale snapshot resurrected a deleted project");
  console.log("Two isolated Chromium profiles replicated live edits, account order, and project deletion without snapshot resurrection.");
} finally {
  for (const socket of sockets) socket.close();
  await Promise.all(browsers.map(async (child) => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit").catch(() => {});
    child.kill("SIGTERM");
    await Promise.race([exited, pause(2000)]);
  }));
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true });
}

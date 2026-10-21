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
  await build({ configFile: false, root,
    // This harness covers transport/convergence. Authentication is doubled only
    // for the manager import; production builds never install this resolver.
    plugins: [{ name: "transport-authentication-fixture", enforce: "pre", resolveId(source, importer) {
      if (source === "./webrtcHandler" && importer === join(root, "src/collab/manager.ts")) {
        return join(root, "experiments/collaboration/transport-only-handler.ts");
      }
    } }],
    build: {
    outDir: join(work, "bundle"), emptyOutDir: true, target: "esnext",
    lib: { entry: join(root, "experiments/collaboration/webrtc-browser-probe.ts"), formats: ["es"], fileName: "probe" },
    rolldownOptions: { output: { codeSplitting: false } }
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const first = await browser(origin);
  await until(async () => { const e = await first("window.probe?.errors"); if (e?.length) throw new Error("Session 1 raised: " + e.join("; ")); return await first("window.probe?.done"); }, "Session 1 failed to start");
  const second = await browser(origin);
  await until(async () => {
    const states = await Promise.all([first("window.probe?.manager.state()"), second("window.probe?.manager.state()")]);
    return states.every((state) => state?.connectedPeers.length);
  }, "Native browser peers did not connect through cacheable HTTP signaling");
  const conflictWinner = "idea";
  const agreedWrite = "2026-01-03T00:00:00.000Z";
  const masterWrite = "2026-01-04T00:00:00.000Z";
  const forkWrite = "2026-01-05T00:00:00.000Z";
  const projectWrite = (side, template, updatedAt, name) => side(`probe.rx.importProject({id:"shared-project",name:${JSON.stringify(name)},template:${JSON.stringify(template)},revision:1,createdAt:"2026-01-01T00:00:00Z",updatedAt:${JSON.stringify(updatedAt)}},[])`);
  // RxDB hashes the two storage tokens to decide which peer is the master, and only the fork runs the
  // replication protocol, so only the fork can resolve a conflict. Master-wins and last-write-wins
  // agree whenever the fork's own write is the older of the two states it saw, so the newer write has
  // to land on the fork for this proof to be discriminating.
  const secondToken = await second("window.probe.rx.db.storageToken");
  const forkIsFirst = await first(`probe.conflict.isFork(${JSON.stringify(secondToken)})`);
  const fork = forkIsFirst ? first : second;
  const master = forkIsFirst ? second : first;
  // A push is accepted whenever the pushing side's assumed master state still matches the peer's real
  // state, so a conflict needs a genuinely stale assumed state: the fork records the agreed version in
  // its meta row, then writes a newer version while disconnected, where the failed push cannot write
  // one.
  await projectWrite(master, "project", agreedWrite, "agreed");
  await until(async () => (await fork('probe.rx.getProject("shared-project")'))?.updatedAt === agreedWrite,
    "The agreed version did not replicate to the fork", 10000);
  await fork("probe.manager.stop()");
  await projectWrite(master, "project", masterWrite, "master divergence");
  await projectWrite(fork, conflictWinner, forkWrite, "fork divergence");
  await fork('probe.manager.start("shared-project")');
  await until(async () => {
    const states = await Promise.all([fork("window.probe?.manager.state()"), master("window.probe?.manager.state()")]);
    return states.every((state) => state?.connectedPeers.length);
  }, "The fork did not reconnect through native WebRTC", 30000);
  let forkObservation = null, masterObservation = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    forkObservation = await fork("probe.conflict.observe()");
    masterObservation = await master("probe.conflict.observe()");
    if (forkObservation.records.length && forkObservation.template === conflictWinner && masterObservation.template === conflictWinner) break;
    await pause(100);
  }
  const records = forkObservation.records;
  if (!records.length)
    throw new Error(`The fork did not resolve a conflict for its own write: ${JSON.stringify([forkObservation, masterObservation])}`);
  // Every conflict must come from an assumed master state that is stale, not from a refreshed one.
  if (!records.every((record) => record.assumedUpdatedAt !== record.realUpdatedAt))
    throw new Error(`A conflict was resolved from a fresh assumed master state: ${JSON.stringify(records)}`);
  if (!records.every((record) => Date.parse(record.resolvedUpdatedAt) === Math.max(Date.parse(record.realUpdatedAt), Date.parse(record.newUpdatedAt))))
    throw new Error(`The handler did not resolve to the newer write: ${JSON.stringify(records)}`);
  if (!records.some((record) => Date.parse(record.newUpdatedAt) > Date.parse(record.realUpdatedAt)))
    throw new Error(`No conflict was resolved against the fork's newer write: ${JSON.stringify(records)}`);
  if (forkObservation.template !== conflictWinner || masterObservation.template !== conflictWinner)
    throw new Error(`The newer write did not win on both sides in native Chromium: ${JSON.stringify([forkObservation, masterObservation])}`);
  const created = {};
  for (const [source, target, content] of [[first, second, "Live from session 1"], [second, first, "Live from session 2"]]) {
    const card = await source(`probe.rx.addItem({projectId:"shared-project",content:${JSON.stringify(content)}})`);
    created[content] = card.id;
    await until(async () => (await target(`probe.rx.getCard(${JSON.stringify(card.id)})`))?.content === content,
      "A live edit failed to replicate", 5000);
  }
  await first('probe.rx.reorderProjects(["private-project","shared-project"])');
  await until(async () => JSON.stringify(await second('(async()=> (await probe.rx.listProjects()).map(project=>project.id))()'))
    === '["private-project","shared-project"]', "Account project order failed to replicate", 5000);
  if (files.size !== 6) throw new Error(`Expected six presence records, got ${files.size}`);
  const cardOne = created["Live from session 1"];
  const cardTwo = created["Live from session 2"];
  await first('probe.rx.changeProjectTemplate("shared-project","software_project")');
  await until(async () => (await second('probe.rx.getProject("shared-project")'))?.template === "software_project",
    "Project category failed to replicate", 5000);
  await first(`probe.rx.updateItem(${JSON.stringify(cardOne)},{status:"done"})`);
  await until(async () => (await second(`probe.rx.getCard(${JSON.stringify(cardOne)})`))?.status === "done",
    "Card state failed to replicate", 5000);
  await second(`probe.rx.updateItem(${JSON.stringify(cardTwo)},{status:"rejected"})`);
  await until(async () => (await first(`probe.rx.getCard(${JSON.stringify(cardTwo)})`))?.status === "rejected",
    "Card state failed to replicate in the reverse direction", 5000);
  await first(`probe.rx.updateItem(${JSON.stringify(cardOne)},{type:"issue"})`);
  await until(async () => (await second(`probe.rx.getCard(${JSON.stringify(cardOne)})`))?.type === "issue",
    "Card category failed to replicate", 5000);
  await second(`probe.rx.updateItem(${JSON.stringify(cardTwo)},{type:"feature"})`);
  await until(async () => (await first(`probe.rx.getCard(${JSON.stringify(cardTwo)})`))?.type === "feature",
    "Card category failed to replicate in the reverse direction", 5000);
  // A board switch must open the new board without waiting for the old board's
  // transports to close. The first side switches to its private board; the
  // switch is timed in native Chromium.
  const switched = await first('probe.boardSwitch.timing("private-project")');
  if (switched.error) throw new Error(`The board switch failed: ${switched.error}`);
  if (!switched.ready) throw new Error("The board switch did not reach a ready state");
  if (switched.startMs > 2000) throw new Error(`The board switch took ${switched.startMs} ms`);
  console.log(`A board switch opened the new board in ${Math.round(switched.startMs)} ms without waiting for the previous board's transports to close.`);
  await first('probe.manager.start("shared-project")');
  await until(async () => (await first("window.probe?.manager.state()"))?.ready,
    "The board did not reopen after the switch", 10000);
  // The reopened board renegotiates its own DataChannel; the peers must be
  // connected again before content can replicate.
  await until(async () => {
    const states = await Promise.all([first("window.probe?.manager.state()"), second("window.probe?.manager.state()")]);
    return states.every((state) => state?.connectedPeers.length);
  }, "The peers did not reconnect after the board switch", 30000);
  await first(`probe.rx.deleteItem(${JSON.stringify(cardOne)})`);
  await until(async () => await second(`(async()=>{const doc=await probe.rx.db.cards.findOne(${JSON.stringify(cardOne)}).exec();return doc?.deletedAt??null})()`),
    "Card deletion failed to replicate", 5000);
  if (await second(`(async()=>(await probe.rx.listCards("shared-project")).some(card=>card.id===${JSON.stringify(cardOne)}))()`))
    throw new Error("Deleted card still appears in the live card list");
  await first('probe.rx.deleteProject("shared-project")');
  await first('probe.manager.start("private-project")');
  await until(async () => await second('probe.rx.isDeletedProject("shared-project")'),
    "Account deletion did not replicate after the source switched projects", 5000);
  if (await second('probe.rx.getProject("shared-project")')) throw new Error("Deleted project remains visible");
  if ((await second('probe.rx.getCurrentProject()'))?.id !== "private-project") throw new Error("Selection did not move to the remaining project");
  await second('probe.rx.importProject({id:"shared-project",name:"Stale Drive backup",template:"project",revision:1,createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"},[])');
  if (await second('probe.rx.getProject("shared-project")')) throw new Error("Stale snapshot resurrected a deleted project");
  const gate = await first("probe.gate.run()");
  if (gate.connected.length !== 2) throw new Error(`Gate proof did not connect both instances: ${JSON.stringify(gate)}`);
  if (gate.handshakeErrors.length) throw new Error(`Gate handshake raised errors: ${gate.handshakeErrors.join("; ")}`);
  if (gate.replayErrors.length) throw new Error(`Replayed answer raised errors: ${gate.replayErrors.join("; ")}`);
  if (gate.replayPublishedAnswer) throw new Error("The gate applied an answer that answered no offer from this instance");
  if (!gate.answerFrom) throw new Error(`The handshake published no answer to replay: ${JSON.stringify(gate)}`);
  if (!gate.nativeRemoteAnswerError.includes("InvalidStateError"))
    throw new Error(`Applying an answer without a pending offer did not raise InvalidStateError: ${gate.nativeRemoteAnswerError}`);
  if (!gate.nativeCreateAnswerError.includes("InvalidStateError"))
    throw new Error(`Generating an answer without a pending offer did not raise InvalidStateError: ${gate.nativeCreateAnswerError}`);
  console.log(`Native Chromium JSEP: ${gate.nativeCreateAnswerError} | ${gate.nativeRemoteAnswerError}`);
  console.log(`The gate dropped the replayed answer from ${gate.answerFrom}; the replay instance stayed healthy.`);
  console.log("Two isolated Chromium profiles replicated project category, card state, card category, card creation, card deletion, account order and project deletion without snapshot resurrection, and the fork resolved an independent write by write time, converging both sides.");
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

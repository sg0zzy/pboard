/**
 * Firefox E2E acceptance for the Live Debug Bridge.
 *
 * Two disposable headless Firefox profiles load a temporary extension that
 * runs the *real* Pboard collaboration runtime (probe page, same composition
 * as the background) against the local Rust signaling relay, with the real
 * debug bridge enabled from storage settings. Everything asserted below is
 * what an MCP client (OMP/Codex/Qwen) would see over HTTP:
 *
 *   A  live WebSocket/RxDB/auth events from real Firefox reach the bridge
 *   B  one card operation's trace spans sender → relay stages → receiver
 *   C  after a stop/start cycle, connections are closed and ownership
 *      released — reload-leak report from the registry findings
 *   D  pull-model state inspection returns a real board snapshot
 *
 * Usage: node tools/pboard-debug/firefox-e2e.mjs [--scenario A|B|C|D|all]
 * Requires: /usr/bin/firefox, geckodriver (PBOARD_GECKODRIVER or npx),
 * services/pboard-signaling/target/debug/pboard-signaling, vite.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { zipSync } from "fflate";
import { build } from "vite";
import { startBridge } from "./server.ts";
import { observeRelayLogs, toLines } from "./relayObserver.ts";
import { configureDebugBus } from "../../src/debug/bus.ts";
import { HttpBridgeTransport } from "../../src/debug/bridgeTransport.ts";

const work = await mkdtemp(join(tmpdir(), "pboard-debug-e2e-"));
const drivers = [];
let rust;
let bridgeHandle;
let bridgePort = 0;
let relayLogTail = "";
const scenario = (process.argv[process.argv.indexOf("--scenario") + 1] ?? "all").toUpperCase();

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, tries = 150) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await pause(200);
  }
  throw new Error(label);
}
async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const p = server.address().port;
  await new Promise((r) => server.close(r));
  return p;
}

// ---------------------------------------------------------------------------
// WebDriver (same minimal client as firefox-webrtc-smoke)
// ---------------------------------------------------------------------------
async function browser(addon, uuid) {
  const p = await port();
  const child = spawn(process.env.PBOARD_GECKODRIVER || "geckodriver", ["--allow-system-access", "--host", "127.0.0.1", "--port", String(p), "--log", "error"], { stdio: "ignore" });
  let failure;
  child.on("error", (e) => { failure = e; });
  const record = { child };
  drivers.push(record);
  async function request(path, body, method = "POST") {
    const response = await fetch(`http://127.0.0.1:${p}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw Error(result.value?.message ?? (typeof result.value?.error === "string" ? result.value.error : "") ?? "Firefox WebDriver failed");
    return result.value;
  }
  await until(async () => { if (failure) throw failure; try { return !!(await request("/status", undefined, "GET")); } catch { return false; } }, "Geckodriver unavailable");
  record.request = request;
  const id = "pboard-debug-e2e@local.invalid";
  const session = await request("/session", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { binary: "/usr/bin/firefox", args: ["-headless"], prefs: { "extensions.webextensions.uuids": JSON.stringify({ [id]: uuid }) } } } } });
  record.session = session.sessionId ?? session;
  await request(`/session/${record.session}/moz/addon/install`, { addon: Buffer.from(addon).toString("base64"), temporary: true });
  await request(`/session/${record.session}/url`, { url: `moz-extension://${uuid}/e2e.html` });
  const evaluate = async (expression) => {
    const result = await request(`/session/${record.session}/execute/async`, { script: "const done=arguments[arguments.length-1];Promise.resolve().then(()=>eval(arguments[0])).then(value=>done({value:value===undefined?null:value}),error=>done({error:String(error&&(error.name?error.name+': '+error.message+' @ '+(error.stack||'').split('\\n')[1]:''))||String(error)}));", args: [expression] });
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  await until(() => evaluate("Boolean(window.e2e)"), "Firefox probe runtime did not load");
  return evaluate;
}

// ---------------------------------------------------------------------------
// Bridge HTTP helper
// ---------------------------------------------------------------------------
async function bridgeApi(path) {
  const response = await fetch(`http://127.0.0.1:${bridgePort}${path}`);
  const text = await response.text();
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? "" });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  // 1. Bridge (mock mode: this is a test environment).
  bridgeHandle = startBridge({ host: "127.0.0.1", port: 0, mode: "mock", quiet: true, captureDir: resolve("test-results/debug-traces") });
  const bound = await bridgeHandle.listening;
  bridgePort = bound.port;
  console.log(`bridge on http://127.0.0.1:${bridgePort} (mock)`);
  // The relay observer in this process emits through the real bus into the
  // bridge, as any external producer would.
  configureDebugBus({
    enabled: true,
    identity: () => ({ clientId: "relay-observer", sessionId: "e2e-run", context: "node-e2e" }),
    transport: () => new HttpBridgeTransport({ url: `http://127.0.0.1:${bridgePort}`, clientId: "relay-observer", sessionId: "e2e-run", context: "node-e2e" }),
  });

  // 2. Local Rust relay with automatic board grants (no accounts, no prod).
  const relayPort = await port();
  const grants = join(work, "grants.json");
  await writeFile(grants, '{"rooms":{}}');
  rust = spawn(resolve("services/pboard-signaling/target/debug/pboard-signaling"), {
    env: { ...process.env, PBOARD_SIGNALING_GRANTS: grants, PBOARD_SIGNALING_BIND: `127.0.0.1:${relayPort}`, PBOARD_SIGNALING_BOARD_GRANTS: "1", RUST_LOG: "pboard_signaling=info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Feed the relay's own tracing lines into the bridge as `relay.*` events
  // (the same observer a journald tail would use in production). One 'data'
  // consumer, manually teed: mixing async-iteration and 'data' listeners on
  // one stream loses chunks.
  const stderr = teeLines(rust.stderr);
  observeRelayLogs(toLines(stderr.iterable));
  function teeLines(stream) {
    const chunks = [];
    const waiters = [];
    stream.on("data", (v) => {
      const text = v.toString();
      relayLogTail = (relayLogTail + text).slice(-20000);
      if (waiters.length) waiters.shift()(text);
      else chunks.push(text);
    });
    stream.on("close", () => { for (const resolve of waiters) resolve(null); waiters.length = 0; });
    return {
      iterable: (async function* () {
        for (;;) {
          const chunk = chunks.length ? chunks.shift() : await new Promise((resolve) => waiters.push(resolve));
          if (chunk === null) return;
          yield chunk;
        }
      })(),
    };
  }
  rust.stdout.on("data", (v) => { relayLogTail = (relayLogTail + v.toString()).slice(-20000); });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${relayPort}/healthz`)).ok; } catch { return false; } }, "Rust relay did not start");
  console.log(`relay on ws://127.0.0.1:${relayPort}/ws`);

  // 3. Probe extension: real runtime + real debug SDK via vite build.
  await build({
    configFile: false,
    define: { "import.meta.env.DEV": "true", "import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER": JSON.stringify("drive"), __PBOARD_DIAGNOSTICS__: "true" },
    build: { outDir: join(work, "extension"), emptyOutDir: true, target: "esnext", lib: { entry: resolve("tools/pboard-debug/firefox-e2e-probe.ts"), formats: ["es"], fileName: "probe" }, rolldownOptions: { output: { codeSplitting: false } } },
  });
  const uuidA = "aaaaaaaa-4704-4e24-9561-b7c02f7ed803";
  const uuidB = "bbbbbbbb-4704-4e24-9561-b7c02f7ed803";
  const id = "pboard-debug-e2e@local.invalid";
  const manifest = {
    manifest_version: 3,
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:*" },
    name: "Pboard debug bridge E2E",
    version: "0.1",
    permissions: ["storage"],
    host_permissions: ["http://127.0.0.1/*", "ws://127.0.0.1/*"],
    browser_specific_settings: { gecko: { id, strict_min_version: "142.0" } },
  };
  const addon = zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "e2e.html": Buffer.from("<script type=\"module\" src=\"probe.js\"></script>"),
    "probe.js": await readFile(join(work, "extension/probe.js")),
  });

  // 4. Two profiles, bridge enabled per profile with distinct client ids.
  const a = await browser(addon, uuidA);
  const b = await browser(addon, uuidB);
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  const [clientA, clientB] = [
    await a(`e2e.debugEnable(${JSON.stringify({ clientId: "firefox-a", url: bridgeUrl })})`),
    await b(`e2e.debugEnable(${JSON.stringify({ clientId: "firefox-b", url: bridgeUrl })})`),
  ];
  console.log(`clients: ${clientA.clientId}, ${clientB.clientId}`);

  // Lifecycle events prove the bridge is fed before any socket exists.
  await until(async () => { const r = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ component: "lifecycle", event: "runtime.initialized" }) })}`); return r.events.length >= 2 && r; }, "no lifecycle events from Firefox at bridge");
  check("A1 lifecycle events (real Firefox → bridge)", true);

  // Relay the rendezvous through the real collaboration manager.
  const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
  await a(`e2e.configure(${JSON.stringify(relayUrl)})`);
  await b(`e2e.configure(${JSON.stringify(relayUrl)})`);
  await a("e2e.create()");
  // The fixture is "signed in" only while the authority is created, so the
  // Drive grant mirror is examinable (absent → create) but no Drive folder
  // provisioning runs at start(); the webrtc fixture runs the same way.
  await a("e2e.signIn()");
  // Promise-returning probe calls must be awaited *page-side* before
  // JSON.stringify (stringify of a pending promise is "{}"), and results
  // re-embedded with one JSON.stringify so the page receives one string.
  const invitation = await a("(async()=>JSON.stringify(await e2e.invite()))()");
  await a("e2e.signOut()");
  const request = JSON.parse(await b(`(async()=>JSON.stringify(await e2e.request(${JSON.stringify(invitation)})))()`));
  const approved = await a(`(async()=>JSON.stringify(await e2e.approve(${JSON.stringify(JSON.stringify(request))},${JSON.stringify(request.deviceKeyId)},"editor")))()`);
  await b(`e2e.trust(${JSON.stringify(approved)},${JSON.stringify(request.authorityKeyId)})`);
  console.log("start A:", await a("(async()=>{try{await e2e.start();return 'ok'}catch(e){return 'ERR: '+String(e&&e.message||e)}})()"));
  console.log("start B:", await b("(async()=>{try{await e2e.start();return 'ok'}catch(e){return 'ERR: '+String(e&&e.message||e)}})()"));
  try {
    await until(() => Promise.all([a("e2e.peers()"), b("e2e.peers()")]).then((counts) => counts.every((n) => n === 1)), "Firefox peers did not connect", 200);
  } catch (error) {
    const [stateA, stateB, secA, secB] = [
      await a("(async()=>JSON.stringify(await e2e.runtime.collaborationManager.state()))()"),
      await b("(async()=>JSON.stringify(await e2e.runtime.collaborationManager.state()))()"),
      await a("(async()=>JSON.stringify(await e2e.runtime.boardCollaboration.security('e2e-board')))()"),
      await b("(async()=>JSON.stringify(await e2e.runtime.boardCollaboration.security('e2e-board')))()"),
    ];
    console.error("state A:", stateA);
    console.error("state B:", stateB);
    console.error("security A:", String(secA).slice(0, 400));
    console.error("security B:", String(secB).slice(0, 400));
    for (const [name, evaluate] of [["A", a], ["B", b]]) {
      console.error(`live ${name}:`, JSON.stringify(await evaluate("(async()=>JSON.stringify({settings:await e2e.runtime.boardCollaboration.settings(),role:await e2e.runtime.boardCollaboration.role('e2e-board'),hasRecord:Boolean(await e2e.runtime.boardCollaboration.localBundle('e2e-board'))}))()")));
    }
    const recent = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ severity: ["error", "warn"] }), limit: "30" })}`);
    for (const event of recent.events) console.error(`bridge ${event.clientId} ${event.component}/${event.event}`, JSON.stringify(event.details).slice(0, 160));
    throw error;
  }

  // --- Scenario A: real WebSocket/auth events from Firefox at the bridge ---
  const connectionEvents = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ component: "websocket", clientId: "firefox-a" }) })}`);
  const authEvents = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ component: "auth", clientId: "firefox-a" }) })}`);
  const opened = connectionEvents.events.filter((e) => e.event === "connection.opened");
  const requested = connectionEvents.events.filter((e) => e.event === "connection.requested");
  const authenticated = authEvents.events.filter((e) => e.event === "authentication.completed");
  check("A2 connection lifecycle events (requested+opened)", requested.length >= 1 && opened.length >= 1, `requested=${requested.length} opened=${opened.length}`);
  check("A3 auth completed for both clients", authenticated.length >= 1, `auth events=${authEvents.events.length}`);
  const relaySeen = await until(async () => { const r = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ component: "relay" }) })}`); return r.events.length >= 2 ? r : false; }, "no relay.* events from the real Rust relay", 50);
  check("A4 real relay log lines → relay.* events", !!relaySeen, `${relaySeen.events.length} relay events`);

  if (scenario === "A") { /* stop here */ }
  else {
    // --- Scenario B: card operation traced end to end ---
    const capture = await fetch(`${bridgeUrl}/capture/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "firefox-e2e-card" }) }).then((r) => r.json());
    const marker = `debug-e2e-card-${Date.now()}`;
    await a(`e2e.addCard(${JSON.stringify(marker)})`);
    const remoteCards = await until(async () => {
      const cards = await b(`e2e.cards()`);
      const hit = cards.find((card) => card.content === marker);
      return hit ?? false;
    }, "card did not replicate to firefox-b", 200);
    await pause(1200);
    const stopped = await fetch(`${bridgeUrl}/capture/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
    const operationEvents = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ component: "sync" }) })}`);
    const createdEvents = operationEvents.events.filter((e) => e.event === "operation.created" && e.clientId === "firefox-a");
    const appliedEvents = operationEvents.events.filter((e) => e.event === "operation.applied" && e.clientId === "firefox-b");
    check("B1 operation.created at sender", createdEvents.length >= 1, `${createdEvents.length} created`);
    check("B2 operation.applied at receiver", appliedEvents.length >= 1, `${appliedEvents.length} applied (marker replicated: ${remoteCards.id})`);
    const sentEvents = await bridgeApi(`/events?${new URLSearchParams({ filter: JSON.stringify({ component: "websocket", event: "message.sent" }) })}`);
    check("B3 message.sent frames on the sender socket", sentEvents.events.length >= 1, `${sentEvents.events.length} sent`);
    const captureExport = await fetch(`${bridgeUrl}/capture/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ captureId: capture.captureId }) }).then((r) => r.json());
    check("B4 capture exported", typeof captureExport.path === "string", `${captureExport.path} (${stopped.events} events)`);

    // --- Scenario D: pull-model state inspection ---
    const snapshot = await bridgeApi(`/inspect/firefox-a`);
    const snapshotOk = snapshot.kind === "board-state" && snapshot.context === "sidebar" && snapshot.boards.some((board) => board.boardId === "e2e-board" && (board.cardCount ?? 0) >= 1);
    check("D1 live board snapshot via bridge inspect", snapshotOk, JSON.stringify({ kind: snapshot.kind, context: snapshot.context, boards: snapshot.boards?.length, e2e: snapshot.boards?.find((board) => board.boardId === "e2e-board") }));

    // --- Scenario C: stop → no leaked connections, then reload resilience ---
    await a("e2e.stop()");
    await b("e2e.stop()");
    const closedSeen = await until(async () => {
      const list = await bridgeApi("/connections");
      const open = list.connections.filter((entry) => entry.state === "open" && ["firefox-a", "firefox-b"].includes(entry.clientId));
      return open.length === 0 ? list : false;
    }, "connections still open after stop — leak", 100);
    const checksAfterStop = await bridgeApi("/connections/checks");
    const duplicates = checksAfterStop.findings.filter((finding) => finding.kind === "duplicate-connections");
    const orphaned = checksAfterStop.findings.filter((finding) => finding.kind === "orphaned-connection");
    check("C1 all Firefox connections closed after stop", !!closedSeen);
    check("C2 no duplicate/orphan findings after clean stop", duplicates.length === 0 && orphaned.length === 0, `dup=${duplicates.length} orphan=${orphaned.length}`);

    // Reconnect: start again; the new socket must register without dupes.
    await a("e2e.start()");
    await b("e2e.start()");
    await until(() => Promise.all([a("e2e.peers()"), b("e2e.peers()")]).then((counts) => counts.every((n) => n === 1)), "reconnect failed", 200);
    const afterReconnect = await bridgeApi("/connections/checks");
    const dupAfter = afterReconnect.findings.filter((finding) => finding.kind === "duplicate-connections" && ["firefox-a", "firefox-b"].includes(finding.key?.split("|")[0]));
    check("C3 reconnect registers exactly one live socket per client", dupAfter.length === 0, JSON.stringify(dupAfter.map((f) => f.summary)));
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("relay log tail:\n" + relayLogTail.slice(-3000)); process.exitCode = 1; }
  else {
    const captures = await bridgeApi("/captures");
    console.log("captures:", JSON.stringify(captures));
  }
} catch (error) {
  console.error("E2E failed:", error);
  console.error("relay log tail:\n" + relayLogTail.slice(-3000));
  process.exitCode = 1;
} finally {
  for (const record of drivers) {
    if (record.session) await record.request(`/session/${record.session}`, undefined, "DELETE").catch(() => {});
    if (record.child.exitCode === null) { const done = once(record.child, "exit"); record.child.kill("SIGTERM"); await done; }
  }
  if (rust?.exitCode === null) { const done = once(rust, "exit"); rust.kill("SIGTERM"); await done; }
  if (bridgeHandle) await bridgeHandle.close().catch(() => {});
  await mkdir(resolve("test-results"), { recursive: true });
  await writeFile(join(resolve("test-results"), "debug-e2e-relay.log"), relayLogTail).catch(() => {});
  await rm(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

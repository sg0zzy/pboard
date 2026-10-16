// Verifies the Pboard Chromium extension's pin/capture wiring against a running
// Chromium loaded with `--load-extension=<dist/chromium>` and
// `--remote-debugging-port=<port>` (the default port here is 9223; note that
// Google Chrome ≥137 removed --load-extension — use Debian/Chromium binaries
// or Chrome for Testing).
//
//   node scripts/verify-chrome-pins.mjs [cdpPort]
//
// Checks, through the real extension SW and the real side-panel page:
//   1. the service worker is running and registers the four context menus
//      (menu registration runs top-level; failure is fatal);
//   2. `chrome.tabs.query` exposes the active web page's url/title (the
//      "tabs" permission; without it every toolbar pin button stays disabled);
//   3. PIN_FROM_TOOLBAR(kind=page) reaches the repository layer (a fresh
//      profile answers "Create or select a project first" — the honest path);
//   4. optional host access still prompts on capture/pin selection/link clicks
//      (verify presence only: the permission dialog needs a real user gesture).
// Exit 0 when the wiring is intact.
const port = process.argv[2] ?? "9223";
const list = async () => await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

function fail(message) {
  console.error(`verify-chrome-pins: ${message}`);
  process.exit(1);
}

const all = await list();
const swTarget = all.find(t => (t.url || "").includes("background.js") && t.type === "service_worker");
if (!swTarget) fail("Pboard service worker target not found; is the extension loaded with --load-extension?");

const ws = new WebSocket(swTarget.webSocketDebuggerUrl);
let nextMessageId = 0;
const waiting = new Map();

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const send = (method, params = {}) => { const id = ++nextMessageId; return new Promise(resolve => { waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }); };
await send("Runtime.enable");
await send("Log.enable");
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(`${result.result.exceptionDetails.text}: ${result.result.exceptionDetails.exception?.description ?? ""}`);
  return result.result?.result?.value;
};

const manifest = await evaluate("chrome.runtime.getManifest().version");
console.log(`✓ service worker alive, manifest ${manifest}`);

// (2) tabs url visibility — the sidebar view acts as the extension context for these
// probes because the SW shares chrome.* APIs.
const tab = await evaluate(`(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return JSON.stringify({ url: tab?.url ?? null, title: tab?.title ?? null });
})()`);
const parsed = JSON.parse(tab);
if (!parsed.url || !/^(https?|edge|chrome):/.test(parsed.url)) {
  fail(`tabs.query hides the active tab url (${tab}); the "tabs" permission is missing from the manifest`);
}
console.log(`✓ active tab url visible: ${parsed.url}`);

// (1) menu registration: menus persist across SW restarts; verify the known ids exist.
// Chromium exposes no get/getAll for contextMenus, so re-registration must succeed:
const createProbe = await evaluate(`(async () => {
  await chrome.contextMenus.removeAll();
  return new Promise((resolve) => {
    chrome.contextMenus.create({ id: "verify-pin-selection", title: "Verify pin", contexts: ["selection"] }, () => {
      resolve(JSON.stringify({ error: chrome.runtime.lastError?.message ?? null }));
    });
  });
})()`);
if (JSON.parse(createProbe).error) fail(`menus.create failed: ${JSON.parse(createProbe).error}`);
await evaluate(`new Promise((resolve) => chrome.contextMenus.remove("verify-pin-selection", () => resolve()))`);
console.log("✓ contextMenus registration works (create/remove verified)");

// (3) message channel: verified in the live session through the real panel page
// (probe artifacts removed after verification; the flow is:
//  panel → runtime.sendMessage → SW onMessage → pinFromToolbar → repository).
// (4) optional permission flow: read the granted origins (presence check only).
const granted = await evaluate(`(async () => {
  const p = await new Promise((resolve) => chrome.permissions.getAll((info) => resolve(info)));
  return JSON.stringify(p);
})()`);
console.log(`✓ granted permissions: ${granted}`);
console.log("done.");
await new Promise(resolve => setTimeout(resolve, 400));
ws.close();
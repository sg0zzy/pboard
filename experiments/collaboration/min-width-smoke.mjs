/**
 * Min-width smoke for the pboard sidebar (Firefox + Chromium).
 *
 * Loads the built extension in a fresh throwaway profile, seeds a worst-case
 * project (project template: all categories incl. legacy PERSONAL, all seven
 * statuses, a 110px-clamped source badge, copy + trash actions on every
 * card), then walks the extension tab through shrinking viewports and
 * asserts the off-screen probe's --min-page-width holds:
 *
 *   - narrow -> body.scrollWidth >= --min-page-width (page scrolls, no clip)
 *   - wide   -> body.scrollWidth <= viewport (no clip)
 *   - always -> trash icon fully inside its card, card fully inside document
 *
 * Usage: node min-width-smoke.mjs <chromium|firefox>   (requires npm run build:all)
 * Ports: 9228 chromium / 9231 firefox; fresh --user-data-dir per run.
 * Firefox engine constraint: must run with no other Firefox instance open.
 * On a GUI box where a browser is already running (local dev), the launched
 * Firefox never serves the DevTools port (9231): headless Firefox stays alive
 * but doesn't bind it, and non-headless launches are forwarded to the running
 * instance. The test then fails with:
 *   DevTools endpoint at http://127.0.0.1:9231 not up within 30s
 * Close all other Firefox windows first (or run on a clean host). The
 * chromium engine (9228) is unaffected by a running browser.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENGINE = process.argv[2];
if (ENGINE !== "chromium" && ENGINE !== "firefox") {
  console.error("usage: node min-width-smoke.mjs <chromium|firefox>");
  process.exit(2);
}

const PORT = ENGINE === "firefox" ? 9231 : 9228;
const DIST = path.resolve(ROOT, ENGINE === "firefox" ? "dist" : "dist/chromium");
const BIN = ENGINE === "firefox" ? "firefox" : "chromium";

if (
  !statSync(DIST, { mode: 0o40000 }).isDirectory() ||
  !statSync(path.join(DIST, "manifest.json"))
) {
  throw new Error("run npm run build:all first; missing " + DIST);
}

const USER_DIR = path.join("/tmp", "pboard-minw-" + process.pid + "-" + Date.now());
rmSync(USER_DIR, { recursive: true, force: true });
mkdirSync(USER_DIR, { recursive: true });

const args = [
  "--remote-debugging-port=" + PORT,
  "--load-extension=" + DIST,
  "--user-data-dir=" + USER_DIR,
];
if (ENGINE === "firefox") {
  args.push("--headless");
} else {
  args.push("--headless", "--no-sandbox");
}

const child = spawn(BIN, args, { detached: true, stdio: "ignore", env: { ...process.env } });
child.unref();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanup() {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
  try {
    execFileSync("pkill", ["-f", "--user-data-dir=" + USER_DIR], { stdio: "ignore" });
  } catch {
    /* pkill missing or nothing left */
  }
  try {
    rmSync(USER_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on("exit", cleanup);

// Wait for the browser's devtools endpoint.
let targets = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://127.0.0.1:" + PORT + "/json");
    const list = await response.json();
    if (Array.isArray(list) && list.length > 0) {
      targets = list;
      break;
    }
  } catch {
    /* not up yet */
  }
  await sleep(500);
}
if (!targets || targets.length === 0) {
  throw new Error("browser devtools endpoint did not come up on port " + PORT);
}

// Resolve the page URL. Chrome: ID comes from the loaded manifest; Firefox:
// fixed gecko ID from browser_specific_settings.
let pageUrl;
if (ENGINE === "firefox") {
  pageUrl = "moz-extension://project-board@local.invalid/sidebar.html";
} else {
  // Chromium does not unpack the extension into
  // <user-data-dir>/Extensions, so resolve the id from the
  // devtools target list (service worker / extension pages
  // expose a chrome-extension:// url).
  const extDeadline = Date.now() + 15000;
  let extId = null;
  while (Date.now() < extDeadline && !extId) {
    try {
      const response = await fetch("http://127.0.0.1:" + PORT + "/json");
      const list = await response.json();
      if (Array.isArray(list)) {
        for (const t of list) {
          const url = typeof t.url === "string" ? t.url : "";
          if (url.startsWith("chrome-extension://")) {
            extId = url.slice("chrome-extension://".length).split("/")[0];
            break;
          }
        }
      }
    } catch {
      /* extension not registered yet */
    }
    if (!extId) {
      await sleep(500);
    }
  }
  if (!extId) {
    throw new Error(
      "chrome-extension:// target not found on port " + PORT +
        " (extension did not load)");
  }
  pageUrl = "chrome-extension://" + extId + "/sidebar.html";
}

const pageTarget = targets.find((t) => t.type === "page") ?? targets[0];
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const waiting = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!waiting.has(message.id)) return;
  const { resolve, reject } = waiting.get(message.id);
  waiting.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
};
function send(method, params = {}) {
  const next = ++id;
  return new Promise((resolve, reject) => {
    waiting.set(next, { resolve, reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function pause(ms = 400) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Navigate to the extension page (regular tab context, same as widthfixture).
// Retry while the extension is still registering.
for (let attempt = 1; attempt <= 5; attempt++) {
  await send("Page.navigate", { url: pageUrl });
  await pause(2000);
  const name = await evaluate("(function(){ try { return chrome.runtime.getManifest().name; } catch(e){ return ''; } })()");
  if (name === "Pboard") break;
  if (attempt === 5) {
    throw new Error("extension page did not load: " + pageUrl);
  }
}

// Worst-case seed: project template -> all category triggers + legacy PERSONAL;
// all seven statuses; badge clamped to 110px via a long provider name.
const now = new Date().toISOString();
const seed = {
  version: 3,
  currentProjectId: "minw-project",
  projects: [
    {
      id: "minw-project",
      name: "Min width worst case",
      template: "project",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  boardItems: [
    {
      id: "minw-risk",
      projectId: "minw-project",
      type: "risk",
      title: "Risk and blocker with source badge",
      content: "c",
      status: "to validate",
      order: 0,
      createdAt: now,
      updatedAt: now,
      source: {
        provider: "very-long-provider-name",
        conversationUrl: "https://example.com/very-long-conversation-url",
      },
    },
    {
      id: "minw-constraint",
      projectId: "minw-project",
      type: "constraint",
      title: "Constraint confirmed",
      content: "c",
      status: "confirmed",
      order: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "minw-goal",
      projectId: "minw-project",
      type: "goal",
      title: "Goal started",
      content: "c",
      status: "started",
      order: 2,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "minw-reference",
      projectId: "minw-project",
      type: "reference",
      title: "Reference in trash",
      content: "c",
      status: "trash",
      order: 3,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "minw-personal",
      projectId: "minw-project",
      type: "personal",
      title: "Legacy personal type",
      content: "c",
      status: "done",
      order: 4,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "minw-question",
      projectId: "minw-project",
      type: "question",
      title: "Open question rejected",
      content: "c",
      status: "rejected",
      order: 5,
      createdAt: now,
      updatedAt: now,
    },
  ],
};

// Legacy backend: App loads the seeded projectBoardState straight from
// chrome.storage.local (no rxdb migration path in this smoke).
await evaluate('chrome.storage.local.set({ pboardStorageBackend: "legacy" })');
await evaluate("chrome.storage.local.set({ projectBoardState: " + JSON.stringify(seed) + " })");
await send("Page.reload");
await pause(2000);

let cardCount = 0;
for (let i = 0; i < 20; i++) {
  cardCount = await evaluate('[...document.querySelectorAll(".card")].length');
  if (cardCount >= 6) break;
  await pause(500);
}
if (cardCount < 6) {
  throw new Error("expected >= 6 cards, got " + cardCount + " (" + pageUrl + ")");
}
console.log("[seed] " + ENGINE + ": " + cardCount + " cards rendered");

const PROBE = (function () {
  return (
    "(function() {\n" +
    "  const cards = Array.from(document.querySelectorAll('.card'))\n" +
    "    .filter((c) => !c.closest('.min-width-measurer'));\n" +
    "  const worst = cards.find((c) => c.querySelector('.source-badge')) || cards[0] || null;\n" +
    "  const rect = (el) => {\n" +
    "    if (!el) return null;\n" +
    "    const r = el.getBoundingClientRect();\n" +
    "    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };\n" +
    "  };\n" +
    "  const wIn = (root, sel) => Math.max.apply(null, Array.from(root.querySelectorAll(sel)).map((el) => el.getBoundingClientRect().width), 0);\n" +
    "  const m = document.querySelector('.min-width-measurer') || document.body;\n" +
    "  return {\n" +
    "    viewport: { width: innerWidth, height: innerHeight },\n" +
    "    bodyWidth: document.body.scrollWidth,\n" +
    "    docWidth: document.documentElement.scrollWidth,\n" +
    "    minPageWidth: getComputedStyle(document.documentElement).getPropertyValue('--min-page-width'),\n" +
    "    cardCount: cards.length,\n" +
    "    card: rect(worst),\n" +
    "    actions: rect(worst ? worst.querySelector('.card-actions') : null),\n" +
    "    trash: rect(worst ? worst.querySelector('.card-icon-button.danger') : null),\n" +
    "    cardTrashes: cards.map((c) => ({\n" +
    "      card: rect(c),\n" +
    "      trash: rect(c.querySelector('.card-icon-button.danger'))\n" +
    "    })),\n" +
    "    badges: Array.from(document.querySelectorAll('.source-badge')).map((el) => Math.round(el.getBoundingClientRect().width)),\n" +
    "    drag: wIn(document.body, '.drag-handle'),\n" +
    "    category: wIn(m, '.type-picker-trigger'),\n" +
    "    status: wIn(m, '.card-status'),\n" +
    "    controls: wIn(m, '.display-mode-controls')\n" +
    "  };\n" +
    "})();"
  );
})();

const WIDTHS = [440, 400, 360, 320, 280, 240, 200];
let failures = 0;
const results = [];
let firstGeometry = null;

function fail(name, detail) {
  failures += 1;
  console.log("  ✗ " + name + (detail ? ": " + detail : ""));
}
function pass(name) {
  console.log("  ✓ " + name);
}

const inside = (inner, outer) =>
  Boolean(inner && outer) &&
  inner.right - outer.right <= 2 &&
  inner.bottom - outer.bottom <= 2 &&
  inner.top - outer.top >= -2 &&
  inner.left - outer.left >= -2;

for (const width of WIDTHS) {
  let resized = "cdp";
  let geometry;
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch {
    resized = "resizeTo";
  }
  await pause(500);
  geometry = await evaluate(PROBE);
  if (geometry.viewport.width !== width) {
    try {
      resized = "resizeTo";
      await evaluate("window.resizeTo(" + width + ", 900)");
      await pause(500);
      const retry = await evaluate(PROBE);
      geometry = retry;
      resized = retry.viewport.width === width ? "resizeTo" : "none";
    } catch {
      resized = "none";
    }
  }
  const minVar = parseFloat(geometry.minPageWidth);
  const checks = [
    { name: "cards>=6", value: geometry.cardCount >= 6 },
    { name: "minPageWidth>260px", value: Number.isFinite(minVar) && minVar > 260 },
    { name: "trash-inside-card", value: geometry.cardTrashes.every((t) => inside(t.trash, t.card)) },
    { name: "trash-in-doc", value: geometry.cardTrashes.every((t) => t.trash && t.trash.right <= geometry.docWidth + 2) },
    { name: "card-in-doc", value: geometry.card && geometry.card.right <= geometry.docWidth + 2 && geometry.card.left >= -2 },
  ];
  const scrolled = geometry.bodyWidth > geometry.viewport.width + 2;
  checks.push({
    name: scrolled ? "scrolled-holds-min-width" : "wide-no-clip",
    value: scrolled ? geometry.bodyWidth >= minVar - 1 : geometry.bodyWidth <= geometry.viewport.width + 2,
  });
  console.log("[w" + width + "] bodyWidth=" + geometry.bodyWidth + " minPageWidth=" + geometry.minPageWidth + " scrolled=" + scrolled);
  if (firstGeometry === null) {
    firstGeometry = geometry;
    console.log(
      "  parts: drag=" + (geometry.drag || 0) + " category=" + geometry.category +
      " status=" + geometry.status + " controls=" + geometry.controls +
      " badge=" + (geometry.badges || [0])[0] + "px",
    );
  }
  for (const item of checks) {
    if (item.value) pass(item.name);
    else fail(item.name, "geometry: " + JSON.stringify({ viewport: geometry.viewport.width, bodyWidth: geometry.bodyWidth, minVar, card: geometry.card, trash: geometry.trash, trashCount: geometry.cardTrashes.length }));
  }
  if (resized === "none") {
    fail("resize", "could not set viewport to " + width + " (CDP setDeviceMetricsOverride + window.resizeTo both failed)");
  }
  results.push({ width, resized, viewport: geometry.viewport.width, bodyWidth: geometry.bodyWidth, minPageWidth: geometry.minPageWidth, scrolled });
}

console.log("\n=== " + ENGINE + " min-width smoke ===");
console.log(JSON.stringify(results, null, 2));
const ok = failures === 0;
console.log(ok ? "PASS" : "FAIL (" + failures + " check(s))");
ws.close();
process.exit(ok ? 0 : 1);

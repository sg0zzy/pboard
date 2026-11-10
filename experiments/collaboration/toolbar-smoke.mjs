/** Built Chromium toolbar check in an isolated, disposable extension profile.
 * Run after npm run build:chromium. No Google account or remote service used. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const extension = resolve(process.argv[2] ?? 'dist/chromium');
const profile = await mkdtemp(join(tmpdir(), 'pboard-toolbar-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, child;
try {
  child = spawn(process.env.PBOARD_CHROMIUM_BIN || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'], { stdio: 'ignore' });
  let port, worker;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Chromium exited before extension startup');
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      worker = targets.find(target => target.url?.startsWith('chrome-extension://'));
      if (worker) break;
    } catch { /* The temporary browser is still starting. */ }
    await pause(100);
  }
  if (!worker) throw new Error('Built extension did not load in isolated Chromium');
  const workerUrl = new URL(worker.url);
  const origin = `${workerUrl.protocol}//${workerUrl.host}`;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${origin}/sidebar.html`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0; const waiting = new Map();
  socket.onmessage = event => {
    const result = JSON.parse(event.data), item = waiting.get(result.id);
    if (!item) return; waiting.delete(result.id); clearTimeout(item.timer);
    if (result.error) item.reject(new Error(result.error.message)); else item.resolve(result.result);
  };
  function send(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Timed out: ${method}`)); }, 5000);
      waiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Toolbar page evaluation failed'); return result.result.value;
  }
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await evaluate(`!!document.querySelector('button[aria-label="Toggle WebRTC collaboration"]:not(:disabled)')`);
    if (ready) break; await pause(100);
  }
  assert(ready, 'Production WebRTC toggle must be present without WebSocket build flags');
  const widths = [];
  for (const width of [240, 320, 480, 800]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }); await pause(50);
    const result = await evaluate(`(() => {
      const row = document.querySelector('.app-title-row'), rect = row.getBoundingClientRect();
      const buttons = [...row.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0);
      return { width: innerWidth, rowWidth: rect.width, overflows: row.scrollWidth > row.clientWidth + 1,
        controlsFit: buttons.every(button => { const b = button.getBoundingClientRect(); return b.left >= rect.left - 1 && b.right <= rect.right + 1; }),
        toggleCount: row.querySelectorAll('button[aria-label="Toggle WebRTC collaboration"]').length };
    })()`);
    assert(!result.overflows && result.controlsFit && result.toggleCount === 1, `Toolbar overflow at ${width}px: ${JSON.stringify(result)}`);
    widths.push(result);
  }
  await evaluate(`document.querySelector('button[aria-label="Toggle WebRTC collaboration"]').click()`); await pause(100);
  assert.equal(await evaluate('(async () => (await chrome.storage.local.get("pboardLiveCollaboration")).pboardLiveCollaboration)()'), false);
  await send('Page.reload'); await pause(600);
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Toggle WebRTC collaboration"]')?.getAttribute('aria-pressed')`), 'false');
  console.log(JSON.stringify({ result: 'passed', widths, preferenceSurvivesReload: true }));
} finally {
  socket?.close();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([exited, pause(2000)]); }
  await rm(profile, { recursive: true, force: true });
}

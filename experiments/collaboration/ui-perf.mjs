/** UI responsiveness probe in native Chromium: local edit cost and read amplification. */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "pboard-uiperf-"));
const browsers = [];
const sockets = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<script type="module" src="/probe.js"></script>');
      return;
    }
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(join(work, "bundle/probe.js")));
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
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
  const target = targets.find((item) => item.type === "page");
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
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const message = await result;
    if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails));
    return message.result?.result?.value;
  };
}

try {
  await build({ configFile: false, root,
    build: {
      outDir: join(work, "bundle"), emptyOutDir: true, target: "esnext",
      lib: { entry: join(root, "experiments/collaboration/ui-perf-probe.ts"), formats: ["es"], fileName: "probe" },
      rolldownOptions: { output: { codeSplitting: false } }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser(origin);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await page("window.probe?.result ?? null");
    if (result) { console.log(JSON.stringify(result, null, 2)); break; }
    await pause(200);
  }
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

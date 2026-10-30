import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
const requestedVariant = process.argv[2] ?? "all";
const packageMetadata = await readJson("package.json");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function assertFile(path) {
  await access(resolve(root, path));
}

function verifyBackgroundStartup(source, kind) {
  const listeners = new Map();
  const event = (name) => ({
    addListener(listener) { listeners.set(name, listener); },
    removeListener() {}
  });
  const api = {
    runtime: {
      getURL: () => `${kind === "firefox" ? "moz" : "chrome"}-extension://pboard/`,
      onInstalled: event("installed"), onMessage: event("message")
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: event("storage")
    },
    identity: {},
    menus: { removeAll: async () => {}, create() {}, onClicked: event("menu") },
    commands: { onCommand: event("command") },
    alarms: {
      onAlarm: event("alarm"),
      get: async () => undefined,
      create: async () => {},
      clear: async () => true
    }
  };
  // Evaluate the production bundle without Node's global/process/Buffer.
  // Merely checking that files exist misses browser-incompatible imports.
  runInNewContext(source, {
    [kind === "firefox" ? "browser" : "chrome"]: api,
    console, crypto: globalThis.crypto, setTimeout, clearTimeout,
    setInterval, clearInterval, queueMicrotask, TextEncoder, TextDecoder,
    URL, URLSearchParams, AbortController, performance, structuredClone,
    Headers, Request, Response, Blob, atob, btoa,
    fetch: async () => { throw new Error("Unexpected network request during startup verification"); }
  }, { filename: `${kind}/background.js`, timeout: 5000 });
  for (const name of ["installed", "message", "menu", "command", "alarm"]) {
    if (!listeners.has(name)) throw new Error(`${kind} background did not register ${name}`);
  }
}

async function verifyVariant(directory, manifest, kind) {
  await assertFile(`${directory}/manifest.json`);
  await assertFile(`${directory}/sidebar.html`);
  await assertFile(`${directory}/background.js`);
  await assertFile(`${directory}/content.js`);
  await assertFile(`${directory}/icons/pin.svg`);
  const license = await readFile(resolve(root, directory, "LICENSE.md"), "utf8");
  if (license !== await readFile(resolve(root, "LICENSE.md"), "utf8")) {
    throw new Error(`${kind} build has an outdated GPL license`);
  }
  const notices = await readFile(resolve(root, directory, "THIRD-PARTY-NOTICES.txt"), "utf8");
  if (!notices.includes("Pboard — third-party licenses and notices") || !notices.includes("react@")) {
    throw new Error(`${kind} build is missing bundled dependency notices`);
  }

  if (manifest.version !== packageMetadata.version) {
    throw new Error(`${kind} build version ${manifest.version} does not match package version ${packageMetadata.version}`);
  }

  if (kind === "firefox") {
    if (
      !manifest.sidebar_action ||
      !manifest.action ||
      !manifest.background?.scripts ||
      !manifest.commands?.["_execute_sidebar_action"] ||
      manifest.side_panel
    ) {
      throw new Error("Firefox build does not have the expected sidebar/action/background manifest");
    }
  } else if (!manifest.side_panel || !manifest.action || !manifest.background?.service_worker || manifest.sidebar_action) {
    throw new Error("Chromium build does not have the expected side_panel/service-worker manifest");
  } else if (!manifest.oauth2?.client_id || !["drive.appdata", "drive"].every((scope) => manifest.oauth2?.scopes?.includes(`https://www.googleapis.com/auth/${scope}`))) {
    throw new Error("Chromium build does not have the expected Google Drive OAuth configuration");
  }

  const background = await readFile(resolve(root, directory, "background.js"), "utf8");
  if (!background.includes("OffscreenCanvas")) {
    throw new Error(`${kind} background bundle is missing the service-worker image path`);
  }
  verifyBackgroundStartup(background, kind);
}

if (requestedVariant === "firefox" || requestedVariant === "all") {
  await verifyVariant("dist", await readJson("dist/manifest.json"), "firefox");
}
if (requestedVariant === "chromium" || requestedVariant === "all") {
  await verifyVariant("dist/chromium", await readJson("dist/chromium/manifest.json"), "chromium");
}
if (!["firefox", "chromium", "all"].includes(requestedVariant)) {
  throw new Error(`Unknown build variant: ${requestedVariant}`);
}
console.log(`${requestedVariant === "all" ? "Firefox and Chromium" : requestedVariant} build verification passed`);

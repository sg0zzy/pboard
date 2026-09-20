import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const requestedVariant = process.argv[2] ?? "all";

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function assertFile(path) {
  await access(resolve(root, path));
}

async function verifyVariant(directory, manifest, kind) {
  await assertFile(`${directory}/manifest.json`);
  await assertFile(`${directory}/sidebar.html`);
  await assertFile(`${directory}/background.js`);
  await assertFile(`${directory}/content.js`);
  await assertFile(`${directory}/icons/pin.svg`);

  if (kind === "firefox") {
    if (!manifest.sidebar_action || !manifest.background?.scripts || manifest.side_panel) {
      throw new Error("Firefox build does not have the expected sidebar/background manifest");
    }
  } else if (!manifest.side_panel || !manifest.action || !manifest.background?.service_worker || manifest.sidebar_action) {
    throw new Error("Chromium build does not have the expected side_panel/service_worker manifest");
  }

  const background = await readFile(resolve(root, directory, "background.js"), "utf8");
  if (!background.includes("OffscreenCanvas")) {
    throw new Error(`${kind} background bundle is missing the service-worker image path`);
  }
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

// Store-listing screenshots for the Android app (Google Play).
//
//   node scripts/screenshots.mjs          writes build/screenshots/home.png + board.png
//
// Renders the real app screens (HomeScreen; BoardScreen on a software-project
// board with representative cards) over the real stylesheet at 1080x1920
// (FHD 9:16) and captures the two screenshots. Screens are bundled by the
// project's own Vite into self-contained pages and captured with the system
// Chromium through Playwright. Both screens render without Capacitor/browser
// runtime dependencies; the data props mirror the app data shapes exactly.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const androidRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(androidRoot, "..", "..");
const workDir = resolve(androidRoot, "build", "screenshots");
mkdirSync(workDir, { recursive: true });

const WIDTH = 1080;
const HEIGHT = 1920;
const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
];

// ---------------------------------------------------------------------------
// Entries (verbatim app components, realistic seed data)
// ---------------------------------------------------------------------------

const homeEntry = `
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { HomeScreen } from "../../src/screens/HomeScreen";

const boards = [
  { id: "phone", name: "PhoneHaul", category: "Project", template: "project", firstCardType: "task", firstCard: "Improve Android transfer UX", updatedAt: "2026-10-14T09:00:00Z" },
  { id: "film", name: "filmTidy", category: "Project", template: "project", firstCardType: "task", firstCard: "Photo metadata analysis", updatedAt: "2026-10-13T09:00:00Z" },
  { id: "personal", name: "Personal ideas", category: "Ideas", template: "brainstorming", firstCardType: "idea", firstCard: "A lightweight notes system", updatedAt: "2026-10-12T09:00:00Z" },
  { id: "website", name: "Website", category: "Project", template: "project", firstCardType: "task", firstCard: "Publish the landing page", updatedAt: "2026-10-11T09:00:00Z" },
  { id: "ai", name: "AI experiments", category: "Ideas", template: "brainstorming", firstCardType: "idea", firstCard: "Test new coding agents", updatedAt: "2026-10-02T09:00:00Z" },
  { id: "archive", name: "Archive", category: "Notes", template: "brainstorming", firstCardType: "note", firstCard: "Reading list and references", updatedAt: "2026-10-01T09:00:00Z" },
];

createRoot(document.getElementById("root")).render(
  React.createElement(HomeScreen, {
    boards, showPreviews: true,
    onOpen: () => {}, onSettings: () => {}, onNotice: () => {}, onCreate: () => {},
  })
);
`;

const boardEntry = `
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { BoardScreen } from "../../src/screens/BoardScreen";

const project = { id: "sw", name: "Sync engine", template: "software_project", revision: 7, createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-15T08:00:00Z" };
const card = (id, type, title, content, status, order) => ({ id, projectId: "sw", type, title, content, status, order, createdAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-10T10:00:00Z" });
const cards = [
  card("g1", "main_goal", "Offline-first sync", "Keep every board usable offline; sync in the background when Drive is reachable.", "started", 0),
  card("f1", "feature", "Background transfer queue", "- [x] queue pending changes\\n- [ ] tune backoff\\n- [ ] sync status chip", "started", 1),
  card("i1", "issue", "Token expiry race", "Refresh flow races on flaky mobile networks; requests fail with 401 before retry.", "candidate", 2),
  card("d1", "decision", "Storage engine", "RxDB + blob store keyed by SHA-256; no plaintext duplicates.", "done", 3),
  card("t1", "task", "Instrument the sync loop", "Add counters for pulls, pushes and conflicts.", "candidate", 4),
  card("t2", "task", "Test image hash validation", "Reject assets failing SHA-256 before storing.", "confirmed", 5),
  card("r1", "main_description", "Drive quota spikes", "Polling latency degrades near quota; consider longer backoff.", "candidate", 6),
  card("t3", "task", "Ship beta to testers", "", "done", 7),
];

createRoot(document.getElementById("root")).render(
  React.createElement(BoardScreen, {
    project, cards, busy: false, readOnly: false,
    onBack: () => {}, onEditBoard: () => {}, onDeleteBoard: () => {}, onAddCard: () => {},
    onEditCard: () => {}, onDeleteCard: () => {}, onReorderCard: () => {}, onUpdateCard: () => {},
    onTrashSection: () => {}, onEmptyTrash: () => {}, onChooseCardField: () => {},
    getImage: async () => null,
    onCardActions: () => {}, onCopyBoard: () => {}, onDownloadBoard: () => {}, onCopySection: () => {},
    uiScale: 1, fingerprintTransition: null, focusCardId: null, onFocusHandled: () => {},
    cloud: null,
  })
);
`;

// ---------------------------------------------------------------------------
// Bundling: one IIFE page per screen via the project's Vite
// ---------------------------------------------------------------------------

const viteConfigSource = `
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Bundle every react-* import to ONE copy: mixed workspace-relative imports hit
// two node_modules roots and otherwise produce two React instances, one of which
// never receives the hooks dispatcher (null useRef at render).
const androidRoot = ${JSON.stringify(androidRoot)};

export default defineConfig({
  root: ${JSON.stringify(workDir)},
  envDir: ${JSON.stringify(repoRoot)},
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom", "react-dom/client", "scheduler"],
    alias: [
      { find: /^react$/, replacement: path.join(androidRoot, "node_modules", "react", "index.js") },
      { find: /^react-dom$/, replacement: path.join(androidRoot, "node_modules", "react-dom", "index.js") },
      { find: /^react-dom\\/client/, replacement: path.join(androidRoot, "node_modules", "react-dom", "client.js") },
      { find: /^scheduler$/, replacement: path.join(androidRoot, "node_modules", "scheduler", "index.js") }
    ]
  },
  define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": JSON.stringify("production") },
  build: {
    outDir: ${JSON.stringify(workDir)},
    emptyOutDir: false,
    write: true,
    minify: false,
    target: "chrome124",
    cssCodeSplit: false,
    rollupOptions: {
      input: process.env.SCREENSHOT_ENTRY,
      treeshake: true,
      // Distinct names: an identical assetFileNames/entryFileNames string makes
      // the CSS asset overwrite the JS chunk (verified with a probe).
      output: { format: "iife", inlineDynamicImports: true, entryFileNames: process.env.SCREENSHOT_BUNDLE, assetFileNames: process.env.SCREENSHOT_ASSET }
    }
  }
});
`;

function buildPage(name, entry) {
  const entryFile = resolve(workDir, `${name}-entry.mjs`);
  const config = resolve(workDir, `screenshot.config.mjs`);
  const bundle = `${name}-bundle.js`;
  writeFileSync(entryFile, entry);
  writeFileSync(config, viteConfigSource);
  execFileSync(process.execPath, [
    resolve(androidRoot, "node_modules", "vite", "bin", "vite.js"), "build",
    "--config", config
  ], {
    cwd: workDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      SCREENSHOT_ENTRY: entryFile,
      SCREENSHOT_BUNDLE: bundle,
      SCREENSHOT_ASSET: `${name}-styles.css`
    }
  });
  const bundlePath = resolve(workDir, bundle);
  if (!existsSync(bundlePath)) throw new Error(`Vite produced no bundle for ${name}: expected ${bundlePath}`);
  const cssPath = resolve(workDir, `${name}-styles.css`);
  const css = existsSync(cssPath) ? `<link rel="stylesheet" href="./${basename(cssPath)}">` : "";
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${css}
<style>html,body{margin:0;padding:0;background:#fbfaff;width:${WIDTH}px;min-height:${HEIGHT}px}</style>
</head><body><div id="root"></div><script src="./${bundle}"></script></body></html>`;
  writeFileSync(resolve(workDir, `${name}.html`), html);
  return { page: resolve(workDir, `${name}.html`), bundlePath, cssPath: resolve(workDir, `${bundle}.css`) };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function pickChromium() {
  for (const candidate of CHROMIUM_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error("No system Chromium found; install chromium or set CHROMIUM_PATH");
}

async function capture(pagePath, pngPath) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? pickChromium(),
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars", "--lang=en-US"]
  });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: "en-US"
    });
    await page.goto(`file://${pagePath}`);
    await page.waitForSelector("#root .app-shell, #root .board-tile, #root .board-content, #root .empty-state", { timeout: 15_000 });
    await page.waitForTimeout(600); // fonts, transitions, fingerprint layout settle
    await page.screenshot({ path: pngPath, type: "png" });
    await page.close();
  } finally {
    await browser.close();
  }
}

const screens = [
  { name: "home", entry: homeEntry, png: resolve(workDir, "home.png") },
  { name: "board", entry: boardEntry, png: resolve(workDir, "board.png") }
];

for (const { name, entry, png } of screens) {
  rmSync(resolve(workDir, `${name}.html`), { force: true });
  const built = buildPage(name, entry);
  console.log(`capturing ${name} → ${png.replace(new RegExp(`\\${sep}`, "g"), "/")}`);
  await capture(built.page, png);
}
console.log(`screenshots written to ${workDir}`);
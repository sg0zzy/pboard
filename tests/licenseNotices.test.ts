import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error Release scripts are native Node ESM.
import { packageNotices, licenseNotices, writeLicenseNotices } from "../scripts/license-notices.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(name = "fixture-dependency") {
  const root = await mkdtemp(join(tmpdir(), "pboard-licenses-"));
  directories.push(root);
  const directory = join(root, "node_modules", name);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT" }));
  // Packages can ship a nested package.json just to specify module format.
  await writeFile(join(directory, "dist/package.json"), '{"type":"module"}');
  return { root, directory, moduleId: join(directory, "dist/index.js") };
}

it("keeps complete copyright, license, and NOTICE texts from a bundled package", async () => {
  const { directory, moduleId } = await fixture();
  await writeFile(join(directory, "LICENSE"), "Full license and copyright text\n");
  await writeFile(join(directory, "NOTICE"), "Additional attribution\n");
  const notices = await packageNotices(`${moduleId}?commonjs`);
  expect(notices.documents).toEqual([
    { name: "LICENSE", text: "Full license and copyright text\n" },
    { name: "NOTICE", text: "Additional attribution\n" }
  ]);
});

it("fails instead of silently omitting a dependency's missing license", async () => {
  const { moduleId } = await fixture();
  await expect(packageNotices(moduleId)).rejects.toThrow("Missing license text for bundled dependency fixture-dependency@1.0.0");
});

it("uses the version-specific upstream copy when npm omitted the license", async () => {
  const notices = await packageNotices(resolve("node_modules/event-reduce-js/dist/esm/src/index.js"));
  expect(notices.name).toBe("event-reduce-js");
  expect(notices.documents.some((document: { text: string }) => document.text.includes("Permission is hereby granted"))).toBe(true);
  expect(notices.documents.some((document: { text: string }) => document.text.includes("52e54b9f5944c35435e8e9dbbbd58c2413294998"))).toBe(true);
});

it("collects rendered modules, excludes tree-shaken packages, and consolidates all entries", async () => {
  const { root, directory, moduleId } = await fixture();
  await writeFile(join(directory, "LICENSE"), "Fixture copyright and license\n");
  const plugin = licenseNotices("sidebar");
  let source = "";
  await plugin.generateBundle.call({ emitFile(asset: { source: string }) { source = asset.source; } }, {}, {
    "sidebar.js": { type: "chunk", modules: {
      [moduleId]: { renderedLength: 10 },
      [join(root, "node_modules/absent/index.js")]: { renderedLength: 0 }
    } }
  });
  for (const entry of ["sidebar", "background", "content"]) await writeFile(join(root, `.licenses-${entry}.json`), source);
  await writeLicenseNotices(root);
  const text = await readFile(join(root, "THIRD-PARTY-NOTICES.txt"), "utf8");
  expect(text.match(/fixture-dependency@1.0.0/g)).toHaveLength(1);
  expect(text).toContain("Fixture copyright and license");
  expect(text).toContain("rolldown@");
  await expect(readFile(join(root, ".licenses-sidebar.json"))).rejects.toThrow();
});

import { readFile, readdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, join, isAbsolute } from "node:path";

const noticeFile = /^(?:licen[cs]e|copying|copyright|notice|third[-_]party[-_](?:licen[cs]es?|notices?))(?:[._-].*)?$/i;
const fragments = ["sidebar", "background", "content"].map((entry) => `.licenses-${entry}.json`);
const fallbackDirectory = resolve("scripts/third-party-licenses");

export async function packageNotices(moduleId) {
  const path = moduleId.replace(/^\0/, "").split("?")[0];
  if (!isAbsolute(path) || !path.includes("/node_modules/")) return null;
  let directory = dirname(path);
  while (directory !== dirname(directory)) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (metadata?.name && metadata.version) {
      const names = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && noticeFile.test(entry.name))
        .map((entry) => entry.name).sort();
      const documents = await Promise.all(names.map(async (name) => ({
        name, text: await readFile(join(directory, name), "utf8")
      })));
      if (!documents.some((document) => /^(?:licen[cs]e|copying)(?:[._-]|$)/i.test(document.name) && document.text.trim())) {
        const fallbacks = JSON.parse(await readFile(join(fallbackDirectory, "sources.json"), "utf8"));
        const fallback = fallbacks[`${metadata.name}@${metadata.version}`];
        if (!fallback) throw new Error(`Missing license text for bundled dependency ${metadata.name}@${metadata.version}`);
        documents.push({ name: "LICENSE (recorded fallback)", text: await readFile(join(fallbackDirectory, fallback.file), "utf8") });
        documents.push({ name: "License source", text: fallback.source });
      }
      return { name: metadata.name, version: metadata.version, license: metadata.license, documents };
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot identify bundled dependency: ${moduleId}`);
}

// Use the emitted chunk graph, including transitive dependencies, rather than
// copying every package installed for development or guessing from package.json.
export function licenseNotices(entry) {
  return {
    name: "pboard-license-notices",
    apply: "build",
    async generateBundle(_options, bundle) {
      const moduleIds = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          if (module.renderedLength > 0) moduleIds.add(id);
        }
      }
      // Rolldown also supplies generated runtime helpers without a disk module ID.
      moduleIds.add(resolve("node_modules/rolldown/dist/index.mjs"));
      const packages = new Map();
      for (const id of [...moduleIds].sort()) {
        const notices = await packageNotices(id);
        if (notices) packages.set(`${notices.name}@${notices.version}`, notices);
      }
      this.emitFile({ type: "asset", fileName: `.licenses-${entry}.json`, source: JSON.stringify([...packages.values()]) });
    }
  };
}

export async function writeLicenseNotices(outputDirectory) {
  const packages = new Map();
  for (const fragment of fragments) {
    for (const notices of JSON.parse(await readFile(join(outputDirectory, fragment), "utf8"))) {
      packages.set(`${notices.name}@${notices.version}`, notices);
    }
  }
  let text = "Pboard — third-party licenses and notices\n\n";
  text += "These components retain their respective licenses. Pboard's GPLv3 license is in LICENSE.md.\n";
  text += "Packages below were included in the production bundles, plus Rolldown's generated runtime helpers.\n\n";
  for (const [key, notices] of [...packages].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    text += `${"=".repeat(72)}\n${key}\nLicense: ${notices.license ?? "See license text"}\n`;
    for (const document of notices.documents) text += `\n--- ${document.name} ---\n${document.text}\n`;
  }
  await writeFile(join(outputDirectory, "THIRD-PARTY-NOTICES.txt"), text);
  await Promise.all(fragments.map((fragment) => rm(join(outputDirectory, fragment))));
  return packages.size;
}

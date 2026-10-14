// Release tag gate, run in GitHub Actions before any AMO upload.
//   node scripts/verify-release-tag.mjs <tag>
// The tag must be v<version> where <version> matches the Firefox manifest.
// It also pins the Gecko ID to the ID of the existing AMO listing so an
// accidental ID change can never create a second listing.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];

if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error(`Release tags must match v*.*.* (for example v0.2.0); received: ${tag ?? "(none)"}`);
  process.exit(1);
}

const expected = `v${JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")).version}`;
if (tag !== expected) {
  console.error(`Tag ${tag} does not match Firefox manifest version ${expected}. ` +
    "Update manifest.json (and package.json) or retag the commit as " +
    `v${JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version}.`);
  process.exit(1);
}

const id = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"))
  .browser_specific_settings?.gecko?.id;
const LISTING_ID = "project-board@local.invalid";
if (id !== LISTING_ID) {
  console.error(`Firefox extension ID must stay ${LISTING_ID} to update the existing AMO listing; ` +
    `manifest.json declares ${id ?? "(none)"}.`);
  process.exit(1);
}

console.log(`Release tag ${tag} matches manifest version and extension ID ${id}`);
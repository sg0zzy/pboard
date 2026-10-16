// Read-only stable metadata check; remote/source/signature gates live in release-control.mjs.
import { readFileSync } from 'node:fs';
import { official } from './release-policy.mjs';
const tag = process.argv[2];
const version = official(tag?.replace(/^v/, '') ?? '');
if (tag !== `v${version}` || version.includes('-')) throw Error('Expected an explicit stable vX.Y.Z tag');
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
if (read('VERSION').trim() !== version) throw Error('Stable tag and VERSION differ; select a greater unused version for any corrected release');
for (const path of ['package.json', 'manifest.json', 'manifest.chromium.json']) if (JSON.parse(read(path)).version !== version) throw Error(`Mirror out of sync: ${path}`);
if (JSON.parse(read('manifest.json')).browser_specific_settings?.gecko?.id !== 'project-board@local.invalid') throw Error('Firefox listing ID changed');
console.log(`Stable metadata matches ${tag}; this does not validate publication readiness`);

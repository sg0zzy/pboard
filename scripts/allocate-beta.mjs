// Compatibility CLI: allocation uses the same full remote inventory as stable preparation.
import { remoteInventory } from './release-control.mjs';
import { nextBeta } from './release-policy.mjs';
try {
  if (process.argv[2] !== 'resolve') throw Error('usage: allocate-beta.mjs resolve X.Y.Z');
  const { versions } = await remoteInventory();
  console.log(`v${nextBeta(process.argv[3], versions)}`);
} catch (e) { console.error(e.message); process.exitCode = 1; }

// Managed Firefox build with the Live Debug Bridge compiled in and enabled by
// default, staged at `dist-debug/` so it can coexist with the ordinary bundle.
// Developer-only: never ship this tree, and never point it outside loopback.
import { buildLocal } from './local-build.mjs';

buildLocal(['firefox'], { diagnostics: true });
console.log('Debug-channel Firefox bundle staged in dist-debug/. Start `npm run debug:bridge`, then load dist-debug/manifest.json in a dedicated test profile.');

import { buildLocal } from './local-build.mjs';
const target = process.argv[2] || 'firefox';
if (!['firefox', 'chromium'].includes(target)) throw Error('Use firefox or chromium');
buildLocal([target], { signalingExperiment: true });
console.log('Experimental extension staged in ' + (target === 'firefox' ? 'dist' : 'dist/chromium') + '. Load it in a dedicated TEST browser profile. Ordinary builds remain Drive-only.');

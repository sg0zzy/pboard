// Trusted signing only; no selected-source code or dependency installation in this job.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { releaseReadiness } from './release-policy.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const config = JSON.parse(readFileSync(join(root, 'project-standards.json'))); releaseReadiness(config);
const dir = resolve(process.argv[2]), tools = process.env.ANDROID_BUILD_TOOLS;
const info = JSON.parse(readFileSync(join(dir, 'build-info.json')));
if (info.state !== 'awaiting_signature' || info.outputs.length !== 1) throw Error('Invalid unsigned manifest');
const entry = info.outputs[0];
if (entry.filename.includes('/') || entry.filename.includes('..')) throw Error('Invalid APK filename');
const apk = join(dir, entry.filename);
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
if (hash(apk) !== entry.sha256) throw Error('Unsigned APK transport hash mismatch');
for (const name of config.signing['android-release'].credentialReferences) if (!process.env[name]) throw Error(`Missing required signing credential: ${name}`);
const temp = mkdtempSync(join(tmpdir(), 'pboard-sign-'));
try {
  const keystore = join(temp, 'release.keystore');
  writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64'), { mode: 0o600 });
  const aligned = join(temp, 'aligned.apk');
  execFileSync(join(tools, 'zipalign'), ['-p', '-f', '4', apk, aligned]);
  const filename = entry.filename.replace('-unsigned.apk', '-release.apk'), final = join(dir, filename);
  const signing = spawnSync(join(tools, 'apksigner'), ['sign', '--ks', keystore, '--ks-key-alias', process.env.ANDROID_KEY_ALIAS, '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD', '--key-pass', 'env:ANDROID_KEY_PASSWORD', '--out', final, aligned], { stdio: 'pipe' });
  if (signing.status !== 0) throw Error('Android signing failed; secret-bearing tool diagnostics are withheld');
  const verification = execFileSync(join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', final], { encoding: 'utf8' });
  const signer = verification.match(/certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1]?.toLowerCase();
  if (signer !== config.signing['android-release'].certificateSha256.toLowerCase()) throw Error('Android signer fingerprint mismatch');
  const badging = execFileSync(join(tools, 'aapt'), ['dump', 'badging', final], { encoding: 'utf8' });
  if (!badging.includes(`versionName='${info.version}'`) || !badging.includes(`versionCode='${entry.versionCode}'`) || !badging.includes("name='it.stefanogozzi.pboard'")) throw Error('APK package/version mismatch');
  rmSync(apk);
  info.outputs = [{ ...entry, filename, sha256: hash(final), bytes: readFileSync(final).length, signing: 'release', certificateSha256: signer }];
  info.state = 'succeeded'; info.targets[0].outcome = 'succeeded'; info.completedAt = new Date().toISOString();
  writeFileSync(join(dir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
} finally { rmSync(temp, { recursive: true, force: true }); }

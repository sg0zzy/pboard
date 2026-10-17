// Pure repository release policy; shared by local preparation and trusted workflows.
export const CORE = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
export function parseVersion(v) {
  const m = v.match(new RegExp(`^${CORE}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`));
  if (!m) throw Error(`Invalid version: ${v}`);
  const prerelease = m[4]?.split('.') ?? [];
  if (prerelease.some(p => /^0[0-9]+$/.test(p))) throw Error(`Invalid numeric prerelease: ${v}`);
  return { core: m.slice(1, 4).map(BigInt), prerelease, label: prerelease[0], n: prerelease[1] && /^\d+$/.test(prerelease[1]) ? BigInt(prerelease[1]) : null };
}
export function compareVersion(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.prerelease.length || !y.prerelease.length) return x.prerelease.length ? -1 : y.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const left = x.prerelease[i], right = y.prerelease[i];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}
export function official(v) {
  if (!new RegExp(`^${CORE}(?:-dev\\.([1-9]\\d*))?$`).test(v)) throw Error(`Invalid official version: ${v}`);
  return v;
}
export function nextBeta(core, records) {
  if (!new RegExp(`^${CORE}$`).test(core)) throw Error('Beta core must be X.Y.Z without leading zeroes');
  let n = 0n;
  for (const v of records) {
    official(v);
    if (v.startsWith(`${core}-dev.`)) n = n > parseVersion(v).n ? n : parseVersion(v).n;
  }
  const v = `${core}-dev.${n + 1n}`;
  assertForward(v, records);
  return v;
}
export function assertForward(version, records, retry = false) {
  official(version);
  for (const previous of records) {
    official(previous);
    if (previous === version && retry) continue;
    if (compareVersion(version, previous) <= 0) throw Error(`${version} does not exceed reservation ${previous}`);
  }
}
export function extensionVersion(version) {
  official(version);
  const p = parseVersion(version);
  const slot = p.label ? p.n : 65535n;
  if (slot > 65534n && p.label || p.core.some(n => n > 65535n)) throw Error('Extension numeric version exhausted');
  return [...p.core, slot].join('.');
}
export function validateConfig(c) {
  if (c.schema !== 1 || !c.targets || !c.matrix || !Number.isSafeInteger(c.retention) || c.retention < 0) throw Error('Invalid project configuration');
  for (const context of ['local', 'ci', 'beta', 'stable']) {
    const matrix = c.matrix[context];
    if (!matrix || !Array.isArray(matrix.required) || !Array.isArray(matrix.optional)) throw Error(`Missing matrix: ${context}`);
    const selected = [...matrix.required, ...matrix.optional];
    if (new Set(selected).size !== selected.length || selected.some(id => !c.targets[id])) throw Error(`Invalid targets: ${context}`);
  }
  for (const t of Object.values(c.targets)) {
    if (!t.platform || !t.architecture || !t.package || !['debug-test-only', 'unsigned-upload-archive', ...Object.keys(c.signing)].includes(t.signing)) throw Error('Invalid target signing profile');
  }
  const destinations = new Set();
  for (const d of c.distribution) {
    const key = `${d.destination}:${d.target}:${d.channel}`;
    if (destinations.has(key) || !c.targets[d.target] || !['beta', 'stable'].includes(d.channel) || !['manual', 'disabled'].includes(d.mode)) throw Error('Unapproved/invalid destination configuration');
    destinations.add(key);
  }
  return c;
}
export function historyReservations(c) {
  const h = c.history;
  if (!h || !Array.isArray(h.unresolved) || h.unresolved.some(reason => typeof reason !== 'string' || !reason.trim()) ||
      !Array.isArray(h.reservations) || !h.historicalAliases || typeof h.historicalAliases !== 'object' || Array.isArray(h.historicalAliases)) {
    throw Error('Release blocked: missing/invalid history inventory configuration; reconcile migration evidence (history.reviewed is obsolete)');
  }
  for (const name of Object.keys(h.historicalAliases)) historicalVersion(c, name);
  return [...new Set([...h.reservations, ...Object.values(h.historicalAliases)].map(official))];
}
export function historicalVersion(c, name) {
  const canonical = name.replace(/^v/, '');
  const alias = Object.hasOwn(c.history.historicalAliases, name) ? c.history.historicalAliases[name] : undefined;
  let standard = false;
  try { official(canonical); standard = true; } catch { /* Nonstandard names need an explicit mapping. */ }
  if (standard && alias !== undefined && alias !== canonical) throw Error(`Historical alias redefines canonical version: ${name}`);
  return official(alias ?? canonical);
}
export function historyReadiness(c) {
  historyReservations(c);
  const h = c.history;
  if (h.unresolved.length) throw Error(`Release blocked: unresolved historical inventory: ${h.unresolved.join('; ')}`);
}
export function releaseReadiness(c) {
  validateConfig(c);
  historyReadiness(c);
  const signer = c.signing['android-release'];
  if (!Number.isSafeInteger(signer.highestHistoricalCode) || signer.highestHistoricalCode < 0 || !signer.historyReviewed || !/^[a-fA-F0-9]{64}$/.test(signer.certificateSha256 ?? '')) throw Error('Release blocked: Android production signer and code/submission history require owner review');
}

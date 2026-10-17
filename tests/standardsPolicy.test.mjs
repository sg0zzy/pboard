import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareVersion, assertForward, nextBeta, extensionVersion, validateConfig, releaseReadiness } from '../scripts/release-policy.mjs';
import { androidVersionCode } from '../scripts/version.mjs';
const config = JSON.parse(readFileSync(new URL('../project-standards.json', import.meta.url)));
describe('pinned standards version/operation gates', () => {
  it('compares every required precedence example numerically', () => {
    for (const sequence of [['1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0'], ['0.9.7','0.10.0','1.0.0'], ['0.9.5-dev.2','0.9.5-dev.10','0.9.5'], ['0.9.5-dev.99','0.9.6-dev.1'], ['0.9.5-dev.2','0.9.5-local.1','0.9.5']]) for (let i=1;i<sequence.length;i++) expect(compareVersion(sequence[i-1],sequence[i])).toBe(-1);
    expect(compareVersion('0.9.5-dev.2+one','0.9.5-dev.2+two')).toBe(0);
  });
  it('keeps failed reservations in the global forward stream, including skipped cores', () => {
    const records = ['0.9.4','0.9.5-dev.1','0.9.5-dev.2','0.9.6-dev.1'];
    expect(() => assertForward('0.9.5',records)).toThrow(); expect(() => assertForward('0.9.7', records)).not.toThrow();
    expect(nextBeta('0.9.6',records)).toBe('0.9.6-dev.2'); expect(nextBeta('0.9.7',records)).toBe('0.9.7-dev.1');
    expect(() => nextBeta('0.9.5',records)).toThrow(); expect(() => nextBeta('0.9.7',[...records,'unknown'])).toThrow();
    expect(() => assertForward('0.9.6-dev.1',records,true)).not.toThrow();
  });
  it('rejects malformed official forms and local tags', () => {
    for(const v of ['01.2.3','1.2.3-dev.0','1.2.3-local.1','1.2.3+metadata','1.2.3-dev.01']) expect(() => assertForward(v,[])).toThrow();
  });
  it('preserves Android encoded values, beta to stable order, range and exhaustion', () => {
    expect(androidVersionCode('0.10.2')).toBe(10002999);
    expect(androidVersionCode('0.10.3-dev.1')).toBeLessThan(androidVersionCode('0.10.3'));
    expect(androidVersionCode('0.10.3')).toBeLessThan(androidVersionCode('0.11.0-dev.1'));
    expect(androidVersionCode('20.99.999')).toBe(2099999999);
    for(const v of ['21.0.0','0.100.0','0.1.1000','0.1.1-dev.999','0.1.1-dev.0']) expect(() => androidVersionCode(v)).toThrow();
  });
  it('maps official extension versions monotonically and reserves final stable slot', () => {
    expect(extensionVersion('0.10.3-dev.1')).toBe('0.10.3.1'); expect(extensionVersion('0.10.3')).toBe('0.10.3.65535');
    expect(() => extensionVersion('0.10.3-dev.65535')).toThrow();
  });
  it('validates all effective targets, requiredness, signing and distribution entries', () => {
    expect(() => validateConfig(config)).not.toThrow();
    for (const mutate of [c=>c.matrix.ci.required.push('unknown'), c=>c.matrix.ci.optional.push('firefox'), c=>c.retention=-1, c=>c.targets.firefox.signing='unknown', c=>c.distribution[0].mode='automatic']) {
      const c=structuredClone(config);mutate(c);expect(()=>validateConfig(c)).toThrow();
    }
  });
  it('fails closed on unresolved history or absent production signer', () => {
    expect(()=>releaseReadiness(config)).toThrow(/historical inventory/);
    const c=structuredClone(config); c.history.unresolved=[];
    expect(()=>releaseReadiness(c)).toThrow(/Android/);
  });
});

import { expect, it } from 'vitest';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { certifyHistory, verifyJournalChange } from '../../src/collab/security/journalProof';
import { signMutation } from '../../src/collab/security/mutation';
import { signManifest } from '../../src/collab/security/manifest';
import { makeChange } from '../../src/storage/changeJournal';
import type { CollaborationSecurityOptions } from '../../src/collab/manager';
async function fixture() {
  const [root, author, receiver] = await Promise.all([generateDeviceKey(), generateDeviceKey(), generateDeviceKey()]);
  const now = Date.now();
  const first = { protocol: 2 as const, boardId: 'admission-board', authorityKeyId: root.keyId, driveProjectFileId: '', driveFolderId: '', epoch: 1,
    issuedAt: now - 1000, expiresAt: now + 299000, devices: [{ deviceKeyId: root.keyId, publicKey: root.publicJwk, role: 'owner' as const }, { deviceKeyId: author.keyId, publicKey: author.publicJwk, role: 'editor' as const }] };
  const second = { ...first, epoch: 2, devices: [first.devices[0], { deviceKeyId: receiver.keyId, publicKey: receiver.publicJwk, role: 'editor' as const }] };
  const context: CollaborationSecurityOptions = { boardId: first.boardId, manifest: first, ownSessionId: 'root', signer: { privateJwk: root.privateJwk, deviceKeyId: root.keyId }, historyAuthority: { privateJwk: root.privateJwk, deviceKeyId: root.keyId }, manifestHistory: new Map([[1, first]]), relayAuthorization: { authority: root.publicJwk, manifest: await signManifest(first, root) } };
  const fresh: CollaborationSecurityOptions = { ...context, historyAuthority: undefined, manifest: second, signer: { privateJwk: receiver.privateJwk, deviceKeyId: receiver.keyId }, manifestHistory: new Map([[1, first], [2, second]]) };
  const value = await signMutation({ id: 'card', projectId: first.boardId, content: 'Previously admitted', type: 'note', status: 'candidate', orderKey: 'a0', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), _deleted: false }, { privateJwk: author.privateJwk, deviceKeyId: author.keyId }, { boardId: first.boardId, collection: 'cards', manifest: first, sequence: 1 });
  const change = await makeChange({ boardId: first.boardId, collection: 'cards', documentId: 'card', parents: [], ancestry: 'unknown', value });
  const admission = (await certifyHistory(change, undefined, context))!;
  return { root, author, receiver, context, fresh, change, admission };
}
it('allows a fresh authorized device to verify root-admitted history after author removal without re-signing the author', async () => {
  const f = await fixture(); await expect(verifyJournalChange(f.change, undefined, f.fresh)).rejects.toThrow('not authorized');
  await expect(verifyJournalChange(f.change, undefined, f.fresh, f.admission)).resolves.toBeUndefined();
  expect((f.change.value._sec as any).provenance.authorKeyId).toBe(f.author.keyId);
});
it('does not create admission from an old timestamp after removal', async () => {
  const f = await fixture(); const ownerNow = { ...f.fresh, historyAuthority: f.context.historyAuthority };
  await expect(certifyHistory(f.change, undefined, ownerNow)).rejects.toThrow('not authorized');
  await expect(verifyJournalChange(f.change, undefined, f.fresh, { ...f.admission, signature: 'forged' })).rejects.toThrow('certificate');
});
it.each(['boardId', 'changeId', 'authorityKeyId'] as const)('binds certificates to exact %s', async field => {
  const f = await fixture(); const bad = { ...f.admission, payload: { ...f.admission.payload, [field]: 'other' } };
  await expect(verifyJournalChange(f.change, undefined, f.fresh, bad)).rejects.toThrow('certificate');
});
it('requires original signature and trusted historical grant even with a root certificate', async () => {
  const f = await fixture();
  await expect(verifyJournalChange(f.change, undefined, { ...f.fresh, manifestHistory: new Map() }, f.admission)).rejects.toThrow('grant');
  const bad = structuredClone(f.change); (bad.value._sec as any).signature = 'forged';
  await expect(verifyJournalChange(bad, undefined, f.fresh, f.admission)).rejects.toThrow('signature');
});
it('a member key or another root cannot certify a victim namespace', async () => {
  const f = await fixture();
  await expect(certifyHistory(f.change, undefined, { ...f.context, historyAuthority: { deviceKeyId: f.author.keyId, privateJwk: f.author.privateJwk } })).rejects.toThrow('authority');
  const other = await generateDeviceKey();
  await expect(verifyJournalChange(f.change, undefined, { ...f.fresh, relayAuthorization: { ...f.fresh.relayAuthorization!, authority: other.publicJwk } }, f.admission)).rejects.toThrow('certificate');
});
it('root admission is history evidence and never admits an expired room session', async () => {
  const f = await fixture();
  await expect(verifyJournalChange(f.change, undefined, { ...f.fresh, manifest: { ...f.fresh.manifest, expiresAt: Date.now() - 100000 } }, f.admission)).rejects.toThrow('authorization');
});

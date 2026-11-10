import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createPeerHistorySession, type PeerHistorySession } from '../../src/collab/peerHistory';
import { generateDeviceKey } from '../../src/collab/security/keys';
import { installLiveBoardMutations, withUntrustedImport } from '../../src/collab/security/liveMutations';
import { manifestHash, signManifest, verifyManifest } from '../../src/collab/security/manifest';
import type { CollaborationSecurityOptions } from '../../src/collab/manager';
import type { VerifiedSessionContext } from '../../src/collab/security/session';
import { makeChange, type Change, type JournalEntry } from '../../src/storage/changeJournal';

/**
 * The peer history exchanges the board's change log. A board with a long
 * history must be transferred completely: the exchange delivers the records the
 * peer still needs, and a record the peer already holds must not be offered
 * again. The verification of a record is a signature check, so a record that
 * was verified once is not verified again.
 */
const repos: RxRepository[] = [];
const sessions: PeerHistorySession[] = [];
afterEach(async () => {
  sessions.splice(0).forEach(session => session.close());
  for (const repo of repos.splice(0)) await repo.db.close();
});

async function fixture(cards: number, options: { name?: string; attestExisting?: boolean; copyToPeer?: boolean } = {}) {
  const a = await createRxRepository({ name: `exch-a-${crypto.randomUUID()}` }); repos.push(a);
  const b = await createRxRepository({ name: `exch-b-${crypto.randomUUID()}` }); repos.push(b);
  const board = await a.createProject(options.name ?? 'Shared', 'project');
  const owner = await generateDeviceKey(), editor = await generateDeviceKey();
  const payload = { protocol: 2 as const, boardId: board.id, driveProjectFileId: '', driveFolderId: '', authorityKeyId: owner.keyId,
    epoch: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300000,
    devices: [{ deviceKeyId: owner.keyId, publicKey: owner.publicJwk, role: 'owner' as const }, { deviceKeyId: editor.keyId, publicKey: editor.publicJwk, role: 'editor' as const }] };
  const signer = { deviceKeyId: owner.keyId, privateJwk: owner.privateJwk };
  const manifest = await verifyManifest(await signManifest(payload, signer), owner.publicJwk, owner.keyId);
  const sa: CollaborationSecurityOptions = { boardId: board.id, manifest, signer, ownSessionId: 'a' };
  const sb: CollaborationSecurityOptions = { ...sa, signer: { deviceKeyId: editor.keyId, privateJwk: editor.privateJwk }, ownSessionId: 'b' };
  await installLiveBoardMutations({ projectId: board.id, cards: a.db.cards, projects: a.db.projects, security: sa, attestExisting: options.attestExisting ?? true });
  await installLiveBoardMutations({ projectId: board.id, cards: b.db.cards, projects: b.db.projects, security: sb });
  const project = (await a.db.projects.findOne(board.id).exec())!.toJSON();
  if (options.copyToPeer ?? true) await withUntrustedImport([b.db.projects], () => b.db.projects.upsert(JSON.parse(JSON.stringify(project))));
  for (let index = 0; index < cards; index++) await a.addItem({ projectId: board.id, content: `Card ${index}` });
  return { a, b, sa, sb, board };
}

function context(own: CollaborationSecurityOptions, remote: CollaborationSecurityOptions, collection: Change['collection'] = 'cards'): VerifiedSessionContext {
  return { boardId: own.boardId, collection, ownDeviceKeyId: own.signer.deviceKeyId, remoteDeviceKeyId: remote.signer.deviceKeyId,
    remoteRole: remote.manifest.devices.find(d => d.deviceKeyId === remote.signer.deviceKeyId)!.role,
    ownSessionId: own.ownSessionId, remoteSessionId: remote.ownSessionId,
    manifestEpoch: own.manifest.epoch, manifestHash: manifestHash(own.manifest), transcriptHash: 'x', manifestExpiresAt: own.manifest.expiresAt };
}

function pair(f: Awaited<ReturnType<typeof fixture>>, collection: Change['collection'] = 'cards') {
  const errors: string[] = [];
  let qa: Promise<unknown> = Promise.resolve(), qb: Promise<unknown> = Promise.resolve();
  const left = createPeerHistorySession({ repository: f.a, security: f.sa, context: context(f.sa, f.sb, collection), active: () => true,
    send(frame) { qb = qb.then(() => right.receive(frame)).catch(e => { errors.push(String(e)); }); }, onError: e => errors.push(String(e)) });
  const right = createPeerHistorySession({ repository: f.b, security: f.sb, context: context(f.sb, f.sa, collection), active: () => true,
    send(frame) { qa = qa.then(() => left.receive(frame)).catch(e => { errors.push(String(e)); }); }, onError: e => errors.push(String(e)) });
  sessions.push(left, right);
  return { left, right, errors, async exchange() { await Promise.all([left.flush(), right.flush()]); await qa; await qb; } };
}

it('transfers a board with a long history completely', async () => {
  const f = await fixture(40);
  const p = pair(f);
  await p.exchange();
  expect(p.errors).toEqual([]);
  expect((await f.b.listCards(f.board.id)).length).toBe(40);
});

it('verifies a record once, not on every exchange', async () => {
  const f = await fixture(30);
  const p = pair(f);
  const module = await import('../../src/collab/security/journalProof');
  const original = module.verifyJournalChange;
  let verifications = 0;
  vi.spyOn(module, 'verifyJournalChange').mockImplementation(async (...args: Parameters<typeof original>) => {
    verifications++;
    return original(...args);
  });

  await p.exchange();
  const afterFirst = verifications;
  expect(afterFirst).toBeGreaterThan(0);

  // A second exchange over the same history must not verify it again.
  await p.exchange();
  const afterSecond = verifications;
  // The delta must not grow with the history: it is the records the receiver
  // newly stored, not the whole log.
  expect(afterSecond - afterFirst).toBeLessThanOrEqual(20);
});

/**
 * A board created before its device was enrolled has no attested seed: the bytes
 * it had then were never signed, so no proof can be offered for them and every
 * presentable descendant used to be offered as its own parentless unknown-ancestry
 * root. The peer then reconciled a multi-head fork that nobody had created, and
 * such a document stayed conflicted forever - which is how a delete on one side
 * could never settle against the other. Presentation must therefore re-anchor each
 * disclosed change onto the record the peer is actually given, so one serialized
 * history arrives as one chain while the private root stays local.
 */
it('presents a chain behind an unattested private root as one chain, not as separate roots', async () => {
  // The peer starts empty: bytes that were never signed cannot be imported past
  // its guard, so the private name reaches it only through the journal, if at all.
  const f = await fixture(0, { name: 'PRIVATE_PRE_ENROLLMENT', attestExisting: false, copyToPeer: false });
  // One rename records the name patch and then the touch, so each shared edit is
  // two journal entries, all of them hanging below the unattested root.
  await f.a.renameProject(f.board.id, 'Shared current content');
  await f.a.renameProject(f.board.id, 'Live delete');
  const p = pair(f, 'projects');
  await p.exchange();
  expect(p.errors).toEqual([]);
  const shared = (await f.b.journal.entries.where('boardId').equals(f.board.id).toArray()).filter(e => e.collection === 'projects');
  expect(shared.map(e => e.value.name)).not.toContain('PRIVATE_PRE_ENROLLMENT');
  // The private root stays undisclosed, so the peer keeps a single chain instead
  // of offering each change as its own parentless root: exactly one received record
  // is a root, every other one names a received parent, and walking those links
  // reaches every record once in the order the changes were made.
  const root = shared.filter(e => e.ancestry === 'unknown');
  expect(root.length).toBe(1);
  expect(root[0].parents).toEqual([]);
  expect(root[0].value.name).toBe('Shared current content');
  const received = new Set(shared.map(e => e.id));
  for (const record of shared) {
    if (record.ancestry === 'unknown') continue;
    expect(record.parents.length).toBe(1);
    expect(received.has(record.parents[0])).toBe(true);
    expect(record.proof).toBeTruthy();
  }
  const chain: string[] = [];
  let node: JournalEntry | undefined = root[0];
  while (node && chain.length <= shared.length) {
    chain.push(String(node.value.name));
    const from: string = node.id;
    node = shared.find(e => e.parents[0] === from);
  }
  expect(chain.length).toBe(shared.length);
  expect(chain).toEqual(['Shared current content', 'Shared current content', 'Live delete', 'Live delete']);
  const scope: Pick<Change, 'boardId' | 'collection' | 'documentId'> = { boardId: f.board.id, collection: 'projects', documentId: f.board.id };
  expect((await f.a.reconciliation.inspect(scope)).kind).toBe('current');
  expect((await f.b.reconciliation.inspect(scope)).kind).toBe('current');
});

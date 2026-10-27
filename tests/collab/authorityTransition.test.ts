/**
 * Unit tests for the auditable authority-transition record (D1/D4): signature
 * integrity, key-binding checks, the ACL digest, and the freshness-bound
 * acceptance rule against a live ownership proof.
 */
import { expect, it } from 'vitest';
import {
  AUTHORITY_TRANSITION_FORMAT,
  TRANSITION_MIN_CLIENT_VERSION,
  aclDigest,
  sha256Hex,
  signTransition,
  transitionBytes,
  verifyTransition,
  verifyTransitionOwnership,
  type AuthorityTransitionRecord,
  type DriveOwnershipProof,
} from '../../src/collab/security/authorityTransition';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';

type Unsigned = Omit<AuthorityTransitionRecord, "signature">;

async function unsigned(overrides: Partial<Unsigned> = {}): Promise<{ value: Unsigned; newKey: StoredDeviceKey }> {
  const newKey = await generateDeviceKey();
  const value: Unsigned = {
    format: AUTHORITY_TRANSITION_FORMAT,
    boardId: 'board-1',
    previousAuthorityKeyId: null,
    previousAuthorityPublicKey: null,
    newAuthorityKeyId: newKey.keyId,
    newAuthorityPublicKey: newKey.publicJwk,
    driveFolderFileId: 'folder-1',
    driveOwnerEmailHash: await sha256Hex('owner@example.com'),
    aclDigest: await sha256Hex('acl'),
    minClientVersion: TRANSITION_MIN_CLIENT_VERSION,
    issuedAt: Date.now(),
    ...overrides,
  };
  return { value, newKey };
}

async function signed(overrides: Partial<Unsigned> = {}): Promise<{ record: AuthorityTransitionRecord; newKey: StoredDeviceKey }> {
  const { value, newKey } = await unsigned(overrides);
  return { record: await signTransition(value, newKey.privateJwk), newKey };
}

it('round-trips a signed transition and keeps the signing bytes deterministic', async () => {
  const { record } = await signed();
  expect(await verifyTransition(record)).toBe(true);
  const { signature: _signature, ...value } = record;
  expect(transitionBytes(value as Unsigned)).toEqual(transitionBytes(value as Unsigned));
  const other = await unsigned({ boardId: 'board-2' });
  expect(transitionBytes(value as Unsigned)).not.toEqual(transitionBytes(other.value));
});

it('rejects tampered records and foreign authority keys', async () => {
  const { record } = await signed();
  expect(await verifyTransition({ ...record, boardId: 'evil' })).toBe(false);
  expect(await verifyTransition({ ...record, driveOwnerEmailHash: await sha256Hex('attacker@example.com') })).toBe(false);
  expect(await verifyTransition({ ...record, signature: record.signature.slice(0, -2) + (record.signature.endsWith('A') ? 'B' : 'A') })).toBe(false);
  // Re-pointing the record at a different authority key fails the fingerprint pin.
  const stranger = await generateDeviceKey();
  expect(await verifyTransition({ ...record, newAuthorityKeyId: stranger.keyId, newAuthorityPublicKey: stranger.publicJwk })).toBe(false);
});

it('validates previous-key bindings in both directions', async () => {
  const previous = await generateDeviceKey();
  const good = await signed({ previousAuthorityKeyId: previous.keyId, previousAuthorityPublicKey: previous.publicJwk });
  expect(await verifyTransition(good.record)).toBe(true);
  // A previous key that contradicts its fingerprint is rejected even when the
  // new authority signs the inconsistency away.
  const stranger = await generateDeviceKey();
  const bad = await signTransition({ ...(await unsigned({ previousAuthorityKeyId: previous.keyId, previousAuthorityPublicKey: stranger.publicJwk })).value, previousAuthorityKeyId: previous.keyId, previousAuthorityPublicKey: stranger.publicJwk } as Unsigned, stranger.privateJwk);
  expect(await verifyTransition(bad)).toBe(false);
  // A fingerprint without the public key (or the reverse) is inconsistent.
  const half = await signTransition({ ...(await unsigned({ previousAuthorityKeyId: previous.keyId })).value, previousAuthorityKeyId: previous.keyId, previousAuthorityPublicKey: null } as Unsigned, (await generateDeviceKey()).privateJwk);
  expect(await verifyTransition(half)).toBe(false);
});

it('accepts a transition only against a fresh, matching ownership proof', async () => {
  const { record } = await signed();
  const now = Date.now();
  const proof: DriveOwnershipProof = { folderFileId: 'folder-1', ownerEmailHash: record.driveOwnerEmailHash, aclDigest: record.aclDigest, verifiedAt: now };
  expect(verifyTransitionOwnership(record, proof, now)).toBe(true);
  expect(verifyTransitionOwnership(record, { ...proof, folderFileId: 'other-folder' }, now)).toBe(false);
  expect(verifyTransitionOwnership(record, { ...proof, ownerEmailHash: await sha256Hex('them@example.com') }, now)).toBe(false);
  // A stale live read is not evidence: the ACL may have been revoked since.
  expect(verifyTransitionOwnership(record, { ...proof, verifiedAt: now - 61_000 }, now)).toBe(false);
  expect(verifyTransitionOwnership({ ...record, minClientVersion: TRANSITION_MIN_CLIENT_VERSION + 1 }, proof, now)).toBe(false);
});

it('digests the ACL order-stably, distinguishes roles, and never embeds addresses', async () => {
  const acl = [
    { id: 'p1', type: 'user' as const, role: 'owner' as const, emailAddress: 'Owner@Example.com ' },
    { id: 'p2', type: 'user' as const, role: 'writer' as const, emailAddress: 'them@example.com' },
  ];
  const a = await aclDigest(acl);
  expect(a).toBe(await aclDigest([...acl].reverse()));
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a.toLowerCase()).not.toContain('owner@example.com');
  expect(await aclDigest([acl[0], { ...acl[1], role: 'reader' as const }])).not.toBe(a);
  expect(await aclDigest([])).not.toBe(a);
});

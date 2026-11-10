import { describe, expect, it } from 'vitest';
import { fromBase64Url } from '../../src/collab/security/canonical';
import { generateWrapKey, importWrapKey } from '../../src/collab/security/keys';
import { exportBoardContentKey, generateBoardContentKey, importBoardContentKey } from '../../src/sync/bufferCrypto';
import { KEY_COURIER_INFO, MAX_ENVELOPE_BYTES, MAX_PUBLIC_KEY_BYTES, exportCourierPublicKey, importCourierPeerKey, openKeyEnvelope, sealKeyEnvelope } from '../../src/sync/operations/keyCourier';

const board = 'pboard-v2-authority-hash', otherBoard = 'pboard-v2-authority-other';

/** Three devices, as the courier knows them: sender, recipient, stranger. */
async function pair() {
  const alice = await generateWrapKey(), bob = await generateWrapKey(), carol = await generateWrapKey();
  const alicePrivate = await importWrapKey(alice.privateJwk);
  const bobPrivate = await importWrapKey(bob.privateJwk);
  const carolPrivate = await importWrapKey(carol.privateJwk);
  const alicePublic = await importCourierPeerKey(await exportCourierPublicKey(alice.publicJwk));
  const bobPublic = await importCourierPeerKey(await exportCourierPublicKey(bob.publicJwk));
  return { alice, bob, carol, alicePrivate, bobPrivate, carolPrivate, alicePublic, bobPublic };
}

describe('key courier envelope', () => {
  it('round-trips a board content key between two devices', async () => {
    const context = await pair();
    const content = await generateBoardContentKey();
    const material = await exportBoardContentKey(content.key);
    const envelope = await sealKeyEnvelope({ board, privateKey: context.alicePrivate, peerPublicKey: context.bobPublic, material });
    const opened = await openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope });
    expect(opened).toBe(material);
    // The unwrapped material is a working content key, not just a string.
    expect((await importBoardContentKey(opened)).keyId).toBe(content.keyId);
  });

  it('uses the contract construction: canonical base64url, iv ‖ ciphertext, fresh iv per seal', async () => {
    const context = await pair();
    const seal = async () => await sealKeyEnvelope({ board, privateKey: context.alicePrivate, peerPublicKey: context.bobPublic, material: 'aGVsbG8' });
    const first = await seal(), second = await seal();
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(first).not.toBe(second);
    const raw = fromBase64Url(first);
    // 12-byte IV + the 7-byte payload + a 16-byte GCM tag, and the IVs differ.
    expect(raw.length).toBe(35);
    const rawSecond = fromBase64Url(second);
    expect(raw.subarray(0, 12)).not.toEqual(rawSecond.subarray(0, 12));
  });

  it('reads padded and standard base64 without failing for the wrong reason', async () => {
    const context = await pair();
    const envelope = await sealKeyEnvelope({ board, privateKey: context.alicePrivate, peerPublicKey: context.bobPublic, material: 'aGVsbG8' });
    const bytes = fromBase64Url(envelope);
    const standard = btoa(String.fromCharCode(...bytes)); // btoa already pads: standard base64, as pasted by hand
    expect(await openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope: standard })).toBe('aGVsbG8');
  });

  it('will not open on a different board: the salt binds the envelope to one room', async () => {
    const context = await pair();
    const envelope = await sealKeyEnvelope({ board, privateKey: context.alicePrivate, peerPublicKey: context.bobPublic, material: 'aGVsbG8' });
    await expect(openKeyEnvelope({ board: otherBoard, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope }))
      .rejects.toThrow('Key envelope could not be opened');
  });

  it('will not open for the wrong device keypair', async () => {
    const context = await pair();
    const envelope = await sealKeyEnvelope({ board, privateKey: context.alicePrivate, peerPublicKey: context.bobPublic, material: 'aGVsbG8' });
    // Carol intercepts the envelope. Her private key against the sender's real
    // public key derives a different secret; and presenting a stranger's
    // public key changes the derivation again. Both fail closed.
    await expect(openKeyEnvelope({ board, privateKey: context.carolPrivate, peerPublicKey: context.alicePublic, envelope }))
      .rejects.toThrow('Key envelope could not be opened');
    const carolPublic = await importCourierPeerKey(await exportCourierPublicKey(context.carol.publicJwk));
    await expect(openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: carolPublic, envelope }))
      .rejects.toThrow('Key envelope could not be opened');
  });

  it('fails closed on tampering and garbage, and reports nothing about the plaintext', async () => {
    const context = await pair();
    const secretMaterial = 'sup3r-s3cret-key-material';
    const envelope = await sealKeyEnvelope({ board, privateKey: context.alicePrivate, peerPublicKey: context.bobPublic, material: secretMaterial });
    const flip = (value: string, index: number) => (value.slice(0, index) + (value[index] === 'A' ? 'B' : 'A') + value.slice(index + 1));
    const failures = [
      () => openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope: flip(envelope, envelope.length - 2) }),
      () => openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope: envelope.slice(0, -4) }),
      () => openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope: 'not base64 !!' }),
      () => openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope: '' })
    ];
    for (const attempt of failures) {
      // Fixed strings only: nothing here may echo the material or the envelope.
      const message = await attempt().then(() => 'opened', (error: Error) => error.message);
      expect(message).toMatch(/^Key envelope/);
      expect(message).not.toContain(secretMaterial);
      expect(message).not.toContain(envelope);
    }
  });

  it('caps decoded sizes to the server wire limits', async () => {
    const context = await pair();
    const huge = 'A'.repeat(4000); // decodes far past the envelope cap
    // Sealing an oversized payload cannot happen through the API (the material
    // is key material), so exceed the cap only where the wire accepts input.
    await expect(openKeyEnvelope({ board, privateKey: context.bobPrivate, peerPublicKey: context.alicePublic, envelope: huge }))
      .rejects.toThrow('Key envelope has an invalid length');
    await expect(importCourierPeerKey(huge)).rejects.toThrow('Courier public key exceeds the wire cap');
    expect(MAX_ENVELOPE_BYTES).toBe(1024);
    expect(MAX_PUBLIC_KEY_BYTES).toBe(128);
    // A real P-256 SPKI fits well inside the cap.
    expect((await exportCourierPublicKey(context.alice.publicJwk)).length).toBeLessThanOrEqual(128 * 4 / 3 + 4);
  });

  it('rejects public keys that are not a P-256 SPKI without echoing the value', async () => {
    await expect(importCourierPeerKey('AAAA')).rejects.toThrow(/Courier public key/);
    await expect(importCourierPeerKey('###not base64###')).rejects.toThrow(/Courier public key/);
  });

  it('keeps the contract domain separator', () => {
    expect(KEY_COURIER_INFO).toBe('pboard-key-courier-v1');
  });
});

# Collaboration encryption and authentication implementation plan

Status: proposed design, 15 October 2026. This plan describes work to implement and verify; it does not certify the current application. It applies to the browser extension and Android runtime.

The target is encrypted transport for collaboration content, authenticated peers, and permissions enforced by every receiving client. These are separate properties. Replacing `isPeerValid: () => true` addresses only one entry point and cannot establish all three.

Use this eventual product claim after completing the corresponding release gates:

> Collaboration content is encrypted in transit using HTTPS and WebRTC DTLS. Live peers authenticate with approved device keys, and receiving clients verify write permissions. Connection setup can expose network metadata. Google Drive can access the content stored through its APIs.

Do not use “all connections are encrypted without any doubt.” Ordinary STUN/ICE setup traffic is an exception, and testing cannot establish an unconditional guarantee about every device or future release. Authentication also does not make Drive snapshots end-to-end encrypted. A shorter label can say **Collaboration content encrypted in transit**, with the explanation above available nearby.

## Current implementation

| Surface | Current behavior | Required change |
| --- | --- | --- |
| Live content | `src/collab/webrtcHandler.ts` creates simple-peer WebRTC data channels | Retain DTLS; authenticate sessions before exposing them to RxDB |
| Shared snapshots and images | `src/sync/drivePermissions.ts` uses HTTPS Google API endpoints | Retain HTTPS; authenticate imported content and validate image hashes |
| Account snapshots and signaling | `src/sync/driveTransport.ts` and `accountSignaling.ts` use HTTPS | Apply account device authentication and content validation |
| Shared signaling | `src/collab/signaling.ts` exchanges ordinary JSON through Drive | Add signatures, session binding, expiry, replay protection and bounded parsing |
| Peer admission | Both pools in `src/collab/manager.ts` accept every peer through `isPeerValid` | Require a verified session context |
| Roles | Local role checks and repository mutation gates | Enforce authorization at remote read and write boundaries |
| Project scoping | `scopedPull.ts`, receive filtering and push modifiers | Keep existing scoping and add validation before sending any content |
| Development WebSocket | Caller supplies the URL with no `wss:` requirement | Reject insecure network URLs outside an explicit loopback development mode |
| ICE services | simple-peer defaults include Google and Twilio `stun:` URLs | Document metadata exposure and make configuration explicit |

The Android service imports the same `createDriveRuntime`, so it must use the same protocol and validation. Audit platform authentication, key storage and networking separately.

WebRTC data channels carry SCTP over DTLS, providing transport confidentiality and integrity ([RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)). Identity must be bound to the actual connection; an arbitrary application peer ID does not establish it ([RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html)).

## Threat model and security boundaries

Protect against a network observer, a collaborator running a modified client, a viewer attempting writes, forged or replayed signaling records, cross-board requests, and a removed device reconnecting after its authorization expires.

Assume the installed application, browser or Android runtime, operating system and private keys are uncompromised. HTTPS relies on the platform certificate trust store. An authorized recipient can copy content. An authorized editor can make undesirable edits within its permissions. Device compromise, copied data and denial of service by a Drive writer are outside the confidentiality guarantee.

Treat filenames, room names, timestamps, UUIDs, account hashes, self-reported email addresses and unsigned role fields as untrusted input. Every signaling writer can potentially alter shared records; the code convention that a peer writes only its own file is not an access-control boundary.

Trust must start outside the shared writable signaling folder. A public key read from that folder is not automatically the owner's key.

## Proposed trust architecture

### Owner approved device keys

Preserve the current architecture without adding a Pboard server by using a board owner signing authority and individually enrolled device keys. This is an architectural choice with availability costs, not a one-line validation change.

1. Generate a board authority signing key when the owner upgrades a board. Derive a fingerprint from its canonical public key. Bind the authority to a random security board ID and the exact Drive project and folder IDs.
2. Pin the authority fingerprint during an authenticated invitation or an independent verification step. A practical first implementation uses a QR code or fingerprint comparison through a trusted channel. Fetching the fingerprint from the same writable Drive folder is insufficient. This enrollment verifies an approved device; do not claim independent Google account identity verification from a typed email address.
3. Each device generates its own signing key. The owner verifies an enrollment request and grants that public key a board role. If displaying a verified account identity, add a separately reviewed account identity proof and bind it to the key; otherwise label it as an owner-approved device.
4. The authority signs a permission manifest listing device keys, roles, membership epoch and expiry. A fingerprint-pinned client accepts only manifests signed by that authority.
5. Devices sign connection setup and prove possession of their private keys. Every receiver independently validates permissions.

Use Web Crypto signing and verification, initially ECDSA P-256 with SHA-256, subject to compatibility tests on supported browsers and Android WebViews. Specify the public-key representation and the exact signature encoding. Prefer non-extractable private `CryptoKey` objects persisted through IndexedDB where supported. Non-extractability limits accidental export; it does not stop malicious code running in the application from using a key. Never place authority private keys in shared Drive data.

The board authority is separate from an ordinary editor device key. Editors must not grant roles or enroll devices. Additional owner devices require explicit authority enrollment or a reviewed delegation mechanism.

### Fresh permissions and owner availability

Proposed initial constants are a five-minute manifest lifetime, renewal after two minutes, a 30-second clock tolerance and a ten-second authentication timeout. These values are design defaults to validate, not existing behavior.

The owner must be available to renew manifests and reconcile Drive permissions. If the authority is unavailable, new sessions fail and existing live sessions close when their manifest expires. Local editing can continue as pending work; publication and live collaboration wait for authorization. Show a clear renewal status. Do not silently extend an expired manifest.

This is a significant behavior change: long-running collaboration with the owner offline requires a different authority model. If that availability is required, implement an always-available authorization service that authenticates accounts, owns membership state, issues short-lived device-bound permissions and observes Drive access changes. That introduces hosting, account authentication, credential handling and privacy work. A shared secret or a longer-lived manifest does not provide equivalent revocation.

Drive remains the content access authority. The signed device policy must never grant broader access than current Drive access. Reconcile both policies when issuing or renewing a manifest, and deny when effective Drive access cannot be resolved. Initially support direct user grants and an individual owner; explicitly reject unsupported group, domain, public-link and ownership models. Mapping approved devices to those users requires the owner's verified enrollment decision or a real account proof.

On removal or downgrade, update Drive access and the signed manifest, advance the epoch, and publish the change. Treat partial failure as an incomplete permission update and surface it. Previously issued manifests remain usable until their expiry if a malicious peer hides the new manifest. The defensible bound is the maximum remaining lifetime plus clock tolerance after renewal stops. External Drive changes add the authority's discovery delay. Never promise instantaneous revocation.

### Account synchronization

Use a separate account authority and device enrollment for the private account-order room. A shared-board viewer must never receive credentials valid for account preferences or another board. Do not use the normalized email hash as authentication.

Pin the account authority through an already trusted device or a recovery process. Restoring an unverified key from appDataFolder provides only Google-account-based bootstrap trust; describe that explicitly if chosen. Loss of all trusted devices requires recovery and re-enrollment, not automatic acceptance of arbitrary stored keys.

## Protocol objects and signing rules

Create versioned schemas before modifying the transport. Proposed types are illustrative contracts; implement runtime validation as well as TypeScript types.

```ts
type BoardPermissionManifest = {
  protocol: 2;
  boardId: string;
  driveProjectFileId: string;
  driveFolderId: string;
  authorityKeyId: string;
  epoch: number;
  issuedAt: number;
  expiresAt: number;
  devices: Array<{
    deviceKeyId: string;
    publicKey: JsonWebKey;
    role: "owner" | "editor" | "viewer";
  }>;
}; // Distributed with an authority signature over its canonical payload.

type SignedSignalPayload = {
  protocol: 2;
  boardId: string;
  collection: "cards" | "projects" | "accountOrder";
  manifestHash: string;
  epoch: number;
  fromDeviceKeyId: string;
  fromSessionId: string;
  toDeviceKeyId: string;
  toSessionId: string;
  signalId: string;
  issuedAt: number;
  expiresAt: number;
  sequence: number;
  signal: unknown;
}; // Distributed with the sender device signature.
```

Use one reviewed canonicalization implementation, such as [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html), with fixed schema restrictions. Sign a domain separator plus the canonical payload bytes. Give manifests, presence announcements, signals, session proofs, mutations and snapshots different separators. Define base64url encoding, finite integer limits, allowed algorithms, allowed key parameters and maximum sizes. Reject duplicate JSON members before canonicalization, unknown protocol versions and ambiguous encodings. Never select a verification algorithm solely from an untrusted message.

Persist the highest accepted manifest epoch and its hash. Reject rollback and conflicting manifests at the same epoch. An epoch alone cannot protect a fresh installation from a still-valid older manifest; trusted bootstrap and bounded expiry remain necessary. Check expiry on every security-sensitive action, including after sleep or background suspension. Fail closed on detected clock rollback; do not rely solely on timers.

Presence announcements also require signatures, board and room binding, a session ID, a bounded lifetime and a reference to the manifest. Otherwise forged rosters can allocate connections without authentication. Cap record size, total peers, pending signals, replay caches and verification work. A possible initial limit is 64 KiB per signaling envelope and 32 pending signals per remote session; test actual non-trickle offers before fixing production limits.

## Connection establishment

Use the following state machine in `webrtcHandler.ts`:

```text
discovered -> signalingVerified -> transportConnected
           -> mutualProofVerified -> replicationReady -> closed
```

1. Verify the authority pin and a fresh manifest. Validate a signed presence record and resolve its device role before allocating a peer.
2. Sign the complete offer or answer envelope. Bind it to both sessions, both devices, the board, collection, manifest, expiry and sequence. Verify it before passing its SDP to `peer.signal()`.
3. Preserve the existing JSEP stale-answer checks. Add replay checks scoped to device, session and direction. Reconnection creates a new random session ID; old buffered messages must not migrate to it. Bind any future trickled ICE candidates to the same signed session.
4. Once DTLS connects, exchange only bounded authentication frames. Each side signs a fresh random challenge from the other side, both session/device IDs, room, manifest hash and a hash of the ordered offer/answer transcript. Verify that the transcript covers the SDP fingerprints used for this connection. The peer's verified SDP supplies the expected DTLS certificate binding through WebRTC. If the library cannot provide a reliable transcript and transport association, add an explicit adapter rather than guessing from a peer UUID.
5. Require mutual completion before emitting `connect$` or delivering anything through `message$` or `response$`. Reject application frames received early. End the session on proof failure or timeout.
6. Store an immutable verified session context outside peer-controlled JSON. Include device identity, board, collection, transcript hash, manifest epoch, role and expiry. `isPeerValid` consults this context and rejects a peer without it.
7. Recheck current context before sending content and before applying received content. Close and clear context on logout, board switch, role change, authority change, expiry or teardown. Async completion after a generation change must not reopen a closed session.

Keep credentials out of peer messages. Never send Google access or refresh tokens as identity proof. A self-signed key proves possession only; its authority-approved enrollment establishes permission.

## Authorization and content integrity

### Every replication direction

RxDB chooses replication roles independently of board roles. A viewer can be the replication master, and content may arrive as a pull response or live stream rather than a push request. Therefore a local `push` modifier or UI edit restriction is insufficient.

Enforce the following policy at the transport and persistence boundaries:

| Action | Required authorization |
| --- | --- |
| Receive board content | Fresh approved board device with owner, editor or viewer role |
| Submit new board mutations | Fresh owner or editor grant, plus valid mutation signatures |
| Modify membership or authority | Board authority signature and the supported owner policy |
| Synchronize account order | Enrolled device under that account authority only |
| Request another board or collection | Reject, regardless of a peer's role in its own room |

Trace the installed RxDB implementation and cover `masterWrite`, `masterChangesSince`, streamed changes, pull responses, conflict results and tombstones. Wrap the appropriate handlers or introduce a verified staging layer before writes. Verification must finish before RxDB persistence or replication checkpoints advance. Invalid security data must not be silently skipped while reporting a successful batch.

Existing `scopeMasterChanges` filters catch-up reads. Also filter live outgoing streams and incoming read requests before serialization, so private documents never leave the device. Receiver-side filtering alone cannot protect an honest sender from a modified receiver.

### Signed mutations and forwarding

Sign application mutations at their origin so an honest editor cannot accidentally legitimize a forged viewer document by forwarding it. Each mutation includes board and collection, document ID, complete application payload or tombstone, author key ID, authorization epoch, a unique operation ID, author sequence and causal parent references. The signature covers all fields. Exclude RxDB-managed storage metadata from the signed application payload through an explicit schema adapter.

Store mutation provenance in the replicated schema or in an inseparable verified operation store. Verify before persistence through every import path. A viewer may relay an already verified editor mutation unchanged; it may not create one or re-sign it as an editor. Generated merges require a new authorized editor signature, or a deterministic merge with verifiable parent operations and no invented unsigned content.

Do not trust author timestamps to prove an edit predates revocation. For the first secure protocol, reject newly received mutations under expired or superseded grants unless they are already part of a verified history or authority-signed checkpoint. Pending offline edits require a current editor grant and a new publication signature; replay the user's pending change against current verified state. This deliberately trades unrestricted historical import for enforceable revocation. More permissive historical acceptance needs a separate trusted ordering or timestamp design.

Define replay and conflict behavior before coding: repeated identical operations are idempotent; conflicting payloads with the same operation ID are rejected; missing causal dependencies are bounded and quarantined; signed deletions cannot be resurrected through an older unsigned snapshot. Persist provenance and replay state atomically with accepted application data.

### Drive snapshots and images

Authentication must also cover bootstrap, periodic refresh, reconnect recovery, private backups, shared discovery and image retrieval. Otherwise a modified client can bypass live validation through a Drive file.

Use a signed checkpoint format containing the board identity, authority context, schema version, checkpoint sequence, state hash and retained mutation provenance. A checkpoint that establishes trusted board history must be authority-signed; an ordinary editor signature cannot erase author authorization checks. Keep mutable snapshot pointers separate from immutable signed content. Store the last accepted checkpoint sequence and hash and reject rollback on existing devices. Restore on a new device requires trusted bootstrap to a current checkpoint; an older signed file is not automatically current.

For images, bind the expected SHA-256 digest and MIME/size constraints into a signed card mutation or checkpoint. Hash downloaded decoded image bytes before storing or displaying them; compare with the authenticated expected digest. A hash supplied alongside an untrusted blob establishes no authenticity. Restrict supported image types and parsing limits.

Signed Drive files remain readable by Google. Their signatures provide integrity and origin verification, not additional confidentiality. A collaborator with Drive write access can still delete files or corrupt pointers and cause availability failures.

## Transport encryption policy

Centralize endpoint validation for Drive, OAuth and any future service. Require HTTPS for network content requests and WSS for network WebSockets. Restrict Google transports to their intended API origins and validate redirect behavior so credentials or payloads cannot be redirected to an insecure or unexpected destination. Test this against browser fetch behavior rather than assuming URL prefix checks cover redirects.

A development exception may allow only explicit loopback HTTP/WS endpoints. It must be disabled in release builds, visibly marked, and incapable of being activated by a received board or signaling record. In-memory test providers make no network encryption claim.

Keep WebRTC data channels on the browser's standard DTLS transport; do not add custom encryption algorithms or accept a plaintext alternative on failure. Configure ICE services explicitly rather than inheriting undocumented dependency defaults.

Ordinary STUN exchanges network addressing information and does not provide the same confidentiality as DTLS content traffic ([RFC 8489](https://www.rfc-editor.org/rfc/rfc8489.html)). ICE connectivity checks and packet headers remain observable. Restricting WebRTC to a TLS TURN relay can reduce exposure of peer addresses, but requires a separately tested relay design and does not make every protocol byte or network header encrypted. The content-in-transit claim remains the appropriate product wording.

If the intended claim includes confidentiality from Google, add a separate end-to-end encryption project covering snapshots, images, backups, preferences and key distribution. That needs per-board content keys, authenticated encryption through a reviewed library, unique nonces, device-specific key wrapping, key rotation and recovery. Signatures or DTLS alone do not deliver that property for Drive storage.

## Implementation sequence

1. **Define the protocol and compatibility contract.** Specify canonical bytes, schemas, role rules, authority enrollment, expiry and checkpoint semantics. Review the design before handling real user keys. Confirm the owner availability tradeoff or choose a service authority.
2. **Implement key and authority modules.** Suggested new files are `src/collab/security/keys.ts`, `canonical.ts`, `manifest.ts`, `enrollment.ts` and `session.ts`. Add key persistence, fingerprint verification, signed manifests and deterministic signature test vectors. Keep signing keys separate from Google OAuth storage.
3. **Secure transports and signaling.** Add endpoint policy, signed presence/signal envelopes, replay protection, protocol versioning and limits in `signaling.ts`, `drivePermissions.ts`, `driveTransport.ts` and `accountSignaling.ts`.
4. **Authenticate the handler.** Update `webrtcHandler.ts` with the admission state machine, mutual proofs, timeouts and verified session context. Update both `manager.ts` pools to reject unverified peers. Preserve reconnect and cancellation behavior.
5. **Secure every content path.** Add mutation provenance to `rxdbSchemas.ts`, repository mutation methods and conflict handling. Introduce verified replication boundaries and signed snapshot/checkpoint adapters in `snapshot.ts`, `sharedSync.ts`, shared discovery and the Drive provider. Update `imageSync.ts` and image retrieval to verify authenticated digests.
6. **Implement membership lifecycle.** Wire invitations, role changes, device removal, authority renewal and account disconnect through `runtime.ts`. Reconcile Drive access and signed policy; expose partial failures and pending authorization clearly.
7. **Migrate and verify.** Complete the attack tests and real platform checks below. Update architecture, privacy disclosures and product copy only after the relevant release gates pass.

## Migration and recovery

Use distinct version 2 rooms and an explicit secure board version so legacy clients cannot join secure replication. A received legacy offer must never trigger fallback to unsigned collaboration. Report that the other device needs an update.

The owner creates the initial signed checkpoint from explicitly reviewed existing state. Old unsigned history has no retroactive proof of authorship; preserve it as legacy backup data, not verified operations. After upgrade, reject unsigned remote snapshots and writes. Make a backup before schema migration and test interrupted migration, profile restart and rollback without downgrading a secure board to the old protocol.

Authority rotation requires a transition signed by the previously pinned authority and an explicit new pin. Recovery without the old authority requires independent verification and re-enrollment. A higher epoch or replacement key in Drive is insufficient. Define ownership transfer as a separate verified transition; do not infer it from a changed filename or a self-reported owner role.

## Verification and release gates

### Automated adversarial tests

Extend the existing collaboration, signaling, recovery, permissions, account signaling and image tests. Add security tests that assert zero unauthorized content bytes sent and zero unauthorized documents persisted, rather than merely checking a callback returned false.

| Test | Required result |
| --- | --- |
| Unknown key, self-signed enrollment or forged owner manifest | No authenticated session and no content release |
| Viewer changes its role or writes another peer's signaling file | Signature or permission rejection |
| Modified SDP, changed fingerprint or replayed answer | Handshake rejection |
| Copied proof on a new session or another board | Proof rejection |
| Viewer submits writes as master, slave, stream or conflict response | No new mutation persists |
| Honest peer forwards forged viewer content | Original mutation verification rejects it |
| Cross-board read request and live stream containing private docs | No private document is serialized |
| Tampered snapshot, stale checkpoint, missing provenance or image mismatch | No import or display of unverified content |
| Revocation, downgrade or expired grant during an active session | Content stops within the documented bound |
| Owner offline, stale policy, clock rollback and suspended tab wakeup | No authorization extension; expiry checked before content |
| Logout, board switch or delayed async verification | Old session stays closed |
| Legacy protocol, unsupported algorithm, malformed/oversized JSON and signal flood | Bounded rejection with no fallback |
| HTTP/WS endpoint or insecure redirect in release configuration | Connection rejected |
| Account-order handshake using shared-board credentials | Rejected |
| Duplicate valid operation and conflicting duplicate | Idempotent first case; rejected second case |

### Browser and Android integration

Extend `npm run test:webrtc:browser` with real device keys and the secure protocol. Test Firefox, Chromium and supported Android WebViews with two isolated profiles/devices, both replication role orderings, restarts, reconnection, background suspension and key persistence. Use real Drive accounts for owner, editor and viewer to verify permissions and revocation; current mocks cannot establish real Google behavior.

Capture a controlled session at the network interface. Use distinctive synthetic text and image bytes, correlate requests and inspect the negotiated WebRTC transport using supported browser diagnostics and the [WebRTC statistics interfaces](https://www.w3.org/TR/webrtc/). Record actual negotiated DTLS state and certificate/fingerprint association where available. Captures should show HTTPS/TLS for Google traffic and DTLS-protected data channels. Separately enumerate STUN/ICE, DNS and other metadata traffic. A packet capture alone cannot verify endpoint authorization or prove absence of every leak.

Distinguish ciphertext on the network from decrypted content visible in browser DevTools or a trusted local debugging proxy. Record browser and OS versions, application commit, dependency lockfile, test accounts and roles, network conditions and redacted results. Do not commit credentials, real user content or private keys.

Run `npm run typecheck`, `npm test`, the browser harness and the applicable build verification commands. An authentication or authorization failure must make its security test fail; it must not be accepted as an ordinary replication timeout. Obtain an independent review of enrollment, signature verification, replication boundaries and recovery before advertising authenticated permissions.

### Acceptance checklist

- [ ] Production network content transports enforce HTTPS/WSS or WebRTC DTLS with no insecure fallback.
- [ ] Every live content session has a verified authority, device proof and connection binding before RxDB sees it.
- [ ] Both board and account rooms enforce their own scoped identities and permissions.
- [ ] Every mutation/import path verifies origin, scope, authorization and provenance before persistence.
- [ ] Outgoing streams and read responses cannot serialize another board's content.
- [ ] Snapshots and images cannot bypass validation or silently restore stale unsigned state.
- [ ] Expiry, removal, downgrade, sleep and disconnect meet a measured, published revocation bound.
- [ ] Legacy clients cannot downgrade a secure board.
- [ ] Platform tests, real Drive tests, transport evidence and independent review are complete for the release.
- [ ] Public wording distinguishes content encryption, peer authentication, metadata exposure and Google-readable storage.

Passing only the transport items supports “collaboration content is encrypted in transit.” Advertising authenticated peers and enforced remote permissions additionally requires the corresponding protocol, content-integrity and lifecycle gates. End-to-end encryption requires its separate storage and key-management implementation.

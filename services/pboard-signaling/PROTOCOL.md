# Pboard experimental signaling protocols 1, 2 and 3

## Identity-only enrollment extension, version 1

Explicit, default-off server gate: `PBOARD_SIGNALING_GOOGLE_IDENTITIES=1`.
Requires board grants and the existing Google verifier. It does not change WS
protocol 2, legacy enrollment, SDP/ICE handling or room admission.

`POST /identity/challenge`, strict body `{"version":1}`, returns
`{version:1,challenge}`. The random 32-byte nonce expires after 30 seconds, is
single-use even on failed verification, and grants no access. At most 128 pending
nonces are held in RAM. Unknown fields/version are rejected.

`POST /identity/exchange` requires a transient `Authorization: Bearer` Google
access token and strict JSON:

```json
{
  "version": 1,
  "challenge": "<fresh nonce>",
  "publicKey": {"kty":"EC","crv":"P-256","x":"...","y":"..."},
  "operation": {"type":"sync","publication":null},
  "signature": "<raw P-256 r||s, base64url>"
}
```

The signature covers canonical UTF-8 JSON
`["pboard-identity-v1",challenge,publicKeyFingerprint,operation]`.
All fields in this extension are ASCII; timestamps are safe integer milliseconds.
The token is verified using Google's `about?fields=user(emailAddress)` only. An
Origin/header/email supplied by a client is never identity proof. No token is
retained. HTTP requests use existing TLS/Origin, 16 KiB body, concurrency, rate,
Google-request timeout and overall deadline gates.

`sync` optionally publishes `{policy,signature}`. Strict policy fields:
`{version:1,boardId,authority,ownerEmail,members:[{email,role}],issuedAt,expiresAt}`.
Email addresses are normalized ASCII; member roles are Editor/Viewer, with no
implicit domain/group/public access. The original root signs canonical JSON
`["pboard-identity-policy-v1",policy]`. Its owner email must equal the verified
Google identity. Policies last at most ten minutes. Scope is the existing
root-fingerprint + board ID hash. Within a retained scope, owner changes, older
issue times and same-time conflicting policies are rejected. No namespace can
replace another root's grant. Expired directory tombstones are retained another
390 seconds to reject immediate rollback. At capacity, a new valid publication
may replace only the same authenticated owner's oldest owner-only entry that
has never carried invitations or device requests in this directory lifetime.
Collaboration entries retain their rollback floor even after invitations or
requests are removed; other owners' entries are never displaced. The 16-entry
per-owner and 64-entry global bounds remain unchanged. The directory is disposable, so
clients preserve their authority pin and membership history across restarts.
The original root browser also persists its policy revision and email membership
and refuses replayed/removed invitations before approving pending devices, even
if that board is not currently selected.

`request` has only `{type:"request",request:<existing signed BoardDeviceRequest>}`.
Its board device must also sign the fresh HTTP exchange, preventing replay of a
copied public request under somebody else's identity key. The current root policy
must authorize the verified email. Requests retain the original board/root/device
signature bindings and expire within one hour. Owner requests are visible only to
the verified owner. Participants receive only boards explicitly listing their
email, or owned by it; uninvited accounts receive an empty directory.

Reply: `{version:1,email,boards:[{publication,pending:[{email,request}]}]}`.
The owner browser rechecks the root signature, identity policy and request proof,
then issues the ordinary five-minute device manifest through `/grants/publish`.
The directory/policy/Google token alone never authorize a WebSocket room. New
clients pin the root from the authenticated directory at their explicitly chosen
TLS service, verify the entire signed history and require their own key in the
current manifest. Existing pins cannot be replaced. Manual pairing remains an
alternative with independently compared fingerprints/codes.

Fixed directory caps: 64 retained scopes, 16 per verified owner, 16 invited emails
and 16 pending device requests per scope; 128 pending challenges. These bounds
are additional to the configurable global HTTP/auth/room/traffic quotas. Only
public authorization metadata is held in memory; there is no content mailbox,
server-side membership signing on this path, or new persistent account database.
The directory reveals invited email addresses to that board's participants;
requests and device/email associations are visible only to its owner. A service
restart discards this metadata, sessions and challenges; the original authority
browser must republish. The old issuer key/registry are unchanged.

## Independent board-grant metadata extension (publication version 2)

Explicit server switch: `PBOARD_SIGNALING_BOARD_GRANTS=1`. This can coexist with
the unchanged legacy Google broker. Only standalone board manifests with **both**
Drive IDs empty qualify; a partial binding/account grant cannot bypass the legacy
Google issuer policy. No Google request/token is needed for this extension.

WS protocol 2 and device challenge/response are unchanged. Each namespace is derived
from the board authority fingerprint plus topic and binding. A self-issued grant
under another authority never joins a pinned board room. The clients retain the
existing signed signaling and DataChannel mutual proof before RxDB replication.

First `POST /grants/challenge` with `{"version":2}` obtains
`{version:2,challenge,expiresAt}`. The nonce expires after 30 seconds and is consumed
on one verification attempt. No board membership is granted by this endpoint.

`POST /grants/publish` accepts strict JSON (unknown/duplicate fields rejected):

```json
{
  "version": 2,
  "challenge": "<fresh server challenge>",
  "authoritySignature": "<fresh authority signature>",
  "bundle": {
    "version": 1,
    "authority": {"kty":"EC","crv":"P-256","x":"<base64url>","y":"<base64url>"},
    "history": [{"payload":"<base64url canonical manifest bytes>","signature":"<authority signature>"}]
  },
  "deviceKeyId":"<member fingerprint>",
  "signature":"<member signature>"
}
```

History is ordered by increasing epoch and bound to one authority/board. Every
entry has a valid `pboard-manifest-v2` authority signature. The last entry must be
fresh and list the publisher key; its device signs the UTF-8 JSON array
`["pboard-ws-auth-v2","publish","publish",room,deviceKeyId,manifestDigest]`, using
the usual cards-room name and exact current-manifest digest. Publication requires
no reusable server secret. Additionally `authoritySignature` is raw P-256/SHA-256
`r||s` in base64url over the UTF-8 JSON array
`["pboard-grant-publish-v2",challenge,authorityFingerprint,boardId,manifestDigest]`.
Only the board authority can publish/restore history, including after restart.
A captured publication or member proof cannot restore an older grant. Unknown,
expired, reused or invalid challenges/signatures fail closed; old static version-1
publications are rejected. Clients must reload the updated provider. Bundle/read
version 1 and WS protocol 2 remain unchanged. Higher epochs invalidate both board
collection rooms; history cannot fork, truncate or replace accepted entries.

Response: `204`, or fixed redacted error code with `400/403/404/429`. No private
payloads or raw validation errors are logged. Configurable HTTP, history, cache,
verification and traffic budgets are documented in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).
There is one blocking publication verification worker. Source authority/history
must not be cleared as a retry strategy. Limits are not measured capacity claims.

`GET /grants/<scope>` returns `{version:1,authority,history}` with `Cache-Control:
no-store`, or `404`. `scope` is base64url SHA-256 of UTF-8
`JSON.stringify(["pboard-board-grants-v1",authorityFingerprint,boardId])`.
This is public authorization metadata: public keys, board ID, roles and issue/expiry
times. The locator is not a board authorization credential. No emails, images,
documents, OAuth credentials or private keys belong in this protocol. Browsers
verify against their independently pinned authority, exact board/empty binding,
append-only local history, monotonic epochs and their current device membership.

Cache entries become unreadable at grant expiry and are pruned after an additional
390 seconds on publication. Restart loses all cache/room state. The original
authority browser republishes its locally retained signed history and renews when
needed. Standalone WS admission requires the current authority-published cache entry; it
fails closed after restart until fresh authority-signed republication. A member
with a captured old grant cannot repopulate that cache. Legacy Google admission
also requires the latest manifest in its existing persistent issuer registry. No
asynchronous board mailbox, contents storage or backup is provided by the relay.

## Earlier protocol modes

The optional Google enrollment extension below restricts protocol 2 to its own
Google-verified authority. The general self-signed namespace and legacy-grant modes
remain available when Google enrollment is disabled, as in earlier local milestones.

Protocol 2 is the current experimental client transport. Protocol 1 below remains
available for existing explicitly configured operator grants. Neither changes the
collaboration protocol, WebRTC DataChannel authentication or RxDB storage.

## Protocol 2: automatic signed admission

The server explicitly enables this mode with `PBOARD_SIGNALING_AUTOMATIC_ADMISSION=1`
(standalone default: 0). Its welcome retains `version:1` for legacy clients and adds
`supportedVersions:[1,2]`. A proof-based client requires 2 and never downgrades to 1.
No application header, extension ID, User-Agent or embedded secret grants access.
Anyone implementing this protocol may create their own authorized namespace; it
does not attest that their executable is an official Pboard build.

The client obtains an existing signed manifest only after verification against its
independently pinned board/account authority and Drive binding. It sends:

```json
{
  "type": "authenticate", "version": 2,
  "room": "pboard-v2-AUTHORITY_FINGERPRINT-ROOM_HASH",
  "deviceKeyId": "DEVICE_FINGERPRINT", "signature": "CHALLENGE_SIGNATURE",
  "authorization": {
    "topic": "pboard-collab-BOARD-cards",
    "authority": {"crv":"P-256","kty":"EC","x":"BASE64URL_X","y":"BASE64URL_Y"},
    "manifestPayload": "BASE64URL_CANONICAL_MANIFEST_PAYLOAD_BYTES",
    "manifestSignature": "BASE64URL_AUTHORITY_SIGNATURE"
  }
}
```

The existing manifest payload has exactly `protocol`, `boardId`,
`driveProjectFileId`, `driveFolderId`, `authorityKeyId`, `epoch`, `issuedAt`,
`expiresAt` and `devices`. Each device has exactly `deviceKeyId`, `publicKey`
and `role` (`owner`, `editor`, `viewer`). Public keys contain exactly `crv,kty,x,y`.
No private key, account email, Google token, board document or image is included.
The browser rejects unexpected fields before transmitting the proof.

The authority signature covers the existing bytes:
`UTF8("pboard-manifest-v2") || uint32LE(payloadByteLength) || payloadBytes`.
Clients send the existing canonical JSON bytes; the server verifies those exact
bytes without cross-language reserialization. Typed parsing rejects duplicate or
unknown fields. Payload limit: 65,536 decoded bytes; normal 96-KiB frame/message
limits still apply to the whole authentication message.

Let `H` mean unpadded base64url SHA-256, and `J` compact UTF-8 JSON encoding of an
array of ASCII strings. Existing key fingerprints are unchanged. Derive:

```text
roomHash = H(J(["pboard-ws-room-v2", topic, driveProjectFileId, driveFolderId]))
room = "pboard-v2-" + authorityFingerprint + "-" + roomHash
manifestDigest = H(payloadBytes)
challengeBytes = J(["pboard-ws-auth-v2", challenge, transportSession,
                    room, deviceKeyId, manifestDigest])
```

`signature` is raw ECDSA P-256/SHA-256 `r||s` over `challengeBytes`, encoded as
base64url. It proves possession of the enrolled device private key and binds that
proof to the fresh challenge, session, namespace and exact manifest. A captured
proof is unusable on a new connection or with another manifest.

The server verifies the authority fingerprint/signature; all public keys and device
fingerprints; distinct device entries (1–64, at least one owner); current expiry;
member inclusion; the device challenge; and the derived room. Board topics must
match the signed board ID and end in `cards` or `projects`; both Drive IDs must be
nonempty in the legacy bound mode. Explicit independent board-grant mode requires
both empty and a current authority-published cache entry. Account topics must match the signed `account:<hash>` and end in `order`,
with both Drive IDs empty. IDs are 1–200 ASCII letters/digits/hyphens/underscores;
topics remain at most 240 characters. Integers must fit JavaScript's safe range.
Issued-at allows 30-second future clock skew; expiry has no server grace. Maximum
lifetime is 360 seconds (the existing five-minute default plus protocol tolerance).

A client-provided authority is authoritative **only for its own derived namespace**.
It cannot impersonate a different authority or gain admission to that authority's
board/account room, even with the same board ID. The server makes no claim to verify
Google ACLs: Pboard still verifies Drive permissions and pins at enrollment/runtime.
Protocol-1 grants cannot authorize reserved `pboard-v2-` rooms.

### Observed revocation and bounds

The server caches the highest verified epoch and payload digest per authority and
signed board/account/Drive binding. Cards and projects share this scope. Lower
epochs and conflicting payloads at the same epoch receive `authorization_stale`.
A higher epoch invalidates existing scope sessions (`authorization_changed`), even
in the other collection room; stale members are excluded from rosters/forwarding.
Clients stop and require a fresh runtime context rather than retrying stale proofs.

This cache is in memory only and keeps no board contents, private keys or Google
credentials. It is bounded to 1,024 unexpired scopes; expired entries are pruned on
admission. By default at most 32 authentication attempts per global one-second window
are allowed before expensive crypto. Scope/verification exhaustion returns
`server_busy`; clients back off. Existing connection, frame, room, idle and queue
limits remain. The deployed HAProxy additionally bounds per-IP request rates.

**Limits:** revocation is effective after the server observes a newer signed epoch.
An unobserved revocation may permit a still-current proof until its short expiry.
Independent admission after restart requires fresh authority publication; legacy
Google proofs must match its persisted current registry manifest. Clients independently persist their accepted epochs
and still enforce signed presence, mutual DTLS proofs and receiving mutation guards.
There is no durable revocation directory, universal account system, attestation of
official apps, automatic manifest renewal or protection against every distributed
resource-exhaustion attack in this experiment. Open admission is not a capacity claim.

### Restricted signaling payloads

The outer `signal` envelope is preserved. Version 2 requires the existing signed
`pboard-presence` or `pboard-signal-v2` envelope, verified against authenticated
membership, current manifest, collection, source/target logical sessions and expiry.
Signal IDs are replay-checked. Only DataChannel offer/answer SDP, bounded ICE
candidates and `{renegotiate:true}` are allowed inside signed signals. Arbitrary
JSON, board documents, image blobs, media SDP, custom SDP attributes, unknown fields,
duplicate JSON members and nesting beyond 16 levels are rejected. Operator-grant
protocol 1 accepts only the same bounded negotiation shapes as raw `data`.
The service never fetches ICE/SDP addresses or implements an application proxy.
Valid SDP/ICE can carry a bounded covert channel; this is not executable attestation
or a guarantee against colluding authorized endpoints. See the security audit for
exact quotas and transport policy.

After authentication, join/leave, directed signal, presence, heartbeat, disconnect
and reconnect semantics are the same as protocol 1. Peers must all use the new
client to meet in authority-derived rooms; old raw-topic rooms remain isolated.

## Protocol 1: retained operator-grant admission

This protocol is separate from collaboration protocol 2. It transports protocol-2
signed signaling envelopes unchanged. It is not compatible with the older RxDB
`init/join` WebSocket protocol in `src/collab/signaling.ts`.

Connect to `/ws` over WSS, or explicit loopback WS during development. The HTTP
upgrade opens an unauthenticated challenge socket; no presence, membership or
payload forwarding is available until authentication succeeds. Tokens, private
keys and Google credentials never travel in URLs. `/healthz` returns `ok` and no
membership details.

All messages are UTF-8 JSON objects with a `type`. Client messages reject unknown
fields and unsupported types. Version is negotiated as exactly 1 at authentication.
Room identifiers are 1–240 ASCII letters, digits, hyphens or underscores. The
application uses the existing exact topics:

- `pboard-collab-<projectId>-cards`
- `pboard-collab-<projectId>-projects`
- `pboard-account-<accountHash>-order`

The server does not interpret board IDs. An operator explicitly authorizes each
exact topic/device pair; knowing a topic confers no access. A connection joins
one room, and a device can have one joined session per room. Cards/projects/account
rooms therefore use independent connections.

## Admission and identity

The server loads a required, local, public-only grants file once at startup:

```json
{
  "rooms": {
    "pboard-collab-BOARD-cards": {
      "DEVICE_FINGERPRINT": {
        "publicKey": {"kty":"EC","crv":"P-256","x":"BASE64URL_X","y":"BASE64URL_Y"},
        "expiresAt": 1800000000000
      }
    }
  }
}
```

This schematic example intentionally cannot authenticate anyone. Replace entries
with explicitly approved public keys and a deliberate expiry in epoch milliseconds.
Keys must be valid P-256 points; fingerprints must match existing pboard SHA-256
fingerprints of canonical public JWK bytes (sorted ASCII properties
`crv,kty,x,y`). Invalid keys, fingerprints and room structures fail startup. Maximum
1,024 configured rooms, 64 grants per room. Never copy private JWK `d` or OAuth
tokens into this file.

An empty top-level `rooms` map is a valid deny-all configuration. Expired grants
may remain in the configuration across restarts; authentication and active sessions
always enforce their expiry. This lets a persistent service stay healthy without
authorizing any peer. `--check-config` validates the configured file without binding
a listener. Replacing the grants file requires a service restart.

Admission flow:

1. Server → `{"type":"welcome","version":1,"challenge":"…","session":"…"}`.
   Challenge and transport session are independent 256-bit random values.
2. Client signs the exact UTF-8 JSON array, without spaces:
   `["pboard-ws-auth-v1",challenge,session,room,deviceKeyId]`.
   All elements are strings; this array avoids cross-language object canonicalization.
   Use ECDSA P-256/SHA-256, raw 64-byte `r||s`, base64url without padding, matching
   pboard's existing `signBytes()` and device keys.
3. Client → `{"type":"authenticate","version":1,"room":"…","deviceKeyId":"…","signature":"…"}`.
4. Server checks the configured grant, expiry, fingerprint and proof against its own
   challenge/session. It never accepts a client-provided verification key.
5. Server → `{"type":"authenticated","peerId":"DEVICE_FINGERPRINT","session":"…"}`.
6. Client → `{"type":"join"}`.
7. Server → `{"type":"joined","peers":[{"peerId":"…","session":"…"}]}`.
   Only other joined members of the same room appear.

Authentication must finish within 10 seconds. Challenges cannot be reused on a new
connection or after restart; repeated authenticate messages fail. Duplicate joined
device sessions are rejected rather than evicting the existing session. A reconnect
retries with backoff until the old socket closes/expires. All grants are enforced
throughout a session, not just at join. Expiry is checked on forwarding and by a session expiry deadline. Grants are operator trust, not a replacement for board-owner manifest trust.

## Presence and forwarding

- Server → `{"type":"peer_joined","peerId":"…","session":"…"}`.
- Server → `{"type":"peer_left","peerId":"…","session":"…"}`.
- Client → `{"type":"signal","to":"…","session":"TARGET_TRANSPORT_SESSION","data":{…}}`.
- Server → `{"type":"signal","from":"AUTHENTICATED_FINGERPRINT","session":"SENDER_TRANSPORT_SESSION","data":{…}}`.
- Client → `{"type":"ping"}`; server → `{"type":"pong"}`.
- Client → `{"type":"leave"}`, or close the socket.
- Server → `{"type":"error","code":"…"}`, then close for protocol/admission/limit failures.

`data` has the restricted signaling schemas defined above. Accepted payloads are
forwarded unchanged after validation. The server supplies sender identity; clients
cannot choose or impersonate `from`. The target
must be joined in the same room, unexpired and match its current transport session.
Transport sessions are distinct from protocol-2 device sessions; they do not replace
the latter's checks. Clients discard signals from absent or stale transport sessions.
No offline delivery, durable queue, acknowledgement or automatic retransmission is
provided. WebRTC handles retransmitted/restarted negotiations through its existing code.

## Limits and lifecycle

Defaults: 128 sockets globally, 16 peers per room, 128 rooms, one room per
connection, 96 KiB per WebSocket frame/message, 60 incoming messages and 128 KiB
per socket per fixed one-second window, 4 MiB per socket per rolling 60-second
window plus 2 MiB per attached room per rolling 60-second window (both are renewed,
not accumulated — they replace the retired 4 MiB lifetime total), 512 signals per
socket lifetime, 45-second inbound idle timeout, 10-second authentication
timeout. The operator knobs are `PBOARD_SIGNALING_MAX_SESSION_WINDOW_BYTES` and
`PBOARD_SIGNALING_MAX_ROOM_WINDOW_BYTES`;
`PBOARD_SIGNALING_MAX_SESSION_BYTES` is retired and ignored if still present in an
environment file. See
[the security audit](SECURITY_AUDIT.md#default-resource-policy) for all configurable
aggregate, HTTP, replay and history budgets. Browser heartbeat: 15 seconds. Outbound
queues hold at most four messages per connection. Queue overflow closes affected
sessions; forwarding overflow closes the sender. Socket sends have five-second
deadlines. Read buffers are at most 16 KiB; the write buffer flushes immediately,
with a maximum buffer twice the configured message limit.
Binary frames and WebSocket control frames other than closing are not application
messages; use JSON ping for application heartbeat. Control frames are handled at
the protocol layer and never close a session: a browser keep-alive-pings an idle
socket by itself, and those pings and their pongs are neither protocol errors nor
charged against the message or byte budgets. A Binary frame closes the connection.
There is no compression or persistent signaling state.

Peer departure removes only that exact transport session. Empty rooms are removed.
Server shutdown closes sessions; process restart forgets all challenges/membership.
The adapter reconnects with exponential backoff (500 ms base, 30-second nominal cap,
±25% jitter), reauthenticates and rejoins. Permission/expiry errors stop retries;
duplicate/full-room errors retry. Existing secure WebRTC/RxDB admission remains
mandatory and has separate blockers described in the architecture note.

Logs contain event/reason only, never SDP/ICE, room names, peer keys, signatures,
board data or Google credentials. Payloads exist only transiently in bounded relay
queues. Arbitrary application JSON is rejected; colluding authorized peers may
still encode a bounded covert channel within valid SDP/ICE fields. Origin checks
are defense in depth, never authentication. Public deployments require WSS through
a TLS proxy which overwrites forwarded-protocol headers; Rust binds loopback only.

## Milestone 0.2 application integration

The application forwards signed presence through
`data: {"kind":"pboard-presence","envelope":…}` messages. This shape is now verified
by the hardened protocol-2 relay before forwarding. It broadcasts the
latest presence to newly joined/rejoined peers. Receivers verify presence against
locally pinned manifests before addressing SDP to the actual remote protocol-2
session. The relay's transport session and the signed protocol-2 session remain distinct.
Drive uses its existing optional `security.presence` record for the same purpose.

After DTLS connects, peers issue `sessionChallenge` frames over the DataChannel and
sign a `sessionProof` answering the **remote** challenge, bound to the actual sessions
and SHA-256 offer/answer transcript. Both proof verification and sending the reciprocal
proof must finish before admission to RxDB. No content travels in relay presence.
The common handler restricts authenticated RxDB requests to token/catch-up/write
operations, bounds batches, and rejects cross-room writes/private-document ID collisions.
These messages travel only in the DataChannel, never through this relay protocol.


## Optional Google enrollment extension (HTTP v1, milestone 0.4)

Explicit settings `PBOARD_SIGNALING_GOOGLE_EMAILS` (CSV exact normalized emails),
`PBOARD_SIGNALING_AUTHORITY_KEY` (32 raw secret bytes) and
`PBOARD_SIGNALING_ENROLLMENT_STATE` enable a build-pinned server authority.
`--generate-authority PATH` creates a new key exclusively (never overwrites),
`--public-authority` exports only its public P-256 JWK with those settings, and
`--check-config` verifies loadable configuration/history. This mode restricts WS
protocol 2 to this authority and disables protocol-1/manual/self-signed room access.
Defaults and the legacy protocols remain unchanged when this mode is unconfigured.

1. `POST /experiment/challenge` with `{}` returns `{"challenge":"BASE64URL_32_BYTES"}`.
   Challenges expire after 30 seconds; at most 256 are pending. The existing global
   authentication rate limit applies. Challenge possession alone authorizes nothing.
2. `POST /experiment/enroll` uses `Authorization: Bearer ACCESS_TOKEN` and a JSON body:
   `challenge`, `kind` (`account` or `board`), `scope`, `driveProjectFileId`,
   `driveFolderId`, `publicKey` (public P-256 JWK only) and `signature`.
   Unknown/duplicate fields and bodies over 16 KiB are rejected.
3. `signature` is raw P-256/SHA-256 r||s, base64url, over UTF-8 JSON array:
   `["pboard-google-enroll-v1",challenge,deviceFingerprint,kind,scope,fileId,folderId]`.
   The challenge is consumed once even on failure. Verify key possession before
   contacting Google. Four verification requests may run concurrently; fixed Google
   HTTPS GETs have four-second request timeouts and a twelve-second outer timeout.
4. Google `about?fields=user(emailAddress)` authenticates the account. The exact
   normalized email must be allowlisted. Account scopes are its SHA-256 lowercase
   hex hash with empty file/folder IDs. Board scopes bind a `project.json` JSON file
   to its actual non-trashed parent folder named after the board ID. Folder ACLs
   establish explicit-user owner/editor/viewer roles; write capabilities of both
   folder and project file are checked for writers. No document media is requested.
5. Success returns `authority`, `deviceKeyId`, `manifest` (the existing signed
   protocol-2 shape), and `history` (at most 256 signed manifests for that binding).
   No email or token appears in this response. The first device must be a verified
   owner. Subsequent devices join after Google role verification. Roster/role changes
   or fewer than two minutes remaining advance the epoch and issue a five-minute
   grant; otherwise return the identical current grant. No persistence write occurs
   when the grant/roster is unchanged. Public-key ownership cannot cross accounts.
6. The client verifies every new history signature against its **build pin**, checks
   binding/current membership/role/expiry, rejects history forks and epoch rollback,
   and then uses the unchanged version-2 WS challenge/response and DataChannel
   mutual proofs. Ten-second existing role polling refreshes enrollment and restarts
   changed pools; history permits originally valid signed edits after renewal while
   current author membership and role still gate them. Only the first owner may
   attest initial unsigned local data. Other owner profiles receive signed data.

Responses use `Cache-Control: no-store`. Failed checks return a fixed error code
(e.g. `email_not_allowed`, `google_token_rejected`, `board_access_denied`,
`drive_binding_invalid`, `owner_must_connect_first`, `history_capacity`) with 403;
body/format errors use Axum 4xx and saturation uses 429. Clients expose fixed
context plus the bounded code, never Google response bodies. Refresh tokens are
never sent. No credentials are put in URLs, query parameters, WS signaling frames,
configuration metadata or logs. The authority scalar and bounded public enrollment
registry survive service restarts; active rooms, challenges and WS sessions do not.
This is a deliberate exception to earlier entirely in-memory signaling state, not
board persistence. Protect and recover the key/registry together; do not reset epochs.

Google metadata contracts: [about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get),
[files fields and capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[Drive roles](https://developers.google.com/workspace/drive/api/guides/ref-roles).

## Google service admission (Job 8)

Independent board grants on a Google-enabled service additionally require a
Google-verified, single-use service receipt. This does not authorize any board.
The public binary fails startup without the required verifier/identity settings.
Local cryptographic-only loopback fixtures and the legacy Google broker retain
their documented authentication paths.

1. `welcome` includes `requiresServiceAdmission: true`, its existing random
   `challenge` and `session`.
2. Obtain a fresh `/identity/challenge` (existing version 1). POST
   `/identity/exchange` with the existing Bearer token, actual board-device
   `publicKey`, and this operation:

   ```json
   {"type":"admit","challenge":"WS_CHALLENGE","session":"WS_SESSION","room":"DERIVED_BOARD_ROOM"}
   ```

   Sign the existing canonical JSON bytes
   `["pboard-identity-v1", HTTP_CHALLENGE, deviceFingerprint, operation]`
   with that board-device private key. Both the HTTP nonce and device signature
   are checked before Google verification. HTTP limits remain applicable.
3. A valid identity returns `{"version":1,"admission":"RANDOM_RECEIPT","expiresAt":NUMBER}`.
   This operation creates no invitation/policy/member. A grant must already exist.
4. Include `serviceAdmission: "RANDOM_RECEIPT"` in the existing `authenticate`
   message, alongside its unchanged version 2 board authorization and challenge
   signature. Neither Google token nor email goes in a signaling frame.

The receipt must be consumed within 30 seconds, once, by the exact bound
challenge, socket session, room and device. Wrong bindings consume/reject it;
expired/absent proofs return `service_auth_required` or `service_binding_invalid`.
The session expires at the earlier of service admission (five minutes) or board
manifest expiry. Reconnect needs fresh HTTP and WebSocket challenges. Receipts
are memory-only, bounded by `MAX_REPLAY_ENTRIES`, and lost on restart. No board
content is accepted in an `admit` operation; unknown fields remain rejected.

A Google receipt alone, even correctly bound, fails without the independent
current board manifest, root/cache validation and device signature. No protocol
version downgrade or unrestricted room fallback is permitted. Clients missing
this feature fail closed against the new public service. New clients retain
compatibility with older services that do not advertise this additive gate;
server hardening takes effect only after a separately authorized deployment.

## Sync v3: durable operation log over the authenticated connection

2 November 2026. Implemented; inert unless the service is started with
`PBOARD_SIGNALING_SYNC_DIR`, because a relay that cannot store an operation must
not acknowledge one. Design rationale and the layer contract live in
[`docs/architecture/websocket-operation-log.md`](../../docs/architecture/websocket-operation-log.md).

`/ws` already proves a device key against a challenge, carries the board's
admission proof and expiry, and drops the connection when that authorization
changes. Sync v3 reuses that connection instead of adding an endpoint: a second
transport with a hand-copied authorization path is how one transport ends up
enforcing roles while the other does not.

### Identity

Three identifiers, not interchangeable. `board` is the room the connection was
admitted to; every frame naming another board is refused with `board_mismatch`
rather than re-scoped, so cross-board reads and writes are impossible rather than
merely unauthorised. `actorId` is the authenticated device key id and is stamped
by the server — a client can never submit as another actor. `session` is one TCP
connection, minted in `welcome`; fan-out is keyed by it, so two tabs of one
browser or one account on two machines are separate sessions that share a cursor
neither displace each other.

### Frames

Request: `{"type":"sync","request":{"action":…}}`. Unknown request fields are
tolerated (a newer client is not an attack); unknown fields inside a submitted
operation envelope are rejected, because a silently ignored field would change
what an operation means.

| Action | Reply | Payload |
| --- | --- | --- |
| `subscribe` `board, afterSeq` | `window`, or `snapshotRequired` when the requested point predates the log | `operations[]` ascending, `liveFromSeq`, `checkpointSeq`, `synced`, `gap` |
| `submit` `board, operations[{opId,protocolVersion,logicalClock,payload}]` | `accepted` | `results[{opId,seq,duplicate}]`, `ackedSeq` |
| `lease` `board, leaseMs?` | `lease` | `holder`, `epoch`, `expiresAt` |
| `release` `board` | `released` | holder only; a non-holder's release is a no-op |
| `commit` `board, epoch, seq, snapshotSeq, driveEtag` | `committed` | `checkpointSeq`, `epoch`, `snapshotSeq`, `stale` — `driveEtag` is a **publication receipt** (the Drive file id of the uploaded immutable snapshot), not an entity tag; the name is kept for wire compatibility. See *What `commit` evidence actually is* below. |
| `status` `board` | `status` | `nextSeq`, `oldestRetainedSeq`, `retainedOperations`, `checkpointSeq`, `snapshotSeq`, `checkpointStale`, `leaseEpoch`, `leaseHolder`, `leaseExpiresAt` |

Broadcast: `{"type":"sync","action":"operation","board":…,"seq":…,"opId":…,
"actorId":…,"protocolVersion":…,"logicalClock":…,"payload":…}` goes to every
subscriber of the board **including the author**, who must tolerate receiving its
own operation. Replies are queued before the broadcast is published, so a peer
never learns of an operation before its author has been told it is durable. A
duplicate submission answers `duplicate: true` with the original `seq` and
broadcasts nothing.

`gap.reason` is `snapshot_required` (with `checkpointSeq`, `checkpointEpoch`,
`snapshotSeq`) when the operations the client needs were pruned because a
published snapshot covers them, or `history_unavailable` (with
`oldestRetainedSeq`) when the log simply does not go back that far. A short list
is never offered in place of a gap.

### Durability and ordering

`seq` is assigned by the server inside the append transaction and is the only
ordering the protocol offers; `logicalClock` is stored and echoed for diagnostics
and never ordered by, exactly like wall-clock time. SQLite runs WAL with
`synchronous = FULL`, and the acknowledgment is queued only after the transaction
commits. Dedupe consults `(board_id, op_id)` *before* a sequence is consumed, so a
retry neither stores a second row nor burns a sequence.

Replies carry no request id. A connection answers **exactly one reply per
request, in the order the requests arrived**, and that is the whole correlation
contract: a client attributes each reply to its oldest outstanding request, and a
reply that arrives with nothing waiting — or nothing arriving while something is —
means the connection is broken and must be rebuilt rather than resynchronized.
`answers_pipelined_requests_in_order_with_exactly_one_reply_each` pins it, because
a misattributed acknowledgment is an edit believed saved when it is not.

### Leases, fencing and commit evidence

One writer at a time may publish a board's consolidated snapshot. `lease` grants a
time-bounded lease and a fencing epoch taken from a per-board counter that only
increases, so epochs survive a restart and are never reused. `commit` requires the
presented epoch to be the one the board issued **and** the writer to be the device
it was issued to: an epoch is a reference to a lease, not a bearer token, and
epochs are small integers. Repeating a commit under a still-held lease is a
recovery path and answers idempotently; a writer whose epoch was superseded is
refused with `lease_expired`.

A snapshot generation that is not strictly newer is accepted and reported
`stale: true`. Drive has no hook for our epoch, so an upload already in flight
cannot be blocked — the next leader watermark-merges before publishing. Strict
prevention would mean publishing through the server, which changes the trust model
and is not part of this protocol.

### Key courier

Two devices of one account must agree on a board's AES content key without the
relay ever learning it. Each device publishes an ECDH wrap key; a device holding
the content key stores an envelope sealed to a peer's wrap key; the peer fetches
what is addressed to it. The service stores opaque base64 blobs it cannot open:
it validates size and shape only, holds neither a plaintext nor any key that
opens one, and echoes stored strings byte-for-byte. Authorization is the
connection's existing board admission; the writer-role rule does not apply,
because a courier frame mutates no operation log — refusing one would deny a
device the board's content key without protecting anything.

| Action | Reply | Payload |
| --- | --- | --- |
| `publishDeviceKey` `board, publicKey` | `deviceKeyStored` | `stored` — `false` only when the identical key was already stored (an idempotent retry) |
| `listDeviceKeys` `board` | `deviceKeys` | `devices[{deviceKeyId,publicKey}]` — every device that published for this board, caller included, no device of any other board |
| `publishKeyGrants` `board, grants[{deviceKeyId,envelope}]` | `keyGrantsStored` | `stored` — count of envelopes; a refused batch stores none |
| `fetchKeyGrants` `board` | `keyGrants` | `grants[{fromDeviceKeyId,envelope}]` — only rows addressed to the connection's authenticated `deviceKeyId` |

`publicKey` is a base64 P-256 SPKI, at most 128 bytes decoded; `envelope` is an
opaque sealed blob, at most 1024 bytes decoded. Canonical encoding is unpadded
base64url, as every other id in this protocol. The author of a grant is the
authenticated device — never a body field — and `fetchKeyGrants` selects by it,
so one device cannot read another device's mailbox even on the same board.

Refusals answer `error` with the reason and store nothing:
`envelope_too_large`, `public_key_too_large`, `batch_too_large` (empty, or more
than 32 grants), `too_many_device_keys` (the board already holds 64 wrap keys,
and a sixty-fifth is refused rather than an old one evicted), `invalid_request`.
Caps apply to decoded bytes; a batch containing one oversized envelope is
refused whole, never truncated. Envelopes are keyed by sender and recipient and
*replaced*, not appended, so re-wrapping a rotated key cannot grow the tables.
Key rows are never pruned with the operations they outlive; the caps are the
whole bound. Revoking a departed device's already-delivered content keys is out
of scope; rotation is a separate decision.

### Limits

Per connection: submit batch and operation size derived from the existing message
budget; replay at most 512 rows per frame by default. Clients can request `limit: 128`
and must request subsequent pages until
they reach the first response's `liveFromSeq - 1`. Per board: 200 000 operations, 64 MiB. Global:
512 MiB. A batch that would exceed capacity is refused whole, because accepting
part of a batch leaves a client with an acknowledgment it cannot retry
idempotently. Live subscribers that cannot drain are dropped, never waited on.

### Tests

`tests/sync.rs` (14) drives real WebSockets: two sessions of one device, replay
into a live subscription, dedupe across connections, acknowledgment surviving a
service replacement, cross-board refusal, lease contention and stale-commit
refusal, batch limits, status, and the courier's publish/list/grant round trip,
cross-device mailbox isolation, cap refusals and admission scope.
`src/sync_log.rs` (27), `src/sync_api.rs` (19) and `src/key_courier.rs` (9)
cover sequence allocation, gaps, publication-evidence validation, retention
anchored per segment, pruning safety (including a row older than the window that
no snapshot covers), the capacity wedge and its recovery, fencing, the read-only
rule, and the courier's replace-not-append, shared-schema migration and
per-board caps. `tests/sync.rs` also drives a pruned prefix over a socket and
asserts `snapshotRequired` rather than a short window.

## Sync v3: retention, publication evidence and pruned history

This section replaces the previous claim that commit evidence is an "etag" and
records what the retention path now guarantees, because it is enabled. Nothing
here changes a frame: the wire shapes in *Frames* above are untouched and a
deployed client keeps working byte for byte.

### What `commit` evidence actually is

`driveEtag` is a **publication receipt**: the Drive file id of the immutable
snapshot the writer says it uploaded. It has never been an entity tag — the
client takes `.id` from the listed snapshot file
(`logConsolidationRuntime.ts`, `find`/`upload`) — and the name is kept only so no
client has to change.

The relay holds no Drive credential, so it **cannot** verify that the file exists,
is readable, or contains the operations the commit claims. No server-side check
of the upload is possible without giving the relay the authority it exists to not
have. What the service can and now does enforce, at the commit boundary:

| Rule | Refusal |
| --- | --- |
| **Server-validated provenance** (`checkpoint.evidence_kind = 1`, set only by the commit path) | `evidence_rejected` never; the row simply is not a pruning licence |
| Evidence present | `evidence_rejected` with `missing publication evidence` |
| At most 256 bytes | `evidence_rejected` with `publication evidence too long` |
| Only `[A-Za-z0-9_-]`, at least 4 bytes | `evidence_rejected` with `publication evidence is not a Drive file id` |
| `snapshotSeq` non-zero | `evidence_rejected` with `publication evidence names no generation` |

A refused commit writes nothing: no checkpoint row, no coverage row. The
validated file id — not the raw frame string — is what is stored, so every later
reader sees a value this service has already accepted once.

Shape alone is not evidence of provenance: `etag` is four URL-safe characters and
would pass any syntactic test, yet it is exactly what the old protocol stored
without checking. So the checkpoint row also carries `evidence_kind`, written to
`1` only by this commit path and only after the parser accepted the value. A row
from before schema version 3 keeps `0` and is never a pruning licence — the board
becomes prunable again only when its committer publishes once under this build.

The one thing that makes the receipt meaningful is **client ordering**: the
snapshot is uploaded to Drive before the commit is sent, so `commit` can only
arrive after `publishLogSnapshot` resolved. The cycle encodes exactly that —

```
remember it -> upload -> commit the checkpoint -> forget it.
```

— and it additionally remembers the intent *before* the upload, so a browser that
dies between "Drive has the file" and "the log knows" comes back, finds its own
immutable file by name, and commits that rather than publishing a second
snapshot. The relay therefore treats an accepted commit as an assertion by an
authenticated, fenced writer that it finished an upload, which is the strongest
statement the trust model allows.

### Retention: what prune guarantees

The background sweeper runs in the service process, not on a client request. Its
guarantee is the conjunction of two conditions, both server-side:

1. **There is a checkpoint row this build wrote (`evidence_kind = 1`) and its
   stored evidence still parses as a receipt.** Pre-v3 data and out-of-band writes
   fail the first test; a value edited after the fact fails the second. Prune
   reads the record *this service produced*, never a string some frame supplied,
   and re-validates it before trusting it again.
2. **The segment that covered the rows was published more than `retention_ms`
   ago.** Coverage is recorded per committed prefix (schema version 3), with the
   time that prefix was first committed. The cutoff is

   ```
   cutoff      = MAX(upto_seq) FROM coverage WHERE covered_at <= now - retention_ms
   eligible    = operation.seq <= min(cutoff, board.checkpoint_seq)
   ```

   The window is therefore measured from publication of *each* segment, not from
   the newest commit: a board that consolidates every five minutes still ages out
   its old segments instead of refreshing one anchor forever and never pruning.

The `min(.., checkpoint_seq)` term is the hard barrier that answers "can this
delete un-snapshotted data": **no**. Operations above the checkpoint have no
snapshot, so the log holds their only copy, and nothing in the pruning path
touches them regardless of age — a row older than the whole retention window but
above the checkpoint is kept.

Prune also retires the coverage rows for prefixes it has just deleted. Without
that, a board committing every five minutes would add 105 000 rows a year to a
table that had already served its purpose, trading one unbounded table for
another. Rows still covering retained operations stay, because those are what
ages them out later.

Pruning is idempotent and optional. If the sweeper never runs, nothing becomes
incorrect; the log simply keeps more than it must until capacity refuses a write,
which is the behaviour before retention existed. There is no correctness
dependence on it.

### `snapshot_required` in production

Before this change the answer was unreachable: nothing pruned, so
`afterSeq` below the oldest retained row could not happen. It is now reachable and
means precisely this: **the operations between the client's cursor and the log
have been deleted because a committed snapshot covers them, and the client must
adopt that snapshot before applying anything newer.** The frame carries
`checkpointSeq`, `checkpointEpoch` and `snapshotSeq`; the client's fallback is to
bootstrap from Drive (`runtime.ts`) and continue from the checkpoint.

It is distinct from `history_unavailable`, which means the gap is *not* covered by
any committed snapshot — a genuinely missing range, for which a snapshot
download is the only honest answer too, but which no client should experience
while retention is behaving. A short list is still never offered in place of a
gap.

### Operator notes

Enable retention only with `PBOARD_SIGNALING_SYNC_DIR` set; the sweeper starts
with the log and is a no-op otherwise. Defaults: one pass per hour, at most 16
boards examined per pass, at most 20 000 rows deleted per board per pass. A board
filled to its 200 000-operation cap therefore drains over ten passes (ten hours)
while no single pass holds the writer lock long enough to stall an append.
Boards are visited in `board_id` order from a rotating cursor, so every board is
reached regardless of how many exist, and a board that is not yet eligible cannot
starve the ones behind it.

What to watch after enabling it:

- `operation log retention sweep started` at startup, once, with the interval and
  slice sizes it read. Absence means the sweep did not start.
- `operation log pruned` with `boards`/`operations` counts. On a service that has
  never pruned, expect a burst of passes as the backlog drains, then silence.
- `prune_skipped` with an `error` — a board that could not be read. Retention for
  that board is paused and the board keeps growing; it is never a deletion risk.
- `log_full` refusals in `submit`. Still possible for a board with *no committer*
  (see below), and the signal that retention is not reaching that board.
- `replay` gaps reported as `snapshot_required`: expected for a client that has
  been offline longer than the window, a bug for one that was online.

Rollback is configuration, not migration: stop the service and start the previous
binary. Schema version 3 is additive — one new `coverage` table, the `checkpoint`
table unchanged — but a build that predates it refuses the file outright rather
than opening a version it does not know, so **the rollback target must be a build
that already understands version 3**. Practically: ship the version-3 binary one
release before turning retention on, and keep the retention switch (the presence
of committed checkpoints, which is to say committer clients) separable from the
schema. Pruning itself is irreversible, which is why the window and the checkpoint
barrier are the whole safety story, and why the window is not shortened without a
separate decision.

### The account room has no committer

`account:<hash>` rooms carry lifecycle records and, by construction, never
consolidate: no session takes a lease there and no Google Drive folder
corresponds to the room, so no client ever sends `commit`. Retention for such a
room is therefore **zero**: the sweeper will find no checkpoint and delete
nothing, and the room grows until its per-board cap refuses further appends.

Enabling retention for the account room requires a committer, and that is a
product decision, not a code change: either a durable account-scoped store (a
Drive file the account's own devices publish, mirroring board consolidation), or
a server-side "snapshot accepted" marker written by an authenticated owner — the
latter changes the trust model, because the relay would then be the authority on
what is durable. Until one exists, the account room's bound is its cap alone.

## Protocol 3: several rooms on one connection

6 November 2026. Implemented; inert unless a client negotiates it. This is the
change that makes "one WebSocket per session" possible: the protocol no longer
implies "one room per connection", so a client can stop dialling one socket per
board and stop paying a full admission on every board switch.

Nothing about versions 1 and 2 changes. A connection that authenticates with
`"version": 2` gets the v2 protocol byte for byte, including the frame shapes,
the error codes and the disposition of an unknown frame. The v3 vocabulary is
reachable only after a client has asked for 3 in its `authenticate` frame, which
is why the **server ships first**: a v3 server serves v2 clients unchanged, while
a v2 server would close the socket on the first `attach`, because in v2 an
unknown frame is fatal (the same rule that protects it from a confused client).

### Version negotiation

`welcome` still carries `"version": 1` — that is the *envelope* version and it has
never changed — and its `supportedVersions` list now includes 3:

```json
{"type":"welcome","version":1,"supportedVersions":[1,2,3],
 "challenge":"…","session":"…","requiresServiceAdmission":false}
```

A client that finds 3 in `supportedVersions` may send `"version": 3` in its
`authenticate` frame. The server echoes the negotiated version back:

```json
{"type":"authenticated","peerId":"…","session":"…","version":3}
```

`version` on `authenticated` is new and additive; a v2 client that does not read
it is unaffected. Version 3 is refused (`version_unsupported`) by a server that
does not offer it, and a v3 connection never advertises capabilities it has not
been granted.

### Frames

The first room is still the `authenticate` frame, with exactly the material v2
requires: the signed board manifest (or account manifest), the device signature
over `["pboard-ws-auth-v2", challenge, session, room, device, manifestDigest]` —
unchanged, because the binding is the same one and reusing it means a v3 client
reuses its existing proof code — and the Google service-admission receipt where
`requiresServiceAdmission` is true. **Every further room is attached with its own complete authorization**, the
same proof material verifies independently per room, and the service receipt is
consumed for that exact `(challenge, session, room, device)` tuple. There is no
"trust the connection" shortcut: attaching is an authenticated act.

```
{"type":"attach","room":"<room id>","signature":"<b64 device sig over that room's digest>",
 "authorization":{…same proof as authenticate…},"serviceAdmission":"<ticket, when required>"}
{"type":"attached","room":"<room id>","role":"editor"|"viewer"}
{"type":"detach","room":"<room id>"}
{"type":"detached","room":"<room id>"}
```

`attach` and `detach` are **not** parsed by the strict top-level enum. Their
shapes tolerate unknown *fields* (a newer client is not an attack), while the
nested authorization material keeps every strictness it has today. Unknown
*actions* are answered, not punished:

```
{"type":"refused","code":"<reason>","room":"<room, when the frame named one>"}
```

`refused` means "that request was declined and this connection is fine"; it is
never followed by a close. Its codes are `invalid_request`, `room_limit`,
`service_auth_required`, `service_binding_invalid`, `server_busy`,
`authorization_unavailable`, `authorization_stale`, `no_primary_room` and the
admission codes (`unauthorized`, …). A per-room revocation is not a `refused`:
it arrives as the `detached` frame described below, because it is something that
happened to the room rather than an answer to a request. A refusal for one
room leaves every other attached room, the socket and its cursors untouched; the
deployed alternative — closing the connection — would turn one bad board into a
full outage for that tab.

`attach` is idempotent: attaching an already-attached room answers `attached`
with that room's role and does not double-subscribe. `detach` of a room that is
not attached answers `detached` with `"code":"not_attached"`, so a client
retrying after a lost reply is not punished for it.

The `sync` request shape is unchanged; `board` now selects *which attachment* the
frame applies to. A frame naming a room this connection did not attach is refused
with `board_mismatch` and is not re-scoped — that is the same code and the same
meaning it had in v2, only the set it is measured against is the attachment map
rather than the single admission. Broadcasts are still published per board, so
one socket carrying three boards receives three separate streams, each tagged
with its `board`; nothing merges them.

### Roles are per room

The v2 connection carried one `writer` flag because it held one room. A
multiplexed connection cannot: the same device is routinely `viewer` on one board
and `editor` on another, and both seats must work on the same socket. The role is
therefore resolved per attachment from that room's manifest and consulted per
frame: `submit`, `lease`, `commit` are refused with `read_only` in a viewer room
and accepted in an editor room, on the same connection, in either order.

### Revocation and expiry are per room

`admission.rs` already published a revocation watch per authorization scope. A
scope change — an epoch bump, a republished manifest, a pruned grant — now ends
**only the rooms whose scope moved**:

```json
{"type":"detached","room":"<room id>","code":"authorization_changed"}
```

The connection, its other rooms and their sync cursors survive. For v1 and v2 the
same event still closes the connection with the identical code, because for those
versions the connection *is* the room; that asymmetry is deliberate, not an
oversight. Per-room proof expiry is scoped the same way in v3 (`grant_expired` on
the `detached` frame) and still closes a v1/v2 connection as before.

### Session identity

`welcome.session` is the server's session id: 32 random bytes, base64url, minted
per dial, signed into every admission proof for the connection, and stable for
the life of the socket. The service keeps a registry — session id → device key →
attached rooms — which is written on authentication, updated on attach/detach,
and removed exactly once on disconnect. Reconnecting mints a new id, so a stale
entry cannot be mistaken for a live one. The registry carries **no user account
concept**: the device key, the signed manifest and Drive permissions remain the
only authority, and the registry never grants anything — it answers "which
sockets are live and what may they currently reach", which is what routing needs.

### Byte accounting

`Limits::session_bytes` was a **lifetime** total that never reset: one socket died
permanently at 4 MiB. Correct for a socket that was reopened on every board
switch, fatal for the one long-lived socket v3 asks a client to hold. It is
replaced by two rolling-window budgets, both renewed rather than accumulated:

| Budget | Default | Renews | Scope |
| --- | --- | --- | --- |
| `bytes_per_window` | 4 MiB | every `byte_window` (60 s) | the whole connection |
| `room_bytes_per_window` | 2 MiB | every `byte_window` (60 s) | per attached room |
| `bytes_per_second` | 128 KiB | every second | burst ceiling, unchanged |
| `global_bytes_per_second` | 2 MiB | every second | whole service, unchanged |

4 MiB per 60 s is ≈ 68 KiB/s sustained, an order of magnitude above a board under
active editing and above the 128 KiB/s burst allowance that still applies per
second. The per-room share means one busy board exhausts *its own* budget rather
than starving the siblings on the same socket; in v3 that detaches that room
(`{"type":"detached","room":…,"code":"budget"}`) instead of closing the
connection, and in v1/v2 it remains `traffic_limit` followed by a close, exactly
as before. Operator knobs are `PBOARD_SIGNALING_MAX_SESSION_WINDOW_BYTES` and
`PBOARD_SIGNALING_MAX_ROOM_WINDOW_BYTES`; `PBOARD_SIGNALING_MAX_SESSION_BYTES`
is retired and is ignored if present in an existing environment file, because a
drop-in that silently kept a 4 MiB *lifetime* cap is the bug being fixed.

### Compatibility matrix

| | v1 client | v2 client | v3 client |
| --- | --- | --- | --- |
| **v1/v2 server** | works | works | `authenticate` with `version:3` → `version_unsupported` and the socket closes; `attach` never gets a chance to run. A v3 client must therefore negotiate by capability (`supportedVersions`), never by assumption. |
| **v3 server** | works, unchanged | works, unchanged: same frames, same codes, unknown frame still fatal, `board_mismatch` still refuses a foreign board | works: attach/detach, per-room role, per-room revocation, windowed byte budget |

The upgrade order is server first, client second, and there is no rollback
hazard in the protocol itself: a v3 server serves v2 clients unchanged, so
rolling the server back only breaks clients that already speak v3 — which is why
the client cutover is gated on verifying a v3 server in front of it.

### Limits

One connection may hold `sync_api::Limits::rooms_per_connection` rooms (32). The
cap is a fan-out bound, not an authorization one: every room still passes its own
admission, and every room is independently bounded by its byte share and by
`peers_per_room` for roster traffic. The attach path draws on the same
`automatic_auth_per_second` budget as `authenticate`, so an authenticated socket
cannot become an unthrottled verifier.

### Tests

`tests/multiplex.rs` (9) drives real sockets: three boards on one connection with
per-room filtering, a viewer room and an editor room on one socket, an
unauthorized attach refused without closing, an epoch bump detaching one room,
the v2 regression (unknown field tolerated, unknown action still fatal,
`board_mismatch` unchanged, and a v2 connection that tries `attach` is closed
with `malformed` exactly as any unknown frame was), the session registry's create/update/cleanup/reconnect
behaviour, a connection moved past the old 4 MiB lifetime figure, and a byte
budget that renews instead of accumulating.

## Cross-account board discovery: the per-account hint inbox

6 November 2026. Implemented; inert unless the operation log is configured,
because the inbox lives in the log's file. This closes requirement 4.2 — "share a
board with another Google account and that account's connected sessions learn
about it without a reload" — which the relay could not express at all before,
for two reasons that are structural rather than accidental:

* an `account:<hash>` room is writable **only** by members of that account's own
  manifest (`admission.rs` binds the topic `pboard-account-<hash>-order` to the
  board id `account:<hash>`), so the owner of a board shared *with* somebody
  cannot enqueue anything into the other account's room; and
* the relay cannot enumerate another account's sessions, because the verified
  email is discarded when the service ticket is consumed. A session is only ever
  `(room, deviceKeyId, expiry)`.

The inbox is the missing primitive: a durable, bounded store addressed by
**account hash** — SHA-256 of the lowercased verified email, rendered lowercase
hex, which is already the account-room scope — into which a verified board
authority may write and from which a verified account session may read. The relay
holds no email, no display name, no Drive token, and no session→account map
beyond the index of live sockets currently attached to an account room.

### Frames

Both actions travel inside the existing `sync` request envelope, so they need no
new top-level frame type and a v2 client's unknown-frame rule is untouched.

```json
{"type":"sync","request":{
  "action":"publishAccountHint",
  "board":"<the board room this connection holds>",
  "to":"<account hash: 64 lowercase hex characters>",
  "hintId":"<client-chosen idempotency key, ≤128 id characters>",
  "payload":"<base64, ≤4 KiB decoded, opaque to the relay>"
}}
```

```json
{"type":"sync","action":"accountHintStored","board":"<the room that was named>",
 "to":"<account hash>","seq":7,"duplicate":false}
```

```json
{"type":"sync","request":{
  "action":"replayAccountHints",
  "board":"account:<hash>",
  "afterSeq":6
}}
```

```json
{"type":"sync","action":"accountHints","board":"account:<hash>",
 "inbox":"<account hash>",
 "hints":[{"type":"accountHint","inbox":"<hash>","seq":7,
           "board":"<board id>","hintId":"…","sender":"<deviceKeyId>",
           "createdAt":1750000000000,"expiresAt":1750604800000,
           "payload":"<the stored base64, verbatim>"}],
 "highest":7,
 "oldestRetained":3}
```

`oldestRetained` is present only when the inbox still holds something; it is the
lowest sequence still retrievable, exactly like the operation log's
`oldestRetainedSeq`. A client compares it with its own cursor: **`afterSeq + 1 <
oldestRetained`, or a cursor at all while `hints` is empty and `highest` is ahead
of it, means hints were evicted or expired and the client must reconcile against
Drive.** An empty `hints` list is therefore never mistakable for "you are up to
date".

Each stored hint is also pushed live, to every session of the target account, as
the frame shown inside `hints` — identical in shape and in `expiresAt` to the
replayed one, so a client has one parser and one apply path whether the hint
arrived live or after a reconnect. Refusals arrive as the usual
`{"type":"sync","action":"error","board":…,"code":…}`:

| Code | Meaning |
| --- | --- |
| `unauthorized` | the named room carries no verified board id, or carries an `account:` id (an account room is not a board) |
| `read_only` | a viewer seat may read a board and may not speak for it |
| `board_mismatch` | the named room is not attached to this connection |
| `invalid_request` | the target hash, the board id, the hint id, or the payload is malformed or over its cap |
| `inbox_disabled` | the operation log is off, so nothing can be stored durably |

There is deliberately no capacity code: capacity is answered by eviction, not
refusal (see *Bounds and retention*).

### Sender authorization: the room, not a claim

The sender's authorization is **the board room it already holds**, and the board
it names is taken from that room's *verified* manifest, never from the frame:

* `lib.rs` `admit_room` stores `board_id: Some(verified.context.board_id)` on
  every manifest-backed attachment (and `None` in operator-grant mode, where no
  manifest exists to vouch for a board id);
* `lib.rs` builds `sync_api::Identity { board_ids }` from those attachments per
  frame;
* `sync_api.rs`, in the `PublishAccountHint` arm, refuses `read_only` when the
  room's role cannot write, `unauthorized` when the room has no verified board id
  or when that id starts with `account:`, and only then calls
  `AccountInbox::publish(&to, board_id, &identity.actor, …)`.

So a hint names the board the admission proved. `account_inbox.rs` additionally
refuses an `account:` board id at the storage boundary, which is the defence that
does not depend on any caller remembering the rule. A device that holds only its
own account room therefore cannot fan out into another account's inbox: its
verified board id *is* `account:<its own hash>`, which is refused.

No client assertion is involved at any point. The alternative — trusting a
`board` or `boardId` field in the frame — would let any device holding any board
notify any account about any board, and the check above is exactly the difference
between the two.

### Receiver authorization: its own account room, and nothing else

`replayAccountHints` names a room, and that room must be an `account:<hash>`
room this connection is attached to — which means it passed the same admission
`admission.rs` performs for every account room, with the same device signature,
the same service ticket and the same revocation watch. The account the answer is
about is then read out of *that room's verified board id*:

```
identity.board_ids[board].strip_prefix("account:")
```

There is deliberately **no target field on the read path** and no
`inbox` parameter derived from one: `AccountInbox::replay(inbox, after_seq)` is
called with the hash the connection's own room proved, so "read somebody else's
inbox" has no wire shape in which to be expressed. A frame naming an account room
this connection does not hold is refused `board_mismatch` before any read, and a
room whose manifest declares an ordinary board id is refused `unauthorized`.

### Delivery reaches every session

`sync_api::Hub` gained a second index — `by_inbox`, keyed by account hash, with
an `inbox_owners` map from session to the one account it belongs to. A session
enters it at the moment the loop files an attachment whose *verified* board id is
`account:<hash>`, and leaves it in `drop_room`, in the same call that removes the
room: the fan-out path cannot outlive the proof that created it. `publish_inbox`
sends to every session in the index, and a session that cannot keep up is skipped
exactly as a board broadcast skips it — its own slow-consumer handling closes it,
and the hint is durable, so its next reconnect replays it.

`Outcome` gained `inbox_broadcast: Vec<(String, Value)>`, published **after** the
sender's reply, for the same reason operation broadcasts are: no receiver learns
of a hint the sender has not been told is stored.

Two sessions of one account are two entries in the index, and both receive the
frame (`tests/inbox.rs::an_authorized_sender_reaches_every_session_of_the_target_account`).

### Bounds and retention

| Bound | Value | Why that number |
| --- | --- | --- |
| Payload, decoded | 4 KiB | a board id and a sealed hint, not a document |
| Hints per inbox | 64 | `64 × 4 KiB = 256 KiB` per inbox, by construction |
| Inboxes, service-wide | 1024 | `1024 × 64 × 4 KiB = 256 MiB` absolute ceiling |
| Retention | 7 days (`HINT_TTL_MS`) | the operation log's window: both exist for "a device was away" |

Over capacity the answer is **eviction at every level, never refusal**. The
per-inbox cap drops the lowest `seq`; the service-wide inbox cap drops the least
recently written inbox whole, hash-break-tied so the choice is deterministic.
Refusing instead would look safer but is the dangerous option: any device holding
any board can create an inbox, so a refusal at the cap lets one actor deny
share-notification delivery to every future account for the whole retention
window. Eviction loses a hint, and a lost hint degrades to Drive polling, which
this design already permits; there is no third option in which a hint is both
bounded and never lost. Because the sequence counter is **global and monotonic**,
an inbox that is evicted and later written again continues above anything it ever
issued, so a client's stored cursor is never silently behind.

Expired rows are deleted lazily: on every write (bounded to 1024 rows per call,
so a request never becomes a full-table delete) and on every replay of the inbox
in question. Because the per-inbox count is capped, an inbox nobody touches still
cannot grow; an inbox nobody reads for a week keeps its 64 rows until the next
write or read reaches it, which is at most 256 KiB.

### Durability and restart

Rows live in the operation log's SQLite file, on the log's single connection,
with the log's `journal_mode = WAL` and `synchronous = FULL`; the insert commits
before `accountHintStored` is sent. A restart therefore preserves undelivered
hints and their per-inbox cursor, and a receiver that reconnects asks from the
last sequence it applied and gets exactly what it missed
(`tests/inbox.rs::a_restart_preserves_undelivered_hints_and_a_reconnecting_receiver_gets_them`).
The grant cache is RAM-only and is not part of this: a replaced service needs its
boards' grants republished before those *board rooms* are admissible again, which
is normal operation. The inbox is unaffected by that.

The per-inbox `next_seq` is dense and never reset. Reclaiming the counter would
hand a reconnecting client a sequence below the cursor it holds, i.e. hints it
would silently skip; rows are bounded by the 1024-inbox cap, so keeping them
costs 64 bytes an inbox rather than being a leak.

### Revocation

* **Sender loses the board.** Its room's admission scope moves, and the existing
  per-room revocation ends that attachment (`detached` /
  `authorization_changed` on v3, connection close on v1/v2). Every later
  `publishAccountHint` names a room the connection no longer holds and is refused
  `board_mismatch`. Hints already stored are **not** retracted: revocation is not
  a deletion primitive, and it does not need to be — the receiver's own Drive
  verification is what decides whether the board exists for it, and that check
  has already run by the time a delivered hint can have any effect.
* **Receiver loses the account room.** `drop_room` removes the session from
  `by_inbox` in the same call that removes the room, so no live delivery path
  survives the proof that created it. Stored hints are unaffected; a later
  re-admission replays them.
* **Nobody gains a capability from a hint.** See below.

### What a hint can and cannot do

The relay guarantees, and the tests assert:

* the writer held a live, verified authorization for the board it named at the
  moment of the write;
* the receiver holds the account room it is reading;
* the payload is stored and replayed byte for byte, with no field the server
  invented about the board;
* no room, log, grant or authorization is created by a hint: `sync.boards()` is
  still empty after one arrives, and the receiver still cannot subscribe to the
  named board's room (`tests/inbox.rs::a_hint_never_creates_access_and_the_receiver_still_cannot_reach_the_board`).

The relay cannot guarantee that the named board is in fact shared with the target
account, because that fact lives in Drive's ACL and the relay holds no Drive
credential. An attacker who holds *some* board can therefore post an inert hint
into an arbitrary hash's inbox, up to the caps above. The consequences are
bounded structurally: the payload is opaque (no server-side interpretation to
abuse), the caps make a flood a bounded amount of storage, and on the receiver the
hint can only ever trigger a Drive verification attempt — one that fails for a
board the account cannot see. **A hint is a hint.** Losing one degrades to Drive
polling; it never produces wrong state, and it never grants anything.

### Where the client's gate takes over

This change is server-side only. The receiver's existing create-free verified
discovery path (`src/sync/operations/accountChannel.ts`, whose `deferred` queue
and `appliedByKind` counters already express "received, not yet verifiable")
remains the sole route from a hint to anything interactive: it hands the board id
to the Drive role/board check, and a board the account cannot verify simply stays
non-interactive. The wire shape above was chosen so that path needs only a new
`action` to subscribe to; no client behaviour changes without one, and until then
these frames are inert on an old client, which ignores unknown sync actions.

### Compatibility, schema and rollback

* **Protocol version.** No new protocol version. Both actions are `sync` requests
  inside the v2 envelope, so a client that does not know them never sends them,
  and a v2 client's handling of unknown *frames* is unchanged. A v3 server and a
  v2 server are both unaffected by the frames' existence.
* **Schema.** Two additive tables (`account_hint`, `account_hint_cursor`, plus
  two indexes) are created with `CREATE TABLE IF NOT EXISTS` when the inbox is
  opened, in the same presence-gated style as the key courier's tables. The
  shared `sync_schema` version is **deliberately not raised**: raising it would
  make an older binary refuse a file it can in fact read, which is the opposite of
  what a rollback needs. An older binary opens the same file unchanged and simply
  ignores the extra tables; it will not serve the two new actions, and a client
  that sends them gets `invalid_request` from that older build.
* **Rollback.** Stop the service, run the previous binary. Hints already stored
  are retained (nothing deletes them) but unreachable until the new binary
  returns; clients fall back to Drive polling in the meantime, which is the
  degraded path this design already promises. No migration is reversed because
  none was applied to existing data.
* **Operator surface.** `with_sync` logs `operation log enabled` as before; there
  is no separate switch, because an inbox without a durable store cannot be
  honest. An inbox dropped at the service-wide cap logs
  `event = "account_inbox_evicted"` and nothing else: the hint frames themselves
  are opaque and are never logged. The only other new startup-visible fact is the
  tables' presence in `sync-log.db`.

## Protocol 3: an `attach` may present its own device key

6 November 2026. Implemented; additive to protocol 3, which is still selected by
`"version": 3` on `authenticate`. Nothing in v1 or v2 changes.

### The blocker this removes

Protocol 3 let one connection hold several rooms, but every room's proof was
verified against `SessionRecord.device` — the device the connection
authenticated with. The client signs each board's proof with that board's own
device key (`board-device:<board>`), because a device is a *per-board* identity
in the manifest model. The combination was unsatisfiable: a second board on the
same socket presented its own key, the relay checked the connection's key, and
the answer was `service_auth_required` or `unauthorized`. "One socket per
session regardless of board count" was therefore unreachable no matter how good
the multiplexing was.

The fix is one optional field on `attach`. It does not widen what the server
accepts; it lets a frame name the key its signature is already made with, so the
check can be performed against the right key instead of the wrong one.

### Frame

```json
{"type":"attach","room":"<room id>",
 "deviceKeyId":"<the device key id this proof speaks for>",
 "signature":"<b64 device sig over that room's digest>",
 "authorization":{…same proof as authenticate…},
 "serviceAdmission":"<ticket, when required>"}
```

`deviceKeyId` is **optional**. Absent, it means the connection's own device —
exactly today's frame, byte for byte, and the behaviour is unchanged: the
signature is verified against the key the connection authenticated with and the
room is attributed to that device. This is the compatibility story, and it costs
nothing because the server substitutes the connection's device before any check
runs.

`deviceKeyId` is **strictly bounded**: the same shape as a room name (base64url
and `-`/`_`, at most 200 bytes) so no identifier that no manifest could list is
ever handed to a lookup. A malformed one is refused with `unauthorized`; it is
never a socket close.

### What the server checks, in order

1. **The signature against the named key.** The pre-image is unchanged —
   `["pboard-ws-auth-v2", challenge, session, room, device, manifestDigest]` —
   with `device` being the **attach's** `deviceKeyId`, not the connection's. The
   `challenge` and `session` are the connection's, minted in `welcome` and stable
   for the life of the socket, so the proof is bound to *this* connection: a
   signature captured from another socket fails here even though every other
   field matches.
2. **The key against the room's authorized device set.** The room's signed
   manifest is loaded through the same machinery `authenticate` uses — the
   `AdmissionProof` in the frame, verified against the authority pinned by
   `board_grants`, cross-checked against the current grant bundle — and the named
   device must appear in that manifest's `devices` with a key whose fingerprint
   equals the id. No new key registry exists: a device is authorized by the
   manifest that the board's authority signed and published, and by nothing else.
3. **Owner presence, epoch, expiry, digest and scope**, identically to
   `authenticate`, because it is literally the same function (`admit_room`). A
   v3 attach cannot reach a room that the single-room protocol would have
   refused; the only thing that changed is which device is looked up in the set.

`authenticate` is untouched and does **not** take the new field's meaning from
`attach`: the first room's device is still the connection's device, and that is
the only frame that writes `SessionRecord.device`.

Operator-grant mode (protocol 1, and protocol 3 without automatic admission)
needs no separate rule: the grants file is keyed by room and then by device
fingerprint, and the lookup uses the same resolved device, so an attach that
names its own key is admitted exactly when that key is listed for that room.
Nothing else about the mode changes — no roles, no manifests, no expiry beyond
the grant's own.

### Possession is proven per attachment

The security property, stated as the invariant the tests pin:

* **A connection holds no authority it did not sign for.** Every attachment
  carries its own signature, made with the key it names, over a pre-image
  containing this connection's `challenge`, `session` and that room's digest.
  Holding room A therefore confers nothing in room B — not an admission, not a
  cursor, not an author identity.
* **Naming a device is not becoming one.** A connection that has correctly
  attached room B under device *D* cannot use *D*'s presence in room C's manifest
  to enter room C: the signature in C's attach must verify against *D*'s public
  key, which the connection does not hold. The refusal is `unauthorized`, and it
  is a `refused` frame — the socket, its other rooms and their cursors survive.
* **The device must be one the room authorizes.** A valid signature by a device
  the manifest does not list is refused just as a missing signature is. The two
  halves — possession and authorization — are both required, and neither implies
  the other.
* **Attribution follows the attachment, not the socket.** Every operation
  appended through a room is recorded with that room's verified device as
  `actorId`, taken from the attachment, never from a frame field. `submit`,
  `lease`, `release`, `commit`, `publishDeviceKey`, `publishKeyGrants`,
  `fetchKeyGrants` and `publishAccountHint` all use it, so a multiplexed socket
  cannot launder three devices' writes into one identity, and cannot read another
  device's courier mailbox by attaching under its key without its signature.
  The session registry records the same fact per room (`rooms` plus
  `room_devices`), so "which device holds this room" is answered from the
  admission rather than from the connection.

### Service admission receipts bind to the attach's device

When `requiresServiceAdmission` is true, the receipt must be minted for the
attachment's device, not the connection's: the consumed tuple is
`(challenge, session, room, device)` with `device` = the attach frame's
`deviceKeyId` (or the connection's device when the field is absent).

This is the only choice that composes with the change. A receipt is the Google
verification service saying "this human, on this device, is entitled to this
room now". A connection acting for three boards' device keys needs three receipts,
one per device, because it is asking the service to vouch for three different
devices' right to be there. Accepting a receipt minted for the connection's
device while attaching under a different key would make the receipt meaningless
as a binding — the server would be pairing one device's service proof with
another device's board seat — so the check is tightened rather than relaxed, and
the refusal code (`service_binding_invalid`) keeps its meaning: the receipt does
not describe this attachment. A client that presents the wrong device's receipt
gets `service_binding_invalid` as a `refused` for that room; the socket and its
other rooms are untouched.

### Compatibility

* **Wire.** `deviceKeyId` is an unknown *field* to an older server, which
  tolerates unknown fields on `attach` by design; such a server ignores it and
  verifies against the connection's device, which is what the client would have
  had anyway. A new client talking to a new server gets the widened behaviour.
  There is no new version number, no new frame and no new required field.
* **Old clients.** A v3 client that sends today's frame is unchanged: no
  `deviceKeyId` means the connection's device, the same verification, the same
  attribution, the same registry entry. The test
  `an_attach_without_a_device_key_id_behaves_exactly_as_before` asserts both the
  admission and the author identity.
* **v1/v2.** Unreachable. `attach` does not exist in those vocabularies; a v1/v2
  connection that sends it is closed with `malformed`, exactly as before, and
  `authenticate` never had the field.
* **Receipts.** A deployment without Google service admission
  (`requiresServiceAdmission:false`) is unaffected. Where it is on, the receipt
  is now checked against the presented device; a client that was minting
  receipts for the connection's device and attaching under the same device — the
  only case that works today — sees no change.

### Refusals and their scoping

All of these are `refused` frames carrying `room`, never a close:

| code | meaning |
| --- | --- |
| `unauthorized` | bad signature for the named key, device absent from the room's manifest, malformed key id, or any manifest/scope failure |
| `service_auth_required` | no receipt presented |
| `service_binding_invalid` | a receipt minted for a different `(challenge, session, room, device)` |
| `authorization_unavailable` / `authorization_stale` | the room's grant bundle is unknown or has moved, unchanged from `authenticate` |

A refusal for one room leaves every other attached room, the socket and its
cursors untouched — the property that makes it safe to hold many boards on one
connection.

### Tests

`tests/attach_device.rs` (5) drives real sockets: one connection holding three
rooms under three different device keys, with each room's operation attributed to
its own device in both the broadcast and the durable log and the registry
recording one device per room; an attach naming a device whose signature does not
verify, refused with the socket and its other rooms intact (and the same frame,
correctly signed, accepted immediately after, so the refusal is shown to be about
the signature and not the device); a device outside the room's manifest refused
despite a valid signature; an attach without `deviceKeyId` behaving exactly as
before, including the `read_only` seat and the idempotent re-attach; and a
connection that holds one room under another device's key being unable to borrow
that device for a *different* room without its signature.

## `--check-config` is a dry run (6 November 2026)

Argument parsing now happens before any `App` is built. `--check-config` never
opens, creates or migrates the operation log, so a pre-flight check against a
production data directory no longer changes it: previously the binary built the
application — and therefore opened `sync-log.db` and ran the schema migration —
before looking at its argument, which left a fresh directory at schema v3 and
upgraded an existing v1 file. That made a check indistinguishable from an
activation and, because the schema bump makes an older binary refuse the file,
broke the documented rollback path.

What `--check-config` validates, one line each on stdout, `ok`/`FAILED`/`skipped`:
the grants path, that the grants file is readable and parses, and that its room
structures and device keys are valid; the `AUTOMATIC_ADMISSION`, `BOARD_GRANTS` and
`GOOGLE_IDENTITIES` flags; resource limits; transport policy; Google enrollment
(authority key and enrollment registry read, not written); readability of the
`AUTHORITY_KEY` and `ENROLLMENT_STATE` paths when those are set; the identity
prerequisites; the bind address (parsed, must be loopback); the in-memory service
policy; a final `startup parity` line that runs the serving path's own environment
parse, so a passing check cannot disagree with startup; and, when `PBOARD_SIGNALING_SYNC_DIR` is set, that the directory exists and
is writable — proven by creating and removing a uniquely-named probe file, never by
opening the database. When `PBOARD_SIGNALING_BUFFER_DIR` is set, the same probe
runs against it, or against its parent when the directory does not exist yet.

What it deliberately does not validate: the database schema version, its tables,
its WAL/journal integrity, and whether the SQLite file parses at all. Each of
those requires opening `sync-log.db`, which is the operation being avoided — the
answer would be produced by performing the change the check exists to prevent. The
check prints a `skipped sync log schema` line saying exactly that rather than
passing silently. It also does not bind the listener, connect to Google, or inspect
the content of the enrollment registry beyond what loading it verifies. A `sync
log` line does report whether the database file is already present and its size,
which distinguishes "will create" from "will migrate" without touching it.

Exit codes: `0` success (including `--help`), `1` any failed check or runtime
startup error, `2` usage error (unknown argument, too many arguments,
`--generate-authority` without exactly one path). `--help` was added so a
deployment step can test the binary itself instead of `--help || true`: it prints
the usage line, every accepted argument, every environment variable the service
reads, and the exit codes, then exits `0`. The refusal path prints the same usage
line to stderr and names every accepted argument.

Tests: `tests/check_config.rs` (5) run the real binary against a temporary
directory and assert the filesystem, not the output. One points `--check-config` at
an empty directory and asserts it is still empty afterwards — no `sync-log.db`, no
`-wal`, no `-shm`. The other builds a schema-v1 `sync-log.db` with the raw v1 DDL
(the only way to obtain an older schema from this build, since opening is the
migration), runs the check, and asserts the `sync_schema` version is still 1, no
table was added, the `checkpoint.evidence_kind` v3 column is absent, the file is
byte-identical and no file beside it appeared; it then opens the same file the way
startup does as a control, showing that open migrates to v3 — which is what makes
the assertion meaningful. The remaining three drive the checking machinery itself:
four invalid environments (out-of-range limit, non-flag boolean, non-loopback bind,
identity without board grants) each refused while still leaving the sync directory
empty; a missing sync directory reported as a failure without being created; and the
`--help`/usage exit codes. The environment cases are the parity property above — the
check refuses exactly what startup refuses. Together they cover the safety property
end to end. They do not cover a database written by a *newer* build (refused by `SyncLog::migrate`,
untouched by the check for the same reason) or the behaviour of a v2-only file;
both are the same code path as v1.

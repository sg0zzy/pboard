# Pboard experimental signaling protocols 1 and 2

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
390 seconds to reject immediate rollback; the directory is disposable, so
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

Fixed directory caps: 64 retained scopes, 8 per verified owner, 16 invited emails
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
per socket per fixed one-second window, 4 MiB and 512 signals per socket lifetime,
45-second inbound idle timeout, 10-second authentication timeout. See
[the security audit](SECURITY_AUDIT.md#default-resource-policy) for all configurable
aggregate, HTTP, replay and history budgets. Browser heartbeat: 15 seconds. Outbound
queues hold at most four messages per connection. Queue overflow closes affected
sessions; forwarding overflow closes the sender. Socket sends have five-second
deadlines. Read buffers are at most 16 KiB; the write buffer flushes immediately,
with a maximum buffer twice the configured message limit.
Binary frames and WebSocket control frames other than closing are not application
messages; use JSON ping. There is no compression or persistent signaling state.

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

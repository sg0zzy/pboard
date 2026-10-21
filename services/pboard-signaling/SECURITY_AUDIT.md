# Rendezvous security audit — 19 October 2026

Scope: the existing Rust service and its normal opt-in browser provider. This is
an implementation review and targeted hardening, not a cryptographic audit or a
production capacity certification. Drive signaling remains the application default;
Drive persistence, scopes, permissions, data and schemas are unchanged.

## Identity-only enrollment follow-up

Default-off `/identity/*` endpoints add verified Google identity lookup, root-signed
expiring email policies, per-device fresh challenge proofs and an owner-only
bounded request queue. They do not mint device grants or change room admission.
Uninvited identities, invalid signatures/tokens, expired/replayed challenges,
unknown operations/fields and cross-board requests fail closed. Limits: 64 policy
scopes, 8 per owner, 16 members/requests per scope and 128 challenges, plus existing
HTTP/auth quotas and timeouts. State is volatile; tokens are never retained/logged.
Manual key revocation is preserved during automatic polling. Legacy ACL admission
remains a separate compatibility path, with its existing allowlist unchanged.

The chosen TLS service is a trusted identity verifier; its compromise can falsely
label a pending device's identity and induce automatic owner approval. This is an
explicit additional trust assumption versus manual code/fingerprint comparison.
Google authentication alone still cannot sign a manifest or join a board. Existing
root pins, original signed data and private keys cannot be silently replaced.
See the current architecture note and protocol for tests, metadata visibility and
owner-online availability limitations. No claim of original-binary attestation or
prevention of every bounded covert channel in valid authorization/SDP/ICE metadata.

## Findings before changes

| Area | Already implemented | Gap corrected |
| --- | --- | --- |
| Peer authentication | P-256 device proof bound to a fresh random challenge, socket session, exact manifest and room; expiry; no anonymous signaling | Authentication budget now covers both protocol modes; invalid configuration fails startup |
| Board authorization | Signed authority manifests, member fingerprints/roles, authority-derived namespaces, shared epoch/revocation watches, exact-room target lookup | Standalone admission now requires the current authority-published grant; legacy broker admission requires its latest persisted manifest |
| Session isolation | One room per socket; current recipient incarnation; duplicate sessions rejected; bounded outgoing queues | Signed inner presence/signal identity, collection, epoch, logical sessions, expiry and replay are also verified before forwarding |
| Payload handling | Strict outer message types; frame cap | Previously forwarded arbitrary `signal.data`. Now accepts only bounded DataChannel SDP, ICE and renegotiation control; rejects duplicate nested fields and excessive JSON depth |
| Resources | Connection/room-member/frame caps; auth/idle timeout; proxy IP throttling; systemd memory/task/file caps | Validated configurable caps, room count, pre-parse HTTP concurrency/rate/deadline, aggregate traffic, cumulative session budgets, replay/history/cache quotas and CPU quota |
| Transport/logging | Loopback Rust listener behind TLS HAProxy; redacted events | Explicit trusted-proxy TLS gate and Origin filter; proxy overwrites forwarded protocol; added queue/body timeouts and safe rejection categories |
| Restart | Sessions/cache disappear; clients reconnect and retain signed history | A captured static publication could repopulate an older still-fresh grant. Fresh single-use authority challenge is now required; member credentials cannot restore an old grant alone |

Evidence: `src/lib.rs` (`http_guard`, socket state machine and directed forwarding),
`src/admission.rs`, `src/board_grants.rs`, `src/google_enrollment.rs`, new
`src/policy.rs`, `src/strict_json.rs`, and `src/signals.rs` in this service;
`../../src/collab/boardGrants.ts` and `../../src/collab/security/session.ts` in the
client. Negative cases are in `tests/hardening.rs`, `tests/admission.rs` and
`tests/protocol.rs`.

## Trust and fail-closed behavior

Google verification alone does not admit anyone to a board. The independent path
uses the independently pinned board authority and explicit signed device grants.
The preserved two-account Google experiment additionally checks its real legacy
Drive ACLs and issuer registry; it is not the independent path's authorization.
Existing storage really includes shared Drive folders as well as private appData;
this change does not migrate or misrepresent that legacy architecture.

The open-source protocol cannot attest an official Pboard executable. A peer may
create an authority for its own namespace but cannot thereby enter another pinned
authority's board. Origin filters, extension identifiers and TLS headers provide
transport defense in depth only. Missing Origin is allowed for native clients;
cryptographic admission remains mandatory. Spoofing an extension Origin grants
nothing. An exact configured HTTPS Origin does not grant board access either.

Publication protocol 2 requires a 30-second, single-use server challenge signed by
the board authority as well as the existing publisher-device proof. After restart,
standalone admission fails until the authority republishes its retained history.
This deliberately favors fail-closed revocation over authority-offline availability.
No private authority key is sent to the service, and no durable standalone grant or
new account database is introduced. Old static publications fail; the owner and
joining browsers must reload the updated extension. WS protocol 2, grant bundle
version 1 and existing device/authority identities remain unchanged.

The service validates but never rewrites or fetches SDP/ICE addresses. Only
DataChannel SDP and ICE control are accepted; documents, image payloads, arbitrary
JSON, custom SDP attributes and proxy-style operations are rejected. It implements
no outbound relay/proxy or TURN. **This cannot eliminate covert data encoded by
colluding authorized peers in valid bounded SDP/ICE fields.** No signaling service
can prove the semantic intent of every valid negotiation string. Tight schemas,
per-pair negotiation counts and byte/session limits bound this residual abuse.

## Default resource policy

All names below have the prefix `PBOARD_SIGNALING_`. Invalid, zero, out-of-range or
non-UTF-8 settings fail startup. Operator bounds are enforced in `src/policy.rs`;
raising an application limit does not bypass a lower proxy/OS limit.

| Setting | Default |
| --- | ---: |
| MAX_CONNECTIONS / MAX_PEERS_PER_ROOM / MAX_ROOMS | 128 / 16 / 128 |
| MAX_MESSAGE_BYTES | 98,304 |
| MESSAGES_PER_SECOND / BYTES_PER_SECOND, per socket | 60 / 131,072 |
| MAX_SESSION_SIGNALS / MAX_SESSION_BYTES | 512 / 4,194,304 |
| GLOBAL_MESSAGES_PER_SECOND / GLOBAL_BYTES_PER_SECOND | 256 / 2,097,152 |
| AUTH_PER_SECOND | 32 |
| HTTP_CONCURRENCY / HTTP_PER_SECOND | 4 / 64 |
| AUTH_TIMEOUT_SECONDS / IDLE_TIMEOUT_SECONDS | 10 / 45 |
| MAX_AUTHORIZATION_SCOPES / MAX_REPLAY_ENTRIES | 1,024 / 8,192 |
| MAX_GRANT_BYTES / MAX_GRANT_CACHE_BYTES | 4,194,304 / 33,554,432 |
| MAX_GRANT_HISTORY | 4,096 |

HTTP bodies/handlers have a 20-second deadline. Grant verification has one blocking
worker; fresh root proof is verified before bulk history. Publication challenges
are limited to 128, expire after 30 seconds and are consumed on a verification
attempt. Per socket/target incarnation: at most 32 presences and 128 negotiation
messages; at most 64 target incarnations per socket. Queues are bounded and slow
consumers disconnect. Active replay identifiers are never evicted to admit others.
At quota exhaustion, fail closed; the client may reconnect/back off normally.

For the public deployment `REQUIRE_TLS_PROXY=1`, loopback origins are disabled,
and HAProxy strips incoming `X-Forwarded-Proto` then sets `https` in the backend
reachable only from its TLS frontend. Default Origin policy permits syntactically
valid Firefox/Chromium extension origins and absent Origin; rejects `null`, duplicate
headers and arbitrary web origins. `ALLOWED_ORIGINS` optionally adds exact HTTPS
origins (no wildcard). `ALLOW_LOOPBACK_ORIGINS=1` is only for explicit local tests.
Bind stays loopback. Example systemd adds CPUQuota=100% to existing MemoryMax=768M,
TasksMax=128 and LimitNOFILE=8192. HAProxy caps backend connections at 64, queued
requests at 32, and each source at 60 requests/10 seconds. These are resource bounds,
not measured peer capacity. Distributed denial of service still requires upstream
network controls; authenticated peers creating many own namespaces can exhaust
bounded shared quotas and deny service to others.

## Validation

- Rust: 30 tests passed; formatting and strict Clippy passed. Covers authentication,
  invalid/expired/replayed grants and proofs, unauthorized joins, cross-board and
  logical-session spoofing, duplicate sessions/JSON, malformed/oversized data,
  flooding, global/room/session quotas, slow HTTP bodies, presence, disconnect,
  reconnect, restart and authority-only republication.
- Focused TypeScript: 12 tests passed; root TypeScript passed.
- Two isolated native Chromium profiles: approved standalone board, authenticated
  WebRTC/RxDB creation/edit/reconnect, renewal/revocation/restart and separate Drive
  fixture persistence passed. Legacy Google broker fixture also passed, including
  renewal, historic catch-up and snapshot/image paths.
- Two isolated native Firefox profiles: signed presence/SDP, DTLS, RxDB create/edit
  and reconnect passed. The local disposable test manifest permits loopback WS;
  production CSP is unchanged. Public-WSS validation is recorded below separately.
- No new load benchmark or 100/500/1,000/2,000-peer capacity claim. Historical
  measurements predate these stricter limits. No real-account invitation/Google
  ACL flow or physical Android enrollment is certified by the fixtures.

Standalone images, account-order replication, Android grant UI, growing bounded
history, authority-key recovery, revoked-author historical catch-up and field/manual
conflict resolution remain the documented rollout limitations. This hardening does
not solve them by weakening trust, rewriting signed history or migrating user data.

## Operational evidence

Final build, deployment and public checks are appended after validation. Existing
private issuer key/registry must be preserved; backups stay root-only on the VPS.

Completed operational validation:

- Feature-free `cargo build --locked --release` from a coherent captured source
  snapshot: `local_artifacts/20261019T104810Z/` (service-local, ignored).
  Binary SHA-256:
  `e43c4d548740db49414b3611f0c97fe5972430f9527c5f41d4084c003426c0e1`.
- Updated the same previously authorized permanent OVH service, not a new public
  release. Root-only rollback backup:
  `/var/backups/pboard-signaling/20261019T105034Z/`. The issuer key was verified
  unchanged; its registry was not replaced. No secret was downloaded or printed.
  HAProxy candidate and application configuration validated before activation;
  service/proxy active, loopback/public health passed, unrelated routing preserved.
  The initial health assertion omitted the endpoint's trailing newline and caused
  automatic rollback; deployment was repeated with the corrected health check.
- Public WSS: two isolated production-flagged Chromium extension profiles passed
  signed project/card replication, reconnect, grant renewal/republication, device
  revocation, zero collaboration Google calls and simultaneous private appData
  backup fixture. Two isolated native Firefox profiles passed signed WebRTC/RxDB
  create/edit/reconnect through the same public service with production CSP.
- Public rejection probe passed: pre-auth join, unknown proxy operation, duplicate
  fields, untrusted web Origin, nonmembers, wrong authority, authorized arbitrary
  application data, captured publication replay. Valid SDP offer/answer and ICE,
  presence and reconnect passed. Legacy public Google verifier rejected an invalid
  token, challenge replay and a self-signed bound-room bypass. No valid Google
  account/token was used for public probes, and no public service restart was
  performed by those probes.
- Normal Firefox and Chromium packages built and verified. Firefox lint: zero
  errors/notices/warnings. Root and Android TypeScript checks passed. Full Vitest:
  **569 passed, 2 pre-existing failures** (`releaseMetadata`: VERSION/package
  mismatch; `standardsPolicy`: expected release-blocker wording). Neither failure
  was changed or hidden by this work. Legacy Drive native replication passed again.
- One pre-browser-test cgroup `MemoryCurrent` snapshot was 2,101,248 bytes with
  three tasks. This is neither process RSS nor idle/per-peer/peak load measurement.
  No new latency, CPU-load or target-capacity benchmark was run.

Reproduction from the repository root (Node 24 and stable Rust):

```sh
cargo fmt --manifest-path services/pboard-signaling/Cargo.toml --check
cargo clippy --locked --manifest-path services/pboard-signaling/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path services/pboard-signaling/Cargo.toml
npm run typecheck
npx tsc --noEmit -p apps/android/tsconfig.json
npx vitest run tests/boardGrants.test.ts tests/experimentalSignaling.test.ts
npm run build
npm run build:chromium
PBOARD_BOARD_GRANTS=1 node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_M02_USE_DRIVE=1 node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_GECKODRIVER=/path/to/geckodriver node services/pboard-signaling/firefox-webrtc-smoke.mjs
# Public probes use only disposable identities and short-lived diagnostic boards:
PBOARD_BOARD_GRANTS=1 PBOARD_M03_RELAY_URL=wss://pboard.cecosl.ovh/ws node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_GECKODRIVER=/path/to/geckodriver PBOARD_M03_RELAY_URL=wss://pboard.cecosl.ovh/ws node services/pboard-signaling/firefox-webrtc-smoke.mjs
node services/pboard-signaling/automatic-smoke.mjs wss://pboard.cecosl.ovh/ws
node services/pboard-signaling/google-enrollment-smoke.mjs wss://pboard.cecosl.ovh/ws
```

`cargo build --features test-google-fixture --manifest-path
services/pboard-signaling/Cargo.toml` followed by
`PBOARD_M04_GOOGLE_ENROLLMENT=1 node services/pboard-signaling/secure-browser-smoke.mjs`
reproduces the legacy Google fixture test. Never deploy that fixture build; the
coherent release helper deliberately enables no test features.

## Client pairing UX follow-up — 19 October 2026

Normal Pboard builds now expose human-approved connection codes around the existing
public grant metadata endpoints. Invitation signatures, ten-minute expiry, device
request signatures, matched verification codes, explicit owner roles, original
pins, membership and anti-rollback verification remain mandatory. The code itself
is not board authorization; Google identity is not consulted. Pending state is
local only, and cancellation is rechecked after metadata fetches. No server code,
protocol/limits, deployment or additional persistent server data was added.
The copy action requires separate explicit consent and uses a new board identity;
original signed provenance is not stripped in place. See the README/architecture
follow-up for tests, original-preservation evidence and the image-transfer limit.

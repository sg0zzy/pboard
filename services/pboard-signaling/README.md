# Pboard signaling — independent board grants (milestone 0.5)


## Automatic Google account sharing — current flow

Use the normal production build; Drive signaling remains the default. Both
profiles opt into **WebRTC collaboration → Enable WebSocket collaboration** and
allow the selected WSS host. Connect Google using the existing account control.
The selected unsigned local board initializes its own authority automatically;
existing independent board authorities are reused, never replaced.

- **Same Google account:** the other profile discovers the board and requests its
  device grant automatically. Keep the original authority browser on the board.
  Select **Open shared board** in the available-boards list if it is not already
  local. No invitation code, JSON or manual initialization is needed.
- **Different accounts:** the original authority browser uses **Share project →
  Invite by email**, choosing Editor or Viewer. The invited account discovers the
  board under WebRTC collaboration and opens it after automatic device approval.
  Removing an invitation revokes the account's automatically enrolled device grants.
  Separate manual/code grants remain explicit device authorizations; revoke those
  fingerprints in Advanced when removing their access.
- Google proves identity, not board membership. The local board authority signs
  both an expiring email policy and the final device manifest. A new device has no
  room access until that manifest contains its key. The server verifies identity
  through Google's `/about` endpoint only, never Drive ACLs/files for this path.

The explicitly selected TLS service is trusted to verify Google identity honestly;
its verifier receives a transient existing access token, never stores it, and must
not log it. Root private keys stay local. This is an additional trust dependency
compared with manual code pairing. No new Google OAuth scope is requested.

Server operators enable `PBOARD_SIGNALING_GOOGLE_IDENTITIES=1` alongside board
grants and the existing configured Google verifier. The legacy two-email
`PBOARD_SIGNALING_GOOGLE_EMAILS` allowlist continues to restrict only the old Drive
ACL broker; the new identity-only flow accepts verified accounts **only under
owner-signed board policies/grants**. Proxy routes must include
`/identity/challenge` and `/identity/exchange`. The OVH experimental service has
this enabled; no user key/registry or Drive data was migrated.

Job 8 adds a separate Google **service admission** receipt to independent
board-grant WebSockets. Google still grants no board membership. The client
obtains a single-use receipt for the actual socket challenge, session, room and
device over the existing identity HTTP endpoints; board-grant authentication is
unchanged and still mandatory. See [protocol details](PROTOCOL.md#google-service-admission-job-8)
and [offline authorization/recovery limits](../../docs/architecture/offline-authorization.md).

Public binary startup (`PBOARD_SIGNALING_REQUIRE_TLS_PROXY=1`) now fails without a
configured Google verifier; independent board grants additionally require
`PBOARD_SIGNALING_GOOGLE_IDENTITIES=1`. Existing public configurations must supply
these settings before a separately authorized server update. Older clients fail
closed against the new Google-required gate. Loopback authenticated fixtures can
still run without real Google. Nothing in Job 8 deploys or updates the running
public service.

Keep the original authority browser online for first enrollment and five-minute
membership renewal. Discovery policies expire after ten minutes and are
republished by that browser after a service restart. Secondary devices on the
same account receive Editor grants, without the root private key: invitation
management still requires the original authority browser. No unattended
owner-offline enrollment, asynchronous content mailbox, image transfer or root-key
recovery was added. WebRTC catch-up requires simultaneous online peers; existing
private Drive backup/recovery behavior remains separate. Legacy signed/Drive-trust
boards refuse automatic authority migration; use their original provider or the
explicit collaborative-copy operation, which preserves the original.

Reproduce the new native Chromium tests (Google HTTP simulated, real WebRTC/RxDB):

```sh
cargo build --manifest-path services/pboard-signaling/Cargo.toml --features test-google-fixture
PBOARD_BOARD_GRANTS=1 PBOARD_GOOGLE_IDENTITY_SHARING=1 node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_BOARD_GRANTS=1 PBOARD_GOOGLE_IDENTITY_SHARING=1 PBOARD_M02_SAME_ACCOUNT=1 node services/pboard-signaling/secure-browser-smoke.mjs
node services/pboard-signaling/identity-smoke.mjs
```

Rebuild the fixture binary immediately before fixture tests: `cargo test` can
replace `target/debug/pboard-signaling` with a feature-free binary. Never deploy a
`test-google-fixture` build. Public probes use intentionally invalid credentials;
no real account or board is accessed. Live positive enrollment with real Google
accounts remains a user check.

## Manual pairing without Google (retained option)

The rebuilt normal Firefox/Chromium extensions now include **WebRTC collaboration
→ Manual pairing without Google → Connect another browser**. Reload the extension in both real browser profiles.
This uses real board/device keys and the existing public grant metadata service;
no test launcher, private API key, Google login or server change is needed.

1. Both browsers: expand **WebRTC collaboration**, keep
   `wss://pboard.cecosl.ovh/ws`, click **Enable WebSocket collaboration** and allow
   that host. Drive can stay connected for its existing persistence functionality.
2. Browser A: select a text-only local board, click **Share selected board**, and
   send its **Invitation code** to Browser B through a trusted channel.
3. Browser B: paste into **Invitation from Browser A**, click **Request access**,
   then send **Device code** back to A. This grants no board access yet.
4. Browser A: paste into **Device code from Browser B**, click **Review device**,
   compare the displayed verification code in both browsers, check the confirmation,
   choose Editor/Viewer and click **Approve device**. B automatically verifies its
   signed grant, connects through WebRTC, receives the board and selects it.

There is no JSON editing, fingerprint transcription or third grant-copy step.
Use two independent profiles; two windows of one profile share a device identity.
Codes expire after ten minutes. Keep the owner on the board for five-minute grant
renewal. Pending requests survive sidebar reload, can be cancelled, and cannot
replace an already pinned authority. The status in this panel refreshes every
second; it is the manager's current state, not a diagnostic history entry.
Advanced manual grants and revocation remain under their own collapsed section.
The Invite by email dialog follows the selected mode: signed account invitations in WebSocket mode, existing Drive sharing in Drive mode.

For a board with signatures from the earlier experiment, expand **Existing board
from an earlier collaboration setup?**, confirm the explicit copy action and click
**Create collaborative copy**. Pboard creates a new UUID, new card IDs and a new
owner authority for a separate board named `… (collaboration copy)`, retaining
current card content, titles, order, statuses and source references. It leaves the
original documents, signatures, tombstones and authority unchanged. It is an owner
attestation of a new copy, not proof of the old documents' provenance, an in-place
migration or a full backup. The new invitation is produced automatically; continue
with B's request and A's approval above. Do not delete the original profile/board.

Boards containing images are refused by these sharing/copy controls before copying
because standalone image transfer is still unavailable. No images are silently
dropped. Account-order replication, durable authority-key recovery and advanced
conflict workflows remain follow-up work; existing LWW conflict behavior remains.
Device approval is intentionally required even when both browsers use the same
Google account. Default signaling stays Drive until a user explicitly opts in.

Reproduce actual-sidebar integration after ordinary managed builds:

```sh
npm run build
npm run build:chromium
node services/pboard-signaling/pairing-ui-smoke.mjs
PBOARD_GECKODRIVER=/path/to/geckodriver node services/pboard-signaling/firefox-pairing-ui-smoke.mjs
```

These use two disposable native profiles and the actual built sidebar, not the demo
UI. The test manifest alone pre-grants the one optional relay origin, representing
a user accepting the native host-permission prompt. They exercise the real UI,
service, runtime, signatures, DataChannel and RxDB; neither authentication nor
storage guards are mocked. The scenario checks no board data before approval,
pending-request reload recovery, automatic receipt, editing, reopening, explicit
signed-board copying and original preservation. No real Google account is used.
Normal manifest permissions/scopes, server protocol and deployment are unchanged.


## One-command automatic test and visible demo

From the repository root, use Node 24 (`nvm use`) and installed dependencies
(`npm ci`, if needed). Requires Chromium on PATH, or set `PBOARD_CHROMIUM_BIN`.
No Rust build, SSH, Google login, manual JSON exchange or installed extension is
needed against the existing public WSS service.

```sh
npm run test:collaboration      # automated positive and negative tests; exits
npm run demo:collaboration      # automatically enrolls two devices; leaves two windows open
```

The demo creates **fresh temporary Chromium profiles** and a fresh authority. It
approves the second device as editor, pins the owner's authority, verifies real
DTLS/signed RxDB changes in both directions and reconnect catch-up, then exposes a
small test UI in both windows. Add/edit/delete text cards in either window, or use
Disconnect/Reconnect. Keep the launching terminal open; press **Ctrl+C** to close
only the test browsers and remove their temporary profiles. Closing a browser
window independently interrupts the test. Demo data is disposable and is not a
backup. The test browser uses the existing harness's `--no-sandbox`; use only this
disposable fixture, never a personal browsing session.

This is a generated diagnostic extension bundle using the real runtime, guards,
WebRTC and RxDB, with a minimal test UI. It does not exercise the normal sidebar's
manual enrollment controls or migrate old boards. The trusted local test driver
controls both temporary profiles and performs the explicit owner approval/pin
exchange; server authentication and board authorization remain enforced. No private
keys are embedded in source, copied from your profiles, logged or uploaded.
Standalone collaboration makes no Google calls. The full headless test additionally
checks concurrent appData persistence against a local Google HTTP fixture, not a
real account. It checks revocation; the visible demo keeps the editor authorized.

Both commands default to `wss://pboard.cecosl.ovh/ws`; an operator-approved alternate
can be supplied as `-- --url=wss://your-service.example/ws`. Endpoints must use WSS,
end in `/ws`, and have no credentials/query/fragment. There is no insecure fallback.
The public service receives only normal short-lived synthetic grant/signaling
traffic; the launcher never deploys, restarts or reconfigures it.

For automated checking of the demo UI without a display:

```sh
npm run demo:collaboration -- --headless --duration=12
```

Setup still performs real enrollment and a card creation through the demo's HTML
form; the peer must receive and render it. The duration applies after setup and
allows the sidebar-equivalent ten-second grant polling to run. Ordinary demo mode
needs a graphical desktop; the headless test works without one. Exit nonzero means
the test failed; it is not hidden as a successful launch. The source and isolated
browser data are temporary and deleted on normal exit/Ctrl+C; abrupt process/host
termination can leave private temporary profiles in the OS temporary directory.
Your existing board's foreign-authority signatures remain a separate explicit
migration requirement. This demo does not strip or rewrite them.


Current public-service hardening: see [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for the
before/after audit, enforced budgets, negative tests and residual limitations.
Grant publication now uses a fresh authority challenge (publication protocol 2).
**Reload the extension in all participating browsers after updating**; old static
publications are rejected. The original authority profile must be available to
restore the in-memory grant cache after restart. Device/authority keys and grant
bundle version 1 remain compatible. No authorization fallback is provided.

Ordinary production builds now expose **WebRTC collaboration** as a normal opt-in.
Drive signaling remains the default. Drive persistence stays separately controlled:
it can remain connected while WebSocket signaling/WebRTC run. No OAuth scopes,
existing Drive folders/files/permissions, RxDB schemas or existing users are migrated.

The actual legacy application has both private appData and shared Drive folders.
The old Google enrollment experiment authorizes from Drive ACLs; it is preserved
for compatibility, **not** the authorization model for this new opt-in. Independent
boards use an out-of-band pinned owner authority and explicit signed device/role
grants. Google authentication/email/board-ID knowledge alone grants no board access.
See the [architecture review and limits](../../docs/architecture/websocket-signaling-experiment.md#current-architecture-review-and-correction--19-october-2026).

Local service and normal extension build:

```sh
cargo build --locked --manifest-path services/pboard-signaling/Cargo.toml
# Create only if absent; preserve any existing operator grants.
test -f services/pboard-signaling/grants.local.json || \
  (umask 077; set -C; printf '%s\n' '{"rooms":{}}' > services/pboard-signaling/grants.local.json)
PBOARD_SIGNALING_GRANTS="$PWD/services/pboard-signaling/grants.local.json" \
PBOARD_SIGNALING_BOARD_GRANTS=1 RUST_LOG=pboard_signaling=info \
  services/pboard-signaling/target/debug/pboard-signaling

# In another shell: no experimental flags needed for a normal build.
npm run build                 # Firefox: reload the existing add-on from dist/
npm run build:chromium        # Chromium: reload dist/chromium/
# Expand WebRTC collaboration. Use an operator-approved WSS service ending /ws.
# Normal production builds refuse plaintext, including loopback.
# For fully isolated local browser testing:
PBOARD_BOARD_GRANTS=1 node services/pboard-signaling/secure-browser-smoke.mjs
```

The first command creates a private ignored test config; do not overwrite an
existing nonempty grants file. A local plaintext server is intended for the native
development test harness or a local TLS proxy, not a production browser endpoint.
`node services/pboard-signaling/build-local-release.mjs` captures coherent Rust
inputs, builds feature-free `--locked --release`, and retains the standalone binary
plus digest/provenance in ignored `local_artifacts/`; it never deploys anything.

Onboarding (no browser console/SSH required):

1. Both browsers: expand **WebRTC collaboration**, choose the same WSS service,
   click **Enable WebSocket collaboration**, and approve that host permission.
2. Owner: select a local board without an existing collaboration authority, confirm
   authority creation, then **Create / renew board invitation**. Send the separate
   **Public output** to the joining browser through a trusted channel.
3. Joining browser: paste into **Board grant input** and click **Create my device
   request**. Send its **Public output** back to the owner. This grants no access yet.
4. Owner: paste the device request, independently compare its `deviceKeyId`, enter
   that fingerprint, confirm verification, choose editor/viewer, and **Owner:
   approve device request**. Send the resulting approved public bundle back.
5. Joining browser: paste the approved bundle, independently compare its
   `authorityKeyId`, enter that fingerprint, confirm verification, then **Connect
   approved board**. The owner must have the board open. Signed board contents
   arrive over WebRTC; there is no unsigned placeholder or shared Drive import.

The authority browser must stay available for five-minute grant renewal. The server
caches only bounded public signed authorization metadata in memory and exposes it
through `/grants/*`; no board contents/images/credentials are put there. Admission
still proves the enrolled device key against a fresh WebSocket challenge/session.
Switching off WebSocket does not disconnect Drive or clear keys/pins/data.

The existing OVH service at **wss://pboard.cecosl.ovh/ws** now enables the independent
board-grant path for any explicitly approved device, without an email allowlist.
Its old Google/Drive-ACL broker remains restricted to the original two test accounts
for compatibility. Two production-flagged Chromium profiles passed the independent
flow against public WSS. There was no OAuth/data/authority migration or release
publication. Detailed authorization, artifact digest, rollback and test evidence
are in the architecture document above.

Remaining rollout limits: standalone image transfer, account-order replication and
Android grant onboarding are not integrated; history is bounded and grows with
renewals; historic mutations by removed/downgraded devices can block new-peer catch-up.
Conflict handling remains existing document last-write-wins, not field merging or
persistent manual conflict resolution. These are explicit follow-up work, not
reasons to weaken authorization, reset trust or discard history. No new load or
capacity figures are claimed. The detailed review lists recovery/rollout gates.
Private content backups do not export the separate authority/device keys; preserve
the original authority profile. Existing 0.4-signed boards require a reviewed trust
migration, so use an unsigned local board for initial independent-grant testing.

The following 0.4 instructions are historical compatibility procedures.

**Legacy OVH mode:** Google-verified enrollment, restricted to
`stefanogozzi@gmail.com` and `gozzi@balsamiq.com`. Use the milestone 0.4 procedure
below; the earlier manual JSON procedure is retained for legacy/local deployments.

The Rust relay and authenticated transport from milestone 0.1 now have an explicit
**development extension build**, enrollment UI and secure WebRTC/RxDB integration.
Drive remains the default in ordinary builds. Milestone 0.3 adds automatic signed
room admission (relay protocol 2); operator-grant protocol 1 remains available.
The original local milestones include no OAuth migration, data migration or production
release. A separately authorized persistent experimental VPS installation is recorded below.

Do **not** open `localhost:5173/sidebar.html` to run Pboard: the sidebar needs native
extension APIs. The earlier standalone-Vite/console instructions were incorrect.
No console snippets or handwritten grants are required by the workflow below.

## First: automated local demonstration

Requires stable Rust, Node 24.15+, repository `npm ci`, and Chromium on PATH (or
`PBOARD_CHROMIUM_BIN`). The Rust executable needs a native linker during compilation;
follow <https://www.rust-lang.org/tools/install> for the stable toolchain.

From the repository root:

```sh
cargo build --locked --manifest-path services/pboard-signaling/Cargo.toml
node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_M02_SAME_ACCOUNT=1 node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_M02_USE_DRIVE=1 node services/pboard-signaling/secure-browser-smoke.mjs
```

These tests create two isolated **extension profiles**, perform signed device
requests and explicit out-of-band fingerprint approval through a trusted test driver,
then run the production `createDriveRuntime`, manager, mutation guards, native WebRTC
and RxDB. They check edits, deletion, project rename, reconnect catch-up and existing
Drive snapshot/image paths. The first models different owner/editor Google accounts;
the second models two devices of one account. The third uses the existing Drive
signaling provider through the same real security/replication code, without Rust. Only Google's HTTP API is a deterministic
local fixture. No authentication/manifest/storage-guard doubles are installed. Private
keys stay in temporary profile storage; only public signed authorization and signaling
reach the relay. The local relay starts with an empty legacy allowlist.
Temporary profiles are removed on completion. These scripts do not log in to real Google.
They use Chromium's `--no-sandbox` flag for isolated headless development tests only.

The older `browser-smoke.mjs` remains an adapter-only test. It does not test DataChannels.

## Install the actual development extension

Use dedicated test browser profiles. Compatibility IDs are preserved; loading this
build into a profile with the regular extension can replace that installation.

```sh
node scripts/build-signaling-experiment.mjs firefox
# Or:
node scripts/build-signaling-experiment.mjs chromium
```

These explicit managed builds compile the experimental provider and enrollment UI,
add only the configured relay host to the generated development manifest, label it
`Pboard (signaling experiment)`, and stage unpacked files at `dist/` (Firefox) or
`dist/chromium/` (Chromium). Verified ZIPs/provenance are under `local_artifacts/`.
Tracked manifests, OAuth scopes, VERSION, existing IDs and normal build defaults
remain unchanged. The generated endpoint defaults to `ws://127.0.0.1:8787/ws`.
Override it at build time if needed:

```sh
VITE_PBOARD_SIGNALING_WS_URL=wss://your-reviewed-test-relay.example/ws \
node scripts/build-signaling-experiment.mjs firefox
```

Plain WS is accepted only for explicit loopback development. No DNS or relay is
provisioned by that command. `npm run build` / `npm run build:chromium` produce
ordinary Drive-default builds even if the earlier VITE provider flag is set.

Firefox: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**,
and select `dist/manifest.json`. Open Pboard's browser sidebar. Chromium: open
`chrome://extensions`, enable Developer mode, choose **Load unpacked**, select
`dist/chromium`, and open its side panel. Its UI has **Experimental device enrollment**.

For a real Google test, use the existing configured OAuth test accounts. Create a
fresh test project, connect Google Drive, and enable sharing through the existing
Share dialog. Invite the second account through Drive if applicable; have both
clients discover/select the same shared project. Do not create two unrelated boards
with the same display name. Real Google invitation/ACL/OAuth flows are not certified
by the simulated HTTP test.

## Enroll devices through the UI

Authorizations last **five minutes** under the existing protocol-2 limits. Client
enrollment still requires an attended test even when the relay runs persistently.
Prepare both clients first.
Enrollment actions stop the current local manager before changing authority state.

1. On the first device of each Google account, choose **Initialize / renew my account**.
   This publishes that account's signed manifest in its existing private app-data path.
   The account authority private key stays on that first device.
2. On the board owner's first device, choose **Initialize / renew board authority**.
   This publishes the expected `pboard-manifest.json` security file in the existing
   shared folder. Existing board/card data is attested only after this explicit owner
   action; content is retained, write timestamps advance and signatures are added.
3. On another device, choose **My board device request**, then **Download public JSON**.
   Transfer that file to the board authority owner. Compare the device fingerprint
   AND Google email through a separate trusted channel. The owner loads the request,
   enters that independently verified fingerprint/email, checks the verification
   box and chooses **Owner: approve device request**. Drive ACLs determine its role;
   the request's self-reported role/email alone is insufficient authorization.
4. The owner downloads the resulting signed authority bundle. The recipient loads it,
   enters the authority fingerprint verified separately with the owner, checks the box,
   and chooses **Trust authority bundle**. A bundle cannot pin itself automatically.
5. Two devices of the **same** Google account must also repeat request/approval/trust
   using **My account device request** and that account's first authority device.
   Different users initialize their own separate account authorities; a board owner
   cannot authorize another user's private account room.
6. Choose **Start / restart live collaboration** on both clients. The experimental
   provider automatically presents the verified authority-signed manifest and proves
   possession of its enrolled device key to the relay. **No grant export, server
   upload or SSH is needed.** The first trust/enrollment steps above remain mandatory.

For a local automatic-admission relay, create an empty legacy configuration and start:

```sh
# Create this dedicated file only if it does not already exist:
(umask 077; set -C; printf '{"rooms":{}}\n' > services/pboard-signaling/grants.local.json)
PBOARD_SIGNALING_GRANTS="$PWD/services/pboard-signaling/grants.local.json" \
PBOARD_SIGNALING_AUTOMATIC_ADMISSION=1 \
RUST_LOG=pboard_signaling=info \
services/pboard-signaling/target/debug/pboard-signaling
```

If that file already exists, inspect its public configuration privately; the command
intentionally refuses to overwrite it. The service defaults to `127.0.0.1:8787`,
refuses non-loopback binding and exposes `/healthz`. Put remote instances behind TLS.
`PBOARD_SIGNALING_AUTOMATIC_ADMISSION` defaults to 0 for standalone deployments;
the reviewed persistent-service unit explicitly enables it. No Google credentials
are required by the relay.

After five-minute authorization expiry, stop live sessions and renew account/board
manifests on their original authority devices. Already pinned clients can read the
new signed manifests from Drive when restarting live collaboration; a changed
membership epoch must agree across participants. An initial untrusted device still
needs explicit owner approval and authority fingerprint verification. No server-side
upload/restart is needed to admit the renewed manifests. Automatic renewal and safe
historical-mutation verification are a separate next milestone; do not widen expiry
or disable signature checks as a workaround.

The optional **Export legacy relay grants (optional)** control, `merge-grants.mjs`,
`deploy/update-grants.mjs` and protocol-1 probes are retained for operator-grant
compatibility. They affect legacy rooms only and are not part of normal automatic
admission. An empty legacy allowlist **does not disable protocol 2** when automatic
admission is enabled. Stop the service, or disable automatic admission and restart,
to shut off automatic access. Publishing a newer signed membership manifest revokes
older observed epochs; see the protocol's bounded, in-memory revocation limitations.

## Diagnosing first-time enrollment

Experimental builds expose **Experimental device enrollment → Live collaboration
diagnostics** and emit the same local events in the sidebar page's developer console
with the prefix `[pboard collaboration]`. The history holds at most 100 events and
can be cleared. Events distinguish manifest verification, relay authentication,
room join and peer count, WebRTC negotiation, DataChannel connection, mutual-proof
acceptance, disconnect and reconnect scheduling. `count` on `reconnect_scheduled`
is the delay in milliseconds. A socket being joined does not mean replication is
authorized: look for `webrtc.replication_authorized` on both peers.

On OVH, follow server events with:

```sh
ssh cecosl 'journalctl -u pboard-signaling -f -o cat'
```

The first 12 characters of the server `session` match the frontend's relay events.
Logs record authentication, hashed room identifiers, joined peer count, forwarding
count and disconnect reason/duration. Individual forwarding events are debug-level;
ordinary info logs remain bounded by session activity. Neither diagnostic path logs
Google tokens, signatures, SDP/ICE payloads, document contents or images. Diagnostics
are local/journal output, not remote frontend telemetry. Ordinary Drive builds do
not emit the experimental frontend history.

The old message "Collaboration requires a trusted security manifest" is ambiguous:
account authorization is checked before board authorization, and the old runtime
collapsed missing pins, unavailable Drive files and failed verification into null.
It does not mean the relay rejected the device, nor that matching Gmail identities
are sufficient enrollment. Experimental builds now name the account/board and
missing trust, missing manifest, Drive read error, authority mismatch, expiry,
missing device membership, binding mismatch or rejected acceptance history.
Messages are fixed locally; Drive bodies, private keys and tokens are not displayed.
No failed check initializes authority, changes pins or opens signaling automatically.

Reload the updated temporary extension in the same profile, restart collaboration,
and read its exact status. On the original authority profile initialize/renew the
account and selected board; on a second profile generate and approve/trust both
account and board requests. Do not initialize a separate authority on that second
profile. The selected board must have **Share project → Enable live collaboration**;
this does not require inviting a different Gmail account. Two ordinary windows of
one browser profile can share a device identity and are not two independent devices.

The public same-account browser probe additionally tests manual renewal with
`PBOARD_M03_TEST_RENEWAL=1`: original owner renewal, already-pinned peer restart,
and signed edits after the epoch change, without trust-bundle re-import or server
uploads. Google HTTP remains simulated. A real-user failure still needs the exact
scoped status and browser/profile information; passing fixture tests do not identify
its cause.

## Tests, benchmark and deployment preparation

```sh
cargo test --locked --manifest-path services/pboard-signaling/Cargo.toml
cargo clippy --locked --manifest-path services/pboard-signaling/Cargo.toml --all-targets -- -D warnings
npm run typecheck
npx vitest run tests/deviceEnrollment.test.ts tests/liveMutationSigning.test.ts tests/replicationRequests.test.ts tests/experimentalSignaling.test.ts
node services/pboard-signaling/extension-ui-smoke.mjs # after the Chromium dev build
# Optional native Firefox UI check, requires geckodriver on PATH:
node services/pboard-signaling/firefox-ui-smoke.mjs
cargo build --release --locked --manifest-path services/pboard-signaling/Cargo.toml
node services/pboard-signaling/benchmark.mjs 100 500 1000 2000
```

The original adapter integration suite skips explicitly when the debug Rust executable
is missing; build first. The UI smokes load the actual experimental Chromium/Firefox packages and
check rendered enrollment controls. Firefox uses geckodriver 0.37.1, available from
<https://github.com/mozilla/geckodriver/releases/tag/v0.37.1>; override its path with
`PBOARD_GECKODRIVER` and Firefox with `PBOARD_FIREFOX_BIN` if needed. Its
`--allow-system-access` flag grants WebDriver control only over its disposable test
profile; it does not disable collaboration validation. The secure integration
probe is an isolated extension fixture using the real runtime, not a regular web page.
The old Drive browser convergence harness remains unchanged and still uses its
explicit authentication double; it is regression evidence only.

[PROTOCOL.md](PROTOCOL.md) defines relay admission/limits. [Architecture and validation](../../docs/architecture/websocket-signaling-experiment.md)
records security changes and remaining limits. [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md)
retains historical milestone-0.1 relay-only results; they are not measurements of
protocol-2 authentication or current VPS capacity.
No new VPS capacity or performance claims are made for milestone 0.3.

Android shares the runtime/security fixes. Physical-device/WebView tests are not run;
no OAuth, packaging or cleartext-network policy changes were made. Firefox development
packages pass build/lint and native UI checks; Firefox end-to-end replication with
real Google enrollment still requires manual verification. Android enrollment UI
is not added in this browser-focused milestone. Don't infer that this milestone is ready for public deployment.

The release server is a standalone executable on a compatible Debian/glibc version.
Cargo target executables are build intermediates, not published artifacts.
`deploy/pboard-signaling.service` is the persistent-service template. `deploy/Caddyfile`
is an alternative proxy example; the owner's VPS already uses HAProxy, so do not
install Caddy alongside it. `deploy/haproxy.cfg.fragment` prepares the extra host route,
path restrictions, request-rate limit and WebSocket timeout for the existing proxy.

## Persistent experimental VPS service

On 18 October 2026 the owner explicitly authorized a permanent experimental service
on `cecosl` (OVH, Debian 13 x86-64). This supersedes the earlier local-only deployment
restriction for this destination, not for publication or other infrastructure changes.

Installed and verified:

- `/opt/pboard-signaling/pboard-signaling`, owned by root, executable by the dedicated
  non-login `pboard-signaling` system account.
- `/etc/systemd/system/pboard-signaling.service`, enabled at boot with restart-on-failure,
  filesystem/privilege restrictions, resource limits and core dumps disabled.
- `/etc/pboard-signaling/grants.json`, root-owned, service-group-readable (0640).
  `{"rooms":{}}` disables legacy operator-grant admission. Automatic admission is
  explicitly enabled by the unit: clients need signed membership, not server uploads.
  Empty or expired legacy allowlists do not cause startup failure.
- Listener `127.0.0.1:8787` only; `/healthz` returns `ok`. No public port was opened.
- SHA-256 of the 18 October installed binary (superseded by the diagnostic update below):
  `9b2c84bee645baf0f24e6b4429fba1e3f5b2fe4a2812a6cd11636f0ae160abfe`.
  The isolated-source release build and provenance are retained under the ignored
  `local_artifacts/20261018T151350Z/` within this service directory. No release/tag was made.

**Public endpoint active:** the owner configured `pboard.cecosl.ovh` to
`164.132.195.137`. On 18 October 2026 TLS and HAProxy routing were activated for
`wss://pboard.cecosl.ovh/ws`. `https://pboard.cecosl.ovh/healthz` returns `ok`;
other application paths return 404. The Caddy example is not deployed.

Rebuild explicitly for the public relay, then reload the temporary extension in
the same test profile to preserve local data/device keys:

```sh
VITE_PBOARD_SIGNALING_WS_URL=wss://pboard.cecosl.ovh/ws \
  node scripts/build-signaling-experiment.mjs firefox
# Or replace firefox with chromium.
```

The WSS build needs no SSH tunnel. Firefox: Reload in `about:debugging`; Chromium:
Reload on the extension's entry in `chrome://extensions`. Enrollment above remains required before live collaboration can connect; relay
authorization is then automatic.

Older loopback builds can alternatively reach the persistent service through a tunnel:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8787:127.0.0.1:8787 cecosl
```

Stop a local test relay first if it already owns port 8787. The existing experimental
extension's loopback URL then reaches the VPS; no extension rebuild is needed.
Enroll using the UI above and start live collaboration. The deployed server supports
automatic admission; client users need neither SSH nor a server allowlist update.
Owner approval, authority pins and five-minute expiry remain enforced.

TLS uses the existing Certbot installation and a dedicated `pboard.cecosl.ovh`
certificate, valid until 16 January 2027 at issuance. Renewal is scheduled by the
existing Certbot timer; the installed `/etc/letsencrypt/renewal-hooks/deploy/20-pboard-signaling-cert.sh`
checks hostname, expiry and certificate/key correspondence, atomically updates
`/etc/haproxy/certs/pboard-signaling.pem`, validates HAProxy and reloads it. Private
material stays on the VPS. The hook was exercised with the issued certificate;
a future renewal/dry-run has not been exercised. The mate renewal hook is unchanged.

HAProxy retains the mate certificate/route and adds only the new host/backend.
Signaling paths have an IP request-rate limit (60 requests per 10 seconds), 64
backend connections and a 60-second WebSocket tunnel timeout; clients heartbeat
every 15 seconds. Application authentication/room limits remain mandatory.
Configuration was validated before reload and backed up at
`/var/backups/pboard-signaling/20261018T144211Z/haproxy.cfg` (root-only). After
activation mate still returned its expected HTTPS 302 login redirect. No firewall,
ordinary build default, Google OAuth or Drive storage changes were made.

Operational checks and stop/start commands:

```sh
ssh cecosl 'systemctl is-enabled pboard-signaling; systemctl is-active pboard-signaling'
ssh cecosl 'curl --fail --silent http://127.0.0.1:8787/healthz'
ssh cecosl 'systemctl restart pboard-signaling'
# Disable the experiment while preserving the binary and grants:
ssh cecosl 'systemctl disable --now pboard-signaling'
# Resume it:
ssh cecosl 'systemctl enable --now pboard-signaling'
```

Do not dump service environments, certificate bundles or unfiltered logs into reports.
Preserve approved grants before updates. A server restart loses signaling sessions;
clients reconnect, subject to still-valid manifests/grants. The enabled unit was
checked without rebooting the VPS or interrupting the existing website.

Automatic public-relay diagnostic, with no Google account, SSH or server changes:

```sh
node services/pboard-signaling/automatic-smoke.mjs wss://pboard.cecosl.ovh/ws
```

It generates an ephemeral authority and two device keys, creates only its own
short-lived diagnostic namespace, and tests unauthorized-device/authority-impersonation
rejection, offer/answer/ICE forwarding, presence and reconnect. Private keys stay in
memory; no operator grants are installed. It does not test a DataChannel.

For full native Chromium WebRTC/RxDB validation through the public relay:

```sh
PBOARD_M03_RELAY_URL=wss://pboard.cecosl.ovh/ws \
  node services/pboard-signaling/secure-browser-smoke.mjs
# Add PBOARD_M02_SAME_ACCOUNT=1 to model two devices of the same Google account.
# Add PBOARD_M03_TEST_RENEWAL=1 to exercise owner renewal and already-pinned
# peer restart without re-importing trust bundles, followed by another signed edit.
```

This uses two isolated extension profiles, real enrollment/crypto/guards/DataChannels
and RxDB. Google HTTP/ACL/image storage is a deterministic local fixture, not real
Google authentication; only signaling reaches the public relay. The external server
is not restarted by this test. Its observed WebSocket frames contain no board/card
RPC documents or image data. Full Firefox replication and real Google ACL/revocation
still need manual verification. The legacy initial-install `deploy/smoke.mjs` refuses
a protocol-2 server to avoid disrupting active clients.

All 16 Rust integration tests, strict Clippy, the seven provider/default integration
tests and Android's 98 tests passed. Full root tests: 540 passed, two existing
release metadata/policy failures remain (VERSION/package mismatch and unresolved
Android production history/signer expectation). See the architecture record for the
current integration results. No VPS load/capacity benchmark or reboot test was run.


### 19 October 2026: correlated experiment diagnostics

The owner requested real-service testing restricted to two named Google accounts,
and useful frontend/server debugging. The diagnostic portion is implemented and
installed on the existing OVH service under that authorization. The new binary
SHA-256 is `a094fa05ed334356196bfd80accf5a31dda896a0db0ae278470fc343142fa3e2`;
its isolated source build/provenance is retained in
`services/pboard-signaling/local_artifacts/20261019T053418Z/`. The previous binary
and unchanged systemd unit are backed up at
`/var/backups/pboard-signaling/20261019T053418Z/` on OVH. Public health and automatic
admission/negative probes passed after replacement. No OAuth scope, Google files,
trust pin, signing key, default provider, proxy rule or schema was changed.

The experimental frontend now has a 100-entry local history and console events;
relay session prefixes correlate with server connect/authenticate/join/disconnect
records. WebRTC events distinguish transport connection from verified mutual proof
and permission to start replication. Server summaries include forwarding counts,
duration and fixed disconnect reasons; payloads are omitted. Production Drive
builds emit no experiment history. Two tests verify bounded history, metadata
projection, absence of injected credentials/content and the ordinary-build guard.

Validation: all 16 Rust protocol tests; 34 focused frontend/runtime/admission tests;
root and Android TypeScript checks; strict Rust Clippy and formatting; verified
experimental Firefox and Chromium packages (Firefox lint: zero issues); native
Chromium packaged UI including the diagnostic panel. Two real Chromium profiles
passed same-account enrollment/renewal over public WSS, followed by a post-update
owner/editor two-account public-WSS probe exercising signed card create/edit/delete,
project rename, offline catch-up/reconnect, guarded DataChannel replication and
fixture Drive snapshots/images. Google HTTP was simulated in both probes, not real
Google-account verification. The public adapter probe also rejected nonmembers and
authority impersonation and forwarded offer/answer/ICE. Journal correlation and
forwarding summaries were observed, with no fixture content sentinel. Firefox
native UI was not rerun on this host because geckodriver is unavailable. No new
load or performance-capacity measurement was made.

**Pending authorization design:** the requested email-only automatic enrollment
is not implemented or enforced by this update. An email allowlist alone cannot
replace proof of identity or the client's existing trusted-manifest guards. The
original experiment forbids the server from connecting to Drive. The owner has
been asked whether to permit transient Google access-token verification for
identity and Drive permission metadata (no refresh tokens, persistence, payload
reads or token logs). No token transmission or verification endpoint is enabled
while that exception is pending; current signed-device admission remains active.


## Milestone 0.4: current two-account Google-verified OVH test

On 19 October the owner explicitly approved transient Google access-token checks
for identity and board permission metadata. This supersedes the original no-Drive
server constraint **only for this optional experiment** and makes OVH a trusted
manifest authority. The active allowlist is exactly `stefanogozzi@gmail.com` and
`gozzi@balsamiq.com`. A claimed email, extension ID or User-Agent is insufficient.

### Try the already-built extensions

1. Reload the existing temporary Firefox extension from `dist/` in
   `about:debugging`, or the unpacked Chromium extension from `dist/chromium/` in
   `chrome://extensions`. Keep the same profiles and local data/device keys.
2. In browser A (the original owner with current board data), connect the desired
   Google account, open the board, and use **Share project → Enable live
   collaboration** if it is not already enabled. Open **Experimental device
   enrollment → Connect / reconnect with Google**. Connect A first.
3. In B, connect either the same allowed account or the second allowed account.
   For a different account, invite it through the existing Drive Share dialog and
   open that same discovered board. Click **Connect / reconnect with Google**.
4. The frontend refreshes permissions every ten seconds, including enrollment and
   renewal. Wait for **connected browser**, then edit a card and verify both views.
   No Initialize, request, approve, trust, JSON transfer or SSH grant upload is needed.

Use **Live collaboration diagnostics**, the sidebar console prefix
`[pboard collaboration]`, and `ssh cecosl 'journalctl -u pboard-signaling -f -o cat'`.
The owner must connect at least once before an editor can establish a board grant.
If the returned Google account is not one of the two allowed primary emails,
admission fails closed. Workspace aliases, groups, domains and large/paginated
ACLs are outside this experiment.

### Rebuild this mode

From the repository root, with the Node toolchain in PATH:

```sh
export VITE_PBOARD_SIGNALING_WS_URL=wss://pboard.cecosl.ovh/ws
export VITE_PBOARD_SIGNALING_GOOGLE_ENROLLMENT=1
export VITE_PBOARD_SIGNALING_AUTHORITY="$(cat services/pboard-signaling/deploy/ovh-authority.public.json)"
node scripts/build-signaling-experiment.mjs firefox
node scripts/build-signaling-experiment.mjs chromium
```

The JSON file is a **public** pin, safe to include in the experimental build.
Never put the server private key or Google tokens in build variables. Ordinary
production builds still choose Drive; experimental builds without the new flag
retain manual enrollment for a compatible local/legacy server. The current OVH
service intentionally rejects manual/self-signed roots and protocol-1 grants while
Google enrollment is enabled. Existing manual pins, pending attestations, epoch
records and device keys are retained for returning to those modes.

### Validation and service recovery

```sh
cargo test --manifest-path services/pboard-signaling/Cargo.toml
cargo clippy --manifest-path services/pboard-signaling/Cargo.toml --all-targets --all-features -- -D warnings
npm run typecheck
npx vitest run tests/googleBrokerEnrollment.test.ts tests/liveMutationSigning.test.ts tests/runtimeSecurityDiagnostics.test.ts tests/collaborationAdmission.test.ts tests/experimentalSignaling.test.ts tests/collaborationDiagnostics.test.ts
# Test-only binary: the synthetic Google endpoint exists only behind this feature.
cargo build --manifest-path services/pboard-signaling/Cargo.toml --features test-google-fixture
PBOARD_M04_GOOGLE_ENROLLMENT=1 node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_M04_GOOGLE_ENROLLMENT=1 PBOARD_M02_SAME_ACCOUNT=1 node services/pboard-signaling/secure-browser-smoke.mjs
PBOARD_M02_USE_DRIVE=1 node services/pboard-signaling/secure-browser-smoke.mjs
# Safe public negative check; uses no valid Google token.
node services/pboard-signaling/google-enrollment-smoke.mjs wss://pboard.cecosl.ovh/ws
```

The native harness copies its server executable before starting so concurrent
Cargo builds cannot change the feature set during its restart test. Never deploy a
`test-google-fixture` executable. The deployed optimized build has no optional
features and hardcodes the authenticated Google HTTPS metadata endpoint.

The active server SHA-256 is
`2f7938d6279f122f1c22a4c95b32918225b8c56fbda7dd42fcde523367ba3d55`;
its isolated-source build and provenance are retained in
`services/pboard-signaling/local_artifacts/20261019T055031Z/`. The previous binary,
unit and HAProxy configuration are backed up on OVH in
`/var/backups/pboard-signaling/20261019T055031Z/`. Reverse proxy access was extended
only to `/experiment/challenge` and `/experiment/enroll`; TLS, DNS and the mate
application were not changed. Public health returns 200; pboard root remains 404;
mate still redirects with 302.

The persistent server authority is generated **on OVH** at
`/etc/pboard-signaling/authority.key` (root/service group, 0640), and authorization
metadata is atomically stored at `/var/lib/pboard-signaling/enrollment.json`
(service-only directory 0700, file 0600). Back up both securely **on the server or
through the operator's secure credential backup procedure**, not in source/build
artifacts. They contain no Google access/refresh tokens or board documents. A
missing or wrong key is not regenerated at startup; a signature/key mismatch fails
closed. Restore the original key and registry together to recover. Do not delete
or reset the registry to recover capacity: epoch rollback and lost provenance
history would block existing clients or edits.

To revert the activation, restore the backed-up binary atomically, restore its
unit and HAProxy file, run `haproxy -c -f /etc/haproxy/haproxy.cfg`, then
`systemctl daemon-reload`, `systemctl restart pboard-signaling` and
`systemctl reload haproxy`. Reload a manual-enrollment experimental client built
without the Google flag. Keep the Google authority/registry for recovery; this
rollback does not erase or migrate Google or local board data.

The metadata registry has deliberate bounds: 64 scopes, 16 devices per scope,
256 historical manifests per scope and 32 MiB overall. Reaching a bound rejects new
grants without deleting history or board data. Continuous three-minute renewals can
reach a scope's history bound after roughly 13 hours; this is an attended experiment,
not an unlimited production enrollment system. Capacity maintenance/history serving,
secure recovery, offline-device reconciliation and physical Android integration are
follow-up work. The service and HTTP verifier are trusted with the transient bearer
token's existing broad Drive capabilities; code issues only fixed metadata GETs,
but service compromise is a meaningful risk. Tokens are never persisted/logged,
refresh tokens never leave the client, and grant revocation is bounded by the
five-minute expiry plus client polling rather than instantaneous for offline clients.


### 19 October 2026: native Firefox enrollment fetch fix

Repeated `google.account.verifying` entries could occur with no HTTP rejection:
the broker called native fetch as `options.fetcher(...)`, supplying an ordinary
object as its JavaScript receiver. A disposable native Firefox extension reproduced
`TypeError: 'fetch' called on an object that does not implement interface Window.`
The identical unbound request returned 200 from the live OVH challenge endpoint.
The provider now keeps a local fetch function and invokes it unbound, as the other
Drive transports already do. Every enrollment exception now records a fixed phase
(`challenge`, `google_token`, `enrollment`, `authority`, `history`, `manifest`, `save`,
etc.); a valid challenge records `challenge_received`. Raw exceptions and credentials
are not copied into diagnostic history. The original exception still reaches the
existing collaboration status/error path.

The HTTP unit double now asserts an undefined receiver, closing a gap hidden by
arrow-function mocks. A regression also verifies safe phase diagnostics on network
failure. Focused provider/runtime/admission/diagnostic validation: 40 tests passed;
TypeScript check passed. The native Firefox probe bundles the actual provider,
passes `window.fetch` directly, and reaches live Google verification on OVH with a
deliberately invalid token; it asserts `google_token_rejected`, challenge progress,
and safe enrollment failure diagnostics. No real Google credentials are used.
Geckodriver 0.37.1 was fetched from Mozilla's release and checked against its upstream
SHA-256. The earlier no-geckodriver validation gap is resolved for this probe, not
for full Firefox two-account DataChannel replication.

Reproduce after an experimental Firefox build:

```sh
PBOARD_GECKODRIVER=/path/to/geckodriver PBOARD_TEST_ENROLLMENT_FETCH=1 \
  node services/pboard-signaling/firefox-ui-smoke.mjs
```

The change is client-only. The OVH binary, two-account authorization policy,
private authority key, registry, OAuth scopes and user data require no update.
Reload the existing experimental extension after rebuilding with the milestone
0.4 Google flag and public pin above. The real user's successful enrollment still
needs confirmation after that reload.


### 19 October 2026: Firefox host permissions after extension updates

A fresh install and an existing-profile upgrade are different paths. Installing an
old manifest without the OVH origin and then updating it reproduced
`permissions.contains(...) === false`, a native fetch `NetworkError`, and exactly
`google.account.verifying` followed by `google.account.failed.challenge`.
[Mozilla documents that newly requested host permissions are not shown on update](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions).
The earlier fresh-profile request test did not cover this case.

Browser runtime wiring now checks access to the configured service before any
broker request or credential acquisition. Missing access produces
`google.account.failed.host_permission` and a status message directing the user to
Connect or Firefox's extension Permissions tab. The Connect button invokes
`browser.permissions.request` immediately from the user's click, requesting only
the configured HTTP(S) hostname pattern already declared in the manifest. It
restarts collaboration only after a grant and reports denial/API failure visibly.
Loopback development ports use the same hostname match pattern as the manifest.
No new manifest permissions, Google scopes or server authorization rules are added.

The native Firefox upgrade probe now installs old then current manifests, confirms
the missing permission, verifies preflight denial, uses a real content click to
open Firefox's native permission prompt, accepts its primary button, and verifies
that the real broker can reach Google's OVH verifier afterward (using only an
intentionally invalid token). Headless Firefox's chrome prompt cannot be scrolled
by WebDriver, so its native primary-button handler is activated directly; no
permission database or policy is modified. This passed in a disposable profile.
The new UI regressions cover synchronous scoped requests, deferred connection,
denial and safe failure messages; broker tests cover no HTTP before grant and
successful recovery after grant. Server, private keys, trust history and existing
board data require no changes.

After reloading the existing extension, select the board, open Experimental device
enrollment, click Connect / reconnect with Google, and **allow access to
pboard.cecosl.ovh** if Firefox prompts. Alternatively use about:addons → Pboard →
Permissions to enable that service. Real-account success remains for the user to
verify after this browser permission is granted.

```sh
PBOARD_GECKODRIVER=/path/to/geckodriver PBOARD_TEST_ENROLLMENT_FETCH=1 \
  PBOARD_TEST_PERMISSION_UPGRADE=1 node services/pboard-signaling/firefox-ui-smoke.mjs
```

Validation for the host-permission follow-up: 44 focused tests passed, root and Android TypeScript checks passed, both experimental packages were rebuilt/verified, Firefox lint reported zero issues, and native Firefox upgrade/grant/retry plus Chromium packaged UI probes passed. Successful real-account enrollment remains a manual user check.

### Automatic launcher validation — 19 October 2026

`npm run test:collaboration` passed against public WSS. The demo passed both
headless (`--duration=12`, including grant polling) and actual graphical
(`--duration=3`) runs, including a form-created card rendered in the other profile.
A separate automated interrupt check sent SIGINT to the launcher after readiness:
it forwarded shutdown, both browsers exited, the content-boundary check passed,
and no newly created temporary profiles remained. Root TypeScript and 23 focused
launcher/grant/provider tests passed. No real Google account or installed profile
was used, and no VPS restart/configuration change was performed by these tests.

### Normal-extension pairing validation — 19 October 2026

Both actual Chromium and Firefox production sidebars passed the shared native UI
scenario against public WSS: create a real board/card, exchange connection codes,
reject pre-approval content, restore a pending request after reload, compare codes,
approve the editor, automatically receive/select the board, replicate an edit,
reopen the sidebar, create/share/edit a separate copy of the signed board, and
verify the original content/card identity remains. No Google calls or test content
were detected in signaling. Firefox's automatically opened install-time sidebar
is closed before opening its full-tab sidebar test: two views in one profile would
compete for the existing RxDB leader. No leadership/security bypass was added.

Nineteen focused grant/pairing/copy/UI tests passed. They include expired/forged
codes, wrong endpoint, authority-pin replacement rejection, in-flight cancellation,
explicit owner confirmation, original signed-record preservation and renewal
notification even after role lookup refreshes a cache. Root and Android type checks,
both normal managed builds/package checks and strict Firefox lint passed. Full
suite: 590 passed, with the same two pre-existing releaseMetadata/standardsPolicy
failures. The new UI requires no Rust/service deployment, OAuth change, schema
change, original-board authority reset or production release/version bump.

### Google service-admission activation on OVH — 20 October 2026

The owner explicitly requested updating the public server to accept Google service
admission. Read-only inspection found the configured Google verifier, independent
board grants and identity enrollment already enabled, but the running executable
predated the service-admission handshake. No protocol rewrite or configuration
change was needed: the current Rust implementation was built from an isolated
source copy using `cargo build --release --locked --no-default-features` and no
`test-google-fixture` feature. All 37 Rust tests passed, including one-use,
expiry/cross-session binding, valid-Google/no-board denial and resource limits.

The candidate passed `--check-config` as the service account against the existing
OVH settings before atomic executable replacement and a restart of only
`pboard-signaling`. Existing authority key, enrollment registry, operator grants,
systemd configuration, limits, proxy/TLS, DNS and application data were preserved.
Their rollback copies remain on the server in the root-only directory
`/var/backups/pboard-signaling/20261020T163353Z-google-service-admission/`.
The previous executable is `pboard-signaling.previous`; restore it atomically and
restart this service if rollback is needed. It predates the Google service gate,
so rolling back also reopens that documented deployment gap. Do not replace the
original authority or discard the existing registry to recover a connection.

Current deployed binary SHA-256 (supersedes earlier active-binary references):
`ff6f5b1ef14c7bea9bb1f88c9498ae0108fb101b3af1ab6373d97af09451c29d`.
The local executable and nonsecret provenance are retained under ignored
`services/pboard-signaling/local_artifacts/20261020T163353Z-google-service-admission/`.

Public WSS now advertises `requiresServiceAdmission: true`. Live negative checks
verified anonymous `join` rejection (`invalid_state`), missing/forged service
receipt rejection (`service_auth_required`), health, the identity challenge route,
and enabled/active systemd status. No Google token or valid board credential was
used in these probes. Positive Google identity plus board authorization is covered
locally with synthetic Google HTTP; a real account login remains a user check.

Reload the updated extension in both browsers and open the board on the original
authorized owner device first, so its signed grant/policy directory is republished
after the restart. Devices obtain a fresh Google service receipt automatically;
Google identity alone still grants no board membership. Older clients that cannot
obtain service receipts now fail closed and need updating. Drive persistence and
local editing are unaffected. No tag or application release was published.


### Owner directory quota doubled — 21 October 2026

The owner's instruction “please double it,” following the public service's
eight-board quota diagnosis, authorized increasing the per-account directory
limit to **16** on `pboard.cecosl.ovh`. The global directory remains **64** boards.
All 38 Rust tests passed, including acceptance of sixteen boards, rejection of a
seventeenth, renewal at capacity and enforcement of the global bound. Formatting
and the updated native harness syntax check passed; the new seventeen-board
native scenario was not rerun for this rollout. The earlier native eight-board
scenario is historical evidence, not a measurement of this updated boundary.

An isolated source copy was built with `cargo build --release --locked
--no-default-features`; the candidate passed `--check-config` as the service user
with the existing effective environment before atomic replacement and restart.
Only the executable was replaced. Credentials, authority/enrollment state,
systemd settings, TLS/proxy configuration, DNS, OAuth and application data were
preserved. Public health, WSS service-admission advertisement and anonymous join
rejection passed after activation. No release, tag, push or VPS load test ran.

Current deployed executable SHA-256 (supersedes the earlier deployment reference):
`1c1035b491c61e3e87bffca205eecd4b4959a5665ab992c50b6ebf774acd46ea`.
Rollback executable: `/var/backups/pboard-signaling/20261020T224636Z-owner-quota-16/pboard-signaling.previous`.
Nonsecret local binary/provenance: `/home/ste2/code/pboard/services/pboard-signaling/local_artifacts/20261020T224636Z-owner-quota-16`.

Live read-only inspection confirmed **128 total connections in Rust**, **16 peers
per room**, and an HAProxy backend cap of **64 connections** plus a queue of 32.
These limits were not raised. Two collection rooms normally use two WebSockets
per active browser, and HTTP/control traffic also shares the backend. Historical
2,000-socket measurements concern the older loopback relay on the development
machine; they establish neither current secure-stack nor VPS capacity.

### Connection lifecycle and measured headroom — 21 October 2026

Following the owner's request to double connection limits and run a bounded load
test, HAProxy's pboard backend was raised from **64 to 128** connections, and the
Rust service's effective limit from **128 to 256**. The proxy queue remains 32;
per-room, HTTP, authentication, message and traffic quotas remain unchanged.
The executable and credentials were not changed. Configuration validation,
health, WSS admission requirements and anonymous join rejection passed. The
root-only configuration backup is
`/var/backups/pboard-signaling/20261020T225452Z-connection-limits/`.
The deployment templates reflect these connection limits; Rust's library
defaults remain unchanged. HAProxy still imposes the lower public ceiling, shared
by WebSockets and HTTP/control traffic, so these are bounds rather than supported
numbers of concurrent users.

Board count does **not** determine connection count. The collaboration manager
starts cards/projects pools for one selected board and cancels them when switching
boards. Unacknowledged changes remain in durable local history; independent Drive
work can continue after switching. Closing a DataChannel does not guarantee its
last changes reached a peer: later authorized history exchange/recovery handles
pending work. No connection is kept open for every saved board. Background signed
membership publication remains necessary for invitations to unselected boards.

The client now remembers digests of successfully trusted grant bundles, skipping
repeated trust/storage writes only when the entire received history, local saved
bundle, device identity, persisted accepted epoch/hash and validity interval still match. Directory/grant fetches
continue, and changed or invalid bundles still undergo full verification. This
also avoids unnecessarily invalidating active-board security caches every poll.

The benchmark uses `benchmark-server.py` to launch a separate loopback process,
optionally through SSH. It never reads production credentials/configuration,
never alters the public service's admission requirements, and removes temporary
synthetic public grants on exit. Remote children run as the service user, with a
512 MiB address-space limit, two Tokio worker threads, a five-minute runtime bound
per target, and host memory reserve checks. Clients remain on the workstation.
An SSH account is operational access for running the test; it is not application
authentication. Backend sockets authenticate using temporary expiring signed
operator grants. This tests relay-core capacity, excluding Google admission,
TLS/proxy overhead and real WebRTC/RxDB workload.

```sh
# Local Linux, after building the release binary; Node 24 + Python 3 required.
node services/pboard-signaling/benchmark.mjs 100 500 1000 2000
# ONLY with explicit authorization for the named host:
PBOARD_BENCH_SSH=cecosl node services/pboard-signaling/benchmark.mjs 64 128 256
```

Optional settings: `PBOARD_BENCH_BINARY` (absolute path on the backend host),
`PBOARD_BENCH_PORT` (unused loopback port, default 18787; SSH also uses the next
local port), and `PBOARD_BENCH_IDLE_MS` (20000–60000, default 30000). Connections
and reconnects are paced by 40 ms; each idle window spans client heartbeats.
See [BENCHMARK_RESULTS.md](BENCHMARK_RESULTS.md) for measured results and limits.

Validation for this change: **863 application tests across 117 files**, **38
Rust tests**, TypeScript checking, and managed Firefox/Chromium builds and package
verification passed. New regressions cover unchanged-grant reuse, changed history,
removed local grants, altered history prefixes, expiry, persisted rollback/forks,
and cancellation of the previous board's pools on switch. Live effective limits,
public health/WSS admission, anonymous join rejection and isolated benchmark
cleanup were verified. No real Google/browser end-to-end load or long soak was
run for this change. Reload the updated extension build for the client optimization;
the server configuration changes are already active. No tag or release was made.

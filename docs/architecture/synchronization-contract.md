# Two operating modes and automatic recovery: behavior contract

Status: **approved architectural baseline**, 19 October 2026. Job 1 of the implementation
sequence agreed in this conversation. This document specifies target behavior and
test outcomes; it does not describe completed functionality. The user approved
staged implementation, with validation at each job and no destructive changes to
existing data, grants, keys or OAuth configuration. No tag or release is authorized.

The user's two-mode and automatic-recovery requirements govern this target. The
existing implementation remains the compatibility baseline until the later jobs
implement and validate each change. [SPECIFICATION.md](../../SPECIFICATION.md),
[current collaboration](../collaboration.md) and the
[WebSocket experiment](websocket-signaling-experiment.md) describe that baseline.
Where older plans make Drive ACLs the collaboration authority, that assumption
does not apply to this target. Existing ACL-based boards still require an explicit,
tested compatibility transition; their data and trust cannot simply be removed.

## 1. Invariants and terminology

- RxDB is the authoritative local store. A successful save means the change and
  the information needed to recover and synchronize it have committed durably.
  Network requests, account availability and remote acknowledgements cannot be
  prerequisites for an otherwise permitted local save.
- Standalone and Connected are the only user-facing operating modes. A temporary
  outage is a degraded Connected state, not an automatic switch to Standalone.
- Sync v2 (websocket provider) persists every board — private or shared — in
  the user-visible unified store `My Drive/pboard/<boardId>/board.json.gz`
  with `attachments/`; a private board is a folder without extra ACLs and
  sharing changes ACLs only, never storage location. The legacy Drive-provider
  mode keeps its per-account `appDataFolder` copies until the automatic
  verified migration relocates them; websocket persistence never writes
  AppData, touching it only for the once-per-session read-only legacy probe.
  Collaborators never read or modify another account's private Drive files.
  WebSocket carries bounded authenticated signaling/authorization metadata;
  WebRTC carries authorized peer replication, including attachments when added.
- Google verification establishes account identity and service admission. A
  verifiable board grant establishes board access. Neither substitutes for the
  other on the target public service.
- A **change** is an identifiable logical mutation with its original provenance
  and enough causal information to compare it with other mutations. Transport
  retries and delivery through another channel do not create a new change.
- A **pending draft** is durably saved local work whose publication has not been
  authorized or acknowledged. Saving it does not assert that peers must accept it.
- A **conflict** contains concurrent incompatible variants of the same logical
  state. A permission failure, an unavailable image, a corrupt response or a
  disconnected transport is not itself a content conflict.
- No login, logout, account switch, failed authorization or synchronization error
  may erase local documents, pending drafts, conflicts, attachments or trust keys.
  Explicit content deletion is a separate, permission-checked user operation.

## 2. Modes, login and account boundaries

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| M01 | Fresh installation, no Google account | Standalone. Board creation, editing, reordering, local attachments and export work offline. No Drive, rendezvous, WebRTC or STUN/TURN activity is initiated. |
| M02 | Successful Google connection with required platform permissions | Enter Connected automatically. Enable private persistence and authorized peer collaboration independently. No transport selector or manual board-authority initialization is required for eligible local boards. |
| M03 | Google connection fails or is cancelled | Remain in the previous mode. Existing local data and pending work remain identical. No partial login may enable unauthorized remote access. |
| M04 | Browser denies rendezvous host permission | Google-connected private Drive persistence may operate. Collaboration remains unavailable and pending with an actionable detail. Permission denial never triggers another signaling provider or another hostname. |
| M05 | Login with previously unbound local boards | Connecting Google Drive is the consent (policy updated 2026-10): eligible unsigned local boards enroll automatically with no per-board prompt, and the connect action reconciles immediately so an already-synced account's boards appear unattended. Previously bound boards, pins and signed provenance cannot be reassigned. |
| M06 | Explicit logout | Enter Standalone, stop future remote work, close sessions and cancel retries. Preserve local content, pending work, account bindings and device/authority keys. Recheck account/mode generation before applying late responses; a raced remote write is reconciled on the next login. |
| M07 | Switch from account A to account B | Retain A's *bound* local boards and drafts with their original bindings; never reinterpret B as their owner. An unbound board's first connected account enrolls it — deliberately accepted in the 2026-10 policy so same-account profiles sync without prompts (see operating-modes-status). Account preferences and background jobs remain isolated. A deliberate private copy has new identities and preserves its source. |
| M08 | Restart or resume with an existing account connection | Restore Connected intent, pending work and trust; refresh credentials and authorization as needed. Do not start duplicate pools, jobs or device enrollments. Expired credentials leave local work available. |

Connected is a global operating mode; synchronization status is per board. A board
bound exclusively to an inactive account remains local-only in the current
session. Viewing its cached contents does not rebind it. Logout does not erase
the last known restriction on an existing shared board.

### Fresh-device recovery priorities added at approval

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| PR01 | A user's original device is permanently unavailable; a fresh device has only Google login | Restore that account's permitted private boards and attachment bytes from its own cloud copies — the `pboard` board folders under Sync v2, its appDataFolder under the legacy mode — without a peer, rendezvous server, original profile or copied device key. Other accounts' files remain inaccessible. |
| PR02 | Recovered private data includes a previously signed shared-board copy | Preserve original data/signatures. Google login and snapshot restore do not mint, replace or imply ownership of shared-board authority. Fresh collaboration requires a valid existing-authority grant or reviewed delegation/recovery. |

At approval the user additionally prioritized a minimal authorization design,
incremental causal reconciliation and durable conflicts, public-service resource
limits including pre-authentication admission and bounded processing, and keeping
the current app functional throughout migration. PR01 does not depend on restoring
the old device's authority key; private data recovery and authority recovery are
separate test objectives.

## 3. User-visible status

The default indicator uses these four labels. Details are opened on demand and
may explain a blocked account, missing permission, waiting peer or unavailable
attachment. Temporary disconnections cause no modal dialog, repeated toast or
focus change. A permanent authentication/security problem remains visible and
actionable; it must not be hidden as a harmless transient outage.

| Status | Exact meaning |
| --- | --- |
| Local only | No remote delivery is intended for this board in the current mode/account. Local saves are durable. This does not erase previously pending work or bindings. |
| Synced | The known current board state, pending-history/conflict information needed for recovery, and required attachments have been acknowledged in this account's private Drive persistence; exchanges with currently connected authorized peers have no outstanding work. No enabled channel has a known incomplete recovery task. |
| Synchronization pending | Work is local and durable, but a required upload, download, attachment, peer exchange, authorization renewal or recovery task remains incomplete. A known channel failure also prevents a fresh Synced claim. |
| Conflict requires resolution | One or more durable content conflicts require an authorized user's decision. Non-conflicting changes continue to save and synchronize. Other delivery problems remain available in the details. |

Status precedence is: inactive remote scope gives **Local only**, with an existing
conflict count still accessible; otherwise unresolved content conflicts take
precedence over **Synchronization pending**, which takes precedence over
**Synced**. Logout never resolves a conflict or clears pending markers.

Synced is scoped to the current account's private persistence and current verified
peer exchanges. It **does not mean every offline collaborator has received the
board**, that no unknown remote change exists, or that a historical backup exists.
A healthy rendezvous with no other peers is normal and does not, by itself, keep
an otherwise persisted board pending. A socket opening or an upload starting is
never sufficient acknowledgement.

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| S01 | Drive acknowledges current state and attachments; no peers online; signaling healthy | Synced with the above scope. No claim of delivery to offline collaborators. |
| S02 | Peers receive edits but Drive is unavailable | Edits replicate through WebRTC; status remains Synchronization pending for private persistence. |
| S03 | Drive succeeds but signaling is unavailable | Private persistence continues; status is Synchronization pending for collaboration recovery. |
| S04 | An unresolved conflict is safely persisted remotely | Conflict requires resolution remains visible; successful upload cannot mark it resolved. |

## 4. Change identity, concurrency and safe reconciliation

Wall-clock timestamps and board revision counters alone cannot prove that one
device observed another device's edits. Causal ancestry is the basis for these
decisions. The exact metadata encoding, storage schema and RxDB integration belong
to Jobs 3–7; this contract does not require a second database or a general CRDT.

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| C01 | Same change delivered twice or by both Drive and WebRTC | One logical application and one acknowledgement outcome. Original change identity and provenance remain intact after restart and replay. |
| C02 | A change demonstrably descends from the current variant | Apply its intended update. Retain sufficient history to compare later concurrent arrivals and support recovery. |
| C03 | Two devices edit different cards from the same board state | Both edits survive in the reconciled board. A newer whole-board snapshot cannot erase the other card's change. |
| C04 | Two devices change independent fields of one card with a known common ancestor | Automatically combine only reviewed independent fields when the result satisfies board/card invariants. Preserve both source changes and their provenance. |
| C05 | Devices make the same value change from a common ancestor | A common visible value is allowed; retain the distinct source change identities and acknowledgements. Do not manufacture a user conflict solely for equivalent values. |
| C06 | Devices change the same text field to different values | Store both variants and the common ancestor when available. No automatic character-level merge or timestamp winner is assumed. |
| C07 | Concurrent structural edits, incompatible template/type changes, or insufficient ancestry | Preserve the variants and require resolution whenever independence or structural validity cannot be proved. Unknown ancestry cannot justify replacement. |
| C08 | Concurrent card/board ordering changes | Preserve unambiguous independent insertions/moves only under a tested deterministic ordering rule. Incompatible moves or incomplete ordering evidence retain conflicting intentions; no timestamp winner. |
| C09 | A stale device reconnects after a conflict exists | Its additional concurrent branch joins the conflict. It cannot replace the conflict with a single visible snapshot. |
| C10 | Clock skew, clock rollback or delayed delivery | No conflict winner is chosen by arrival order or wall clock. Revalidate time-sensitive credentials; retain local saves and drafts. |

An automatic merge must be repeatable and preserve verifiable source provenance.
If publishing the merge requires a new authored revision, only a currently
authorized owner/editor may publish it. Viewers cannot forge such a revision or
resolve a conflict by serving their local projection as authoritative state.

## 5. Deletions and explicit conflict resolution

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| D01 | An authorized deletion with no concurrent content change | Apply a tombstone; retain the information required to prevent stale resurrection and recover interrupted synchronization. |
| D02 | Deletion concurrent with an edit | Preserve the deletion intention and edited variant as a conflict. Neither automatic resurrection nor silent loss of the edit is permitted. |
| D03 | A replica acknowledges an edit and later observes an authorized descendant deletion | Apply the causal deletion; delayed delivery of the ancestor edit cannot resurrect the item. |
| D04 | User removes a board from their own list | Change that account's preference only. This is distinct from deleting shared content. Other members and their board contents remain unchanged. |
| D05 | User deletes a shared board | Require owner authority, preserve concurrent branches, and keep any conflict accessible even when the ordinary board list hides the deleted board. Membership and board-deletion decisions remain owner-only. |
| D06 | Authorized editor resolves a card/content conflict | Persist an explicit resolution referencing every variant it resolves. Keep recoverable source variants; transfer the resolution and its authorization through both synchronization channels. |
| D07 | Another change or another resolution arrives concurrently | Keep it unresolved unless the selected resolution demonstrably includes it. Two concurrent incompatible resolutions become a new conflict. |
| D08 | Viewer, revoked device or unknown identity attempts resolution | Reject remote mutation and resolution. Preserve existing local variants and authorized content. A local view selection does not count as a shared resolution. |

Owners/editors resolve ordinary content conflicts; operations that affect board
ownership, membership or shared-board deletion retain their owner-only checks.
Conflict evidence is not garbage-collected merely because one device reports
Synced. Destructive history compaction requires a separately reviewed recovery
and acknowledgement policy; no such compaction is authorized by this job.

## 6. Authorization during outages and recovery

Standalone provides full offline functionality for private/local boards. Existing
shared-board permissions remain meaningful without a network: a cached viewer
does not become an editor when collaboration stops.

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| A01 | Same Google identity on a new device | Discover only that identity's permitted boards, prove device-key possession, obtain a grant under the original board authority, then replicate. No manual initialization is required for eligible new boards. |
| A02 | Different Google identity with an explicit board invitation | Admit only the invited role after verified identity, device proof and a current verifiable board-specific grant. |
| A03 | Valid Google login without board membership | No board contents, room membership or peer-directed signaling access for that board. Knowing its ID or another participant's email changes nothing. |
| A04 | Grant expires or freshness cannot be checked while a previously authorized editor is offline | Keep permitted local editing as durable pending drafts with the original base/provenance. Block new remote publication until current authorization is verified. Never extend a grant silently. |
| A05 | Fresh authorization confirms the editor still has access | Admit pending work through ordinary authorization and reconciliation. Do not re-sign another device's work or replace concurrent remote changes wholesale. |
| A06 | Removal/downgrade is confirmed before pending work is admitted | Do not publish new work requiring the removed permission. Preserve it locally, mark why it is blocked, and allow explicit export/private copy. Viewer restrictions apply to further shared-board edits. |
| A07 | An offline author claims their change predates revocation | A device timestamp alone is insufficient proof. Newly presented work from an author lacking current write permission remains held locally. Previously verifiably admitted historical work remains valid under its retained admission evidence. |
| A08 | Viewer or device with no established editing entitlement goes offline or logs out | Cached shared content remains readable/exportable. Shared mutations and resolutions remain blocked. An explicit private copy has new identities and grants no access to the original board. |
| A09 | Original authority browser is unavailable | Continue local work and any sessions with valid authorization. Renew/admit only through a verifiable owner-authorized delegation or recovery path preserving the original authority. Otherwise remain pending; Google login cannot create a replacement authority. |
| A10 | Claimed authority differs from an existing pin; metadata/signature is invalid | Fail closed for remote access/import, retain local data and original trust, and show a safe actionable detail. No insecure transport or unsigned-data fallback. |
| A11 | Missing Google service proof, forged/replayed credentials, cross-board signals or quota abuse | Public rendezvous rejects the operation before forwarding. Bind service identity and board-device proof to the authorized session; apply resource limits. Headers/application names/embedded keys are not identity proof. |

Revocation is not retroactive erasure of previously received content. It also
cannot be promised instantaneous on an isolated peer. Publication/receipt must
revalidate current authorization when available and enforce the reviewed grant
expiry and freshness bounds. Job 8 must specify and test those bounds, historical
admission evidence, delegated renewal and recovery without depending permanently
on the original browser. This contract does not select a new cryptographic format
or an identity-token implementation prematurely.

Manual/code grants already issued by the experiment are separate device
authorizations. Removing an email invitation cannot be claimed to revoke such
unassociated grants. Their treatment must be explicit in the legacy transition;
they cannot remain an unexamined Google-free public-service bypass in the target.

## 7. Transport independence and interruption handling

| ID | Scenario | Required outcome and test assertion |
| --- | --- | --- |
| R01 | Drive fails while authorized WebRTC is available | Keep saving locally and exchanging peer changes. Retain private-upload work and retry it independently. |
| R02 | Signaling or peer transport fails while Drive is available | Keep saving and reconciling the account's private Drive copy. Retry collaboration independently; do not claim that Drive delivers edits to other users. |
| R03 | Both remote channels fail | Owners/editors retain permitted local editing and pending drafts; viewers retain their restrictions. Local saves do not wait for any remote timeout. |
| R04 | Process ends after a successful local save but before upload/acknowledgement | Restart recovers the change, pending delivery and unresolved variants. Interrupted requests do not clear pending work. |
| R05 | Remote write succeeds but its acknowledgement is lost | Retry/reconcile without duplicate logical mutations, duplicate attachments or an extra visible board. Detect an uncertain create before issuing another create. |
| R06 | New local edit occurs during an upload/download | Keep the newer local edit pending. A late acknowledgement covers only its actual change set, never subsequent edits. |
| R07 | Device sleeps, resumes, or receives repeated connectivity/focus events | Revalidate credentials/state, resume missing work and coalesce triggers. One logical recovery job per account/board/channel, with no duplicate replication sessions. |
| R08 | Repeated transient errors or service throttling | Use bounded exponential backoff with jitter; no tight retry loop. Respect service cooldowns. Pause retries in Standalone and when the platform reports offline. |
| R09 | Permanent authorization denial, invalid trust, or rejected scope | Stop blind retries requiring the same invalid evidence. Keep pending work and show the necessary account/permission action in details. Other permitted channels continue. |
| R10 | Image metadata arrives before its bytes | Keep the reference and existing bytes; show a pending attachment rather than discard/replace it. Validate type/hash/size before accepting bytes. Missing bytes prevent a complete Synced claim. |
| R11 | Two different users are never online together and have no intervening authorized peer | Each can persist their own copy privately. Changes cannot cross accounts through private Drive or the signaling server. Wait for an authorized peer path; no delivery guarantee without one. |
| R12 | State, conflict evidence or an attachment fails durable storage | Do not report a successful save or Synced. Preserve recoverable source data and show a persistent storage problem; do not evict unresolved variants to appear healthy. |

Initial retry behavior for testing: exponential ceilings of 1, 2, 4, 8, 16, then
30 seconds; actual delay uniformly between half the ceiling and the ceiling.
An explicit valid service cooldown takes precedence and may exceed this local
backoff cap. Reset backoff after verified useful progress, not merely opening a
socket. Deadlines, retry scheduling and authentication failure handling must be
tested with a controlled clock and seeded randomness rather than real sleeps.
These are target scheduler defaults, not changes to the deployed service.

## 8. Current implementation gaps and compatibility limits

| Verified baseline | Relevant source | Target work |
| --- | --- | --- |
| Local RxDB documents, Drive dirty/change-token state and an additive local change journal exist | `src/storage/rxdbRepository.ts`, `src/storage/changeJournal.ts`, `src/sync/state.ts` | Jobs 3/4 implement local history and causal projections; Job 5 adds [local conflict review and signed resolutions](conflict-resolution.md). [Jobs 6/7](peer-causal-history.md) integrate private persistence and authenticated peer history; full recovery acceptance remains incomplete. See [implementation boundaries](causal-change-journal.md). |
| RxDB honors a proven sole causal head; legacy/incomplete or concurrent projections retain their compatibility policy | `src/storage/rxdbRepository.ts` (`lastWriteWins`) | [Job 7](peer-causal-history.md) authenticates history and retains unresolved branches. Offline/historical authorization and full platform acceptance remain open. |
| Private RxDB Drive persistence now reconciles additive causal history; v1 snapshots remain compatibility copies | `src/sync/privateDriveHistory.ts`, `src/storage/privateRecovery.ts` | [Job 6](private-drive-history.md) preserves concurrent branches and restores private history; [Job 7](peer-causal-history.md) adds peer exchange; full lifecycle acceptance remains Job 11. |
| Explicit WebSocket settings coexist with Drive, which remains default | `src/collab/signalingSelection.ts`, `src/sidebar/components/BoardCollaborationControls.tsx` | Job 11 changes lifecycle/UI only after correctness and compatibility gates pass. |
| Legacy shared folders, permissions and discovery remain active | `src/sync/drivePermissions.ts`, `src/sync/sharedDiscovery.ts`, `src/sync/runtime.ts` | Job 10 must preserve existing data/trust before retiring ACL-dependent paths. No OAuth or Drive migration in Job 1. |
| WebSocket reconnect jitter and bounded request retries exist | `src/collab/experimentalWebSocketSignaling.ts`, `src/sync/driveRetry.ts` | Jobs 2 and 11 establish complete interruption/resume scheduling and test it. |
| Expired shared grants retain pending existing-card field edits; structural mutations still require current authority | `src/collab/security/liveMutations.ts` (`installLiveBoardMutations`) | [Job 8](offline-authorization.md) separates pending card work and persists permissions; remaining commands and recovery gaps are explicit. |
| Owner-signed Google email policies and device grants exist, with original-browser renewal requirements | `src/collab/googleIdentitySharing.ts`, `src/collab/boardGrants.ts` | Job 8 must address delegation, historical acceptance and trusted recovery. |
| Public independent board-grant admission now requires a separate Google service receipt; loopback cryptographic fixtures remain | `services/pboard-signaling/src/lib.rs`, `board_grants.rs`, `identity_enrollment.rs` | [Job 8](offline-authorization.md) implements the independent gate and fail-closed public startup; live Google/operations validation remains. |
| Independent image transfer and Android onboarding remain incomplete | `src/sync/runtime.ts` (`useImageTransport`), `src/sidebar/components/GoogleBoardSharing.tsx` | Jobs 9 and 12 complete/test platform and attachment behavior. |

No future test may reinterpret timestamp selection as conflict preservation,
unsigned import as authority recovery, or successful Google login as arbitrary
board authorization. Network failure and logout must not remove role restrictions
as an incidental effect of stopping the collaboration manager.

Existing snapshots, IDs, images, signatures and compatibility identities are
preserved until a reviewed, recoverable transition is implemented. Unsupported
legacy input is retained with a clear incomplete outcome. A destructive authority
reset, clearing keys, silently stripping signatures, or deleting a shared folder
is not a compatibility strategy. Synchronization is not a historical backup;
representative export/restore and key-recovery validation remain release gates.

## 9. Review and test gates

All M, S, C, D, A, R and PR IDs above are **planned acceptance scenarios**, not passing
tests. Job 2 will map them to automated tests, controlled failures and browser/
Android coverage. Evidence must label simulated Google and mocked boundaries.
A fixture test can pass for its tested behavior, but a requirement for live Google
verification, real security boundaries or an untested platform remains partial
until that boundary is exercised. A simulated account is not a live-account claim.

Review defaults selected here: automatic private persistence for disclosed,
previously unbound local boards; preservation of account bindings on account
switch; conservative field merges; edit/delete conflicts; locally retained drafts
during uncertain permission freshness; no new remote admission of revoked-author
work based on timestamps; no permanent dependence on the original browser when
valid delegation/recovery is available; and scoped, honest Synced status.

The user approved these defaults, the scenario matrix, current gaps and delivery
limits as the architectural baseline on 19 October 2026, and authorized Job 2 and
the staged implementation sequence. Job 1 is complete. Later jobs must report their scenario
IDs and evidence, retain unfinished scenarios, and preserve the local data
invariants throughout. No tag or release until the required recovery, security,
compatibility and platform gates pass. Existing release-readiness gaps remain
unchanged by this document.

Job 2 tracking: [recovery harness, evidence boundaries and remaining gaps](recovery-validation.md).

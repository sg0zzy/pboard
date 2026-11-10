> **State at 6 November 2026.** This is the approved sequence, not a status page, and
> the job order below is unchanged. What each job became in the shipped code, and
> what is still missing, is recorded in
> [../REFACTOR_STATE.md](../REFACTOR_STATE.md) and in the gap list at
> [architecture/websocket-operation-log.md](architecture/websocket-operation-log.md#known-gaps-at-this-revision).
> The short version, because it changes how several jobs read: the live transport is
> the multiplexed operation log over one authenticated WebSocket per browser context.
> It is reachable on Firefox and Android, since only those auth providers supply the
> Google identity credentials a Drive-authorized room needs; Chromium falls back to
> Drive synchronization. Job 7's "WebRTC with the same reconciliation behaviour" is
> not run by any composition root, on either platform. The relay stores sealed
> operations and never a board content key, and cross-account invitations travel the
> per-account inbox to buy the recipient a Drive read. Job 11's mode/status surface and
> job 12's full platform matrix remain incomplete, and no authoritative peer election
> was built anywhere in the tree — that requirement turned out not to need one. Sections that assume peer election
> describe a design that was not built; sections that assume a hosted authority
> describe one that exists only as the relay, whose grants live in its memory.

The work should proceed in this order. Each job should have its own review and passing tests before we start the next. Existing defaults and synchronization paths should remain available until their replacements pass validation.

1. Define the synchronization and authorization rules

   Specify what “Synced” means, how concurrent changes are identified, how deletions interact with edits, and what happens to offline changes when permissions expire or are revoked. Define Standalone, Connected, logout and account-switch behavior.

   Acceptance: an agreed behavior matrix covering these scenarios, with explicit expected results for subsequent tests.
2. Create the recovery test harness

   Extend the isolated-browser tests to simulate network outages, unavailable Drive/signaling, process termination, restart and sleep/resume. Capture document identities and contents before and after each scenario.

   Acceptance: existing behavior is reproducible, and unsupported requirements are recorded as failing scenarios without weakening security checks.
3. Add durable change tracking

   Introduce the minimum persistent metadata needed to identify changes, their common ancestors, pending delivery and acknowledgements. Reuse RxDB replication metadata where sufficient. Preserve existing boards through additive, tested storage migrations.

   Acceptance: an acknowledged local edit survives restart; interrupted synchronization retains pending work; replaying the same change creates no duplicate effect.
4. Implement reconciliation that preserves concurrent changes

   Replace destructive last-write-wins decisions where they can lose concurrent modifications. Merge independent changes when a common ancestor proves that doing so is safe. Persist unresolved variants, including edit/delete conflicts.

   Acceptance: independent edits survive reconciliation; conflicting edits preserve both variants; repeated reconciliation converges without duplication.
5. Add persistent conflict resolution

   Provide a minimal conflict view where an authorized editor can compare variants and create a resolution. Keep unresolved conflicts across restarts and synchronize resolutions as ordinary authorized changes.

   Acceptance: viewers cannot publish resolutions; unresolved variants survive restart; concurrent resolutions are themselves handled safely.
6. Integrate private Drive synchronization with reconciliation

   Make the private appDataFolder path use the new reconciliation behavior. Handle concurrent uploads, interrupted writes, deletions and remote changes arriving during local edits.

   Acceptance: two devices on one Google account can edit independently while disconnected, reconnect through Drive, and retain every change or unresolved conflict.
7. Integrate WebRTC with the same reconciliation behavior

   Reuse the existing authenticated DataChannels and RxDB replication pools. Ensure changes received through Drive and WebRTC have consistent identities and cannot be applied twice.

   Acceptance: two authorized accounts exchange edits, disconnect, make independent changes and reconcile after reconnecting. Simultaneous Drive and WebRTC delivery produces the same result.
8. Complete authorization recovery and offline editing

   Separate durable local editing from authorization to publish remotely. Preserve pending work during grant expiry without bypassing viewer restrictions or accepting unauthorized remote writes. Address trusted-device renewal and authority recovery so normal operation does not permanently depend on the original browser.

   Require Google-verified service admission alongside board-specific grants.

   Acceptance: expired or revoked credentials cannot publish or join rooms; local work remains preserved; approved devices recover without resetting board trust.
9. Complete attachment synchronization

   Add the missing image transfer/recovery behavior for the independent collaboration path, reusing existing blob storage, hashes and private Drive persistence.

   Acceptance: images survive offline creation, restart and interrupted transfer; authorized peers receive matching bytes; signaling carries no image contents.
10. Transition legacy shared Drive boards safely

    Implement a reviewed compatibility path for existing shared-folder boards, permissions, signatures and images. Establish independent board authorization before retiring ACL-dependent behavior. Preserve original data and provide rollback.

    Acceptance: representative legacy boards retain their content and authorized membership; interrupted transitions are recoverable; no automatic authority replacement occurs.
11. Introduce the two operating modes and unified recovery

    Make Standalone disable remote activity. After Google authentication and required browser permission consent, enable private Drive synchronization and WebSocket/WebRTC automatically. Add bounded recovery scheduling, account-switch isolation and the minimal synchronization statuses.

    Acceptance: login/logout never deletes local data; temporary failures do not interrupt permitted editing; recovery works after restart and sleep; status never falsely reports completion.
12. Run the final compatibility and security matrix

    Validate Firefox, Chromium and the applicable Android integration. Exercise both account relationships, conflicts, attachments, outages, revocation, quotas, legacy transitions and duplicate delivery.

    Acceptance: all required recovery/security tests pass, existing regressions are addressed or explicitly release-blocking, and resource limits are measured. Only then consider tagging or releasing.
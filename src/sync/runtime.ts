import { createDriveChanges } from './operations/changes';
import type { AuthBudget } from '../collab/authBudget';
import { automaticAuthBudget } from '../collab/authBudget';
import { IdentityServiceError } from '../collab/identityErrors';
import { DriveQuotaExceededError } from './driveQuota';
import { createHintDiscovery } from './hintDiscovery';
import { createDriveRoundReads } from './driveRoundReads';
import { driveResourceKnownGone, isDriveGone, noteDriveResourceGone } from './driveHttp';
import { roomSnapshot, trackRoom, reportAccountChannel } from './realtimeDiagnostics';
import { dirtyFlushAt } from './syncPolicy';
import { keyHandoffBeacon, validId } from './operations/protocol';
import { createOperationLogCodec, createOperationLogSync, clearReconnectLedger, describeLogStatus, type OperationLogSync } from './operations/logSync';
import { createPlaintextOperationCodec } from './operations/plaintextCodec';
import { OperationBindingError } from './operations/logRoom';
import { releaseRelaySessions } from './operations/logSession';
import { createAccountLifecycleChannel, accountLifecycleTopic, type AccountAuthorityReport, type AccountChannelState, type AccountLifecycleChannel, type AccountRecordOutcome } from './operations/accountChannel';
import type { AccountLifecycleKind, AccountLifecycleRecord, AccountTombstoneFact } from './operations/accountLifecycle';
import { runKeyCourier } from './operations/keyCourierTransport';
import { requestKeyCourier, requestKeyCourierBounded } from './operations/keyCourierQueue';
import { runLogConsolidation, consolidateBoardLog, describeLogCycle, releaseLogConsolidation } from './logConsolidationRuntime';
import { clearGrantAbsence } from '../collab/grantAbsence';
import type { LogCycleOutcome } from './operations/logConsolidation';
import { generateBoardContentKey, type BoardContentKey } from './bufferCrypto';
import type { Operation } from './operations/protocol';

// How often the log's owner is asked to consolidate: long enough that a busy
// board does not publish a snapshot per edit, short enough that a browser left
// open overnight does not leave a day of operations unpublished.
const LOG_CONSOLIDATE_MS = 5 * 60_000;
import { createOperationService } from './operations/service';
import { createGoogleIdentitySharing } from "../collab/googleIdentitySharing";
import { createCollaborativeCopy } from "../collab/collaborativeCopy";
import { identifyLegacyBoard, legacyTransitionFor, transitionLegacyBoard } from "../collab/legacyTransition";
import { COLLABORATION_SETTINGS, createBoardGrantService, type BoardGrantBundle, type CollaborationSettings } from "../collab/boardGrants";
import { BoardExistingSignedDataError } from "../collab/authorityErrors";
import { createDeviceEnrollment, storageManifestEpochs, type EnrollmentIdentity } from "../collab/security/enrollment";
import { ACCOUNT_AUTHORITY_PREFIX, ACCOUNT_DEVICE_PREFIX, accountDeviceRequestId, openAccountAuthorityFile,
  openAccountDeviceRequest, sealAccountAuthorityFile, sealAccountDeviceRequest, verifyAccountAuthorityFile } from "../collab/security/accountAuthority";
import { loadIceServers } from "../collab/security/ice";
import { classifyBoardAuthority } from "../collab/authorityDiagnostics";
import { collaborationDiagnostic } from "../collab/diagnostics";
import { collaborationCounters } from "../collab/counters";
import { createGoogleBrokerEnrollment, googleBrokerEnabled } from "../collab/googleBrokerEnrollment";
import { experimentalSignalingEnabled, selectRuntimeOperationLog, selectRuntimeSignaling } from "../collab/signalingSelection";
import { webrtcDisabledForTesting } from "../collab/liveTransport";
import { createDriveBoardStore, BOARD_SNAPSHOT_FILENAME } from "./driveBoardStore";
import { runPendingBoardCleanups } from "./boardCleanup";
import { createDriveFolderGardener } from "./driveFolderGardening";
import { defaultDriveIdentityCache, type DriveIdentityCache } from "./driveIdentity";
import { createBoardSyncV2 } from "./boardSyncV2";
import { createDriveTransport } from "./driveTransport";
import { createPrivateDriveHistory } from "./privateDriveHistory";
import { createGoogleDriveProvider, type DriveReconcileResult, type GoogleDriveProvider } from "./googleDriveProvider";
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot, serializeProjectSnapshot } from "./snapshot";
import { createDriveSyncStateStore, createDriveTombstoneStore, type DriveProjectSyncState } from "./state";
import { cleanupLegacySource, migrateLegacyBoards, type LegacyMigrationDeps, type LegacyMigrationResult } from "./legacyMigration";
import { cleanupDue, type MigrationState } from "./privateMigration";
import {
  createDrivePermissionTransport,
  createDrivePermissionService,
  PENDING_BOARD_LEAVES_KEY,
  createDriveSignalStore,
  type DriveSharedProjectRecord,
  type DriveSharedProjectStore
} from "./drivePermissions";
import { createCollaborationManager, type CollaborationManager } from "../collab/manager";
import { createBufferRuntime, type BufferRuntime } from "./bufferRuntime";
import { createBufferClient } from "./bufferClient";
import { createGrantAuthorizer } from "./bufferAuth";
import { createBufferSnapshotStore } from "./bufferSnapshotStore";
import type { DriveFetch } from "./drivePublish";
import type { BoardImage } from "../types";
import { createContentKeyStore } from "../storage/contentKeyStore";
import { DRIVE_PRESENCE_TTL_MS } from "../collab/drivePresence";
import { createDriveSignaling, createOperationRealtime } from "../collab/peerRuntime";
import type { PboardSignaling } from "../collab/signaling";
import type { KeyValueStorage } from "../storage/repository";
import { withStorageLock } from "../storage/lock";
import type { RxRepository } from "../storage/rxdbRepository";
import { hashBlob, imageToBlob } from "../storage/blobStore";
import { createAccountSignalStore } from "./accountSignaling";
import { createSharedBoardDiscovery } from "./sharedDiscovery";
import { createSharedProjectSync, createSharedProjectRefresh } from "./sharedSync";
import { createAccountPreferenceSync } from "./accountPreferences";
import type { GoogleAuthProvider } from "./googleAuth";
import { ensureDeviceKey, importSigningKey, loadPurposeKey, publicKeyFingerprint, signBytes, verifyBytes, type DevicePublicKey, type StoredDeviceKey } from '../collab/security/keys';
import { verifyManifest, acceptManifest, manifestHash, manifestIsCurrent, createInMemoryManifestEpochStore, signManifest, MANIFEST_LIFETIME_MS, MAX_MANIFEST_DEVICES, type BoardPermissionManifest, type ManifestDevice, type SignedManifest } from "../collab/security/manifest";
import { canonicalBytes, parseStrictJson, signedBytes } from "../collab/security/canonical";
import { verifyMutation, createMutationReplayCache, type MutationGuardInstall } from "../collab/security/mutation";
import type { CollaborationSecurityOptions } from "../collab/manager";

/** Storage key holding the timestamp of the last completed reconcile round.
 * Every context that shares storage reads it, which is how the sidebar's
 * mount-time discovery skips the round the extension worker just finished.
 * Exported so a test can start a session with no reconcile history. */
export const DRIVE_LAST_RECONCILED_AT_KEY = "pboardDriveLastReconciledAt";

/**
 * Automatic adoption of a board's collaboration authority in the relay
 * posture (owner decision: zero manual setup). Opening one of this account's
 * writable boards runs the same adopt-or-create path the collaboration
 * panel's checkbox runs, so no click is needed — including for a board that
 * was exported to Drive: the project.json discovery record Drive exports
 * carry is a persistence fact, not collaboration trust, and never blocks
 * adoption (Drive stays the durable path either way).
 *
 * Why this cannot create a second authority for a board that already has
 * one: the only mutation is `identitySharing.sync(board, true)`, whose
 * selected-board path routes through the single decision point
 * (`boardCollaboration.adoptAuthority` — see src/collab/boardGrants.ts).
 * That one function decides whether this device may hold the board authority
 * and in which mode — adopt an advertised authority, restore its own lost
 * record, Drive-verified re-key, create, or refuse — and every other entry
 * point (the panel, pairing, board security resolution) consults the same
 * answer. A refusal is enforced, not advisory: the creation it forbids is
 * unreachable from any caller. This call adds a further gate of its own — no
 * local bundle for this board — and requires a connected Google account and
 * a writable Drive role first, so viewer and revoked boards keep failing
 * with their existing clear messages, and an unconnected device sends
 * nothing. A refused bootstrap is the caller's diagnostic, never a board
 * error: the panel's explicit path and the migration flows (collaborative
 * copy, legacy transition) stay available for exactly the cases this
 * automatic one is forbidden to touch.
 */
/** What one relay heal leg did for one board: `healed:<steps>`,
 * `idle:<reason>` (nothing needed doing — including `idle:synced`, the healthy
 * board an epoch change must leave untouched, and `idle:no-room` in a context
 * that has no live room), or `failed:<reason>`. It is a string by contract:
 * the reconcile result carries one per board verbatim, and the Reconnect
 * action reads it out to the owner. */
export type RelayLegOutcome = `healed${string}` | `idle:${string}` | `failed:${string}`;

/** How often the automatic bootstrap will re-run for one board that still has
 * no local grant. The realtime factory runs on every fresh attach — and after
 * any attach failure every role pass retries it — and a board without a bundle
 * re-pays the whole forced enrollment round (identity challenge + exchange,
 * the device-request round, grant reads) each time. Retrying is right; retrying
 * per reattach is what put the duplicate enrollment pairs in the service
 * journal. The panel's explicit path and the Reconnect action bypass this. */
export const AUTO_BOOTSTRAP_RETRY_MS = 30_000;

/** Courier passes one account-room joiner may spend inside a single round
 * looking for its content-key grant, before it reports the missing grant as a
 * cause. Four is the courier's own joiner ladder (`keyCourierTransport.ts:279`),
 * reused rather than duplicated: a joiner's first pass publishes its wrap key
 * and can only be answered by a *later* pass of the authority device, so the
 * bound is "the same number of attempts a board joiner would make". */
export const ACCOUNT_KEY_ATTEMPTS = 4;
/** How often the authority device re-reads the account room's peer list looking
 * for a device that joined since its last pass. Matched to the account
 * channel's heartbeat (`LOG_HEARTBEAT_MS`, 15 s): the same cadence the room
 * already ticks at, so a joiner is sealed for within one heartbeat and the
 * steady state costs one courier dial per tick and no writes. */
export const ACCOUNT_PEER_CHECK_MS = 15_000;

/** The least time between two courier passes a burst of unreadable rows may
 * trigger. A foreign broadcast arrives once per row this device cannot open, and
 * an admitted writer's handoff beacon repeats for its whole bounded ladder, so
 * without a floor a burst is a stream of short-lived sockets — the churn this
 * queue exists to remove. The pass itself is what answers a row, and one pass
 * re-wraps the board key for every published wrap key at once, so a row that
 * arrives during the window is answered by the pass the next tick runs. */
export const FOREIGN_ROW_MIN_GAP_MS = 2_000;

/** A 403 against the automatic authorization being presented is terminal by
 * this protocol's own rule — the service has already superseded it, so no
 * number of exchanges can succeed with it. Only changed state can help, and
 * an explicit Reconnect is the moment a person says state changed. */
const terminalServiceAdmissionRefusal = (error: unknown) => error instanceof IdentityServiceError && error.status === 403;

/** Boards whose next relay connection is an explicit Reconnect and may pass
 * the reconnect ceiling once. Populated only by `healRelay(force)` — the
 * automatic triggers never find a key here. */
const ceilingBypassOnce = new Set<string>();

export function createAuthorityAutoBootstrap(options: {
  driveConnected: () => Promise<boolean>;
  hasLocalBundle: (boardId: string) => Promise<boolean>;
  sync: (boardId: string) => Promise<unknown>;
  retryMs?: number;
}): (boardId: string, folderRole: () => Promise<string>) => Promise<void> {
  // Recorded before the attempt, so a refused bootstrap backs off exactly like
  // a slow network does; the clock is this runtime's, per board.
  const attempted = new Map<string, number>();
  return async (boardId, folderRole) => {
    if (!await options.driveConnected()) { collaborationDiagnostic('board_authority.drive_unauthorized'); return; }
    const role = await folderRole().catch(async () => (await options.driveConnected().catch(() => false) ? 'revoked' : 'unauthorized'));
    // A dead Google session is not a lost board. Smuggled through as
    // 'revoked' it silently stops every publish/republish (the grant then
    // expires and every joiner 404s forever) while the person sees nothing;
    // named, it stops the relay work for this board *and says why*.
    if (role === 'unauthorized') { collaborationDiagnostic('board_authority.drive_unauthorized'); return; }
    if (role !== 'owner' && role !== 'editor') return;
    if (await options.hasLocalBundle(boardId)) return;
    const last = attempted.get(boardId);
    if (last !== undefined && Date.now() - last < (options.retryMs ?? AUTO_BOOTSTRAP_RETRY_MS)) {
      collaborationDiagnostic('board_authority.auto_bootstrap_coalesced');
      return;
    }
    attempted.set(boardId, Date.now());
    await options.sync(boardId);
  };
}

/** Platform-independent Drive and WebRTC wiring shared by browser and Android. */
/** What an explicit account re-pin did. Read by the collaboration panel and by
 * the owner's own record: the fingerprint it now trusts, whether this browser
 * can renew that authority, and what the account room did with it. */
export type AccountRepinResult = {
  /** The authority this browser now trusts (`account:<hash>` pin). */
  authorityKeyId: string;
  /** What the pin named before; null when this browser held no pin. */
  previousAuthorityKeyId: string | null;
  /** True when this browser holds the new authority's private key, which is the
   * only thing that lets it publish a renewed manifest. False means the account
   * room is usable only while the published authorization stays current. */
  canRenew: boolean;
  /** The account channel's state after the pass. */
  channelState: AccountChannelState;
  /** The channel's own reason for that state. */
  channelReason: string;
  /** Lifecycle records still queued after the pass (0 once they flush). */
  outbox: number;
  /** Lifecycle records that were queued before the re-pin. Re-pinning never
   * drops them; they flush when the room opens. */
  queuedBefore: number;
  /** True when the pin already named this authority: nothing was written. */
  unchanged: boolean;
};

export function createDriveRuntime({ auth: googleAuth, storage, getRepository, fetcher: rawFetcher = fetch, hasSignalingHostPermission, onReconciled, identity = defaultDriveIdentityCache(), authBudget, operationSync = true, allowRealtime = () => true }: {
  /** Legacy protocol is retained only for compatibility tests/recovery tooling. */
  operationSync?: boolean;
  allowRealtime?: () => boolean;
  auth: GoogleAuthProvider; storage: KeyValueStorage; getRepository: () => Promise<RxRepository | null>; fetcher?: typeof fetch;
  hasSignalingHostPermission?: (origin: string) => Promise<boolean>; onReconciled?: () => Promise<void>;
  identity?: DriveIdentityCache;
  /** Automatic-auth budget seam shared by every relay caller this runtime
   * owns; production omits it and each service falls back to the per-context
   * singleton. Tests inject an immediate budget to pace nothing. */
  authBudget?: AuthBudget;
}) {
  // One budget for every automatic-auth caller this runtime owns — identity
  // and grant calls, relay log dials and courier dials — because the proxy
  // counts all of them in one per-IP stick table. The module singleton is the
  // production answer (one per JS context, which is what MV3 worker and
  // sidebar each are); a test injects an immediate one.
  const budget = authBudget ?? automaticAuthBudget;
  // Diagnostics build: count every Drive request issued through any provider
  // below by purpose; a production build returns the fetcher unchanged.
  const driveRoundReads = createDriveRoundReads(collaborationCounters.instrumentFetcher(rawFetcher));
  const fetcher = driveRoundReads.fetch;
  /** Each subsystem builds its own permission transport, but they all resolve
   * the account through one cache: `about.get` used to be paid once per
   * consumer, several times per board, on every startup and every poll. */
  const permissionTransport = () => createDrivePermissionTransport(googleAuth, fetcher, undefined, identity);
  let signalingSettings: CollaborationSettings | undefined;
  // The one question every transport decision asks: which transport does this
  // process resolve to right now? It must be asked of `boardCollaboration.settings()`
  // — the function that also applies the relay posture — because a raw read of
  // the stored value sees `drive` (or nothing) while the posture resolves
  // `websocket`, and a process whose routing disagrees with its own realtime
  // path is half-on: Drive discovery next to a relay log that nothing opens.
  const independentCollaboration = async () => (await boardCollaboration.settings()).provider === "websocket";
  // The broker experiment predates the persisted setting and stays what it
  // was: an explicit configuration question, answered by the stored record.
  const legacyBroker = () => signalingSettings === undefined && googleBrokerEnabled();
  /** Existing recorded trust markers only; a missing signature never classifies a legacy copy. */
  const legacyHasPin = async (boardId: string) => {
    const pins = (await storage.get("pboardSecurityPins")).pboardSecurityPins as Record<string, unknown> | undefined;
    return Boolean(pins?.[`board:${boardId}`]);
  };
  const legacyDriveTrust = async (boardId: string) => Boolean(await legacyHasPin(boardId) || (await sharedProjects.get(boardId)).projectFileId);
  // ── Drive-based board grant discovery (same-account join) ──
  // The relay's grant cache is disposable and its identity directory exists
  // only in the enrollment posture. In the Drive-first posture the one channel
  // every device of the account can always see is the account's
  // appDataFolder, so board grants mirror there beside the account authority
  // file — public data only (public keys and signatures; see `boardGrants`) —
  // and devices that hold no authority announce their board identity there,
  // one file per device. The authority device folds the announcements into
  // the grant roster at its next renewal; discovery, membership, and the
  // never-a-second-authority rule all run off these files. Mirrors are
  // best-effort on write and load-bearing on read: a failed *lookup* throws,
  // so a blind decision never creates a competing authority.
  const BOARD_GRANT_MIRROR_BYTES = 4 * 1024 * 1024;
  const boardGrantFiles = () => createDriveTransport(googleAuth, fetcher, "pboard-board-grant-");
  const boardMemberFiles = () => createDriveTransport(googleAuth, fetcher, "pboard-board-member-");
  const announcedBoardMembers = new Map<string, string>();
  const boardMemberListings = new Map<string, { at: number; members: ManifestDevice[] }>();
  const boardGrantExchange = {
    async publish(board: string, bundle: BoardGrantBundle) {
      const text = JSON.stringify(bundle);
      if (text.length > BOARD_GRANT_MIRROR_BYTES) throw new Error("Board grant mirror exceeds the Drive file ceiling");
      const transport = boardGrantFiles();
      const file = await transport.findProjectFile(board);
      await transport.upload(board, text, file?.id);
    },
    async advertise(board: string): Promise<BoardGrantBundle | null> {
      const transport = boardGrantFiles();
      const file = await transport.findProjectFile(board);
      if (!file) return null;
      const raw = await transport.download(file.id);
      if (raw.length > BOARD_GRANT_MIRROR_BYTES) throw new Error("Board grant mirror exceeds the Drive file ceiling");
      return parseStrictJson(raw, BOARD_GRANT_MIRROR_BYTES) as unknown as BoardGrantBundle;
    }
  };
  const boardMembers = {
    async announce(board: string) {
      const device = await ensureDeviceKey(`board-device:${board}`);
      if (announcedBoardMembers.get(board) === device.keyId) return;
      const payload = { format: "pboard-board-member-v1", boardId: board, deviceKeyId: device.keyId, publicKey: device.publicJwk };
      const signature = await signBytes(await importSigningKey(device.privateJwk), signedBytes("pboard-board-member-v1", payload as never));
      const transport = boardMemberFiles();
      const id = `${board}--${device.keyId}`;
      const file = await transport.findProjectFile(id);
      await transport.upload(id, JSON.stringify({ ...payload, signature }), file?.id);
      announcedBoardMembers.set(board, device.keyId);
    },
    async list(board: string): Promise<ManifestDevice[]> {
      const cached = boardMemberListings.get(board);
      if (cached && Date.now() - cached.at < 60_000) return cached.members;
      const prefix = `pboard-board-member-${board}--`;
      const files = (await boardMemberFiles().listProjectFiles()).filter(entry => entry.name.startsWith(prefix)).slice(0, 32);
      const members: ManifestDevice[] = [];
      for (const entry of files) {
        try {
          const raw = await boardMemberFiles().download(entry.id);
          if (raw.length > 64 * 1024) continue;
          const value = parseStrictJson(raw, 64 * 1024) as Record<string, unknown> | null;
          if (!value || value.format !== "pboard-board-member-v1" || value.boardId !== board || typeof value.signature !== "string") continue;
          const { signature, ...body } = value as { format: string; boardId: string; deviceKeyId: string; publicKey: DevicePublicKey; signature: string };
          if (await publicKeyFingerprint(body.publicKey) !== body.deviceKeyId) continue;
          if (!await verifyBytes(body.publicKey, signature, signedBytes("pboard-board-member-v1", body as never))) continue;
          members.push({ deviceKeyId: body.deviceKeyId, publicKey: body.publicKey, role: "editor" });
        } catch { /* one unreadable announcement must not poison the roster */ }
      }
      boardMemberListings.set(board, { at: Date.now(), members });
      return members;
    }
  };
  const boardCollaboration = createBoardGrantService({ storage, fetcher, canAccessEndpoint: hasSignalingHostPermission, authBudget: budget,
    grantExchange: boardGrantExchange, boardMembers,
    // The trust questions the single decision point (`adoptAuthority`, in the
    // grant service) asks this deployment. Together these replace the old
    // `canInitialize` throw: what used to be a question one caller asked and
    // enforced by its own self-discipline is now data feeding the one place
    // that can create an authority, so the refusal is enforced for every
    // caller at once. Note what is deliberately NOT here:
    // `pboardDriveSharedProjects[board].projectFileId` — the Drive export's
    // project.json discovery record the product writes itself for every
    // exported board — gates migration (`identifyLegacyBoard`,
    // `transitionLegacyBoard`), never adoption. An exported board adopts the
    // relay and keeps synchronizing through Drive.
    authority: {
      async hasLocalBoard(board) {
        const rx = await getRepository();
        return Boolean(rx) && !await rx!.isDeletedProject(board) && Boolean(await rx!.getProject(board));
      },
      // Only the relay posture has a service that advertises authorities;
      // under Drive collaboration there is no second authority to duplicate,
      // and asking would pay an exchange that cannot exist.
      async directoryAdvertisesAuthority(board) {
        if (!await independentCollaboration()) return false;
        // An unreachable service advertises nothing *observable*; treating a
        // failed probe as "no authority exists" keeps the honest degrade (and
        // the auto-adopt) working while the relay is briefly down, and costs
        // nothing: the creation's publication is where the service itself
        // refuses a second authority, and a bundle that never published is
        // inert — it carries no grants and seals no room that others accept.
        return await identitySharing.advertisesAuthority(board).catch(() => false);
      },
      // A pinned board authority is the recorded Drive-hosted collaboration
      // trust: creating a relay authority beside the Drive manifest that
      // governs its room is the split-brain this design forbids, and retiring
      // that trust is a migration, which stays explicit (collaborative copy,
      // legacy transition).
      hasLegacyDriveTrust: legacyHasPin,
      async hasSignedHistory(board) {
        const rx = await getRepository();
        if (!rx) return false;
        const history = await rx.journal.entries.where("boardId").equals(board).toArray();
        if (history.some(change => change.value._sec)) return true;
        const project = await rx.db.projects.findOne(board).exec();
        const cards = await rx.db.cards.find({ selector: { projectId: board } }).exec();
        return Boolean(project?.toJSON()._sec) || cards.some(card => card.toJSON()._sec);
      },
      // D1/D4: re-establishing a lost board authority requires a live
      // authenticated Drive ACL read proving this account owns the board
      // folder. Every failure — Drive unavailable (postponement), unshared
      // board, verified non-owner — refuses without touching local data,
      // leaving the ordinary block (or offline editing) exactly as before.
      async driveOwnershipProof(board) {
        // Read the provider fresh instead of the lazily cached flag: the
        // sharing UI can reach this path before the manager's role refresh
        // has run.
        if ((await boardCollaboration.settings()).provider !== "websocket") return { ok: false, reason: null };
        if (!await driveConnected()) return { ok: false, reason: "Google Drive is not connected; re-keying postponed" };
        try {
          return { ok: true, proof: await drivePermissions.verifyDriveOwnership(board) };
        } catch (error) {
          const reason = String((error as Error)?.message ?? error).slice(0, 160);
          collaborationDiagnostic("board_authority.rekey_refused", { room: reason });
          return { ok: false, reason };
        }
      },
      // Record which authority situation this is (never key material) so the
      // block can be supported with a precise recovery path.
      async describeSignedDataBlock(board, rekeyReason) {
        const rx = await getRepository();
        const history = rx ? await rx.journal.entries.where("boardId").equals(board).toArray() : [];
        const project = rx ? await rx.db.projects.findOne(board).exec() : null;
        const cards = rx ? await rx.db.cards.find({ selector: { projectId: board } }).exec() : [];
        const diagnosis = await classifyBoardAuthority({
          boardId: board, storage,
          hasSignedHistory: history.some(change => change.value._sec),
          hasDocumentSignature: Boolean(project?.toJSON()._sec) || cards.some(card => card.toJSON()._sec)
        });
        collaborationDiagnostic("board_authority.blocked", { room: diagnosis.state });
        return {
          state: diagnosis.state,
          message: "This board has existing signed collaboration data. Keep its original authority; automatic initialization cannot replace it."
            + (diagnosis.state === "authority-metadata-missing"
              ? " This device still holds the board's authority key but lost its grant record: open the board on this device while the grant service still caches its history, or import the sealed authority recovery file; the signed history itself stays intact."
              : diagnosis.state === "authority-foreign"
                ? " The board's authority lives on the device that signed it: open the board there so its grant can renew, import its sealed recovery file, or pair this device; local content stays readable and exportable."
                : "")
            + (rekeyReason ? ` Automatic Drive-ownership re-key was refused: ${rekeyReason}` : "")
        };
      }
    },
    async recoveryHistory(board) {
      const rx = await getRepository(); return rx ? (await rx.journal.publicGrants.where('boardId').equals(board).toArray()).map(g => g.manifest) : [];
    },
    // Locally retained grant chain (verified at each guard install): lets an
    // authority device rebuild a lost grant record without the service cache.
    async publicGrantHistory(board) {
      const rx = await getRepository(); return rx ? (await rx.journal.publicGrants.where('boardId').equals(board).toArray()).map(g => g.manifest) : [];
    },
    async validateRecoveryData(board, bundle) {
      const rx = await getRepository(); if (!rx) throw new Error('Recovery data storage is unavailable');
      const history = new Map(bundle.history.map(e => [e.payload.epoch, e.payload]));
      for (const entry of (await rx.journal.entries.where('boardId').equals(board).toArray()).filter(e => e.value._sec)) {
        const p = (entry.value._sec as any).provenance, manifest = history.get(p.epoch);
        if (!manifest || p.issuedAt < manifest.issuedAt - 30000 || p.issuedAt > manifest.expiresAt) throw new Error('Recover the signed public grant history for these board versions before restoring authority');
        await verifyMutation(entry.value, { boardId: board, collection: entry.collection, manifest, now: () => p.issuedAt }, createMutationReplayCache());
      }
    },
    async onAuthorization(board, permission, authorityReplacementAuthorized) {
      const rx = await getRepository();
      if (!rx) throw new Error("Cannot persist verified board permission");
      const previous = await rx.journal.permissions.get(board);
      // Replacement is allowed only when the grant service is installing a
      // Drive-verified authority transition (re-key); every other caller keeps
      // the original pin.
      if (previous?.authorityKeyId && previous.authorityKeyId !== permission.authorityKeyId && !authorityReplacementAuthorized)
        throw new Error("Board authority replacement is forbidden");
      await rx.journal.permissions.put(permission);
    },
    async onTransition(board, record) {
      const rx = await getRepository();
      if (!rx) throw new Error("Cannot persist board authority transition");
      await rx.journal.authorityTransitions.put({ id: `${board}:${record.newAuthorityKeyId}`, boardId: board, record: record as unknown as Record<string, unknown>, storedAt: Date.now() });
      collaborationDiagnostic("board_grant.rekeyed", { count: 1 });
    } });
  const identitySharing = createGoogleIdentitySharing({ storage, auth: googleAuth, grants: boardCollaboration, fetcher, canAccessEndpoint: hasSignalingHostPermission, authBudget: budget,
    // (No `canInitialize` seam any more: the selected-board path calls the
    // single decision point on the grant service — `adoptAuthority` — whose
    // trust questions are answered by the oracles above. The old throw and
    // its protections live on as enforced refusals inside that decision.)
    async canReceive(board, owner, email) {
      const rx = await getRepository();
      if (!rx || await rx.isDeletedProject(board)) return false;
      if (await boardCollaboration.localBundle(board)) return true;
      const legacyPins = (await storage.get("pboardSecurityPins")).pboardSecurityPins as Record<string, unknown> | undefined;
      if (legacyPins?.[`board:${board}`]) return false;
      // An invitation may create a new board, never replace unrelated local data.
      if (!await rx.getProject(board) || owner === email) return true;
      // Same-board proof: this account's own Drive resolves a folder recorded
      // under this exact board id (`/pboard/<boardId>`, named by its id in
      // every layout the product writes), so the local copy IS the advertised
      // board — an ACL-invited editor joins that board's authority through
      // device admission instead of being locked out by the copy its Drive
      // access already delivered. A locally created look-alike has no Drive
      // folder and stays protected behind this gate.
      return Boolean((await sharedProjects.get(board)).folderId);
    },
    // A device this browser just admitted owns a slot in the board's roster
    // and (shortly) a published wrap key; run a courier pass now so the board
    // key is wrapped for every known wrap key the moment the new device next
    // reads its grants. Failures are internal: the next attach or handoff
    // beacon retries, and an identity round must never fail over a key pass.
    onDeviceApproved: async boardId => {
      try {
        const settings = await boardCollaboration.settings();
        if (settings.provider !== 'websocket') return;
        const security = await boardSecurityFor(boardId);
        const independent = selectRuntimeOperationLog(boardId, security, settings);
        if (!independent) return;
        const role = await drivePermissions.myRole(boardId).catch(async () => (await driveConnected() ? 'revoked' : 'unauthorized'));
        if (role === 'unauthorized') { collaborationDiagnostic('board_authority.drive_unauthorized'); return; }
        if (role !== 'owner' && role !== 'editor') return;
        await requestKeyCourier({
          topic: `pboard-collab-${boardId}-cards`, ...independent,
          trigger: 'courier:device-approved',
          // A device was admitted a moment ago: its wrap key may have been
          // published after the pass now running read the listing, so this one
          // must read the room again rather than ride that pass.
          fresh: true,
          authBudget: budget,
          getServiceAdmission: identitySharing.admitService,
          isWriter: true,
          isAuthority: await boardCollaboration.ownsAuthority(boardId),
          heldKey: () => bufferContentKeys.get(boardId),
          ensureKey: () => bufferContentKeys.ensure(boardId),
          storeKey: material => bufferContentKeys.put(boardId, material),
          attempts: 1
        });
      } catch { /* deferred to the next courier pass */ }
    }
  });
  const driveSyncState = createDriveSyncStateStore(storage);
  const driveTombstones = createDriveTombstoneStore(storage);

  // --- Account-level discovery channel --------------------------------------
  //
  // One connection per browser context to the account room
  // (`pboard-account-<hash>-order`), carrying the lifecycle records that tell a
  // second browser of the same Google account a board exists. It is a second
  // consumer of the authority the board rooms already use (`accountSecurityFor`,
  // pinned as `account:<hash>`), a second `createOperationLogSync` instance
  // bound to the account topic, and nothing else: no service change, no second
  // authorization system, and no path by which a record makes a board
  // interactive without a Drive read saying so first.
  //
  // Boards this context has already announced, with the name it announced: the
  // creation is reported once, and a rename once per name, however often the
  // board is marked dirty or synchronized in between.
  const announcedBoards = new Map<string, string>();
  /**
   * Boards whose `board.created` was published before their first Drive
   * publication, so one confirmation record is still owed once Drive has them.
   * In memory: a restart re-runs `syncOperations` for every board it holds, and
   * a board found on Drive whose announcement already landed needs no second
   * record (the Drive listing covers it), so losing this set costs nothing but
   * one missed nudge in the rare restart-during-first-publication case.
   */
  const awaitingPublication = new Set<string>();
  /** The announcement chain per board, so a creation and its post-sync
   * confirmation cannot interleave (see `announceBoardLifecycle`). */
  const announcing = new Map<string, Promise<void>>();
  /** Readers of "the channel's status changed": the collaboration panel's
   * account section subscribes here so an `absent-pin` it shows cannot go stale
   * while another context of this profile moves the channel. Nothing else in
   * the product needs the event, and no listener may break the channel — each is
   * called inside its own try. */
  const accountChannelListeners = new Set<() => void>();
  const pendingSharedHints = new Map<string, Promise<void>>();
  function requestSharedHint(boardId: string): void {
    // Untrusted hints may cause Drive checks, never an unbounded set of timers.
    if (pendingSharedHints.has(boardId) || pendingSharedHints.size >= 32) return;
    const task = (async () => {
      for (const delay of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
        if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
        const result = await importVerifiedBoard({ kind: 'board.created', boardId, seq: 1, updatedAt: Date.now() }).catch(() => 'deferred' as const);
        if (result !== 'deferred') return;
      }
    })().finally(() => pendingSharedHints.delete(boardId));
    pendingSharedHints.set(boardId, task);
  }
  const accountLifecycle: AccountLifecycleChannel = createAccountLifecycleChannel({
    storage,
    ...(googleAuth.getDriveIdentityCredentials ? { googleDrive: { getCredentials: () => googleAuth.getDriveIdentityCredentials!(), fetcher: rawFetcher, onHint: requestSharedHint } } : {}),
    account: async () => await connectedAccountId(),
    // The account room's admission is the pinned account authority's manifest.
    // A missing pin resolves null (or throws), and the channel turns both into a
    // stated `no account pin` rather than an attempt loop.
    authorization: async account => (await accountSecurityFor(account).catch(() => null))?.relayAuthorization ?? null,
    relayUrl: async () => {
      const settings = await boardCollaboration.settings();
      if (settings.provider !== "websocket") throw new Error("The account channel needs a configured relay");
      return settings.url;
    },
    // The account room signs with the account device key, exactly as
    // `selectRuntimeSignaling` scopes it for `pboard-account-*-order` topics.
    getKey: account => ensureDeviceKey(`account-device:${account}`),
    acquireKey: account => acquireAccountContentKey(account),
    // Same Google-verified service admission the board rooms use, so the shared
    // automatic-auth budget paces this connection's token spend too.
    getServiceAdmission: identitySharing.admitService,
    isTerminalAdmissionError: terminalServiceAdmissionRefusal,
    onRecord: record => materialiseAccountRecord(record),
    // A queued record gave up without ever being acknowledged — which, by this
    // path's own rule, means it was never announced. Forget it here so the next
    // synchronize round re-queues it; until then the board is discovered the
    // way it always was, from the Drive listing.
    onRecordExpired: record => { announcedBoards.delete(record.boardId); },
    onStatus: status => {
      reportAccountChannel(status);
      for (const listener of accountChannelListeners) { try { listener(); } catch { /* a reader never breaks the channel */ } }
      // The heartbeat is this channel's own tick, and it is the right cadence
      // for the one question the room cannot answer for itself: has a device
      // joined since this (authority) browser last sealed for a peer? Free when
      // nothing changed (see `sealAccountKeyForNewPeers`), and never awaited.
      const scope = status.account;
      if (!googleAuth.getDriveIdentityCredentials && scope && status.state === 'connected') void sealAccountKeyForNewPeers(scope).catch(() => undefined);
      // A room lease is five minutes and the server refuses longer ones
      // (`admission.rs` caps issuance at six). An attached socket therefore
      // dies on schedule unless the authority signs a fresh manifest shortly
      // before expiry — so while this browser is connected, the lease is topped
      // up on a fixed tick instead of being left to the reconcile cadence,
      // which is far slower than the lease.
      if (!googleAuth.getDriveIdentityCredentials && scope) keepAccountManifestTicker(scope, status.state === 'connected');
    },
    // Why the authority is or is not available, read only when a status is
    // produced: `absent-pin` plus this answers *which* step refused.
    authority: account => accountAuthorityReport(account),
    // The account channel dials at page load like every board, so its
    // `GET /ws` spends from the same slot allowance: when the allowance
    // paces a cold start, this discovery channel is among the paced, not
    // beside them.
    authBudget: budget
  });
  /** Reconnect history is per topic, and a test or a sign-out must not inherit
   * the previous holder's attempts. */
  function resetAccountChannelLedger(account: string | null) {
    if (account) clearReconnectLedger(accountLifecycleTopic(account));
  }

  /**
   * One key-courier pass for the account room, so every device of this account
   * seals with the same content key: the account room is not a plaintext plane.
   *
   * Key creation follows authority, as it does for a board: only the device
   * holding the account authority's private key (the purpose slot
   * `account-authority:<hash>`, which exists only on the browser that
   * initialized it) may create it. Every other device fetches a grant addressed
   * to it, and a device that can do neither reports that it has no key instead
   * of connecting and reading nothing.
   *
   * A device that already holds the key still runs a pass: answering the requests
   * of devices that joined since the last round is what a pass does, and it is the
   * only way a browser enrolled after the first one ever receives the key.
   */
  async function answerAccountKeyRequests(account: string, options: { attempts?: number; fresh?: boolean } = {}): Promise<BoardContentKey | undefined> {
    const scope = `account:${account}`;
    const settings = await boardCollaboration.settings();
    const security = await accountSecurityFor(account).catch(() => null);
    const authorization = security?.relayAuthorization;
    if (settings.provider !== "websocket" || !authorization) return undefined;
    const isAuthority = Boolean(await loadPurposeKey(`account-authority:${account}`));
    // The joiner's bounded ladder. A device that has just been bootstrapped
    // publishes its wrap key in this pass and can only *receive* the account
    // key afterwards, because the authority wraps envelopes for the peers it
    // saw in `listDeviceKeys` when its own pass ran. One pass therefore finds
    // nothing and reports "no key" — a chicken-and-egg, not a fault — so the
    // account room asks again a bounded number of times inside one round,
    // reusing the courier's own ladder (`keyCourierTransport.ts:275-290`:
    // 4 passes, `retryBaseMs` 500 doubling to 4 s).
    const attempts = options.attempts ?? (isAuthority ? 1 : ACCOUNT_KEY_ATTEMPTS);
    // Every trigger of this function — three of them open the channel — asks the
    // same question, and the courier queue is what makes them one pass: the
    // request is a maintenance call, so it rides a pass already running or one
    // that resolved a key moments ago, and a device still waiting for a grant is
    // answered by its own bounded ladder instead (the queue never reuses a pass
    // that resolved nothing). A device that just joined the account room is
    // fresh: its wrap key is published by the pass the enrolment itself ran, so
    // the authority's next listing must read the room after that.
    const pass = await requestKeyCourier({
      fresh: options.fresh === true,
      topic: accountLifecycleTopic(account),
      url: settings.url,
      authBudget: budget,
      getKey: () => ensureDeviceKey(`account-device:${account}`),
      getAuthorization: async () => authorization,
      getServiceAdmission: identitySharing.admitService,
      // Every device of the account may announce a lifecycle record.
      trigger: 'courier:account',
      isWriter: true,
      isAuthority,
      attempts,
      sealedPeers: accountSealedPeers.get(account),
      heldKey: () => bufferContentKeys.get(scope),
      ensureKey: () => bufferContentKeys.ensure(scope),
      storeKey: material => bufferContentKeys.put(scope, material)
    }).catch(() => undefined);
    const key = pass?.key ?? await bufferContentKeys.get(scope);
    if (pass?.peerIds.length) accountSealedPeers.set(account, pass.peerIds);
    if (!key) {
      // A stated cause, next to `absent-pin`/`failed` rather than only
      // `no account content key`: the relay is not the problem, the grant is.
      const previous = accountAuthorityReports.get(account);
      collaborationDiagnostic("account_channel.key_grant_absent");
      accountKeyReports.set(account, `no account content-key grant after ${attempts} courier pass${attempts === 1 ? "" : "es"}; `
        + "the authority browser of this account must run a pass with this device's wrap key published"
        + (previous ? "" : ""));
    } else accountKeyReports.delete(account);
    return key;
  }

  /**
   * The authority's answer to a device that joined after its last pass.
   *
   * A joiner can only ever *receive* the account key, and the authority wraps
   * envelopes for the peers it saw in `listDeviceKeys` when its own pass ran —
   * so without this, a second browser of the account publishes its wrap key and
   * then waits for the next reconcile round, up to ten minutes, which is exactly
   * the "B never sees it" the account room exists to remove.
   *
   * The check is free when nothing changed: the courier's own listing tells us
   * which peers exist, and `sealedPeers` makes a pass that recognises every one
   * of them publish nothing at all. Bounded and self-paced: the account
   * channel's heartbeat is the cadence (a pass costs one courier dial, which
   * spends from the shared budget like every other automatic-auth dial), and it
   * never blocks anything — every caller is fire-and-forget.
   */
  async function sealAccountKeyForNewPeers(account: string): Promise<void> {
    if (!await independentCollaboration()) return;
    if (!await loadPurposeKey(`account-authority:${account}`).catch(() => null)) return;
    const last = accountPeerCheckedAt.get(account) ?? 0;
    if (Date.now() - last < ACCOUNT_PEER_CHECK_MS) return;
    accountPeerCheckedAt.set(account, Date.now());
    // A pass with `sealedPeers` set returns immediately when the listing holds
    // nothing new, so this costs one dial and zero writes in the steady state.
    //
    // Not fresh: this tick's question is "did a device join since the last
    // *tick*" — fifteen seconds ago by construction — and a pass that resolved a
    // key within the queue's quiet window already listed the room and sealed for
    // every peer in it, so repeating it now could only rediscover the same set.
    // A device that joins in between is answered by the pass its own join causes
    // (the enrol flow and the handoff beacon both request one), not by this tick.
    // Riding the window is also what keeps a cold start at one account dial
    // instead of two: the channel's first `connected` status lands immediately
    // after the pass that opened it.
    await answerAccountKeyRequests(account, { attempts: 1 }).catch(() => undefined);
  }

  /** The key the account room seals with: the stored one when this device has
   * it, otherwise whatever one courier pass produces. */
  async function acquireAccountContentKey(account: string): Promise<BoardContentKey | undefined> {
    return await bufferContentKeys.get(`account:${account}`) ?? await answerAccountKeyRequests(account);
  }

  /**
   * Hands a received record to the existing discovery path. A record is a hint:
   * the only thing it can buy is a Drive read. Verification therefore runs in
   * the only order that keeps that promise — first a create-free probe that
   * establishes whether Drive knows the board at all (`existingBoardFolder`
   * lists; it never resolves), and only then the role/open path, which may
   * write to a folder that exists but must never be the first thing to create
   * it. The earlier order did create: `snapshotFileId` and `role()` both reach
   * `driveBoardStore.resolveFolder`, which is find-or-create, so a record
   * naming a board absent from Drive made the receiver mint `/pboard/<boardId>`
   * itself — the new folder then reported `folderRole() === 'owner'`, the ACL
   * gate passed on a folder the record had just caused, and the ghost persisted
   * into every later `listBoards()`. If Drive grants this account a role, the
   * board is imported by the same call a reconcile round would use; if it does
   * not, nothing is created, and the relay's answer is forgotten.
   */
  async function materialiseAccountRecord(record: AccountLifecycleRecord): Promise<AccountRecordOutcome> {
    const rx = await getRepository();
    if (!rx) return 'deferred';
    if (record.kind === 'board.tombstone') {
      // Account-room events do not create a subscription. A device that has
      // never subscribed to this board must not acquire a deletion marker for
      // it merely because another session mentioned its id.
      if (!await rx.getProject(record.boardId) && !(record.fact?.kind === 'restored' && await rx.isDeletedProject(record.boardId))) return 'ignored';
      // A tombstone is a fact, not a hint: it carries the evidence itself, so
      // applying it costs no Drive read and needs none. The fact lands in the
      // same durable store the local delete/restore path writes, through the
      // same ordering rule (`journal.mergeBoardTombstone`), and every import
      // gate — `isDeletedProject`, `boardDeletionBlocks`, the Drive reconcile
      // round, snapshot recovery — already consults that store. A fact that did
      // not move the decision (a replay, an older fact, a concurrent loser) is
      // reported `ignored` so it is never turned into a second action.
      if (!record.fact) return 'ignored';
      const account = accountLifecycle.status().account;
      if (!account) return 'deferred';
      const merged = await rx.applyBoardTombstoneFact(record.boardId, {
        ...record.fact,
        // The *room* decides which account list the fact speaks for, never the
        // record: the account room is one account list by construction.
        accountId: account,
        deviceId: record.fact.actorId,
        at: new Date(record.updatedAt).toISOString(),
        // Local provenance, never the sender's claim about itself: a receiver
        // records *when* and *how* it learned the fact. It is deliberately not
        // part of the ordering-relevant content, so two receivers of the same
        // facts hold the same deciding evidence.
        evidence: 'account-room'
      });
      if (merged.duplicate) return 'ignored';
      // The board's operation session still holds this board in memory; a
      // decided-gone board must stop being pulled by it, and a restored one may
      // resume. Closing is safe either way: the next synchronize round reopens.
      await operationService.close(record.boardId).catch(() => undefined);
      void onReconciled?.().catch(() => undefined);
      return 'applied';
    }
    if (record.kind === 'board.order') {
      // The account list's order, not a board's. It never names a board as
      // existing: the repository weaves the received total order into the list
      // this device already holds and drops ids it does not have, so a reorder
      // can neither import a board nor resurrect a deleted one. There is no
      // Drive read here because there is nothing to verify — an order over a
      // set that does not include the board says nothing about the board.
      const account = accountLifecycle.status().account;
      if (!account || !record.ids?.length) return 'ignored';
      // The clock the account-room projection accepted this record under. The
      // repository compares it against the last order it applied, which is what
      // makes "two sessions reordered at once" end in one order rather than in
      // the later arrival — and what makes an older record a visible no-op
      // instead of a silent revert.
      await rx.applyRealtimeProjectOrder(account, { ids: record.ids, updatedAt: record.updatedAt, seq: record.seq });
      return 'applied';
    }
    // A board this device deleted, left, or erased is that device's decision
    // until Drive changes it: an old record must never resurrect one.
    if (await rx.isDeletedProject(record.boardId)) return 'ignored';
    if (record.kind === 'board.deleted') {
      // A delete is durable in Drive as an *operation*, never as a missing folder:
      // removing a board never removes its folder (the log is append-only and only
      // retention gardening trashes files), so folder absence can never verify one
      // and probing for it discarded every delete record ever published. Pull the
      // board through the same Drive-gated path a created record uses and let the
      // board's own projection materialise the delete. Nothing here writes to
      // Drive, because the board is already bound locally; a Drive error simply
      // leaves the board in place, which is the safe direction.
      if (!await rx.getProject(record.boardId)) return 'ignored';
      // A read that failed is a question left open, not an answer: the board
      // stays, the board's sync state carries the cause, and the delete is
      // re-verified on the next reconcile round instead of being lost.
      try { await syncOperations(record.boardId, false); }
      catch { return 'deferred'; }
      void onReconciled?.().catch(() => undefined);
      return 'applied';
    }
    if (record.kind === 'board.metadata') {
      // Two audiences, one rule. A peer that holds the board takes the rename;
      // a peer that does not takes the creation path, because the confirmation
      // this device sends once Drive has a creation-time announcement (see
      // `announceBoardLifecycle`) is exactly that record: a board whose
      // creation record arrived before Drive had it, named now that it is
      // there. Both orders are create-free first, so a hint can neither mint a
      // folder nor resurrect a Drive-gone board under a new name.
      const project = await rx.getProject(record.boardId);
      if (!project) return await importVerifiedBoard(record);
      if (record.name === undefined || project.name === record.name) return 'ignored';
      if (!await boardStore.boardFolderExists(record.boardId).catch(() => false)) return 'deferred';
      await rx.renameProject(record.boardId, record.name);
      // The announce gate on this device, updated before the repository event
      // the rename fires: the name just applied is announced, so applying a
      // rename never echoes a rename record back into the room.
      announcedBoards.set(record.boardId, record.name);
      void onReconciled?.().catch(() => undefined);
      return 'applied';
    }
    return await importVerifiedBoard(record);
  }

  /**
   * The one path by which a record can make a board appear locally, and the
   * reason a creation-time announcement is safe: the record buys a Drive read
   * and nothing else. The probe comes first and is create-free
   * (`boardFolderExists` lists; `boardFolder`/`snapshotFileId` find-or-create),
   * then the role gate, and only then the ordinary discovery import.
   *
   * `deferred` is the answer a creation-time announcement makes routine: Drive
   * legitimately does not have the board yet. The channel keeps the record and
   * re-verifies it on the next reconnect and on the next reconcile round, so
   * the eventual state is correct without a reload. Nothing is created on the
   * way to saying "not yet", and nothing is written on Drive at the receiver.
   */
  const discoverForBoardHint = createHintDiscovery({
    account: connectedAccountId,
    discover: () => drivePermissions.discoverSharedProjects({ force: true })
  });
  async function importVerifiedBoard(record: AccountLifecycleRecord): Promise<AccountRecordOutcome> {
    const rx = await getRepository();
    if (!rx) return 'deferred';
    if (await rx.getProject(record.boardId)) return 'ignored';
    const present = await boardStore.boardFolderExists(record.boardId).catch(() => false);
    if (!present) {
      // A shared folder need not live under this account's pboard root. Resolve
      // it through Drive's shared-with-me listing before opening anything: an
      // account-room hint is never itself proof of a subscription.
      const shared = await discoverForBoardHint().catch(() => null);
      if (!shared) return 'deferred';
      if (!shared.some(entry => entry.projectId === record.boardId)) return 'deferred';
    }
    // Drive names the folder but no role for this account: that is a refusal, not
    // a wait. The record bought its Drive read and nothing else.
    const role = await operationService.role(record.boardId).catch(() => null);
    if (role !== 'owner' && role !== 'editor' && role !== 'viewer') return 'ignored';
    // An import caused by this hint must not announce the same subscription
    // back into the account room. A direct Drive discovery does announce it,
    // allowing another session of this account to discover the subscription.
    announcedBoards.set(record.boardId, record.name ?? '');
    try { await syncOperations(record.boardId, false); }
    catch { announcedBoards.delete(record.boardId); return 'deferred'; }
    const imported = await rx.getProject(record.boardId);
    if (imported) announcedBoards.set(record.boardId, imported.name);
    void onReconciled?.().catch(() => undefined);
    return 'applied';
  }

  /**
   * Publishes the lifecycle record a local change implies: `board.created` the
   * first time this device sees the board at all, and `board.metadata` whenever
   * a board it already announced carries a name the channel has not announced.
   *
   * **When a creation is announced.** At creation: `markDirty` is the
   * repository's `projectChanged` event (`src/storage/browser.ts:55`), which is
   * the moment the local row exists, and the mandated sequence puts the socket
   * announcement before Drive persistence — local RxDB write, event on the
   * socket, server buffers/forwards, peers create a local representation, Drive
   * persistence proceeds asynchronously. Announcing only after
   * `syncOperations` put the record behind the board's first Drive
   * publication, which in production can wait for the 25-minute publication
   * flush.
   *
   * Two consequences are load-bearing:
   *  - A receiver may hear about a board before Drive has it. That is what the
   *    channel's `deferred` outcome exists for (see
   *    `AccountRecordOutcome`): the record is kept and re-verified on the next
   *    reconnect and on the next reconcile round, never applied on trust.
   *  - The publisher must not wait on Drive and must not create anything there.
   *    This function is fire-and-forget from every caller, and the only Drive
   *    calls on this path are the account channel's own identity/authorization
   *    reads — never a board folder (`driveBoardStore.boardFolder` is
   *    find-or-create and is not reachable from here).
   *
   * **Why the post-sync call site stays.** `syncOperations` still calls this
   * once a board is demonstrably on Drive, for two cases the creation path
   * cannot cover: a board that predates this build (its row exists, no record
   * was ever queued, and its first synchronization is the first chance to
   * announce it), and a record the channel dropped unacknowledged
   * (`onRecordExpired` un-marks the board, and the next synchronize round is
   * what re-queues it). Both are idempotent: `announcedBoards` is the gate, so
   * a reconcile round that synchronizes forty boards publishes nothing.
   *
   * Fire-and-forget by contract, and total: every failure path is swallowed here,
   * because a hint that cannot be announced is a background retry with a line in
   * `pboardCollaboration()`, never an error dialog. Drive remains the copy that
   * matters; a relay ack says nothing about it (`sync_api.rs` acks its own SQLite
   * write), and a board this hook fails to announce is still found by the next
   * Drive listing.
   */
  async function announceBoardLifecycle(boardId: string, options: { onDrive?: boolean } = {}) {
    // Serialized per board: the creation announcement and the post-sync
    // confirmation are both fire-and-forget from different callers and can
    // overlap, and an overlap would let the confirmation decide from a map the
    // creation has not written yet — the confirmation is exactly what a peer
    // holding a deferred record needs, so it must not be lost to that race.
    const previous = announcing.get(boardId) ?? Promise.resolve();
    const pass = previous.then(() => announceBoardLifecycleNow(boardId, options));
    announcing.set(boardId, pass);
    void pass.finally(() => { if (announcing.get(boardId) === pass) announcing.delete(boardId); });
    return await pass;
  }

  async function announceBoardLifecycleNow(boardId: string, options: { onDrive?: boolean }) {
    try {
      if (!allowRealtime()) return;
      const rx = await getRepository();
      if (!rx || await rx.isDeletedProject(boardId)) return;
      const project = await rx.getProject(boardId);
      if (!project) return;
      if (!announcedBoards.has(boardId)) {
        // Only the device that wrote the board's Drive presence announces its
        // creation. A device that imported the board already learned its id
        // *from* that record (or from the listing), so announcing it again is a
        // record per importing device per board that tells the room nothing it
        // did not already say — the echo the room's own receivers had to
        // tolerate. The origin is recorded when the board is bound
        // (`service.ts:performOpen`), so this is a local fact, not a Drive read.
        // A board whose origin predates that record is treated as created: its
        // announcement is the older, harmless behaviour.
        if (await rx.operationSource.local.boardOrigin(boardId) === 'imported') {
          if (googleAuth.getDriveIdentityCredentials && options.onDrive) {
            // The first session to discover a Drive share announces its newly
            // verified subscription to the other sessions of that account.
            if (!await accountLifecycle.publish('board.created', boardId)) return;
          }
          announcedBoards.set(boardId, project.name);
          return;
        }
        // `false` means there was nothing durable to queue into (no account, no
        // pin): the board is not marked announced, so a later round tries again.
        // Marking is a promise about the queue, not the relay — the channel
        // keeps trying until the log acknowledges the record, and if it ever
        // drops the record unacknowledged, `onRecordExpired` un-marks the
        // board so a later round queues it again.
        if (!await accountLifecycle.publish('board.created', boardId)) return;
        announcedBoards.set(boardId, project.name);
        // The record just queued names a board that may not be on Drive yet. The
        // receiver defers it rather than dropping it, and this device owes it a
        // second record the moment the board *is* on Drive — otherwise the only
        // thing that could ever un-defer it is the peer's Drive poll, which is
        // the wait the account channel exists to avoid.
        if (!options.onDrive) awaitingPublication.add(boardId);
        return;
      }
      if (announcedBoards.get(boardId) !== project.name) {
        // One metadata record per name this device has seen, so a rename is
        // reported without a record per keystroke-saved edit.
        if (await accountLifecycle.publish('board.metadata', boardId, { name: project.name })) announcedBoards.set(boardId, project.name);
        return;
      }
      if (options.onDrive && awaitingPublication.delete(boardId)) {
        // The confirmation. Deliberately a `board.metadata`, not a second
        // `board.created`: the room must carry exactly one creation record per
        // board, and the receiver's metadata branch already falls through to the
        // creation path when it does not hold the board. The newer clock makes
        // the projection treat it as a fresh fact, so a record deferred for
        // "Drive does not have it yet" is verified again — which is the whole
        // point, since the peer's next Drive poll is the wait this channel
        // exists to remove. One record per board, ever: `awaitingPublication`
        // forgets the board here, so every later round is silent.
        if (await accountLifecycle.publish('board.metadata', boardId, { name: project.name })) announcedBoards.set(boardId, project.name);
        else awaitingPublication.add(boardId);
      }
    } catch { /* a hint never fails the work that produced it */ }
  }

  /**
   * Opens the account channel when an account and its account-room pin exist,
   * re-opens it when a different account is connected, and runs one key-courier
   * pass. Awaiting it is optional everywhere in the product — a board opening must
   * never wait on an account socket — and it never rejects: the channel's own
   * status is the report.
   */
  function ensureAccountChannel(): Promise<void> {
    if (!allowRealtime()) return Promise.resolve();
    // Operation sync no longer falls back to the old signed account authority.
    if (operationSync && !googleAuth.getDriveIdentityCredentials) return Promise.resolve();
    if (googleAuth.getDriveIdentityCredentials) return (async () => {
      const account = await connectedAccountId();
      if (account) await (await getRepository())?.setProjectOrderAccount(account).catch(() => undefined);
      await accountLifecycle.start();
    })().catch(() => undefined);
    return (async () => {
      try {
        const account = await connectedAccountId();
        // The authority first, because everything below is admitted by it. Not
        // awaited: a bootstrap that has to reach Drive and wait on a publish is
        // not something a board open, a reconcile round or a socket dial may
        // queue behind — and it never rejects, so nothing downstream can see it
        // fail. The channel's own `absent-pin` then reports the attempt's own
        // verdict (`authority`), so a browser that *cannot* establish one says
        // which step refused instead of only that the pin is missing.
        // Awaited *inside* this function, which every caller starts without
        // awaiting (`reconcileOperations`, `collaborationManager.start`): the
        // board open and the reconcile round go on either way, while the channel
        // start below sees the pin this pass established instead of racing it
        // into a first `absent-pin`.
        // The authority exists for one consumer: the account room, which is a
        // relay room. A context that is not in the relay posture has nothing to
        // admit, and minting an authority would publish a private appDataFolder
        // artifact for a room nothing will ever open — which is exactly what a
        // Drive-only profile must not do.
        if (account && await independentCollaboration()) {
          await bootstrapAccountAuthority(account);
          // The other half of the same handshake: on the authority browser this
          // admits every same-account device that adopted the published
          // authority, so a second browser of this account joins the room with
          // no gesture on either side. Total, and never awaited by a board.
          await admitAccountDeviceRequests(account).catch(() => undefined);
        }
        // The account's list order is scoped to the account, exactly as the
        // Drive preference document is: one list per Google account, whichever
        // transport carries it. The operation-protocol build has no
        // collaboration manager doing this, and without it `listProjects` reads
        // the local-only document while `applyProjectOrder` writes the account
        // one — two lists that never meet.
        if (account) {
          const rx = await getRepository();
          await rx?.setProjectOrderAccount(account).catch(() => undefined);
        }
        const current = accountLifecycle.status().account;
        if (current && current !== account) {
          // Sign-out or account switch: the old room is closed and its reconnect
          // ledger forgotten, and the next start resolves the new pin from scratch.
          await accountLifecycle.reset();
          resetAccountChannelLedger(current);
        }
        await accountLifecycle.start();
        // The courier pass, whoever this device is: a key-holder's pass is how a
        // device enrolled since the last round receives its grant, and for a
        // device still waiting it is the retry. Boards get this from their
        // synchronize rounds; without it a second browser could hold a valid pin
        // and still never read the room that pin admits it to.
        if (account) {
          const granted = await answerAccountKeyRequests(account);
          if (granted && accountLifecycle.status().state !== 'connected') await accountLifecycle.start();
        }
      } catch { /* the channel's own status is the report */ }
    })();
  }

  const isSharedProject = async (projectId: string) => Boolean((await sharedProjects.get(projectId)).projectFileId);
  const projectSnapshots = createBackendProjectSnapshotStore(storage, () => getRepository(),
    async (projectId) => !await isSharedProject(projectId));
  const driveTransport = createDriveTransport(googleAuth, fetcher);
  const driveProvider = createGoogleDriveProvider({
    auth: googleAuth,
    transport: driveTransport,
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    tombstones: driveTombstones,
    history: createPrivateDriveHistory({ transport: createDriveTransport(googleAuth, fetcher, "history-"), snapshots: projectSnapshots,
      erasureTransport: createDriveTransport(googleAuth, fetcher, 'erased-'), imageTransport: createDriveTransport(googleAuth, fetcher, 'image-'),
      getRepository, getAccountId: connectedAccountId, async captureSession() {
        if (!await driveConnected()) return null;
        const token = await googleAuth.getAccessToken();
        const boundAuth = { ...googleAuth, getAccessToken: async () => token };
        const email = await connectedAccountEmail();
        return { account: await hashBlob(new Blob([email])),
          history: createDriveTransport(boundAuth, fetcher, "history-"), snapshots: createDriveTransport(boundAuth, fetcher),
          erasures: createDriveTransport(boundAuth, fetcher, 'erased-'), images: createDriveTransport(boundAuth, fetcher, 'image-') };
      } }),
    beforeReconcile: async () => {
      // Independent private recovery must not depend on legacy shared-folder
      // discovery. This routing question — which board-store loop and which
      // discovery path — follows the *explicit stored* collaboration choice,
      // not the posture-resolved provider: with nothing chosen yet, the
      // shipped fallback stays Drive, which is the degrade-honestly default
      // for a deployment whose relay cannot authorize anyone. Transport
      // construction itself always asks `boardCollaboration.settings()`, so
      // the posture takes effect on the wire (see `realtime`,
      // `boardSecurityFor`, and the sharing paths) whatever this routing says.
      const saved = (await storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS] as { provider?: unknown } | undefined;
      if (saved?.provider !== "websocket") await discoverSharedBoardSnapshots();
    },
    isSharedProject,
    syncSharedProject: (projectId, changeToken) => syncSharedProject(projectId, changeToken),
    syncPreferences: () => syncAccountPreferences(),
    isDeletedProject: async (projectId) => await (await getRepository())?.isDeletedProject(projectId) ?? false,
    // Connect is consent (product decision, 2026-10): once Google Drive is
    // connected under an account, every local board auto-enrolls for private
    // persistence — no per-board prompt. Earlier per-board disclosure records
    // remain valid evidence but are no longer required.
    allowBinding: async () => Boolean(await connectedAccountId())
  });
  // Sync v2 (websocket provider) persists every board — private or shared —
  // through the unified visible-Drive store (`/pboard/<boardId>/board.json.gz`)
  // on the same triggers the legacy path uses. AppData has no role in this
  // mode: the legacy AppData provider only runs while the Drive-provider
  // collaboration setting is active.
  const boardStore = createDriveBoardStore({ auth: googleAuth, fetcher });
  const driveFolderGardener = createDriveFolderGardener({ store: boardStore, repository: getRepository, account: connectedAccountId });
  const boardSyncV2 = createBoardSyncV2({
    store: boardStore, snapshots: projectSnapshots, syncState: driveSyncState, tombstones: driveTombstones,
    getRepository, connectionState: async () => await googleAuth.getConnectionState(),
    deviceKeyId: async () => (await ensureDeviceKey("pboard-sync-v2-writer")).keyId
  });
  // Which reconcile loop runs is storage routing, not transport: like
  // `beforeReconcile` above it follows the *explicit stored* choice, so an
  // un-authorized deployment's fallback build keeps the Drive loop it can
  // complete instead of being switched by a posture whose relay it cannot
  // reach. Transport decisions ask `boardCollaboration.settings()`; both
  // answers now propagate boards correctly (integration-covered), and this
  // one decides only which loop runs.
  const v2Mode = async () => {
    const saved = (await storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS] as { provider?: unknown } | undefined;
    return saved?.provider === "websocket";
  };
  /** How long a completed round answers a discovery-triggered reconcile. The
   * recurring alarm and every explicit user action pass `force`. */
  const RECONCILE_COALESCE_MS = 30_000;
  let reconcileRound: Promise<DriveReconcileResult> | null = null;
  async function lastReconciledAt(): Promise<number> {
    return Number((await storage.get(DRIVE_LAST_RECONCILED_AT_KEY))[DRIVE_LAST_RECONCILED_AT_KEY]) || 0;
  }
  async function performReconcileAll(force = false): Promise<DriveReconcileResult> {
    // Pending Drive cleanups of boards this device deleted, before any
    // discovery work: the folder move is what the deletion promised, it is
    // bounded (one verified folder, or one create-free lookup, per board), and
    // a round is the only cadence it rides — never startup, never a board open.
    // This is also the resumption seam: a browser that closed between the
    // tombstone and the Trash has exactly this pass to finish the job, because
    // the intent is durable in the journal and the round reads it directly
    // instead of enumerating Drive. Failures are recorded per board by the
    // executor and never fail the round.
    {
      const repository = await getRepository();
      // `connectedAccountId` is the same hash `beginBoardCleanup` recorded as
      // the record's `accountId`, so a connected account that is not the one
      // that made the deletion is skipped rather than answered against.
      if (repository) await runPendingBoardCleanups({ journal: repository.journal, store: boardStore, force,
        account: () => connectedAccountId() }).catch(() => undefined);
    }
    if (operationSync) return reconcileOperations(force);
    const finish = async <T>(result: T): Promise<T> => {
      // Opportunistic maintenance after every reconcile round (pending
      // board-leave ACL removals); never fails or delays the reconcile.
      void onReconciled?.().catch(() => undefined);
      return result;
    };
    if (await v2Mode()) {
      // Silent legacy relocation first (connect is consent): boards found
      // in AppData or legacy shared folders join the unified layout before
      // this pass reconciles, and failures never block normal sync. The
      // account ordering preference also pulls/uploads here (it lives in
      // AppData by product decision); in legacy mode the drive provider
      // does both from its own reconcile.
      await Promise.all([
        // Automatic relocation of legacy boards is no longer supported.
        syncAccountPreferences().catch(() => undefined)
      ]);
      return finish(await boardSyncV2.reconcileAll());
    }
    return finish(await (collaborationCounters.enabled
      ? collaborationCounters.withDrivePurpose("reconcile", () => collaborationCounters.timed("reconcile", () => driveProvider.reconcileAll()))
      : driveProvider.reconcileAll()));
  }
  const googleDrive: GoogleDriveProvider = {
    ...driveProvider,
    // A fresh connect must immediately restore this account's boards; waiting
    // for the next sidebar focus would leave a new profile showing empty
    // local state next to a fully synced cloud.
    connect: async () => {
      await driveProvider.connect();
      void googleDrive.reconcileAll({ force: true }).catch(() => undefined);
    },
    syncProject: async (projectId, options) => {
      // A separate explicit refresh must not reuse a read from an older round.
      if (options?.force) driveRoundReads.invalidate();
      return operationSync ? syncOperations(projectId, options?.force ?? false) : await v2Mode()
        ? boardSyncV2.syncProject(projectId, options)
        : collaborationCounters.enabled
          ? collaborationCounters.withDrivePurpose("sync", () => collaborationCounters.timed("sync:project", () => driveProvider.syncProject(projectId, options)))
          : driveProvider.syncProject(projectId, options);
    },
    reconcileAll: async (options) => {
      // One round at a time per JS context. Startup reaches this from several
      // callers at once (worker start, the sidebar's "reconcile now" message,
      // the sidebar's discovery effect, an erasure retry), and an unguarded
      // second round re-lists every folder AppData and Drive expose.
      if (reconcileRound) return await reconcileRound;
      // A fresh round in the *other* context (the sidebar page and the worker
      // each build a runtime) is recorded in shared storage, so the sidebar's
      // discovery effect does not repeat the round the worker just finished.
      // Only a completed round stamps; failures stay immediately retryable.
      if (!options?.force && Date.now() - await lastReconciledAt() < RECONCILE_COALESCE_MS)
        return { status: "reconciled", imported: 0, pulled: 0, pushed: 0, deleted: 0 };
      const round = driveRoundReads.run(() => performReconcileAll(Boolean(options?.force)))
        .finally(() => { if (reconcileRound === round) reconcileRound = null; });
      reconcileRound = round;
      const result = await round;
      await storage.set({ [DRIVE_LAST_RECONCILED_AT_KEY]: Date.now() });
      return result;
    },
    deleteProject: async (projectId) => operationSync ? (async () => {
      if (!await driveConnected()) return 'pending' as const;
      try { await operationService.flushRemoval(projectId); await driveTombstones.clear(projectId);
        // The browser that owns the deletion announces it on the account room:
        // removal otherwise propagates as board-log operations, which reach only
        // devices attached to that board's room (`operations/service.ts:330`), and
        // `driveTombstones` are strictly per-device. The record is a hint; the
        // receiver still verifies against Drive before it hides anything.
        accountLifecycle.publish('board.deleted', projectId);
        return 'deleted' as const; } catch { return 'pending' as const; }
    })() : await v2Mode() ? boardSyncV2.deleteProject(projectId) : driveProvider.deleteProject(projectId),
    pullProject: async (projectId) => operationSync ? pullOperations(projectId) : await v2Mode() ? boardSyncV2.pullProject(projectId) : driveProvider.pullProject(projectId),
    pushProject: async (projectId) => operationSync ? (await syncOperations(projectId, true), { id: (await operationService.layout(projectId)).folderId, name: 'operations' }) : await v2Mode() ? boardSyncV2.pushProject(projectId) : driveProvider.pushProject(projectId)
  };

  const SHARED_PROJECTS_KEY = "pboardDriveSharedProjects";

  // Automatic legacy relocation (decision 2026-10-24): AppData board copies
  // and legacy shared `Pboard/` folders move into the unified layout without
  // prompting — connect is consent. Old copies are only deleted after the
  // migration verified the canonical snapshot and the read-only window
  // elapsed; failures leave everything untouched.
  const LEGACY_MIGRATIONS_KEY = "pboardPrivateMigrations";
  async function readMigrationRecords(): Promise<Record<string, MigrationState>> {
    const saved = (await storage.get(LEGACY_MIGRATIONS_KEY))[LEGACY_MIGRATIONS_KEY];
    return saved && typeof saved === "object" ? (saved as Record<string, MigrationState>) : {};
  }
  async function writeMigrationRecords(records: Record<string, MigrationState>): Promise<void> {
    await storage.set({ [LEGACY_MIGRATIONS_KEY]: records });
  }
  const legacyHistoryTransport = createDriveTransport(googleAuth, fetcher, "history-");
  const legacyPermissionTransport = permissionTransport();
  const legacyMigrationDeps: LegacyMigrationDeps = {
    skipBoard: operationSync ? async boardId => {
      const rx = await getRepository(); if (rx?.operationSource.bindings.has(boardId)) return true;
      const folder = (await sharedProjects.get(boardId)).folderId ?? await boardStore.existingBoardFolder(boardId);
      return folder ? (await legacyPermissionTransport.listFiles(folder)).some(file => file.name.startsWith('migration-')) : false;
    } : undefined,
    store: boardStore,
    listAppDataBoards: () => driveTransport.listProjectFiles(),
    listAppDataHistory: async (projectId) => (await legacyHistoryTransport.listProjectFiles())
      .filter(file => file.name === `history-${projectId}.pboard`),
    downloadFile: async (fileId) => {
      const text = await driveTransport.download(fileId);
      return text ? new TextEncoder().encode(text) : null;
    },
    deleteAppDataFile: (fileId) => driveTransport.delete(fileId),
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    tombstones: driveTombstones,
    getRepository,
    deviceKeyId: async () => (await ensureDeviceKey("pboard-sync-v2-writer")).keyId,
    sharedLegacy: async () => {
      const saved = (await storage.get(SHARED_PROJECTS_KEY))[SHARED_PROJECTS_KEY] as Record<string, DriveSharedProjectRecord> | undefined;
      return Object.entries(saved ?? {}).flatMap(([projectId, record]) =>
        record.folderId && record.projectFileId
          ? [{ projectId, folderId: record.folderId, projectFileId: record.projectFileId }]
          : []);
    },
    listPermissions: async (folderId) => (await legacyPermissionTransport.listPermissions(folderId)).filter(permission => permission.type === "user"),
    createPermission: async (folderId, role, email) => {
      await legacyPermissionTransport.createPermission(folderId, role === "writer" ? "editor" : "viewer", email);
    },
    migrations: {
      load: async (projectId) => (await readMigrationRecords())[projectId],
      save: async (state) => { const records = await readMigrationRecords(); records[state.projectId] = state; await writeMigrationRecords(records); },
      clear: async (projectId) => { const records = await readMigrationRecords(); delete records[projectId]; await writeMigrationRecords(records); }
    },
    now: () => Date.now()
  };
  let legacyPassRun: Promise<LegacyMigrationResult> | null = null;
  function runLegacyPass(): Promise<LegacyMigrationResult> {
    legacyPassRun ??= (async () => {
      const result = await migrateLegacyBoards(legacyMigrationDeps);
      for (const state of Object.values(await readMigrationRecords())) {
        if (!operationSync && cleanupDue(state, Date.now())) await cleanupLegacySource(legacyMigrationDeps, state.projectId).catch(() => undefined);
      }
      return result;
    })().catch(error => { legacyPassRun = null; throw error; });
    return legacyPassRun;
  }

  function createSharedProjectStore(storage: KeyValueStorage): DriveSharedProjectStore {
    async function readAll(): Promise<Record<string, DriveSharedProjectRecord>> {
      const result = await storage.get(SHARED_PROJECTS_KEY);
      const saved = result[SHARED_PROJECTS_KEY];
      return saved && typeof saved === "object" ? (saved as Record<string, DriveSharedProjectRecord>) : {};
    }
    async function writeAll(all: Record<string, DriveSharedProjectRecord>): Promise<void> {
      await storage.set({ [SHARED_PROJECTS_KEY]: all });
    }
    return {
      async get(projectId) {
        const record = (await readAll())[projectId];
        return {
          folderId: record?.folderId ?? null,
          projectFileId: record?.projectFileId ?? null,
          realtimeFolderId: record?.realtimeFolderId ?? null,
          // Stays undefined while nothing has been observed: the sharing service
          // must tell "no baseline yet" from "observed with no grant".
          observedGrantId: record?.observedGrantId
        };
      },
      async set(projectId, patch) {
        const all = await readAll();
        const existing = all[projectId] ?? { folderId: null, projectFileId: null, realtimeFolderId: null };
        const next = { ...existing, ...patch };
        // The layout is re-recorded on every discovery pass and on every
        // signaling round trip. Writing it when nothing changed is not free:
        // the sidebar watches this key and restarts its Drive reconciliation
        // and its collaboration session on every write, so an unchanged
        // layout would keep both running. Firefox fires the change event for
        // an identical value as well, so the write must be skipped here.
        if (next.folderId === existing.folderId &&
            next.projectFileId === existing.projectFileId &&
            next.realtimeFolderId === existing.realtimeFolderId &&
            next.observedGrantId === existing.observedGrantId) return;
        all[projectId] = next;
        await writeAll(all);
      },
      async delete(projectId) {
        const all = await readAll();
        if (!(projectId in all)) return;
        delete all[projectId];
        await writeAll(all);
      }
    };
  }

  const sharedProjects = createSharedProjectStore(storage);

  const drivePermissions = createDrivePermissionService({
    transport: permissionTransport(),
    sharedProjects,
    findOwnershipFolder: async (projectId) => await v2Mode() ? boardStore.existingBoardFolder(projectId) : null,
    prepareOperationBoard: operationSync ? async projectId => { await operationService.open(projectId); } : undefined,
    isOperationBoard: async projectId => Boolean((await getRepository())?.operationSource.bindings.has(projectId)),
    readSnapshot: async (projectId) => {
      const rx = await getRepository();
      if (!rx) throw new Error("Sharing requires the RxDB storage backend");
      const { project, items } = await rx.exportProject(projectId, false);
      return serializeProjectSnapshot(project, items);
    }
  });

  const syncSharedProject = createSharedProjectSync({
    permissions: drivePermissions,
    snapshots: projectSnapshots,
    syncState: driveSyncState,
    getRepository: () => getRepository()
  });

  const discoverSharedBoardSnapshots = createSharedBoardDiscovery({
    connected: async () => await googleAuth.getConnectionState() === "connected",
    permissions: drivePermissions,
    getRepository: () => getRepository(),
    isDeleted: async (projectId) => Boolean(await driveTombstones.get(projectId)) ||
      Boolean(await (await getRepository())?.isDeletedProject(projectId)),
    isReshared: async (projectId) => {
      // A queued self-removal outranks everything: restoring now would eat
      // the leave the transport still has to deliver.
      const leaves = ((await storage.get(PENDING_BOARD_LEAVES_KEY))[PENDING_BOARD_LEAVES_KEY] ?? {}) as Record<string, true>;
      if (leaves[projectId]) return false;
      try {
        return await drivePermissions.wasReinvitedSince(projectId);
      } catch {
        return false;
      }
    },
    onReshared: async (projectId) => { await (await getRepository())?.unhideProject(projectId); }
  });

  async function discoverSharedBoards() {
    // The sidebar calls this while it stays open (and on focus). Private
    // account boards need the same recovery path as startup, not just legacy
    // shared-folder discovery. Reconciliation coalesces overlapping callers
    // and retains the normal binding, erasure and causal-history checks.
    await googleDrive.reconcileAll();
  }

  /**
   * Live collaboration for shared projects, driven by the RxDB repository.
   *
   * Each platform runtime owns one manager. The App calls `start(projectId)`
   * when a project becomes current and `stop()` on unmount; `start()` stops the
   * previous project first. Private projects have no content replication pool;
   * an independent account room can still synchronize the project list order.
   *
   * Signaling here is the legacy Drive-hosted path (ephemeral per-peer records
   * in the shared project's `realtime/` folder; account order uses private
   * appDataFolder records). Sync v2 selects websocket signaling instead —
   * `selectRuntimeSignaling` never reaches this factory in that mode.
   * `pool.cancel()` (on `stop()`) closes the handler, which calls
   * `signaling.leave()` and stops the poll loop.
   */

  /** Stable per-session peer id shared by both of a project's signaling pools. */
  const collaborationPeerId = crypto.randomUUID();

  /**
   * One Drive-signaling instance per pool (cards + projects). The manager creates
   * a fresh one per `signalingFor` call; `pool.cancel()` on `stop()` closes the
   * handler, which calls `signaling.leave()` and stops the poll loop. Both pools
   * of one start share `collaborationPeerId` so they identify as the same peer.
   */
  function driveSignalingFor(topic: string): PboardSignaling {
    if (topic.startsWith("pboard-account-")) {
      const account = topic.slice("pboard-account-".length, -"-order".length);
      return createDriveSignaling({ store: createAccountSignalStore({
        transport: createDriveTransport(googleAuth, fetcher, "account-signal-"),
        account, peerId: collaborationPeerId
      }) });
    }
    const projectId = topic.split("-").slice(2, -1).join("-");
    const store = createDriveSignalStore({
      transport: permissionTransport(),
      sharedProjects,
      projectId,
      peerId: collaborationPeerId,
      topic,
      // The store prices a peer's silence in TTLs; it must be the TTL the poll
      // loop actually publishes.
      presenceTtlMs: DRIVE_PRESENCE_TTL_MS,
      realtimeFolderId: () => drivePermissions.realtimeFolderId(projectId)
    });
    return createDriveSignaling({ store });
  }

  // ---------------------------------------------------------------------------
  // Protocol 2: device keys, pinned board authority, signed manifests.
  //
  // Enrollment/trust bootstrapping is deliberately not implementable from Drive
  // data alone (the plan forbids it): the owner approves a device key through an
  // out-of-band verification (QR/fingerprint comparison). This runtime stores the
  // pinned authority fingerprints in app-private storage and exposes them for the
  // enrollment UI; without a pin no secure pool starts and collaboration stays
  // offline rather than falling back to the unsigned protocol.
  // ---------------------------------------------------------------------------

  /** Storage slots: pinned authority fingerprints per board/account. */
  const AUTHORITY_PIN_KEY = "pboardSecurityPins";

  type SecurityPins = Record<string, {
    /** Board/account id this pin governs. */
    scope: string;
    /** Canonical fingerprint of the pinned authority public key. */
    authorityKeyId: string;
    authorityPublicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
    pinnedAt: number;
    /** "board" rooms bind to a Drive file+folder; "account" rooms to the hash. */
    kind: "board" | "account";
  }>;

  async function readPins(): Promise<SecurityPins> {
    const stored = await storage.get(AUTHORITY_PIN_KEY);
    const pins = stored[AUTHORITY_PIN_KEY];
    return pins && typeof pins === "object" ? pins as SecurityPins : {};
  }

  async function writePins(pins: SecurityPins): Promise<void> {
    await storage.set({ [AUTHORITY_PIN_KEY]: pins });
  }

  /** Pins the board authority after an out-of-band verification (enrollment UI). */
  function pinBoardAuthority(boardId: string, authorityPublicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string }, driveProjectFileId: string, driveFolderId: string) {
    return (async () => {
      const pins = await readPins();
      pins[`board:${boardId}`] = {
        scope: boardId,
        authorityKeyId: await publicKeyFingerprint(authorityPublicJwk),
        authorityPublicKey: authorityPublicJwk,
        pinnedAt: Date.now(),
        kind: "board"
      };
      await writePins(pins);
      boardAuthorityCache.set(boardId, { driveProjectFileId, driveFolderId });
    })();
  }

  /** Create-only account pin. A pin, once written, is this browser's truth about
   * who the account room's authority is, so this never moves one: it returns the
   * pin already stored, whatever key it names. Every caller runs inside the
   * bootstrap's storage lock, so the read and the write see no other context's
   * interleaving (the same create-if-absent rule `boardGrants.saveIfAbsent`
   * applies to a board's grant record). */
  async function pinAccountAuthority(account: string, authorityPublicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string }): Promise<SecurityPins[string]> {
    const slot = `account:${account}`;
    const pins = await readPins();
    const existing = pins[slot];
    if (existing) return existing;
    const pin: SecurityPins[string] = {
      scope: account,
      authorityKeyId: await publicKeyFingerprint(authorityPublicJwk),
      authorityPublicKey: authorityPublicJwk,
      pinnedAt: Date.now(),
      kind: "account"
    };
    pins[slot] = pin;
    await writePins(pins);
    return pin;
  }

  const boardAuthorityCache = new Map<string, { driveProjectFileId: string; driveFolderId: string }>();

  /** Diagnostic text is fixed locally: never expose Drive bodies, keys or tokens.
   * Ordinary Drive clients retain the existing null/fail-closed behavior. */
  function unavailableSecurity(kind: "board" | "account", reason: "pin" | "missing" | "drive" | "invalid" | "authority" | "binding" | "expired" | "member" | "history"): null {
    if (!experimentalSignalingEnabled()) return null;
    collaborationDiagnostic(`security.${kind}.${reason}`);
    const label = kind === "account" ? "Account" : "Board";
    const request = kind === "account" ? "My account device request" : "My board device request";
    const renew = kind === "account" ? "Initialize / renew my account" : "Initialize / renew board authority";
    const details = {
      pin: `${label} enrollment is missing in this browser. On the original authority browser use "${renew}". On an additional browser use "${request}", obtain owner approval, then "Trust authority bundle".`,
      missing: `${label} authorization manifest was not found in Google Drive. Use "${renew}" on the original authority browser, then restart live collaboration.`,
      drive: `${label} authorization could not be read from Google Drive. Check the Drive connection and access, then retry; do not reset device keys.`,
      invalid: `${label} authorization signature or format could not be verified. Renew on the original authority browser; do not reset keys or trust a replacement authority automatically.`,
      authority: `${label} authority in Drive differs from the authority trusted by this browser. Use the original authority profile; do not initialize another authority or reset keys.`,
      binding: `${label} authorization belongs to a different account, board or Drive location. Select the same original board and account on both browsers.`,
      expired: `${label} authorization expired. Use "${renew}" on the original authority browser, then restart live collaboration on both browsers.`,
      member: `This browser's device is not approved for the ${kind}. Use "${request}", obtain owner approval, then "Trust authority bundle".`,
      history: `${label} authorization is older than or conflicts with the version accepted by this browser, or its acceptance could not be saved. Renew on the original authority browser; do not clear trust records.`
    };
    throw new Error(details[reason]);
  }

  async function resolveManifest(
    pin: SecurityPins[string],
    collection: "cards" | "projects" | "accountOrder",
    identity: { boardId: string; driveProjectFileId: string; driveFolderId: string } | null
  ): Promise<CollaborationSecurityOptions | null> {
    const key = await ensureDeviceKey(`${pin.kind}-device:${pin.scope}`);
    // Fetch the newest manifest for the room: board manifests live in the shared
    // folder; account manifests in appDataFolder.
    let raw: string | null;
    try {
      raw = pin.kind === "board" && identity
        ? await readBoardManifest(identity.driveProjectFileId, identity.driveFolderId, experimentalSignalingEnabled())
        : await readAccountManifest(pin.scope, experimentalSignalingEnabled());
    } catch (error) {
      if (!experimentalSignalingEnabled()) throw error;
      return unavailableSecurity(pin.kind, "drive");
    }
    if (!raw) return unavailableSecurity(pin.kind, "missing");
    let signed: SignedManifest;
    try { signed = parseStrictJson(raw) as unknown as SignedManifest; }
    catch { return unavailableSecurity(pin.kind, "invalid"); }
    if (typeof signed?.payload?.authorityKeyId !== "string") return unavailableSecurity(pin.kind, "invalid");
    if (signed.payload.authorityKeyId !== pin.authorityKeyId) return unavailableSecurity(pin.kind, "authority");
    let manifest;
    try { manifest = await verifyManifest(signed, pin.authorityPublicKey, pin.authorityKeyId); }
    catch { return unavailableSecurity(pin.kind, "invalid"); }
    if (pin.kind === "board" && identity && (manifest.boardId !== identity.boardId || manifest.driveProjectFileId !== identity.driveProjectFileId || manifest.driveFolderId !== identity.driveFolderId)) return unavailableSecurity(pin.kind, "binding");
    if (pin.kind === "account" && manifest.boardId !== `account:${pin.scope}`) return unavailableSecurity(pin.kind, "binding");
    if (experimentalSignalingEnabled()) {
      if (manifest.expiresAt <= Date.now()) return unavailableSecurity(pin.kind, "expired");
      if (!manifest.devices.some(member => member.deviceKeyId === key.keyId)) return unavailableSecurity(pin.kind, "member");
    }
    try { await acceptManifest(manifest, manifestEpochStore, Date.now()); }
    catch { return unavailableSecurity(pin.kind, "history"); }
    collaborationDiagnostic(`security.${pin.kind}.verified`, { count: manifest.devices.length });
    return {
        signer: { privateJwk: key.privateJwk, deviceKeyId: key.keyId },
        manifest,
        relayAuthorization: { authority: pin.authorityPublicKey, manifest: signed },
        boardId: manifest.boardId,
        ownSessionId: collaborationPeerId
    };
  }

  // Explicit user-triggered re-key (the auditable D1 act): the same decision
  // point with the caller's fresh Drive ownership proof; real errors
  // propagate so the UI can show the reason. (The automatic attempt that used
  // to live here as `tryDriveRekey` was a second, unguarded entry to authority
  // creation — it is now the `driveOwnershipProof` oracle feeding the single
  // decision point, consulted by `boardSecurityFor` through `adoptAuthority`.)
  async function reestablishAuthorityFromDrive(board: string) {
    if (operationSync) throw new Error('Board access is managed by Google Drive sharing');
    if ((await boardCollaboration.settings()).provider !== "websocket") throw new Error("Enable WebSocket collaboration before re-establishing a board authority");
    if (!await driveConnected()) throw new Error("Connect Google Drive before re-establishing a board authority");
    const transition = await boardCollaboration.reestablishAuthority(board, await drivePermissions.verifyDriveOwnership(board));
    collaborationDiagnostic("board_authority.rekeyed", { room: "explicit Drive ownership re-key" });
    return transition;
  }

  async function boardSecurityFor(projectId: string): Promise<CollaborationSecurityOptions | null> {
    if (await independentCollaboration()) {
      // Independent mode must also pass the single decision point before its
      // transport asks for security: a lost grant record on a board this
      // device signed is restored there, a Drive-verified owner may re-key
      // there, and a board whose authority is advertised elsewhere is never
      // given a second one here. Refusals are diagnostics, not board errors —
      // this path degrades to Drive synchronization, and the panel/recovery
      // surfaces carry the reason.
      if (!await boardCollaboration.localBundle(projectId)) await boardCollaboration.adoptAuthority(projectId);
      return boardCollaboration.security(projectId);
    }
    if (!await driveConnected()) return null;
    if (legacyBroker()) {
      const role = await drivePermissions.myRole(projectId);
      const file = await drivePermissions.projectFileId(projectId);
      const folder = (await sharedProjects.get(projectId)).folderId;
      if (!role || !file || !folder) throw new Error("Enable Drive sharing before starting the Google-verified experiment");
      return googleBroker.security({ kind: "board", scope: projectId, file, folder, role });
    }
    const pins = await readPins();
    const pin = pins[`board:${projectId}`];
    if (!pin) return unavailableSecurity("board", "pin");
    const layout = await drivePermissions.realtimeFolderId(projectId).then(() => drivePermissions.projectFileId(projectId));
    const fileId = await layout || null;
    void fileId;
    return resolveManifest(pin, "cards", {
      boardId: projectId,
      driveProjectFileId: (await drivePermissions.projectFileId(projectId)) ?? "",
      driveFolderId: (await sharedProjects.get(projectId)).folderId ?? ""
    });
  }

  async function accountSecurityFor(account: string): Promise<CollaborationSecurityOptions | null> {
    if (legacyBroker()) return googleBroker.security({ kind: "account", scope: account, file: "", folder: "", role: "owner" });
    const pins = await readPins();
    const pin = pins[`account:${account}`];
    if (!pin) return unavailableSecurity("account", "pin");
    return resolveManifest(pin, "accountOrder", null);
  }

  // Manifest fetch helpers: board manifests are stored as signed envelope JSON.
  async function readBoardManifest(projectFileId: string, folderId: string, strict = false): Promise<string | null> {
    const transport = permissionTransport();
    const name = "pboard-manifest.json";
    const direct = await transport.findFile(name, folderId).catch(error => { if (strict) throw error; return null; });
    if (direct) return transport.downloadFileOrNull(direct.id);
    void projectFileId;
    return null;
  }

  /** The account authority file exactly as Drive holds it: the signed manifest
   * *and* the public key that signed it (`accountAuthority.ts`). Adoption needs
   * the key, because a browser that holds no pin has nothing else to verify the
   * signature against. */
  async function readAccountAuthorityFile(account: string, strict = false): Promise<string | null> {
    const transport = createDriveTransport(googleAuth, fetcher, ACCOUNT_AUTHORITY_PREFIX);
    const file = await transport.findProjectFile(account).catch(error => { if (strict) throw error; return null; });
    return file ? transport.download(file.id).catch(error => { if (strict) throw error; return null; }) : null;
  }

  /** The signed manifest alone — what a pinned browser verifies and what the
   * relay admission presents. Unwrapped from the file, so every existing caller
   * that expects a `SignedManifest` keeps working. */
  async function readAccountManifest(account: string, strict = false): Promise<string | null> {
    const raw = await readAccountAuthorityFile(account, strict);
    if (!raw) return null;
    const file = openAccountAuthorityFile(raw);
    return file ? JSON.stringify(file.signed) : raw;
  }

  const manifestEpochStore = storageManifestEpochs(storage);

  // Per-project mutation verification (protocol 2): a document that arrives
  // through any persistence path for this project must carry valid signed
  // provenance or the write is rejected with a 422-equivalent storage error.
  const activeGuards = new Map<string, { install: MutationGuardInstall; projectId: string; security: CollaborationSecurityOptions; managed: boolean }>();

  async function installBoardMutationGuard(projectId: string, prepared?: CollaborationSecurityOptions, managed = false): Promise<MutationGuardInstall | null> {
    const securityContext = prepared ?? await boardSecurityFor(projectId);
    if (!securityContext) return null;
    const rx = await getRepository();
    if (!rx) return null;
    const pending = await storage.get("pboardEnrollmentAttestations");
    const all = (pending.pboardEnrollmentAttestations ?? {}) as Record<string, number>;
    // Only the first verified owner bootstraps existing unsigned local data.
    // A second same-account browser must receive signed data; stamping its stale
    // local snapshot with a new timestamp could overwrite newer shared content.
    const firstBrokerManifest = securityContext.manifestHistory?.get(1);
    const brokerBootstrapOwner = firstBrokerManifest?.devices.some(d => d.deviceKeyId === securityContext.signer.deviceKeyId && d.role === "owner") &&
      securityContext.manifest.devices.some(d => d.deviceKeyId === securityContext.signer.deviceKeyId && d.role === "owner");
    const install = await rx.installBoardSecurity({
      preserveSignedData: await independentCollaboration(),
      security: securityContext, attestExisting: await independentCollaboration() ? await boardCollaboration.canBootstrap(projectId) : legacyBroker() ? Boolean(brokerBootstrapOwner) : all[projectId] === securityContext.manifest.epoch });
    if (!await independentCollaboration() && !legacyBroker() && all[projectId] !== undefined) { delete all[projectId]; await storage.set({ pboardEnrollmentAttestations: all }); }
    if (await independentCollaboration()) {
      try { await boardCollaboration.markBootstrapped(projectId); }
      catch (error) { await install.uninstall(); throw error; }
    }
    activeGuards.set(projectId, { install, projectId, security: securityContext, managed });
    return install;
  }

  async function removeBoardMutationGuard(projectId: string): Promise<void> {
    const active = activeGuards.get(projectId);
    if (!active) return;
    activeGuards.delete(projectId);
    await active.install.uninstall();
  }

  /**
   * Verifies current board authorization out-of-band (without becoming the
   * actively collaborated board) and admits held pending work under it. The
   * mutation guard remains installed until replaced or stopped, so the recovery
   * panels can reconcile work on boards the manager is not currently connected
   * to. Fail-closed: no verified current grant or an
   * unverifiable manifest leaves everything retained.
   */
  async function renewBoardAuthorization(projectId: string): Promise<{ role: string }> {
    if (operationSync) return { role: await operationService.role(projectId) };
    const active = activeGuards.get(projectId);
    if (active?.managed) {
      // The manager owns its transports and guard. Let it refresh/restart them
      // together; an installed guard can be expired and is not proof of access.
      await collaborationManager.refreshRole();
      const currentGrant = (guard: typeof active | undefined) => !!guard && guard.security.manifest.expiresAt > Date.now() && manifestIsCurrent(guard.security.manifest, Date.now());
      const refreshed = activeGuards.get(projectId);
      if (refreshed && !currentGrant(refreshed)) await collaborationManager.start(projectId);
      const current = activeGuards.get(projectId);
      if (!current || !currentGrant(current)) throw new Error('No current board authorization is available. Local work is retained.');
      const role = current.security.manifest.devices.find(d => d.deviceKeyId === current.security.signer.deviceKeyId)?.role;
      const rx = await getRepository();
      if (!rx) throw new Error('Local repository is unavailable');
      if (role === 'owner' || role === 'editor') await rx.admitPendingWork(projectId);
      return { role: role ?? 'none' };
    }
    const securityContext = await boardSecurityFor(projectId);
    if (!securityContext) throw new Error("No current board authorization is available. Reconnect or renew board access first; local work is retained.");
    if (active) await removeBoardMutationGuard(projectId);
    const install = await installBoardMutationGuard(projectId, securityContext);
    if (!install || install.projectId !== projectId) throw new Error("Current board authorization could not be verified; local work is retained");
    const rx = await getRepository();
    if (!rx) { await removeBoardMutationGuard(projectId); throw new Error("Local repository is unavailable"); }
    // The guard stays installed so the panels can resolve/reconcile under the
    // verified grant. It is replaced when the manager starts this board, and its
    // manifest expiry keeps stale admission from signing anything new.
    const role = securityContext.manifest.devices.find(d => d.deviceKeyId === securityContext.signer.deviceKeyId)?.role;
    if (role === "owner" || role === "editor") await rx.admitPendingWork(projectId);
    return { role: role ?? "none" };
  }

  /** Import a shared project's snapshot from Drive when there is no local copy yet. */
  async function bootstrapFromDrive(projectId: string): Promise<boolean> {
    const rx = await getRepository();
    if (!rx) throw new Error("Collaboration requires the RxDB storage backend");
    if (await rx.getProject(projectId)) return false;
    const snapshot = deserializeProjectSnapshot(await drivePermissions.readSharedSnapshot(projectId));
    await rx.importProject(snapshot.project, snapshot.items);
    return true;
  }

  /** Drive I/O only when connected; private/unconnected projects resolve null locally. */
  const driveConnected = async () => (await googleAuth.getConnectionState()) === "connected";

  const autoBootstrapAuthority = createAuthorityAutoBootstrap({
    driveConnected,
    hasLocalBundle: async boardId => Boolean(await boardCollaboration.localBundle(boardId)),
    sync: boardId => identitySharing.sync(boardId, true)
  });

  /**
   * The connected account's identity.
   *
   * The account is asked for on every private-history sync, twice: once for
   * the erasure inventory and once for the history itself. The answer is not
   * cached here: a different Google account can be signed in without the
   * stored token changing, so a cached identity could report the previous
   * account and let a board be written under it. The shared permission
   * transport caches the identity for the short-lived checks that need it.
   */
  async function connectedAccountEmail(): Promise<string> {
    collaborationCounters.countAccountIdentity(false);
    const user = await permissionTransport().currentIdentity();
    if (!user) throw new Error("Could not identify the Google Drive account");
    return user.email.trim().toLowerCase();
  }

  async function connectedAccountId(): Promise<string | null> {
    if (!await driveConnected()) return null;
    return hashBlob(new Blob([await connectedAccountEmail()]));
  }
  async function privateErasureAccount(boardId: string): Promise<string | null> {
    const rx = await getRepository();
    const bound = rx && (await rx.db.settings.findOne(`privateDrive:${await hashBlob(new Blob([boardId]))}`).exec())?.value;
    return bound || await connectedAccountId();
  }

  /** Explicit connect-time enrollment, scoped to the successfully verified account
   * and the boards reviewed by this action. Old timestamp-only consent is ignored. */
  async function authorizePrivatePersistence(boardId?: string) {
    const accountId = await connectedAccountId();
    const rx = await getRepository();
    if (!accountId || !rx) throw new Error("Connect Google and open local storage before enabling private persistence");
    const visibleBoards = (await rx.listProjects()).map(project => project.id);
    if (boardId && !visibleBoards.includes(boardId)) throw new Error("Select a local board before enabling private persistence");
    await withStorageLock(storage, "pboardBindingDisclosure", async () => {
      const previous = (await storage.get("pboardBindingDisclosure")).pboardBindingDisclosure as { version?: number; accountId?: string; boardIds?: string[] } | undefined;
      const priorBoards = previous?.version === 1 && previous.accountId === accountId && Array.isArray(previous.boardIds) ? previous.boardIds : [];
      const boardIds = boardId ? [...new Set([...priorBoards, boardId])] : visibleBoards;
      if (await connectedAccountId() !== accountId) throw new Error("Google account changed during private persistence enrollment");
      await storage.set({ pboardBindingDisclosure: { version: 1, accountId, boardIds, grantedAt: new Date().toISOString() } });
    });
  }

  const syncAccountPreferences = createAccountPreferenceSync({
    transport: createDriveTransport(googleAuth, fetcher, "account-preferences-", operationSync ? () => boardStore.rootFolder() : undefined),
    legacySource: operationSync ? createDriveTransport(googleAuth, fetcher, 'account-preferences-') : undefined,
    getAccountId: connectedAccountId,
    getRepository: () => getRepository()
  });

  const refreshFromDrive = createSharedProjectRefresh({
    connected: driveConnected, permissions: drivePermissions,
    getRepository: () => getRepository(),
    isDeleted: async (projectId) => Boolean(await driveTombstones.get(projectId)) ||
      Boolean(await (await getRepository())?.isDeletedProject(projectId))
  });

  const enrollmentTransport = permissionTransport();
  /** The identity a ceremony runs as. Shared with the automatic account
   * bootstrap, so the button and the background act can never disagree about
   * which account they are enrolling. */
  async function enrollmentIdentity(kind: "board" | "account", scope?: string): Promise<EnrollmentIdentity> {
    if (!await driveConnected()) throw new Error("Connect Google Drive before enrolling devices");
    const user = await enrollmentTransport.currentIdentity();
    if (!user) throw new Error("Google account identity unavailable");
    const email = user.email.trim().toLowerCase();
    if (kind === "account") {
      const account = await hashBlob(new Blob([email]));
      if (scope && scope !== account) throw new Error("Cannot enroll another account");
      return { kind, scope: account, boardId: `account:${account}`, driveProjectFileId: "", driveFolderId: "", email, role: "owner" };
    }
    if (!scope) throw new Error("Select a shared board first");
    const role = await drivePermissions.myRole(scope);
    const file = await drivePermissions.projectFileId(scope);
    const folder = (await sharedProjects.get(scope)).folderId;
    if (!role || !file || !folder) throw new Error("Enable Drive sharing and verify access before enrolling this board");
    return { kind, scope, boardId: scope, driveProjectFileId: file, driveFolderId: folder, email, role };
  }
  const experimentalEnrollment = createDeviceEnrollment({
    storage,
    identity: enrollmentIdentity,
    async read(id) {
      if (id.kind === "board") return readBoardManifest(id.driveProjectFileId, id.driveFolderId);
      // The ceremony's own view of an account manifest is the signed envelope,
      // so `initialize`/`approve` keep working unchanged; the file on Drive also
      // carries the public authority key that signs it (`accountAuthority.ts`),
      // which is what a *second* browser of the account verifies it with.
      const raw = await readAccountManifest(id.scope);
      if (!raw) return null;
      const file = openAccountAuthorityFile(raw);
      return file ? JSON.stringify(file.signed) : raw;
    },
    async publish(id, text) {
      if (id.kind === "board") {
        const file = await enrollmentTransport.findFile("pboard-manifest.json", id.driveFolderId);
        if (file) await enrollmentTransport.uploadJsonFile(file.id, text);
        else await enrollmentTransport.createJsonFile("pboard-manifest.json", id.driveFolderId, text);
      } else {
        // Published with its public authority key, never as a bare payload: the
        // payload names only a fingerprint, and a second browser of this account
        // that could not verify the signature would have to mint a second
        // authority — the split the single-source rule forbids.
        const authority = await loadPurposeKey(`account-authority:${id.scope}`);
        if (!authority) throw new Error("Account authority key is unavailable in this browser");
        const transport = createDriveTransport(googleAuth, fetcher, ACCOUNT_AUTHORITY_PREFIX);
        const file = await transport.findProjectFile(id.scope);
        const signed = parseStrictJson(text) as unknown as SignedManifest;
        await transport.upload(id.scope, sealAccountAuthorityFile(authority.publicJwk, signed), file?.id);
      }
    },
    async roleForEmail(id, email) {
      if (id.kind === "account") return email === id.email ? "owner" : null;
      return (await drivePermissions.listCollaborators(id.scope)).find(person => person.email.trim().toLowerCase() === email)?.role ?? null;
    }
  });

  // ---------------------------------------------------------------------------
  // Automatic account-authority bootstrap.
  //
  // The account room is admitted by an `account:<hash>` pin, and until now the
  // only code that created one was a button in a component that is mounted
  // nowhere, so the channel reported `absent-pin` in every shipped browser and
  // a board one browser created reached the other only through the Drive
  // publication flush plus a poll (`docs/collaboration.md`, gap 1). This is the
  // same ceremony `experimentalEnrollment.initialize('account')` performs — the
  // authority signs an account manifest into appDataFolder and `pin()` stores
  // the fingerprint — run as an automatic act instead of a button:
  //
  //  - **Once per account per context.** An in-flight promise per account is
  //    shared, so a reconcile round, a board open and a channel start at the
  //    same moment cost one attempt, and a recorded attempt backs off like the
  //    board authority's own auto-bootstrap (`AUTO_BOOTSTRAP_RETRY_MS`).
  //  - **Never on a board's critical path.** Every caller is fire-and-forget;
  //    the promise below never rejects, so a bootstrap that fails is a sentence
  //    in `pboardCollaboration()` and nothing else.
  //  - **Two races, both answered by re-reading storage after the fact**, never
  //    by trusting an in-memory decision. `initialize` publishes before it
  //    pins, so the loser of the publish race may still pin a manifest whose
  //    authority differs from the one another context just pinned — hence the
  //    cross-context lock and the "pins disagree" verdict, which drops the
  //    attempt instead of overwriting. And `pin()` already refuses to move a
  //    pin (`Authority already pinned; rotation requires a separate recovery
  //    procedure`), so the account authority is as immutable as a board's.
  // ---------------------------------------------------------------------------
  const ACCOUNT_AUTHORITY_LOCK = "pboardAccountAuthorityBootstrap";
  const accountAuthorityAttempts = new Map<string, number>();
  const accountAuthorityRuns = new Map<string, Promise<void>>();
  /** The last attempt's verdict per account, for the diagnostics. A state, not
   * a log line: `absent-pin` plus this answers *why*. */
  const accountAuthorityReports = new Map<string, AccountAuthorityReport>();
  /** Per-account reasons why the account room's *content key* is not available.
   * Kept apart from the authority verdict on purpose: an authority can be
   * perfect and the room still unopenable for want of the key, and that is the
   * cause a person needs to see. */
  const accountKeyReports = new Map<string, string>();
  /** The peer wrap keys this account's last courier pass sealed for. The
   * authority compares it against a fresh listing: identical means no device
   * joined, and a pass would publish nothing. */
  const accountSealedPeers = new Map<string, string[]>();
  /** When this context last looked, so the check runs at the account channel's
   * own heartbeat cadence and not on every status announce. */
  const accountPeerCheckedAt = new Map<string, number>();
  const accountAuthorityReport = (account: string | null): AccountAuthorityReport => {
    const report = (account ? accountAuthorityReports.get(account) : undefined)
      ?? { state: "idle" as const, reason: "no account authority attempt has been made in this context" };
    // The key's own cause rides along whenever there is one: `failed` with
    // `no account content key` says nothing about *why*, and the answer — the
    // grant never arrived — is the whole diagnosis.
    const key = account ? accountKeyReports.get(account) : undefined;
    return key ? { ...report, authorization: key } : report;
  };

  /**
   * Establish `account:<hash>` if this browser can, and report what happened.
   * Idempotent, never throws, and never awaited by anything a person waits for.
   *
   * The order inside the lock is the admission order, and its first rule is
   * that **a pin already held is truth**: this bootstrap reads it and decides
   * what it can do *with* it, and never generates a key that would have to
   * replace it.
   *
   *  1. a pin is present → `settleAccountAuthority`:
   *     - the published manifest is current and lists this device → `adopted`
   *       when this browser holds the pinned authority's key, and
   *       `authority-not-local` when it does not (a second device of the
   *       account is exactly that state, by design);
   *     - the manifest does not list this device → the device request is filed
   *       and the verdict is `awaiting-admission`;
   *     - the manifest expired (or Drive has none) and this browser holds the
   *       pinned authority's key → re-sign it under that key (`renewed`);
   *     - the same, without the key → `authority-not-local`, stated plainly:
   *       only the browser that holds the key can publish a manifest, and
   *       generating a second authority here is what used to make this fail
   *       with `Manifest authority does not match the pinned authority`;
   *     - Drive holds a manifest signed by another authority → `failed`, and
   *       the pin stays exactly where it was.
   *  2. no pin, but this account's Drive holds an adoptable authority → adopt
   *     it: verify it under its own key, check it names `account:<hash>` with no
   *     Drive binding, then pin it (`adopted`, or `awaiting-admission` when the
   *     manifest does not list this device yet).
   *  3. no pin and nothing to adopt → `initialize` mints this account's
   *     authority and publishes it; the pin it writes is the one this browser
   *     uses from now on (`pinned`).
   *
   * A pin is never moved: `pinAccountAuthority` is create-only, and
   * `initialize`'s own `pin()` refuses a different fingerprint. The storage
   * lock means one context of this profile runs the sequence at a time, so two
   * contexts racing with no pin end with one pin, not two authorities. A
   * cross-account manifest is never adopted — `assertBinding`'s account rule is
   * re-checked before a pin is written.
   */
  function bootstrapAccountAuthority(account: string): Promise<void> {
    const running = accountAuthorityRuns.get(account);
    if (running) return running;
    const last = accountAuthorityAttempts.get(account);
    if (last !== undefined && Date.now() - last < AUTO_BOOTSTRAP_RETRY_MS) return Promise.resolve();
    const report = (value: AccountAuthorityReport) => { accountAuthorityReports.set(account, value); };
    const pass = (async () => {
      try {
        if (!await driveConnected()) { report({ state: "failed", reason: "Google Drive is not connected" }); return; }
        await withStorageLock(storage, ACCOUNT_AUTHORITY_LOCK, async () => {
          accountAuthorityAttempts.set(account, Date.now());
          const pin = (await readPins())[`account:${account}`];
          // Another context of this profile may have pinned between the read
          // above and this section; it won the lock, and its pin is the answer.
          if (pin) { await settleAccountAuthority(account, pin); return; }
          // No pin: adopt the authority this account published from another
          // browser before minting a second one.
          const published = await readAccountAuthorityFile(account).catch(() => null);
          if (published && await adoptPublishedAccountAuthority(account, published)) {
            collaborationDiagnostic("account_authority.adopted");
            return;
          }
          // A create-only pin may have appeared while the file was being read
          // (the enrollment button does not take this lock). It is truth now.
          const appeared = (await readPins())[`account:${account}`];
          if (appeared) { await settleAccountAuthority(account, appeared); return; }
          await establishAccountAuthority(account, "create");
        });
      } catch (error) {
        // A stated cause, never a throw and never an error dialog: the board
        // opens, Drive synchronizes, and the console says what happened.
        accountAuthorityReports.set(account, { state: "failed",
          reason: error instanceof Error ? error.message : String(error) });
        collaborationDiagnostic("account_authority.failed");
      } finally {
        accountAuthorityRuns.delete(account);
      }
    })();
    accountAuthorityRuns.set(account, pass);
    return pass;
  }

  /** What Google Drive currently says about the pinned authority. Absence and
   * unreadability are kept apart on purpose: an absent manifest is the authority
   * browser's to publish, while a failed read is nobody's fault and is retried
   * by the next round without spending a publish. */
  type AccountManifestView =
    | { kind: "current"; manifest: BoardPermissionManifest }
    | { kind: "expired" }
    | { kind: "absent" }
    | { kind: "foreign" }
    | { kind: "unreadable" };

  async function accountManifestView(account: string, pin: SecurityPins[string]): Promise<AccountManifestView> {
    let raw: string | null;
    try { raw = await readAccountManifest(account, true); }
    catch { return { kind: "unreadable" }; }
    if (!raw) return { kind: "absent" };
    try {
      const manifest = await verifyManifest(parseStrictJson(raw) as unknown as SignedManifest, pin.authorityPublicKey, pin.authorityKeyId);
      return manifest.expiresAt <= Date.now() ? { kind: "expired" } : { kind: "current", manifest };
    } catch {
      // Fail closed: a manifest that does not verify under the pin is not ours,
      // and this bootstrap neither adopts nor overwrites it.
      return { kind: "foreign" };
    }
  }

  /** The `account-authority:<hash>` key, but only when it *is* the pinned
   * authority. A purpose slot naming another key — one this browser generated
   * before it adopted the account's published authority, or a leftover of an
   * earlier install — must never sign the account manifest: the relay and every
   * other device of the account verify against the pin, not against this slot. */
  async function pinnedAuthorityKey(account: string, pin: SecurityPins[string]): Promise<StoredDeviceKey | null> {
    const key = await loadPurposeKey(`account-authority:${account}`).catch(() => null);
    return key && key.keyId === pin.authorityKeyId ? key : null;
  }

  async function accountDeviceListed(account: string, manifest: BoardPermissionManifest): Promise<boolean> {
    const own = await ensureDeviceKey(`account-device:${account}`);
    return manifest.devices.some(device => device.deviceKeyId === own.keyId);
  }

  /**
   * Use an existing pin as this browser's truth about the account authority,
   * and say what that leaves it able to do.
   *
   * The pin is the account's *public* fact: the relay admits a device by the
   * manifest that authority signed, and this browser signs the room's records
   * with its own `account-device:<hash>` key. A browser holding the pin but not
   * the authority's private key is therefore a normal, working device of the
   * account — it can read and write the room — but it can never renew the
   * manifest, and it must never generate a key of its own to try. The two facts
   * are reported apart: `adopted` when the pinned key is here,
   * `authority-not-local` when it is not, with the reason saying whether the
   * room is usable and, when it is not, why.
   */
  async function settleAccountAuthority(account: string, pin: SecurityPins[string]): Promise<void> {
    const report = (value: AccountAuthorityReport) => { accountAuthorityReports.set(account, value); };
    const local = await pinnedAuthorityKey(account, pin);
    const state = local ? "adopted" as const : "authority-not-local" as const;
    const where = local
      ? "the account authority pin was reused; this browser holds its key"
      : "the account authority pin was reused; this browser does not hold its key";
    const view = await accountManifestView(account, pin);
    if (view.kind === "current") {
      if (await accountDeviceListed(account, view.manifest)) {
        report({ state, reason: `${where}, and the published manifest is current` });
        return;
      }
      await fileAccountDeviceRequest(account);
      report({ state: "awaiting-admission",
        reason: "the published account authority does not list this device yet; the authority browser admits it on its next pass" });
      return;
    }
    if (view.kind === "unreadable") {
      // Not proof of anything: the dial reports its own cause and the next
      // round retries. Renewing on a transient Drive error would spend a
      // publish to fix a network blip.
      report({ state, reason: `${where}; the published manifest could not be read on this pass` });
      return;
    }
    if (view.kind === "foreign") {
      report({ state: "failed",
        reason: "Google Drive holds an account authorization signed by a different authority than this browser's pin; the pin was left untouched" });
      return;
    }
    // `expired` or `absent`: a new manifest is needed, and only the authority
    // browser can sign one. Without its key this is a stated fact, not a
    // mismatch, and nothing is generated or pinned in its place.
    if (!local) {
      report({ state: "authority-not-local",
        reason: `${where}; ${view.kind === "absent" ? "Google Drive holds no account authorization" : "the published authorization has expired"}, `
          + "and only the browser holding the pinned authority's key can publish a new one" });
      return;
    }
    await establishAccountAuthority(account, "renew");
  }

  const accountManifestKeepAlives = new Map<string, { timer: ReturnType<typeof setInterval>; running?: Promise<void>; publishedAt: number }>();

  /**
   * Keep this browser's *attached* account-room lease alive. While the channel
   * reports `connected`, a fixed 60-second tick renews the account manifest
   * when it has expired or is within two minutes of expiry — the only window
   * in which `renew` (re-sign under the pinned authority, same key, epoch + 1)
   * prevents the scheduled five-minute detach. A browser that is not the
   * authority browser signs nothing and the tick costs one storage read; a
   * Drive hiccup is left to the next tick, and the publish floor keeps one
   * flapping round from spending a publish per minute.
   */
  function keepAccountManifestTicker(account: string, connected: boolean): void {
    const existing = accountManifestKeepAlives.get(account);
    if (!connected) { if (existing) { clearInterval(existing.timer); accountManifestKeepAlives.delete(account); } return; }
    if (existing) return;
    const entry = { publishedAt: 0, timer: setInterval(() => undefined, 0) };
    entry.timer = setInterval(() => { void keepAccountManifestFresh(account, entry).catch(() => undefined); }, 60_000);
    accountManifestKeepAlives.set(account, entry);
    void keepAccountManifestFresh(account, entry).catch(() => undefined);
  }

  async function keepAccountManifestFresh(account: string, entry: { running?: Promise<void>; publishedAt: number }): Promise<void> {
    if (entry.running) return;
    entry.running = (async () => {
      try {
        const pin = (await readPins())[`account:${account}`];
        if (!pin || !await pinnedAuthorityKey(account, pin)) return; // Not the authority browser: there is nothing for this tick to sign.
        const view = await accountManifestView(account, pin);
        const needs = view.kind === "expired"
          || (view.kind === "current" && view.manifest.expiresAt - Date.now() < 120_000);
        if (!needs || Date.now() - entry.publishedAt < 60_000) return;
        await establishAccountAuthority(account, "renew");
        entry.publishedAt = Date.now();
      } finally { entry.running = undefined; }
    })();
    await entry.running;
  }

  /**
   * Keep an *attached* board's grant lease alive — the board twin of the
   * account ticker above. The renewal is lazy by design: `security()` re-issues
   * the manifest (epoch + 1) only when somebody calls while it is inside the
   * renew window, and the room-construction path calls once at open. Without
   * this tick the grant died 300 s after every board open, the relay detached
   * every attached room at that instant (`grant_expired`), and second browsers
   * could only ever join in the first five minutes — a board that worked at
   * 10:00 and silently stopped at 10:05 was this missing caller, not the
   * network. Only the authority browser has anything to re-sign; for a joiner
   * `security()` would spend a grant-service read every minute against the
   * documented absence-cache design, so the tick is gated on `ownsAuthority`
   * and a Drive or relay hiccup is simply left to the next tick.
   */
  const boardGrantKeepAlives = new Map<string, ReturnType<typeof setInterval>>();
  function armBoardGrantKeepAlive(boardId: string): void {
    if (boardGrantKeepAlives.has(boardId)) return;
    boardGrantKeepAlives.set(boardId, setInterval(() => {
      void (async () => {
        if (await boardCollaboration.ownsAuthority(boardId)) await boardCollaboration.security(boardId);
      })().catch(() => undefined);
    }, 60_000));
  }
  function disarmBoardGrantKeepAlive(boardId: string): void {
    const timer = boardGrantKeepAlives.get(boardId);
    if (timer) { clearInterval(timer); boardGrantKeepAlives.delete(boardId); }
  }

  /**
   * The explicit, one-way way out of a `foreign` dead end.
   *
   * The field state this exists for: the pin names authority A, the account
   * manifest published in Drive is signed by authority B, and the automatic
   * bootstrap refuses to move the pin — deliberately, because a manifest is
   * written into this account's `appDataFolder` and anyone who can write that
   * folder could publish one. Automatic adoption would hand the account room to
   * whoever wrote the file last; fail-closed stays the default and this is the
   * one thing that overrides it. **Only an explicit user gesture reaches here.**
   * No bootstrap, reconcile round, timer or retry may call it: those all go
   * through `bootstrapAccountAuthority`/`settleAccountAuthority`, which never
   * move a pin.
   *
   * The checks, in this order — the first refusal names itself and changes
   * nothing:
   *
   *  1. Google Drive is connected, this context is in the relay posture, and the
   *     Google account resolves to its `account:<hash>`.
   *  2. The published file can be read (`absent` and `unreadable` are kept
   *     apart, as the bootstrap does).
   *  3. The file parses (`openAccountAuthorityFile`: authority key + signed
   *     manifest).
   *  4. Both Drive bindings are empty — the account-room coupling the service
   *     enforces for `account:` manifests. Checked here rather than after the
   *     signature because the manifest validator refuses such a payload outright,
   *     so this is what lets the refusal name the actual rule.
   *  5. The manifest verifies under **its own embedded authority** — signature,
   *     and `authorityKeyId` equal to that key's fingerprint — never under the
   *     stale pin. A file that fails here is not evidence of anything.
   *  6. It names exactly `account:<hash>` for the verified Google account.
   *  7. It lists this browser's `account-device:<hash>` key. A device the
   *     manifest does not name cannot be admitted by the relay, so pinning it
   *     would only produce `awaiting-admission` — this act stays a deliberate
   *     adoption of a manifest that already admits this device.
   *  8. It is unexpired (`manifestIsCurrent`, the same tolerance the admission
   *     uses). An expired manifest would re-pin straight into a room that
   *     refuses it.
   *
   * Then, under the same storage lock the bootstrap uses: the accepted
   * membership record for `account:<hash>` is replaced with this manifest's
   * record (the old one describes the authority being retired; keeping it
   * would make the admission reject the new manifest as a rollback), and the
   * pin is written. Re-running is idempotent: a second call finds the pin
   * already naming this authority and writes nothing.
   *
   * After the pin moves, `settleAccountAuthority` reports what this browser can
   * do with the new authority, and the account channel is started once. It
   * still cannot start without the account content key, and no key can be
   * created without the authority's private key — so a browser that does not
   * hold B's key lands in `authority-not-local` and the channel reports
   * `no account content key`. That is the honest consequence, reported, never
   * hidden: it can read and write the room only if B's key is local.
   */
  async function repinPublishedAccountAuthority(): Promise<AccountRepinResult> {
    const message = (error: unknown) => error instanceof Error ? error.message : String(error);
    if (!await driveConnected()) throw new Error("Account re-pin needs Google Drive: the published account authorization is read from it, and nothing was changed");
    if (!await independentCollaboration()) throw new Error("Account re-pin needs live collaboration enabled: in Drive mode the account authority pin is not used, and nothing was changed");
    const account = await connectedAccountId();
    if (!account) throw new Error("Account re-pin needs a verified Google account, and nothing was changed");

    let raw: string | null;
    try { raw = await readAccountAuthorityFile(account, true); }
    catch (error) {
      throw new Error(`The published account authorization could not be read from Google Drive (${message(error)}); nothing was changed`);
    }
    if (!raw) throw new Error("Google Drive holds no account authorization file for this account; the browser that holds the account authority must publish one, and nothing was changed");

    const file = openAccountAuthorityFile(raw);
    if (!file) throw new Error("The published account authorization file is malformed: it must carry an authority key and a signed manifest, and nothing was changed");

    // The account-room coupling the service enforces: an `account:` manifest
    // carries no Drive binding at all. Checked before the signature because the
    // manifest validator refuses such a payload outright — a signed file that
    // violates it is not a manifest whose signature can even be read, and this
    // refusal has to name the actual rule rather than a generic parse failure.
    const bound = (file.signed.payload ?? {}) as Partial<BoardPermissionManifest>;
    if ((bound.driveProjectFileId ?? "") !== "" || (bound.driveFolderId ?? "") !== "") {
      throw new Error("The published authorization is bound to a Drive file or folder; an account authorization must carry no Drive binding, and nothing was changed");
    }

    let manifest: BoardPermissionManifest;
    let fingerprint: string;
    try {
      // Verified under the key the file carries, never under the stale pin.
      // This is the only check that makes the file evidence rather than a claim.
      fingerprint = await publicKeyFingerprint(file.authority);
      manifest = await verifyManifest(file.signed, file.authority, fingerprint);
    } catch (error) {
      throw new Error(`The published account authorization does not verify under the authority it carries (${message(error)}); nothing was changed`);
    }
    if (manifest.boardId !== `account:${account}`) {
      throw new Error(`The published authorization names ${manifest.boardId}, not account:${account}; it belongs to a different account, and nothing was changed`);
    }
    // Loaded, never created: a refusal must not write anything, and a browser
    // with no account device key certainly is not in the manifest.
    const own = await loadPurposeKey(`account-device:${account}`).catch(() => null);
    if (!own || !manifest.devices.some(device => device.deviceKeyId === own.keyId)) {
      throw new Error(`The published authorization does not list this browser's account device${own ? ` ${own.keyId.slice(0, 12)}` : ""}; ask the authority browser to admit this device first, and nothing was changed`);
    }
    if (!manifestIsCurrent(manifest, Date.now())) {
      throw new Error(`The published authorization expired at ${new Date(manifest.expiresAt).toISOString()}; the browser that holds its key must renew it before this browser can trust it, and nothing was changed`);
    }

    const queuedBefore = accountLifecycle.status().outbox;
    let previousAuthorityKeyId: string | null = null;
    let unchanged = false;
    await withStorageLock(storage, ACCOUNT_AUTHORITY_LOCK, async () => {
      const pins = await readPins();
      const previous = pins[`account:${account}`] ?? null;
      previousAuthorityKeyId = previous?.authorityKeyId ?? null;
      unchanged = previous?.authorityKeyId === fingerprint;
      if (unchanged) return;
      // The accepted membership record describes the authority this pin is
      // replacing. Resetting it is part of the act: keeping it would make the
      // new authority's manifest fail as an epoch rollback in `resolveManifest`.
      await manifestEpochStore.write(`account:${account}`, {
        epoch: manifest.epoch, hash: manifestHash(manifest), expiresAt: manifest.expiresAt
      });
      pins[`account:${account}`] = {
        scope: account, authorityKeyId: fingerprint, authorityPublicKey: file.authority,
        pinnedAt: Date.now(), kind: "account"
      };
      await writePins(pins);
      collaborationDiagnostic("account_authority.repinned");
    });

    // Re-run the bootstrap against the pin as it now stands — re-read, so a pin
    // another context wrote in between is what this browser settles on.
    const pin = (await readPins())[`account:${account}`];
    if (!pin) throw new Error("The account authority pin disappeared immediately after it was written; nothing was changed");
    await settleAccountAuthority(account, pin);
    // On the browser that holds the new key this is the authority's own half of
    // the handshake: devices that asked to join are admitted on this pass.
    void admitAccountDeviceRequests(account).catch(() => undefined);
    // Open (or rebuild) the channel against the new pin, then give the queue its
    // pass. A channel that cannot get the content key reports that reason instead
    // of connecting blind; nothing here waits on the relay beyond that.
    await accountLifecycle.start().catch(() => undefined);
    // Bounded, and not a retry loop: a record queued while an earlier flush pass
    // was already running is left for the next pass by the channel's own design,
    // and "the records you were told about will flush" is a promise this act has
    // to keep. Three passes cover the rows that were waiting plus any that one of
    // them raced; a record the log refuses stays counted in `outbox` and is
    // reported as such.
    for (let pass = 0; pass < 3 && accountLifecycle.status().state === "connected" && accountLifecycle.status().outbox > 0; pass++) {
      await accountLifecycle.flush().catch(() => undefined);
    }
    const channel = accountLifecycle.status();
    const local = await pinnedAuthorityKey(account, pin);
    return {
      authorityKeyId: pin.authorityKeyId,
      previousAuthorityKeyId,
      canRenew: Boolean(local),
      channelState: channel.state,
      channelReason: channel.reason,
      outbox: channel.outbox,
      queuedBefore,
      unchanged
    };
  }

  /**
   * Sign the account manifest with the key this browser holds for the account,
   * publish it, and pin it. Reached only when there is no pin at all (`create`)
   * or when this browser holds the pinned authority and the manifest on Drive is
   * absent or expired (`renew`).
   */
  async function establishAccountAuthority(account: string, mode: "create" | "renew"): Promise<void> {
    const report = (value: AccountAuthorityReport) => { accountAuthorityReports.set(account, value); };
    const identity = await enrollmentIdentity("account");
    // The account hash is derived from the *verified* Google identity, so this
    // is a real binding rather than a comparison: an account switch between the
    // read that found the pin and here cannot sign under the wrong scope.
    if (identity.scope !== account) throw new Error("Connected Google account changed during account authority bootstrap");
    let result;
    try {
      result = await experimentalEnrollment.initialize("account");
    } catch (error) {
      // `initialize` publishes before it pins, and the explicit enrollment
      // gesture does not take this lock. If a pin appeared in that window it is
      // truth: this attempt is dropped and the pin decides what happens next,
      // exactly as it would have if it had been there when the lock opened.
      const pin = (await readPins())[`account:${account}`];
      if (!pin) throw error;
      await settleAccountAuthority(account, pin);
      return;
    }
    const after = (await readPins())[`account:${account}`];
    // `initialize` publishes *then* pins, so a context that lost a publish race
    // can end up pinning a manifest whose authority is not the one another
    // browser of the account pinned. That is a fact read back from storage, not
    // an assumption — and the safe answer is to report it and leave the pin
    // exactly as `pin()` left it, never to overwrite it.
    if (!after) { report({ state: "failed", reason: "the account authority manifest was published but not pinned" }); return; }
    if (after.authorityKeyId !== await publicKeyFingerprint(result.authority)) {
      report({ state: "failed", reason: "another browser of this account pinned a different authority; the pin was left untouched" });
      return;
    }
    report({ state: mode === "create" ? "pinned" : "renewed", reason: mode === "create"
      ? "this browser created and published the account authority"
      : "this browser renewed the account authority manifest" });
    collaborationDiagnostic(`account_authority.${mode === "create" ? "pinned" : "renewed"}`);
  }

  /**
   * Ask the authority browser to name this device. The request rides the same
   * private appDataFolder the manifest came through — the same channel, and no
   * weaker, because a device that can write that folder already holds the
   * account's entire private Drive. Total and bounded: the file is written (or
   * refreshed in place) and the authority browser's next pass admits the device;
   * nothing here rejects, and nothing here is a grant.
   */
  async function fileAccountDeviceRequest(account: string): Promise<void> {
    try {
      const own = await ensureDeviceKey(`account-device:${account}`);
      const transport = createDriveTransport(googleAuth, fetcher, ACCOUNT_DEVICE_PREFIX);
      const name = accountDeviceRequestId(account, own.keyId);
      const existing = await transport.findProjectFile(name).catch(() => null);
      const text = sealAccountDeviceRequest({ account, deviceKeyId: own.keyId, publicKey: own.publicJwk, at: Date.now() });
      await transport.upload(name, text, existing?.id).catch(() => undefined);
    } catch { /* the next pass retries */ }
    void admitAccountDeviceRequests(account).catch(() => undefined);
  }

  /**
   * Adopt the account authority another browser of this account published.
   *
   * This is the same admission `trust()` performs, with the fingerprint taken
   * from *this account's own private appDataFolder* instead of from a human
   * reading it out loud — the documented account bootstrap trust, and no
   * weaker than the folder it comes from, because a device that can write that
   * folder already holds the account's entire private Drive.
   *
   * `verifyAccountAuthorityFile` is what keeps it honest: the signature must
   * verify under the key the file carries, that key must be the manifest's own
   * authority, and the manifest must name exactly `account:<hash>` with empty
   * Drive bindings — so a board manifest, or another account's account
   * manifest, is never adoptable here. A device the manifest does not list then
   * files a request and waits: the pin admits it to the room contract, the
   * manifest alone decides whether the relay does.
   *
   * Returns whether this browser now holds a pin for the account (its own or one
   * that appeared meanwhile); `false` lets the caller create one.
   */
  async function adoptPublishedAccountAuthority(account: string, raw: string): Promise<boolean> {
    const file = openAccountAuthorityFile(raw);
    if (!file) return false;
    const manifest = await verifyAccountAuthorityFile(file, account);
    if (!manifest) return false;
    let pin: SecurityPins[string];
    try { pin = await pinAccountAuthority(account, file.authority); } catch { return false; }
    // Create-only pin: if another context pinned a different authority while
    // this one was reading, that pin is truth and this adoption is discarded —
    // never merged, never overwritten. `settleAccountAuthority` is what then
    // decides what this browser can do with it.
    if (pin.authorityKeyId !== await publicKeyFingerprint(file.authority)) return false;
    await acceptManifest(manifest, manifestEpochStore, Date.now()).catch(() => undefined);
    const local = await pinnedAuthorityKey(account, pin);
    const where = local
      ? "adopted the account authority this account published from another browser"
      : "adopted the account authority this account published from another browser; its key is not in this browser";
    if (await accountDeviceListed(account, manifest)) {
      accountAuthorityReports.set(account, { state: "adopted", reason: where });
    } else {
      // The authority browser admits this device on its next pass; filing the
      // request here is what makes that happen without a gesture.
      await fileAccountDeviceRequest(account);
      accountAuthorityReports.set(account, { state: "awaiting-admission",
        reason: "the published account authority does not list this device yet; the authority browser admits it on its next pass" });
    }
    return true;
  }

  /**
   * The authority browser's half of the same-account handshake: read every
   * request this account's private storage holds, and re-sign the manifest with
   * the requesting devices added, once per pass. Total, bounded, and never on a
   * board's path: a request that does not verify is ignored, and the file is
   * deleted only after the manifest naming it was published *and* pinned.
   */
  async function admitAccountDeviceRequests(account: string): Promise<void> {
    const authority = await loadPurposeKey(`account-authority:${account}`).catch(() => null);
    if (!authority) return; // not this browser's job: only the authority key may re-sign
    const pin = (await readPins())[`account:${account}`];
    if (!pin || pin.authorityKeyId !== authority.keyId) return;
    const raw = await readAccountManifest(account).catch(() => null);
    if (!raw) return;
    const signed = parseStrictJson(raw) as unknown as SignedManifest;
    const manifest = await verifyManifest(signed, authority.publicJwk, authority.keyId).catch(() => null);
    if (!manifest) return;
    const transport = createDriveTransport(googleAuth, fetcher, ACCOUNT_DEVICE_PREFIX);
    const files = await transport.listProjectFiles().catch(() => []);
    const known = new Set(manifest.devices.map(device => device.deviceKeyId));
    const added: { deviceKeyId: string; publicKey: DevicePublicKey; id: string }[] = [];
    for (const file of files) {
      if (added.length + manifest.devices.length >= MAX_MANIFEST_DEVICES) break;
      // The listing gives the file name; the transport writes
      // `<prefix><account>-<deviceKeyId>.pboard`, so the stem minus the prefix
      // is the request's own id and the row is only read when it names this
      // account and a device this manifest does not list yet.
      const stem = file.name.replace(/\.pboard$/, '').replace(ACCOUNT_DEVICE_PREFIX, '');
      const request = await openAccountDeviceRequest(await transport.download(file.id).catch(() => ''), account, Date.now());
      if (!request || stem !== accountDeviceRequestId(account, request.deviceKeyId) || known.has(request.deviceKeyId)) continue;
      added.push({ deviceKeyId: request.deviceKeyId, publicKey: request.publicKey, id: file.id });
    }
    if (!added.length) return;
    // One re-sign for every request this pass found: the manifest is a single
    // document, so N requests would otherwise cost N publishes and N epochs.
    const now = Date.now();
    const manifestEpoch = manifest.epoch + 1;
    const next: BoardPermissionManifest = { ...manifest, epoch: manifestEpoch,
      issuedAt: now, expiresAt: now + MANIFEST_LIFETIME_MS,
      devices: [...manifest.devices, ...added.map(device => ({ deviceKeyId: device.deviceKeyId, publicKey: device.publicKey, role: "owner" as const }))] };
    const signedNext = await signManifest(next, authority);
    const accountTransport = createDriveTransport(googleAuth, fetcher, ACCOUNT_AUTHORITY_PREFIX);
    const current = await accountTransport.findProjectFile(account);
    await accountTransport.upload(account, sealAccountAuthorityFile(authority.publicJwk, signedNext), current?.id);
    await acceptManifest(next, manifestEpochStore, now).catch(() => undefined);
    for (const device of added) await transport.delete(device.id).catch(() => undefined);
    collaborationDiagnostic("account_authority.admitted_devices", { count: added.length });
  }

  const googleBroker = createGoogleBrokerEnrollment({ storage, getAccessToken: () => googleAuth.getAccessToken(), fetcher, canAccessEndpoint: hasSignalingHostPermission });
  let iceConfiguration: Promise<RTCConfiguration | null> | null = null;
  const getIceConfiguration = () => (iceConfiguration ??= loadIceServers(storage).then(iceServers => ({ iceServers })));
  const legacyCollaborationManager: CollaborationManager = createCollaborationManager({
    getAccountId: async () => await independentCollaboration() ? null : connectedAccountId(),
    // Private preference sync verifies and selects its own account. Board pool
    // lifecycle must not clear it, nor add Google identity HTTP on every switch.
    getProjectOrderAccountId: async fallback => await independentCollaboration() && await driveConnected() ? undefined : fallback,
    myRole: async (projectId) => {
      const selected = await boardCollaboration.settings();
      const configured = (await storage.get(COLLABORATION_SETTINGS))[COLLABORATION_SETTINGS];
      signalingSettings = configured ? selected : undefined;
      if (await independentCollaboration()) {
        try { await identitySharing.sync(projectId); }
        catch (error) {
          // Identity discovery is not needed to use an already pinned, current
          // device grant. No new enrollment or unsigned transport is permitted.
          if (!await boardCollaboration.localBundle(projectId)) throw error;
          collaborationDiagnostic("google.identity.unavailable");
        }
        return boardCollaboration.role(projectId);
      }
      return await driveConnected() ? drivePermissions.myRole(projectId) : null;
    },
    getSharedFileId: async (projectId) => await independentCollaboration() ? null : (await driveConnected() ? drivePermissions.projectFileId(projectId) : null),
    bootstrapFromDrive: async (projectId) => await independentCollaboration() ? false : bootstrapFromDrive(projectId),
    refreshFromDrive: async (projectId, isActive) => { if (await independentCollaboration()) return; await refreshFromDrive(projectId, isActive); },
    signalingFor: (topic, security) => selectRuntimeSignaling(topic, () => driveSignalingFor(topic), security, signalingSettings, identitySharing.admitService, budget),
    onHistoryReceived: (projectId) => driveSyncState.markDirty(projectId),
    boardSecurity: boardSecurityFor,
    // Explicit ICE endpoints (pinned defaults + optional operator additions);
    // resolved once per runtime; the loader already degrades to defaults.
    getIceConfiguration,
    accountSecurity: accountSecurityFor,
    securityChanged: async (projectId) => await independentCollaboration() ? boardCollaboration.poll(projectId) : legacyBroker() ? googleBroker.poll(projectId, await connectedAccountId()) : false,
    installMutationGuard: (projectId, security) => installBoardMutationGuard(projectId, security, true),
    removeMutationGuard: (projectId) => removeBoardMutationGuard(projectId),
    // The legacy shared path uses the shared `Pboard/` folder assets; Sync v2
    // uses the board's own `attachments/` files in `/pboard/<boardId>/` plus
    // peer DataChannel bytes. Both need a connected Drive for the file leg.
    useImageTransport: async () => !await independentCollaboration() || await driveConnected(),
    imageTransport: async () => {
      // Sync v2: attachments are files in the board's own Drive folder
      // (`/pboard/<boardId>/attachments/`), the same store as the snapshot.
      if (await independentCollaboration()) return {
        readImage: async (projectId: string, imageId: string) => {
          const found = await boardStore.findAttachment(projectId, imageId);
          if (!found) return null;
          const bytes = await boardStore.downloadFile(found.id);
          if (!bytes) return null;
          return JSON.parse(new TextDecoder().decode(bytes)) as BoardImage;
        },
        writeImage: async (projectId: string, imageId: string, image: BoardImage) => {
          await boardStore.uploadAttachment(projectId, imageId, new TextEncoder().encode(JSON.stringify(image)));
        }
      };
      return {
      readImage: async (projectId, imageId) => {
        const asset = await drivePermissions.readSharedImage(projectId, imageId);
        if (asset) return asset;
        // Recover images from snapshots written before shared image assets existed.
        const snapshot = deserializeProjectSnapshot(await drivePermissions.readSharedSnapshot(projectId));
        if (snapshot.project.id !== projectId) throw new Error("Shared snapshot belongs to a different project");
        for (const card of snapshot.items) {
          if (card.image?.dataUrl.startsWith("data:image/") && await hashBlob(await imageToBlob(card.image.dataUrl)) === imageId) return card.image;
        }
        return null;
      },
      writeImage: (projectId, imageId, image) => drivePermissions.writeSharedImage(projectId, imageId, image)
      };
    },
    getRepository: () => getRepository()
  });

  const driveAuthorityLogs = new Map<string, OperationLogSync>();
  const operationChanges = createDriveChanges({ auth: googleAuth, fetcher, getRepository, getAccountId: connectedAccountId });
  const operationService = createOperationService({ changes: operationChanges, auth: googleAuth, store: boardStore, fetcher, getRepository,
    async recoverLegacyImage(boardId, imageId) {
      const found = await boardStore.findAttachment(boardId, imageId);
      if (found) { const bytes = await boardStore.downloadFile(found.id); if (bytes) return JSON.parse(new TextDecoder().decode(bytes)) as BoardImage; }
      return drivePermissions.readSharedImage(boardId, imageId);
    },
    async realtime(boardId, session, drive) {
      const transport = permissionTransport(), peerId = realtimePeerFor(boardId);
      // The persisted collaboration setting is resolved fresh per board
      // session. The lazily cached `signalingSettings` is only assigned by the
      // legacy manager's role read, which never runs while the operation
      // protocol owns the board — reading the cache here made the relay
      // posture invisible to this factory: no bootstrap, no courier, no log,
      // whatever the settings said.
      const settings = await boardCollaboration.settings();
      if (operationSync && settings.provider !== 'websocket') {
        return { broadcast: async () => false, close: async () => {} };
      }
      // Firefox's OAuth provider supplies both Google identity and Drive
      // credentials. Its room is authorized by Drive and uses its own relay
      // namespace and cursor, independent of the legacy encrypted room.
      if (googleAuth.getDriveIdentityCredentials && settings.provider === 'websocket') {
        const folderId = (await operationService.layout(boardId)).folderId;
        const room = trackRoom(boardId, { self: peerId, topic: `pboard-operations-${boardId}`, folderId });
        const codec = createPlaintextOperationCodec(boardId);
        const cursorKey = 'pboardDriveAuthorityLogCursors';
        const cursors = async () => ((await storage.get(cursorKey))[cursorKey] ?? {}) as Record<string, number>;
        const identityUnavailable = async (): Promise<never> => { throw new Error('Legacy device authority is not used for Drive admission'); };
        const log = await createOperationLogSync({
          boardId, topic: `pboard-collab-${boardId}-cards`, url: settings.url,
          getKey: identityUnavailable, getAuthorization: identityUnavailable,
          googleDrive: { folderId, actorId: peerId, getCredentials: () => googleAuth.getDriveIdentityCredentials!(), fetcher: rawFetcher },
          authBudget: budget, reconnects: room.reconnects,
          // The explicit-Reconnect bypass the signed-authority room gets below.
          // Without it `healRelay(force)` could never repair a Drive-authorized
          // room that had met the reconnect ceiling: the heal leg re-attaches
          // and reads the room record, and the room stayed `reconnect:throttled`
          // forever with no gesture able to clear it. The key is only present
          // when a forced heal put it there, so no automatic path can pass the
          // ceiling.
          reconnectCeilingBypassOnce: ceilingBypassOnce.delete(boardId),
          seal: codec.seal,
          // An unreadable row is an integrity failure, never a foreign seal to
          // skip while advancing the durable replay cursor.
          open: async (payload, opId) => {
            try { return await codec.open(payload, opId); }
            catch { throw new OperationBindingError('Invalid Drive-authorized operation'); }
          },
          receive: operations => session.receiveRealtime(operations),
          gap: async () => {
            try {
              await session.sync(true, false);
              const mark = await log.diagnose();
              const checkpoint = typeof mark.checkpointSeq === 'number' ? mark.checkpointSeq : 0;
              await log.resumeFrom(checkpoint);
            } catch (error) { room.error = error instanceof Error ? error.message : String(error); }
          },
          status: state => {
            room.log = state;
            room.connected = state.phase === 'synced' ? [peerId] : [];
            room.error = state.phase === 'error' || state.phase === 'snapshot' ? state.error : null;
            if (operationProject === boardId) operationState = { ...operationState, connectedPeers: [], error: room.error, note: describeLogStatus(state) };
            if (state.phase === 'synced') queueMicrotask(() => { void session.broadcastUnsent().catch(() => {}); });
          },
          cursor: {
            load: async () => (await cursors())[folderId] ?? 0,
            save: async sequence => {
              const all = await cursors();
              if ((all[folderId] ?? 0) < sequence) await storage.set({ [cursorKey]: { ...all, [folderId]: sequence } });
            }
          },
          loopbackDevelopment: import.meta.env.DEV
        });
        driveAuthorityLogs.set(boardId, log);
        room.channel = log.metrics; room.session = session.metrics;
        const record = (outcome: LogCycleOutcome) => { room.consolidation = describeLogCycle(outcome); };
        const consolidate = () => { void runLogConsolidation({ boardId, folderId, log, session, drive, role: () => drive.folderRole(), storage })
          .then(record)
          .catch(error => { room.error = error instanceof Error ? error.message : String(error); }); };
        const timer = collaborationCounters.countedInterval('log.consolidate', consolidate, LOG_CONSOLIDATE_MS);
        return {
          broadcast: (operations: Operation[]) => log.broadcast(operations), metrics: log.metrics,
          async close() {
            if (driveAuthorityLogs.get(boardId) === log) driveAuthorityLogs.delete(boardId);
            collaborationCounters.clearCountedTimer(timer);
            // Publish the board's outstanding log tail before the socket goes
            // away, exactly as the signed-authority room does. A fire-and-forget
            // cycle here loses its lease to a disconnected transport, so leaving
            // a board could strand every unconsolidated operation in the log —
            // and on this path the interval never had a chance to run yet, so
            // *every* switch would strand the tail and the durable snapshot
            // would keep the state from before the session's own edits.
            await runLogConsolidation({ boardId, folderId, log, session, drive, role: () => drive.folderRole(), storage })
              .then(record)
              .catch(error => { room.consolidation = `failed:${error instanceof Error ? error.message : String(error)}`; });
            releaseLogConsolidation(boardId);
            await log.close();
          }
        };
      }
      if (operationSync && settings.provider === 'websocket') {
        throw new Error('Google Drive identity credentials are required for live collaboration');
      }
      // Zero-touch relay posture: opening one's own writable board bootstraps
      // its local authority instead of waiting for the collaboration panel's
      // checkbox (see `createAuthorityAutoBootstrap` for why that cannot
      // create a second authority). This runs before board security is
      // resolved because on a never-bootstrapped board it is what supplies
      // the relay credentials; a refusal stays a diagnostic and changes
      // nothing about the paths below. Once per session, because this factory
      // itself runs once per session (see the retry window in the service).
      if (settings.provider === "websocket") await autoBootstrapAuthority(boardId, () => drive.folderRole())
        .catch(() => collaborationDiagnostic('board_authority.auto_bootstrap_refused'));
      // Independent collaboration: when this browser is configured for the relay
      // and the board has a pinned grant, its operations go to the durable
      // operation log instead of a peer-to-peer room. The log refuses a
      // plaintext default, so a content key is required — and that key used to
      // arrive only over a peer channel this posture switches off. The key
      // courier carries it now: this device publishes its ECDH wrap key,
      // accepts a grant addressed to it, and a device that may write hands the
      // key to every peer whose wrap key is known — all before the log opens,
      // because the log cannot carry the key its own codec needs. A held key
      // always wins, a received grant beats generating a new key, and only a
      // writer with neither ever creates one; a viewer never holds a key,
      // which is the key store's own contract.
      // The selection consults the settings resolved above, never the lazily
      // cached `signalingSettings`: that cache belongs to the legacy manager's
      // role read, which never runs while the operation protocol owns boards,
      // so under the posture it stayed undefined and no board was ever
      // selected for the log — the silent half of "relay never attaches".
      // A security failure on a relay board (no grant published yet, grant
      // service down) is a board without a live channel, not a failed board:
      // it returns the Drive-first stub with the reason stated, because a
      // throwing factory would re-handshake on every role pass and a session
      // that starts red can never attach later in the round.
      let security: Awaited<ReturnType<typeof boardSecurityFor>> | null;
      try {
        security = await boardSecurityFor(boardId);
      } catch (error) {
        if (settings.provider !== 'websocket') throw error;
        const message = error instanceof Error ? error.message : String(error);
        const room = trackRoom(boardId, { self: peerId, topic: `pboard-operations-${boardId}`, folderId: (await operationService.layout(boardId)).folderId });
        room.error = message;
        if (operationProject === boardId) operationState = { ...operationState, error: message, note: 'The board is converging through Google Drive synchronization until its relay grant is available.' };
        return { broadcast: async () => false, close: async () => {} };
      }
      const independent = selectRuntimeOperationLog(boardId, security, settings);
      let logKey = independent ? await bufferContentKeys.get(boardId) : undefined;
      let courierError: string | null = null;
      let mayWrite = false, authorityDevice = false, lastForeignSealPass = 0;
      if (independent) {
        const writerRole = await drive.folderRole().catch(async () => (await driveConnected() ? 'revoked' : 'unauthorized') as 'revoked' | 'unauthorized');
        if (writerRole === 'unauthorized') collaborationDiagnostic('board_authority.drive_unauthorized');
        mayWrite = writerRole === 'owner' || writerRole === 'editor';
        // Key creation follows authority (the single decision point's answer,
        // read here as `ownsAuthority`): only the device whose authority the
        // directory accepts may create the board's content key, so a second
        // writer joining later receives it as a grant instead of minting a
        // rival key that would split the board's seal.
        authorityDevice = await boardCollaboration.ownsAuthority(boardId);
        // The attach pass keeps its own socket, deliberately: it is the one pass
        // whose lifetime is bound to the board's open/close cycle, and the
        // manager's stop/start ordering (a close while a pass is in flight) is
        // not something a shared queue may perturb. Every other trigger — the
        // account room's three, a device approval, the repair leg, the
        // debounced foreign-row pass — is what the queue collapses.
        const courier = await runKeyCourier({
          topic: `pboard-collab-${boardId}-cards`, ...independent,
          authBudget: budget,
          getServiceAdmission: identitySharing.admitService,
          trigger: 'courier:attach',
          isWriter: mayWrite,
          isAuthority: authorityDevice,
          heldKey: () => bufferContentKeys.get(boardId),
          ensureKey: () => bufferContentKeys.ensure(boardId),
          storeKey: material => bufferContentKeys.put(boardId, material)
        });
        logKey = courier.key ?? logKey;
        courierError = courier.error;
        // The relay may predate the courier or refuse it; the writer that
        // holds the board's authority still provisions its own key so the
        // board attaches, which is also what keeps the manual hand-off panel
        // meaningful — against such a relay it is the only way a second
        // device learns the key. A writer without the authority never
        // provisions: its board's key is the authority device's to create.
        if (!logKey && mayWrite && authorityDevice) {
          await bufferContentKeys.ensure(boardId);
          logKey = await bufferContentKeys.get(boardId);
        }
        // A writer admitted under somebody else's authority that holds no key
        // asks for one. Its courier pass above already published its wrap key;
        // the beacon below publishes a row the key-holding devices cannot
        // open either, which is the signal their foreign-seal pass acts on:
        // they re-wrap the board key for this device's wrap key through the
        // courier grant store, and each poll here collects it. Without a
        // listener the wait simply ends after its bounded patience and the
        // board says so honestly below.
        if (!logKey && mayWrite && !authorityDevice) {
          const KEY_HANDOFF_ATTEMPTS = 12, KEY_HANDOFF_POLL_MS = 350;
          let beacon: OperationLogSync | undefined;
          try {
            const throwaway = await generateBoardContentKey();
            const beaconCodec = createOperationLogCodec(throwaway);
            beacon = await createOperationLogSync({
              boardId, topic: `pboard-collab-${boardId}-cards`, ...independent,
              authBudget: budget,
              // If this wait is the one that opens the context's connection, the
              // console says so: a socket dialled by a key-handoff wait is a
              // different cause from a board attach, and the network panel cannot
              // tell them apart.
              dialTrigger: 'beacon:handoff',
              isTerminalAdmissionError: terminalServiceAdmissionRefusal,
              reconnectCeilingBypassOnce: true,
              getServiceAdmission: identitySharing.admitService,
              seal: beaconCodec.seal,
              open: async () => { throw new Error('The key-handoff wait never reads sealed rows'); },
              receive: async () => {},
              foreignRow: () => {},
              gap: async () => {},
              status: () => {},
              loopbackDevelopment: import.meta.env.DEV
            });
            await beacon.broadcast([keyHandoffBeacon(boardId, `keyhandoff-${crypto.randomUUID()}`)]);
            for (let attempt = 0; attempt < KEY_HANDOFF_ATTEMPTS && !logKey; attempt++) {
              // Direct, not queued, for the same reason as the attach pass: this
              // ladder runs inside a board open, and each poll must reach the
              // relay — the envelope only exists after the key-holder acts on the
              // beacon above.
              const pass = await runKeyCourier({
                topic: `pboard-collab-${boardId}-cards`, ...independent,
                authBudget: budget,
                getServiceAdmission: identitySharing.admitService,
                trigger: 'beacon:handoff',
                isWriter: true,
                isAuthority: false,
                heldKey: async () => undefined,
                ensureKey: () => { throw new Error('A key-handoff wait never creates a second content key'); },
                storeKey: material => bufferContentKeys.put(boardId, material),
                attempts: 1
              });
              logKey = pass.key;
              if (!logKey) await new Promise<void>(resolve => setTimeout(resolve, KEY_HANDOFF_POLL_MS));
            }
          } catch { /* the honest error below states the outcome */ }
          try { await beacon?.close(); } catch { /* already closed */ }
        }
      }
      if (independent && !logKey && webrtcDisabledForTesting()) {
        // With the peer pools on, this board would take the Drive-signaled path
        // below and might receive a key from a collaborator. With them off the
        // courier is the way a key arrives, and a courier that produced
        // nothing says why rather than open a room that cannot decrypt.
        const room = trackRoom(boardId, { self: peerId, topic: `pboard-operations-${boardId}`, folderId: (await operationService.layout(boardId)).folderId });
        room.error = `The relay is configured and this board is granted, but no content key reached this device${courierError ? ` (key courier: ${courierError})` : '; the other device has not published one yet'}. Reopen the board once the device that can edit it is online, or paste the key there through the board content key hand-off.`;
        // The sidebar's one status sentence must carry this reason: a board
        // with no live channel and no explanation reads as a broken sync.
        if (operationProject === boardId) operationState = { ...operationState, error: room.error };
        return { broadcast: async () => false, close: async () => {} };
      }
      if (independent && logKey) {
        const folderId = (await operationService.layout(boardId)).folderId;
        const room = trackRoom(boardId, { self: peerId, topic: `pboard-operations-${boardId}`, folderId });
        const report = (error: string | null) => {
          room.error = error;
          if (operationProject === boardId) operationState = { ...operationState, connectedPeers: room.connected, error: error };
        };
        const codec = createOperationLogCodec(logKey);
        const cursorKey = 'pboardOperationLogCursors';
        const cursors = async () => ((await storage.get(cursorKey))[cursorKey] ?? {}) as Record<string, number>;
        try {
          const log = await createOperationLogSync({
            boardId, topic: `pboard-collab-${boardId}-cards`, ...independent,
            authBudget: budget,
            reconnects: room.reconnects,
            isTerminalAdmissionError: terminalServiceAdmissionRefusal,
            reconnectCeilingBypassOnce: ceilingBypassOnce.delete(boardId),
            getServiceAdmission: identitySharing.admitService,
            seal: codec.seal, open: codec.open,
            receive: operations => session.receiveRealtime(operations),
            // A row this device cannot open is either a rotated key or an
            // admitted writer's handoff beacon. One debounced courier pass
            // answers both: holding the board key means re-wrapping it for
            // every published wrap key (which delivers the beaconed request),
            // and fetching beats holding when the board key moved — a key the
            // running session does not carry gets that session rebuilt.
            //
            // Bounded twice over, because a burst is this trigger's normal
            // shape: one foreign broadcast per unreadable row, and a beaconed
            // joiner repeats its beacon for its whole ladder. `minGapMs` drops
            // every request inside the window — dropped, not queued, so a burst
            // cannot become a stream of passes — and the queue behind it
            // collapses whatever survives into one pass (fresh, because the row
            // arrived after any pass now running read the listing).
            foreignRow: () => {
              if (!mayWrite) return;
              const now = Date.now();
              if (now - lastForeignSealPass < FOREIGN_ROW_MIN_GAP_MS) return;
              lastForeignSealPass = now;
              const sealedWith = logKey;
              void requestKeyCourierBounded({
                topic: `pboard-collab-${boardId}-cards`, ...independent,
                minGapMs: FOREIGN_ROW_MIN_GAP_MS,
                authBudget: budget,
                getServiceAdmission: identitySharing.admitService,
                trigger: 'courier:foreign-row',
                isWriter: true,
                isAuthority: authorityDevice,
                heldKey: () => bufferContentKeys.get(boardId),
                ensureKey: () => bufferContentKeys.ensure(boardId),
                storeKey: material => bufferContentKeys.put(boardId, material),
                attempts: 1
              }).then(pass => {
                if (pass && sealedWith && pass.key && pass.key.keyId !== sealedWith.keyId)
                  void session.setRealtime(false).then(() => session.setRealtime(true)).catch(() => { /* the retry loop owns this */ });
              }).catch(() => { /* a failed pass leaves today's behaviour; the next foreign row re-arms */ });
            },
            // A pruned history is not a broken connection: the log dropped
            // operations because a published snapshot already covers them, so the
            // fix is to read that snapshot from Drive and resume above it. Only if
            // that fails is it something the person using the board must act on.
            gap: async () => {
              try {
                await session.sync(true, false);
                const mark = await log.diagnose();
                const checkpoint = typeof mark.checkpointSeq === 'number' ? mark.checkpointSeq : 0;
                await log.resumeFrom(checkpoint);
              } catch (error) {
                report(`Board history needs a snapshot (${error instanceof Error ? error.message : String(error)})`);
              }
            },
            status: state => {
              room.log = state;
              room.connected = state.phase === 'synced' ? [peerId] : [];
              // A reconnect and an unsent edit are not errors: only a refusal or a
              // pruned history needs the board re-shared, and the sidebar has to
              // say which of the three the person is looking at.
              room.error = state.phase === 'error' || state.phase === 'snapshot' ? state.error : null;
              if (operationProject === boardId) {
                operationState = { ...operationState, connectedPeers: [], error: room.error, note: describeLogStatus(state) };
              }
            },
            cursor: {
              load: async () => (await cursors())[boardId] ?? 0,
              save: async sequence => {
                const all = await cursors();
                if ((all[boardId] ?? 0) >= sequence) return;
                all[boardId] = sequence;
                await storage.set({ [cursorKey]: all });
              }
            },
            loopbackDevelopment: import.meta.env.DEV
          });
          // The same counters the peer path reported, so the diagnostics console
          // answers the same question on both transports: did edits leave, were
          // they refused, did they land.
          room.channel = log.metrics; room.session = session.metrics;
          // The open path's `boardSecurityFor` call renewed/published once; this
          // tick is what keeps that true for as long as the room lives.
          armBoardGrantKeepAlive(boardId);
          // Consolidation triggers. Only the Drive owner does any work inside
          // `runLogConsolidation`, so on every other device these fire and return;
          // the point of the interval is that the *owner* need not be the one
          // editing. Background and `pagehide` catch the case that matters most:
          // the owner closing the last tab with a log full of unpublished edits.
          // Every cycle's outcome is recorded, including the idle ones: a board
          // whose snapshot never publishes looks exactly like a healthy board
          // otherwise, and the reason (`not-owner`, `no-watermark`, `drive-error`,
          // `lease-busy`) is the only thing that distinguishes them.
          const record = (outcome: LogCycleOutcome) => {
            room.consolidation = describeLogCycle(outcome);
            room.error = outcome.status === 'published' && outcome.stale ? 'Another device published over this snapshot; the next cycle re-merges.' : room.error;
          };
          const consolidate = () => { void runLogConsolidation({ boardId, folderId, log, session, drive, role: () => drive.folderRole(), storage })
            .then(record)
            .catch(error => { room.consolidation = `failed:${error instanceof Error ? error.message : String(error)}`; report(error instanceof Error ? error.message : String(error)); }); };
          // Counted: one consolidation interval per *attached* board, so the
          // gauge reports the attach set rather than the board count. A refactor
          // that keeps a board attached in the background is then visible as an
          // extra `timer.log.consolidate` here instead of only as CPU.
          const consolidateTimer = collaborationCounters.countedInterval('log.consolidate', consolidate, LOG_CONSOLIDATE_MS);
          // Going hidden still flushes the log. Coming back is the recovery
          // trigger: Firefox budgets a background tab roughly one timer
          // callback a minute, which cuts the 15 s heartbeat short and lets
          // the proxy age the tunnel out at 60 s, and the transport's own
          // reconnect timer is throttled with it. The visibility callback is
          // the one the browser guarantees, so the room reconnects on the
          // first visible frame instead of whenever the throttled timer
          // finally runs — a hidden disconnected tab is an expected state, and
          // `reconnectNow` leaves a connected one alone.
          const onVisibility = () => {
            if (typeof document === 'undefined') return;
            if (document.visibilityState === 'hidden') consolidate();
            else log.reconnectNow();
          };
          const onPageHide = () => consolidate();
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
          if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', onPageHide);
          consolidate();
          return {
            broadcast: (operations: Operation[]) => log.broadcast(operations),
            metrics: log.metrics,
            async close() {
              disarmBoardGrantKeepAlive(boardId);
              collaborationCounters.clearCountedTimer(consolidateTimer);
              if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
              if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('pagehide', onPageHide);
              // Publish the board's outstanding log tail before the socket goes
              // away: a fire-and-forget cycle here raced `log.close()` and lost
              // its lease to a disconnected transport, so leaving a board could
              // strand every unconsolidated operation in the log until some
              // later device happened to run a cycle. Awaiting is what makes
              // "switching boards flushes a durable snapshot" true.
              await runLogConsolidation({ boardId, folderId, log, session, drive, role: () => drive.folderRole(), storage })
                .then(record)
                .catch(error => { room.consolidation = `failed:${error instanceof Error ? error.message : String(error)}`; report(error instanceof Error ? error.message : String(error)); });
              // Stop answering `consolidateBoardLog` for a board whose room is gone:
              // the session, log and Drive store this registration closes over are
              // all being torn down, and an out-of-room caller should get the
              // explicit `idle:no-room` answer instead of a rejected cycle.
              releaseLogConsolidation(boardId);
              await log.close();
            },
          };
        } catch (error) {
          // The relay may predate the operation log, refuse this board, or be
          // briefly down. None of that is a reason to leave the board without
          // a sink and a realtime factory that re-runs the whole handshake —
          // bootstrap, courier, grant publication — on every ten-second role
          // pass. Degrade to Drive-first synchronization, the behaviour that
          // predates this posture (losing an edit is the worst outcome; a
          // slower sync is not), and put the reason in the status text.
          const message = error instanceof Error ? error.message : String(error);
          room.error = message;
          if (operationProject === boardId) operationState = { ...operationState, error: message, note: 'The board attached through Google Drive synchronization instead of the operation log.' };
          return { broadcast: async () => false, close: async () => {} };
        }
      }
      if (webrtcDisabledForTesting()) {
        // Peer pools are off in this build: no Drive presence files, no
        // offer/answer exchange, no ICE attempts. The board still converges
        // through Drive synchronization, and the room record says the absence of
        // peers is a configuration choice rather than an empty room. In the
        // relay posture, though, this branch means something else and has to
        // say so: the board was not selected for the durable log at all, which
        // names a missing grant or authority, not a transport that is switched
        // off by design. Naming the switched-off transport sent readers to fix
        // a configuration that was never the problem.
        const room = trackRoom(boardId, { self: peerId, topic: `pboard-operations-${boardId}`, folderId: (await operationService.layout(boardId)).folderId });
        room.error = settings.provider === "websocket"
          ? 'This board has no live channel: the configured relay does not serve it to this device yet — no verified board grant (and no advertised authority) resolved for it. Open the board on the device that owns its authority and accept its sharing, then reopen it here; updates arrive with Drive synchronization meanwhile.'
          : 'WebRTC peer pools are switched off in this process; this board has no live channel, so updates arrive with Drive synchronization.';
        // The room record alone left the sidebar saying "waiting for another
        // browser" while the truth was "this build opens no rooms": the
        // configuration choice belongs in the status sentence too.
        if (operationProject === boardId) operationState = { ...operationState, note: room.error };
        return { broadcast: async () => false, close: async () => {} };
      }
      // Board viewers retain the existing separate signaling-folder permission.
      // Resolved against the operations layout, whose folder id every collaborator
      // already agrees on: that is what puts two browsers in one room instead of
      // each trusting whichever parent folder it happened to cache first.
      const realtimeFolder = await drivePermissions.realtimeFolderId(boardId, (await operationService.layout(boardId)).folderId);
      const topic = `pboard-operations-${boardId}`, prefix = `sig-${topic}-`;
      const room = trackRoom(boardId, { self: peerId, topic, folderId: realtimeFolder });
      const base = createDriveSignalStore({ transport, sharedProjects, projectId: boardId, peerId, topic, presenceTtlMs: DRIVE_PRESENCE_TTL_MS, realtimeFolderId: async () => realtimeFolder });
      const roles = new Map<string, { role: string | null; until: number }>();
      /**
       * The answers a role check needs that are the same for every peer: the
       * folder's own role, the presence listing and the board's ACL page. They
       * were fetched inside the per-peer loop, so a room with N peers paid a
       * 100-unit listing and a 100-unit ACL page N times per pass — and the
       * presence poll asks for every peer's role on every tick, so the cost grew
       * with the roster instead of with the board. Each is one short-lived,
       * single-flight answer per board; a grant or revocation is seen one pass
       * later, exactly as with the per-peer cache below.
       */
      const SHARED_ROLE_TTL_MS = 5_000;
      function oncePerPass<T>(load: () => Promise<T>, holdMs: (value: T) => number = () => SHARED_ROLE_TTL_MS) {
        let value: T, until = 0, loaded = false, inflight: Promise<T> | null = null;
        return async (): Promise<T> => {
          if (loaded && until > Date.now()) return value;
          inflight ??= load()
            .then(result => { value = result; loaded = true; until = Date.now() + holdMs(result); return result; })
            .finally(() => { inflight = null; }); // a failure is never cached
          return await inflight;
        };
      }
      // A `revoked` folder is re-proved almost immediately: peers are dropped when
      // their role cannot be read, so holding one bad-looking answer for the whole
      // cache window would empty the room for every pass it survived. A second
      // still answers a whole pass, in which peers are queried back to back.
      const sharedRole = oncePerPass(() => drive.folderRole(), role => role === 'revoked' ? 1_000 : SHARED_ROLE_TTL_MS);
      const sharedPresence = oncePerPass(async () => {
        const byName = new Map<string, string>();
        for (const file of await transport.listFiles(realtimeFolder)) if (file.name.startsWith(prefix)) byName.set(file.name, file.id);
        return byName;
      });
      const sharedAcl = oncePerPass(async () => (await transport.listPermissions((await operationService.layout(boardId)).folderId)) as { type?: string; role?: string; emailAddress?: string }[]);
      async function peerRole(id: string) {
        const cached = roles.get(id); if (cached && cached.until > Date.now()) return cached.role;
        if (await sharedRole() === 'revoked') return null;
        const name = `${prefix}${id}.json`;
        const presence = await sharedPresence();
        const fileId = presence.get(name);
        if (!fileId) return null;
        // Drive reporting the file or the board's folder as gone is a peer that
        // left, not a room that failed: a session deletes its own presence file,
        // and this listing is always a moment stale. Read as a storage failure it
        // rejected the poll, which rejected `join()` and left the realtime session
        // unable to start at all — retrying, on every React render, against a file
        // that is never coming back. The absence is then remembered as well as the
        // answer, because Drive goes on naming a deleted presence file in the room
        // listing, and every pass that asked for it paid another 404 for as long as
        // the board stayed open.
        if (driveResourceKnownGone(fileId)) { presence.delete(name); return null; }
        let file;
        try {
          file = await drive.metadata(fileId);
        } catch (error) {
          if (!isDriveGone(error)) throw error;
          noteDriveResourceGone(fileId);
          presence.delete(name); roles.set(id, { role: null, until: Date.now() + 10000 }); return null;
        }
        if (!file.parents?.includes(realtimeFolder)) return null;
        let permissions;
        try {
          permissions = await sharedAcl();
        } catch (error) {
          if (!isDriveGone(error)) throw error;
          roles.set(id, { role: null, until: Date.now() + 10000 }); return null;
        }
        const owner = file.owners?.[0]?.emailAddress?.trim().toLowerCase();
        const role = file.ownedByMe ? await sharedRole() : permissions.find(permission => permission.type === 'user' && permission.emailAddress?.trim().toLowerCase() === owner)?.role ?? null;
        roles.set(id, { role, until: Date.now() + 10000 }); return role;
      }
      const signaling = createDriveSignaling({ store: { ...base,
        async listPeers() {
          const peers = await base.listPeers();
          const result: typeof peers = {}, rolesByPeer: Record<string, string> = {}, ages: Record<string, number> = {};
          for (const [id, value] of Object.entries(peers)) {
            const age = Math.max(0, Math.round((Date.now() - (value?.updatedAt ?? 0)) / 1000));
            ages[id] = age;
            // A presence record is a claim of liveness for the presence TTL. The
            // room applies that rule to its roster one step later, but the role
            // lookup feeding this listing was paid before it: in a folder holding
            // the abandoned files of every browser that ever opened the board, most
            // of the board's Drive quota was buying roles for sessions that had
            // already closed. Marked, not dropped silently — `stale` in the
            // diagnostics table is the difference between a crowded room and a
            // room of ghosts.
            if (age * 1000 >= DRIVE_PRESENCE_TTL_MS) { rolesByPeer[id] = 'stale'; continue; }
            const role = await peerRole(id);
            rolesByPeer[id] = role ?? 'unresolved';
            if (role) result[id] = value;
          }
          // The difference between an empty room and a room whose peers cannot be
          // verified used to be invisible: both looked like "waiting for another
          // browser" while one needed the other browser and the other needed Drive
          // read access. Readable from the console as `pboardCollaboration()`.
          Object.assign(room, { listed: Object.keys(peers), roles: rolesByPeer, ages, selfListed: Object.prototype.hasOwnProperty.call(peers, peerId), seenAt: Date.now() });
          return result;
        }
      } });
      // A session whose join rejects is closed with no peers and no retry, and the
      // rejection ends in a `.catch(() => {})` in the sidebar — which is how a room
      // that never started looked identical to a room nobody had joined. Whatever
      // it was, it belongs in the snapshot the diagnostics read.
      try {
        const realtime = await createOperationRealtime({ signaling, config: (await getIceConfiguration()) ?? undefined,
          canRead: async id => !!await peerRole(id), canWrite: async id => ['owner', 'editor', 'writer'].includes(await peerRole(id) ?? ''),
          receive: operations => session.receiveRealtime(operations), frontier: () => session.frontier(), recover: () => session.sync(false, false),
          state: (peers, error) => { room.connected = peers; room.error = error ?? null; if (operationProject === boardId) operationState = { ...operationState, connectedPeers: peers, error: error ?? null }; }
        });
        // The counters ride in the snapshot: a room whose channel is open but whose
        // edits never leave is a different fault from one whose frames are refused,
        // and nothing else on the screen distinguishes them.
        room.channel = realtime.metrics;
        // The live object, not a copy: a snapshot taken when the room started
        // reports the traffic of a moment that is already over, which is how one
        // read of this table blamed the wrong stage.
        room.session = session.metrics;
        return realtime;
      } catch (error) {
        room.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    sharedLayout: boardId => sharedProjects.get(boardId),
    recordLayout: (boardId, folderId, projectFileId) => sharedProjects.set(boardId, { folderId, projectFileId }),
    async stopLegacy(boardId) { await legacyCollaborationManager.stop(); await removeBoardMutationGuard(boardId); },
    async onStatus(boardId, error) { if (error) await driveSyncState.markError(boardId, error); }
  });
  async function syncOperations(boardId: string, force: boolean): Promise<import('./googleDriveProvider').ProjectSyncResult> {
    return await driveRoundReads.run(() => syncOperationsWork(boardId, force));
  }
  async function syncOperationsWork(boardId: string, force: boolean): Promise<import('./googleDriveProvider').ProjectSyncResult> {
    const rx = await getRepository();
    if (!rx) throw new Error('Local storage is unavailable');
    if (await rx.isDeletedProject(boardId)) return 'not-dirty';
    const syncState = await driveSyncState.get(boardId);
    const changeToken = syncState.changeToken ?? 0;
    // Opening an unbound local board migrates/publishes a baseline. Defer that
    // first publication too; importing a missing remote board remains immediate.
    if (!force && !rx.operationSource.bindings.has(boardId) && await rx.getProject(boardId)
      && syncState.dirty && dirtyFlushAt(syncState) > Date.now()) return 'not-dirty';
    try {
      const session = await operationService.open(boardId);
      const publish = force || await session.flushDue();
      await driveSyncState.markSyncing(boardId);
      await operationService.sync(boardId, force, publish);
      const project = await rx.getProject(boardId);
      const pending = await rx.operationSource.local.pendingTiming(boardId);
      if (pending) {
        const latest = await driveSyncState.get(boardId);
        await driveSyncState.set({ ...latest, dirty: true, status: 'pending',
          firstDirtyAt: new Date(pending.oldest).toISOString(), dirtyAt: new Date(pending.latest).toISOString() });
      }
      else if (project) await driveSyncState.markSynced(boardId, project.revision, (await operationService.layout(boardId)).folderId, changeToken);
      // The board is demonstrably on Drive now. The creation itself was
      // announced when its local row appeared (`markDirty`, this runtime's
      // `driveSyncState` wrapper), so this call covers exactly the two cases the
      // creation path cannot: a board that predates creation-time announcement
      // (no record was ever queued for it), and a record the channel dropped
      // unacknowledged (`onRecordExpired` un-marked the board, and this round is
      // what re-queues it). Gated by `announcedBoards`, so a reconcile round over
      // forty boards publishes nothing. Not awaited: the sync already happened,
      // and a hint cannot delay a synchronize.
      void announceBoardLifecycle(boardId, { onDrive: true });
      // The two facts this pass answered for, and the two an automatic round
      // compares against before it decides the board owes it nothing (see
      // `roundNeedsWork`). The token was read *before* the sync, on purpose: a
      // change made during it leaves `markSynced` with `dirty: true` (its
      // `expectedChangeToken` check), and a dirty board is never gated. The
      // revision is read after, because that is the folder state the pass just
      // consumed. Recorded only when the pass completed, so a failure never
      // makes a board look settled.
      roundTokens.set(boardId, changeToken);
      const settled = rx.operationSource.bindings.get(boardId);
      if (settled) roundRevisions.set(boardId, await operationChanges.revision(settled.folderId));
      return 'pulled';
    } catch (error) { await driveSyncState.markError(boardId, error instanceof Error ? error.message : 'Drive sync failed'); throw error; }
  }
  /**
   * What one automatic round remembers about the boards it has already settled:
   * the local change token its last completed pass answered for, and the folder
   * revision the account feed reported at that moment.
   *
   * Both are needed and neither is sufficient alone. The token is a *local*
   * fact — it moves when this device dirties the board — so it cannot see an
   * edit another browser published. The revision is the *Drive* fact: the
   * account feed bumps it exactly when a file in this board's folder appeared or
   * disappeared, which is every other device's publication. A board is provably
   * quiet only when neither moved.
   *
   * Both live in memory on purpose: a context that cannot remember what it
   * answered for cannot prove a board owes nothing, so after a restart the first
   * automatic round does exactly what every round used to do.
   */
  const roundTokens = new Map<string, number>();
  const roundRevisions = new Map<string, number | undefined>();
  /**
   * Whether an **automatic** round owes this board any Drive work at all.
   *
   * The round used to call `syncOperations` — and therefore open the session,
   * verify the role, poll the account change feed, list the board's folder and
   * project the result — for every board it listed, every round. None of that is
   * free and none of it can find anything for a board that is clean, already
   * synced, bound, has nothing unpublished, and whose Drive folder has not moved
   * since this context last synchronized it. The gate is the smallest set of
   * local-and-feed facts that proves exactly that, cheapest first:
   *
   *   1. not the board this context displays — its room may be attached and its
   *      gap pull happens through the round, so it is always worked;
   *   2. bound locally — an unbound board is what a first import, a migration or
   *      a baseline publication looks like, and `syncOperations` owns all three;
   *   3. not dirty and `status === 'synced'` — a dirty board owes Drive the edit,
   *      and `pending`, `syncing` and `error` are the three states that must be
   *      retried rather than trusted (an errored board is dirty by `markError`,
   *      so the retry rides the same check);
   *   4. `lastSyncedAt` present — no completed pass ever, so nothing to prove
   *      against (`ensureInitiallyDirty` treats the same absence as "new");
   *   5. nothing unpublished in the local operation store (`pendingTiming`, the
   *      outbox index the flush timer reads) — an outbox row is work whatever its
   *      deadline says, so `dirtyFlushAt` needs no separate test: it can only
   *      return a moment at which a dirty or pending board becomes work, and both
   *      are already work above;
   *   6. the local change token equals the one this context last answered for;
   *   7. the folder's feed revision equals the one it last answered for, the
   *      folder is one this context has listed, and the round's feed pass
   *      succeeded (an unreadable feed answers `null`, and nothing is gated).
   *
   * Every branch returns `true` when a fact is missing rather than assuming the
   * quiet answer, and an unknown folder revision reads as "changed". The cases
   * that are therefore *never* gated: the first import (2), the displayed board
   * (1), anything pending or dirty (3, 5), an errored board (3), a board whose
   * change token moved (6), a board whose Drive folder moved (7), a board this
   * context has never settled (4, 6), a round in which the feed could not be
   * read (7), and a newly discovered board — from the Drive listing or the
   * account channel — because both arrive unbound locally (2).
   *
   * A **forced** round never asks (`Sync now`, the worker's cold start, the
   * account poll alarm, connect, recovery and erasure retries), so a board the
   * gate skips is still reconciled on that cadence.
   */
  async function roundNeedsWork(boardId: string, state: DriveProjectSyncState, rx: RxRepository,
    feed: Map<string, number> | null): Promise<boolean> {
    // A round whose feed pass failed proves nothing about any folder. Every
    // board is worked, exactly as before the gate existed.
    if (!feed) return true;
    if (boardId === operationProject) return true;
    const binding = rx.operationSource.bindings.get(boardId);
    if (!binding) return true;
    if (state.dirty || state.status !== 'synced') return true;
    if (!state.lastSyncedAt) return true;
    if (await rx.operationSource.local.pendingTiming(boardId)) return true;
    if ((state.changeToken ?? 0) !== roundTokens.get(boardId)) return true;
    // A folder this context has never listed cannot be called unchanged.
    const revision = feed.get(binding.folderId);
    if (revision === undefined) return true;
    return revision !== roundRevisions.get(boardId);
    return revision !== roundRevisions.get(boardId);
  }
  async function pullOperations(boardId: string) {
    await syncOperations(boardId, true); const rx = await getRepository();
    if (!rx || !await rx.getProject(boardId)) return null;
    return { format: 'pboard-project' as const, version: 1 as const, exportedAt: new Date().toISOString(), ...await rx.exportProject(boardId) };
  }
  // Only a validated marker from the same account, namespace, file name and
  // Drive version can be reused. A changed or unversioned file is read again.
  const verifiedErasures = new Map<string, { version: string; boardId: string; accountId?: string; format: string; markerVersion: number }>();
  async function syncOperationErasures(rx: RxRepository) {
    const account = await connectedAccountId(); if (!account) return;
    const regular = createDriveTransport(googleAuth, fetcher, `erased-${account}-`, () => boardStore.rootFolder());
    const legacy = createDriveTransport(googleAuth, fetcher, 'erased-');
    const checkAccount = async () => { if (await connectedAccountId() !== account) throw new Error('Google account changed during erasure synchronization'); };
    for (const transport of [regular, legacy]) for (const file of await transport.listProjectFiles()) {
      const key = JSON.stringify([account, transport === regular ? 'regular' : 'legacy', file.id, file.name]);
      const saved = verifiedErasures.get(key);
      const cached = typeof file.version === 'string' && saved?.version === file.version;
      const value = cached ? { format: saved.format, version: saved.markerVersion, boardId: saved.boardId, accountId: saved.accountId }
        : parseStrictJson(await transport.download(file.id), 1024 * 1024) as any;
      if (value?.format !== 'pboard-board-erasure' || value.version !== 1 || !validId(value.boardId)
        || file.name !== `${transport === regular ? `erased-${account}-` : 'erased-'}${value.boardId}.pboard`
        || (transport === regular && value.accountId !== account)) throw new Error('Invalid account erasure marker');
      await checkAccount(); await operationService.close(value.boardId); await rx.applyPrivateBoardErasure(value.boardId, account);
      if (!cached && typeof file.version === 'string' && file.version) {
        if (verifiedErasures.size >= 4096) verifiedErasures.delete(verifiedErasures.keys().next().value!);
        verifiedErasures.set(key, { version: file.version, boardId: value.boardId, accountId: value.accountId, format: value.format, markerVersion: value.version });
      }
    }
    for (const marker of await rx.journal.boardErasures()) {
      if (marker.accountId !== account || !marker.cloudPending) continue;
      await operationService.close(marker.boardId); await operationChanges.forgetBoard(marker.boardId); await checkAccount();
      let file = await regular.findProjectFile(marker.boardId);
      if (!file) file = await regular.upload(marker.boardId, JSON.stringify({ format: 'pboard-board-erasure', version: 1, boardId: marker.boardId, accountId: account }));
      const verified = parseStrictJson(await regular.download(file.id)) as any;
      if (verified.boardId !== marker.boardId || verified.accountId !== account) throw new Error('Private erasure publication could not be verified');
      await checkAccount();
      // Confirmed deletion removes only this account's legacy private backups.
      for (const transport of [driveTransport, legacyHistoryTransport, createDriveTransport(googleAuth, fetcher, 'image-')]) {
        for (const candidate of await transport.listProjectFiles()) {
          if (!(candidate.name === `project-${marker.boardId}.pboard` || candidate.name.startsWith(`history-${marker.boardId}_`) || candidate.name === `history-${marker.boardId}.pboard`)) continue;
          const contents = parseStrictJson(await transport.download(candidate.id), 32 * 1024 * 1024) as any;
          if (contents?.boardId !== marker.boardId && contents?.project?.id !== marker.boardId) continue;
          await checkAccount(); await transport.delete(candidate.id);
        }
      }
      const layout = await sharedProjects.get(marker.boardId);
      if (layout.folderId) {
        const folder = await legacyPermissionTransport.getFile(layout.folderId).catch(error => {
          if (String(error).includes('404')) return null; throw error;
        });
        if (folder) {
          const permissions = await legacyPermissionTransport.listPermissions(layout.folderId);
          const email = (await connectedAccountEmail()).toLowerCase();
          const onlyOwner = permissions.length === 1 && permissions[0].role === 'owner' && permissions[0].emailAddress?.toLowerCase() === email;
          if (onlyOwner && folder.name === marker.boardId) { await checkAccount(); await boardStore.trashFile(layout.folderId); }
        }
      }
      await rx.journal.receipts.update(marker.id, { cloudPending: false } as any);
      await driveSyncState.forget(marker.boardId);
    }
  }
  let reconcilingOperations: Promise<import('./googleDriveProvider').DriveReconcileResult> | undefined;
  function reconcileOperations(force = false) {
    if (reconcilingOperations) return reconcilingOperations;
    reconcilingOperations = (async () => {
      const result: import('./googleDriveProvider').DriveReconcileResult = { status: 'disconnected', imported: 0, pulled: 0, pushed: 0, deleted: 0 };
      // One per round, next to the round itself: `events['reconcile.round']`
      // counts rounds and `events['reconcile.board']` the per-board legs inside
      // them, so `reconcile.board / reconcile.round` is the O(boards) factor a
      // single round costs.
      collaborationCounters.countEvent('reconcile.round');
      if (!await driveConnected()) return result;
      // The account-level discovery channel is maintained by the same round that
      // maintains Drive discovery: it opens once an account and its account-room
      // pin exist, re-opens when a different account is connected, and is never
      // awaited — a reconcile round does not become slower because an account
      // socket is down, and the poll below stays the authority it always was.
      ensureAccountChannel();
      // A creation is announced before its board reaches Drive, so a record for
      // a board Drive did not have yet is *deferred*, not discarded. This round
      // is the product's own "ask Drive again" cadence, which makes it the right
      // place to re-verify them: awaited (so the round answers for the boards it
      // may import), idempotent, and never allowed to fail the round — a record
      // that still cannot verify is simply still deferred.
      await accountLifecycle.retryDeferred().catch(() => undefined);
      // Read/migrate legacy sources, preserving all original files. New board
      // persistence never runs the old AppData writer or leader/buffer runtime.
      const rx = await getRepository(); if (!rx) return result;
      const shared = await drivePermissions.discoverSharedProjects({ force });
      await syncOperationErasures(rx);
      for (const tombstone of await driveTombstones.getAll()) await googleDrive.deleteProject(tombstone.projectId);
      // Automatic relocation of legacy boards is no longer supported.
      await syncAccountPreferences();
      // One feed pass for the whole round, before any board is touched.
      //
      // This is what makes the per-board gate provable rather than merely local:
      // the account feed bumps a folder's revision exactly when a file appeared
      // in it or left it, so a board whose revision has not moved has not been
      // written by any device since this context last synchronized it. The pass
      // is account-wide and gated by the feed's own 15-second window, so it
      // costs at most one Drive request per round however many boards there are
      // — and it is the round's only *global* Drive read, where every automatic
      // round used to pay one per board inside `inventory`. A round that cannot
      // read the feed answers `null`, and then no board is skipped.
      //
      // Two deliberate choices. A **forced** round does not ask at all: it
      // works every board regardless, so the answer could not change anything
      // and the request would be pure cost. An automatic round asks past the
      // feed's own 15-second window, because a skip decision must rest on what
      // Drive says *now* — a cached answer from before the last round would let
      // two rounds seconds apart decide from the same stale revision. The round
      // is already coalesced in shared storage (`RECONCILE_COALESCE_MS`), so
      // this is still at most one request per round for the whole account.
      const feed = !force ? await operationChanges.poll(true).catch(() => null) : null;
      const ids = new Set([...(await rx.listProjects()).map(project => project.id), ...await boardStore.listBoards(), ...shared.map(project => project.projectId)]);
      const errors: unknown[] = [];
      const relay: Record<string, RelayLegOutcome> = {};
      for (const id of ids) {
        if (await rx.isDeletedProject(id)) continue;
        // An automatic round asks the gate before it opens anything: the board's
        // session, its role read, the account change feed, its folder listing
        // and its projection are the work, and a board that provably owes none
        // of it (see `roundNeedsWork`) must not pay for them. A **forced** round
        // — Sync now, the worker's cold start, the account poll alarm, connect,
        // recovery, an erasure retry — never asks, so its behaviour is exactly
        // what it was. The relay leg below still runs either way: it is cheap
        // for a board this context does not display, and it must observe the
        // same attach set whichever branch produced the answer.
        if (!force && !await roundNeedsWork(id, await driveSyncState.get(id), rx, feed)) {
          // Named separately from `reconcile.board`: the ratio between the two
          // is the saving, and a round that stopped reconciling boards because
          // the gate misfired reads as `reconcile.board` collapsing while
          // `reconcile.skip` grows.
          collaborationCounters.countEvent('reconcile.skip');
        } else {
          const existed = !!await rx.getProject(id);
          collaborationCounters.countEvent('reconcile.board');
          try {
            // Guarded, not wrapped: with the counters off this is the plain call,
            // with no extra promise frame per board (the convention every other
            // timing in this file follows).
            // A newly created offline board has no Drive binding yet. On a
            // forced reconnect publish its baseline now, so account-room hints
            // can be verified without waiting for the edit batching window.
            const publishNew = force && existed && !rx.operationSource.bindings.has(id);
            if (collaborationCounters.enabled) await collaborationCounters.timed('sync.board', () => syncOperations(id, publishNew));
            else await syncOperations(id, publishNew);
            if (existed) result.pulled++; else result.imported++;
          }
          catch (error) { if (error instanceof DriveQuotaExceededError) throw error; errors.push(error); }
        }
        // The relay leg runs per board even when the Drive half failed — a
        // board whose Drive sync threw can still have unsent operations and a
        // wedged room — and a failing leg can never fail the round: healRelay
        // resolves with `failed:<reason>` rather than rejecting, and the
        // defensive catch keeps that promise against a throwing seam. The
        // round still *answers* for every board (the sidebar reads
        // `relay[projectId]`), but a board this context is not displaying
        // answers `idle:not-attached` without doing any work: the attach-set
        // rule is enforced inside the heal leg, in one place, so no trigger
        // can attach a room this context has no consumer for.
        collaborationCounters.countEvent('heal.board');
        relay[id] = await healRelay(id).catch((error): RelayLegOutcome => `failed:${error instanceof Error ? error.message : String(error)}`);
      }
      result.relay = relay;
      void onReconciled?.().catch(() => undefined);
      if (errors.length) throw new AggregateError(errors, errors[0] instanceof Error ? errors[0].message : 'Some boards could not synchronize');
      result.status = 'reconciled'; return result;
    })().finally(() => { reconcilingOperations = undefined; }); return reconcilingOperations;
  }
  /**
   * The relay heal leg — one bounded, non-destructive recovery pass for one
   * board, shared verbatim by its three triggers: the forced reconcile round
   * (per board, failure-isolated), the worker-epoch change the sidebar watches
   * (an MV3 worker restarts routinely, so a board that is merely healthy must
   * produce *no* relay traffic — `idle:synced` with zero requests is part of
   * the contract), and the owner's Reconnect action (`force`, which clears the
   * recorded 404 backoff so a pressed button is never served a cached refusal).
   *
   * The order is the recovery order: operations the relay never carried first
   * (idempotent through the `realtimeSent` ledger), then the board's own grant
   * advertisement when this device holds the authority (the service keeps a
   * grant only while it is renewed, and every joiner's read of an unadvertised
   * authority is a 404), then a courier pass when the key looks wrong, then a
   * reconnect when the channel is not `synced`, then the gap pull, and
   * consolidation last — it needs the reconnected room and published
   * everything before it. Nothing here prunes, gardens, or downloads a
   * segment: snapshot publication still comes only from the consolidation
   * cycle, and a room that is merely bootstrapping is left to finish.
   */
  const relayHealInFlight = new Map<string, Promise<RelayLegOutcome>>();
  function healRelay(boardId: string, options: { force?: boolean } = {}): Promise<RelayLegOutcome> {
    // Idempotent against a double press and against the epoch listener racing
    // the reconcile round: every caller joins the leg already running.
    const running = relayHealInFlight.get(boardId);
    if (running) return running;
    const leg = healRelayWork(boardId, options).catch((error): RelayLegOutcome =>
      `failed:${error instanceof Error ? error.message : String(error)}`);
    relayHealInFlight.set(boardId, leg);
    void leg.then(() => { if (relayHealInFlight.get(boardId) === leg) relayHealInFlight.delete(boardId); });
    return leg;
  }
  async function healRelayWork(boardId: string, { force = false }: { force?: boolean }): Promise<RelayLegOutcome> {
    // The attach set is one board: the one this context displays. A heal can
    // restore a room, so it is the one automatic path that could attach a room
    // nothing detaches, and the reconcile round calls it once per board. The
    // rule lives here, not only at the round's call site, because every trigger
    // — the round, the worker-epoch listener, a test — reaches the ladder
    // through this function: a room for a board this context is not displaying
    // is a socket with no owner, no UI reading it, and no consumer of its
    // operations. A board that is merely backgrounded still converges: its
    // operations arrive through the Drive half of the round, and opening it
    // attaches its room on the normal path. Nothing is repaired for it here.
    if (boardId !== operationProject) return 'idle:not-attached';
    const settings = await boardCollaboration.settings();
    if (settings.provider !== 'websocket') return 'idle:not-relay';
    if (force && !operationSync) clearGrantAbsence(boardId);
    const session = operationService.active(boardId);
    if (!session) return 'idle:no-session';
    const room = roomSnapshot(boardId);
    if (!room) return 'idle:no-room';
    const phase = room.log?.phase ?? null;
    const msg = (error: unknown) => error instanceof Error ? error.message : String(error);
    if (phase === 'synced') {
      // Healthy. The one thing a synced room can still owe is an operation an
      // earlier connection never carried — idempotent, request-free when the
      // ledger is empty, which is every healthy board that merely witnessed a
      // worker restart.
      const sentBefore = session.metrics.realtimeMessages;
      try { await session.broadcastUnsent(); } catch (error) { return `failed:unsent:${msg(error)}`; }
      return session.metrics.realtimeMessages > sentBefore ? 'healed:unsent' : 'idle:synced';
    }
    if (phase === 'connecting' || phase === 'bootstrap') return 'idle:connecting';
    // Every repair step below needs a Drive answer — role, advertisement,
    // courier. With a dead Google session none of those answers exist, and
    // letting the admission path re-derive a role per attempt is exactly the
    // loop that burns the shared request budget while looking like a dead
    // relay. Stop, and name the real cause.
    if (await googleAuth.getConnectionState().catch(() => 'disconnected' as const) !== 'connected')
      return 'failed:drive-unauthorized';
    if (force) ceilingBypassOnce.add(boardId);
    // From here the board is demonstrably not healthy: wedged, refused,
    // pruned-history, or never attached to the relay in this context.
    if (!room.log && !room.error) return 'idle:no-room';
    const repaired: string[] = [];
    const notes: string[] = [];
    if (!operationSync && await boardCollaboration.ownsAuthority(boardId).catch(() => false)) {
      // The authority device re-publishes the board's grant: a stale one is
      // exactly the 404 every other device is now backing off from.
      try { await boardCollaboration.security(boardId, true); repaired.push('advertised'); }
      catch (error) { notes.push(`advertise:${msg(error)}`); }
    }
    const keysWrong = (room.channel?.foreign ?? 0) > 0
      || (!room.log && /content key/i.test(room.error ?? ''));
    if (!operationSync && keysWrong) {
      try {
        const security = await boardSecurityFor(boardId);
        const independent = selectRuntimeOperationLog(boardId, security, settings);
        if (independent) {
          const writerRole = await operationService.role(boardId).catch(() => 'revoked');
          const pass = await requestKeyCourier({
            topic: `pboard-collab-${boardId}-cards`, ...independent,
            authBudget: budget,
            getServiceAdmission: identitySharing.admitService,
            trigger: 'courier:repair',
            // A repair exists because the evidence says the key this session
            // holds is wrong (foreign rows, or a board that never received one),
            // so its answer must come from a read that began after that
            // evidence. Fresh, and still bounded: one pass behind whatever is
            // running, and the heal leg itself is single-flight (`healRelay`).
            fresh: true,
            isWriter: writerRole === 'owner' || writerRole === 'editor',
            isAuthority: await boardCollaboration.ownsAuthority(boardId),
            heldKey: () => bufferContentKeys.get(boardId),
            ensureKey: () => bufferContentKeys.ensure(boardId),
            storeKey: (material: string) => bufferContentKeys.put(boardId, material),
            attempts: 1,
          });
          if (pass.error) notes.push(`courier:${pass.error}`);
          else repaired.push('courier');
        }
      } catch (error) { notes.push(`courier:${msg(error)}`); }
    }
    // A pruned history is fixed by reading the Drive snapshot the log pruned
    // in favour of — the same pull the room's own gap handler performs, out
    // of band because this board has no live handler to do it.
    if (phase === 'snapshot') {
      try { await session.sync(true, false); repaired.push('gap-pull'); }
      catch (error) { notes.push(`gap:${msg(error)}`); }
    }
    // Reconnect only when the channel is not `synced`: the close/re-enable is
    // the room's own re-entry path, and the fresh connection resubmits
    // unsent operations by itself.
    try {
      await session.setRealtime(false);
      await session.setRealtime(true);
      // The factory degrades to a Drive-only channel rather than throwing,
      // so a refused re-attach (the reconnect ceiling among them) looks
      // identical from here unless the room is asked: believe the room, not
      // the resolved promise.
      const after = roomSnapshot(boardId);
      if (after && !after.error) repaired.push('reconnected');
      else notes.push(`reconnect:${after?.error ?? after?.log?.error ?? 'no room came up'}`);
    } catch (error) { notes.push(`reconnect:${msg(error)}`); }
    try {
      const outcome = await consolidateBoardLog(boardId);
      notes.push(`consolidation:${describeLogCycle(outcome)}`);
    } catch (error) { notes.push(`consolidation:${msg(error)}`); }
    return repaired.length
      ? `healed:${[...repaired, ...notes].join(',')}`
      : `failed:${notes.join(';') || 'nothing was repairable'}`;
  }
  // Preserve the platform lifecycle interface. No board authority, device grant,
  // RxDB master/fork pool, server buffer or leader participates in operation sync.
  let operationProject: string | null = null, realtimeEnabled = true;
  /**
   * One presence identity per board per browser context, surviving the room's
   * restarts. A fresh uuid on every start — which is what a room that a quota
   * denial switched off and `refreshRole` switched back on did every ten seconds
   * — wrote a new presence file each time, and a browser that flapped a dozen
   * times in a throttled minute left a dozen files in the shared folder for every
   * reader to list, verify and offer to. The identity of a *session* is what the
   * room needs to be stable; a second tab is a second context and still gets its
   * own id, so two tabs of one browser remain two peers.
   */
  const realtimePeers = new Map<string, string>();
  const realtimePeerFor = (boardId: string) => {
    const known = realtimePeers.get(boardId);
    if (known) return known;
    const peerId = crypto.randomUUID();
    realtimePeers.set(boardId, peerId);
    return peerId;
  };
  let operationState: import('../collab/manager').CollaborationState = { sharedFileId: null, role: 'private', ready: false, connectedPeers: [], error: null };
  let operationActivation = 0;
  const collaborationManager: CollaborationManager = operationSync ? {
    async start(boardId) {
      // Opening a board also opens the account channel for the same account, so
      // a browser that only ever opens boards still learns about new ones. It is
      // not awaited: the board must open even if the account room never answers,
      // and a missing pin is reported rather than retried into a loop.
      // The legacy account channel authenticates with a device manifest and
      // cannot share a Drive-authenticated socket. Firefox board sessions use
      // Drive discovery until its account channel has the same admission.
      ensureAccountChannel();
      const activation = ++operationActivation;
      const previous = operationProject; operationProject = boardId;
      if (previous && previous !== boardId) { operationService.active(previous)?.setPolling(false); await operationService.active(previous)?.setRealtime(false); }
      if (activation !== operationActivation) return;
      operationState = { sharedFileId: null, role: 'private', ready: false, connectedPeers: [], error: null };
      if (!await driveConnected()) { operationService.active(boardId)?.setPolling(false); await operationService.active(boardId)?.setRealtime(false); return; }
      if (activation !== operationActivation) return;
      try {
        const rx = await getRepository(), state = await driveSyncState.get(boardId);
        if (rx && !rx.operationSource.bindings.has(boardId) && await rx.getProject(boardId)
          && state.dirty && dirtyFlushAt(state) > Date.now()) return;
        const session = await operationService.open(boardId);
        if (activation !== operationActivation) return;
        // Platform account polling covers inactive boards as well. Per-edit
        // flush timers remain active independently of the selected board.
        const role = await operationService.role(boardId);
        if (activation !== operationActivation) return;
        operationState = { sharedFileId: (await operationService.layout(boardId)).folderId, role: role === 'revoked' ? 'private' : role, ready: true, connectedPeers: [], error: null };
        // Recover immediately on activation. Optional signaling failures never
        // prevent Drive delivery or postpone it until the next polling timer.
        void session.sync(false, false).catch(error => driveSyncState.markError(boardId, error instanceof Error ? error.message : 'Drive synchronization failed'));
        try { await session.setRealtime(realtimeEnabled); }
        catch (error) { if (activation === operationActivation) operationState = { ...operationState, error: error instanceof Error ? error.message : 'WebRTC unavailable' }; }
        if (activation !== operationActivation && operationProject !== boardId) { session.setPolling(false); await session.setRealtime(false); }
      } catch (error) { if (activation === operationActivation) operationState = { ...operationState, error: error instanceof Error ? error.message : 'Collaboration unavailable' }; throw error; }
    },
    async stop() {
      operationActivation++;
      const old = operationProject; operationProject = null;
      if (old) { operationService.active(old)?.setPolling(false); await operationService.active(old)?.setRealtime(false); }
      // Stopping collaboration is leaving the relay, not switching a board: the
      // room is detached above, and the context's own connection — which the
      // account channel may share — is released here so a closed board holds no
      // socket. A board *switch* never reaches this path, which is what makes
      // the switch an attach/detach on one live socket.
      // The account room shares this socket and must survive leaving a board.
      // Its explicit close releases the socket once no board is attached.
      if (!googleAuth.getDriveIdentityCredentials || ['disabled', 'closed'].includes(accountLifecycle.status().state)) releaseRelaySessions();
      operationState = { ...operationState, sharedFileId: null, ready: false, connectedPeers: [] };
    },
    async setEnabled(enabled) { realtimeEnabled = enabled; if (operationProject) await operationService.active(operationProject)?.setRealtime(enabled); },
    async refreshRole() {
      const boardId = operationProject, activation = operationActivation;
      if (!boardId || !await driveConnected() || activation !== operationActivation) return;
      const rx = await getRepository(), state = await driveSyncState.get(boardId);
      if (rx && !rx.operationSource.bindings.has(boardId) && await rx.getProject(boardId)
        && state.dirty && dirtyFlushAt(state) > Date.now()) return;
      const role = await operationService.role(boardId);
      if (activation !== operationActivation) return;
      operationState = { ...operationState, sharedFileId: (await operationService.layout(boardId)).folderId,
        ready: role !== 'revoked', role: role === 'revoked' ? 'private' : role };
      try {
        await operationService.active(boardId)?.setRealtime(role !== 'revoked' && realtimeEnabled);
        if (activation === operationActivation) operationState = { ...operationState, error: null };
      } catch (error) {
        if (activation === operationActivation) operationState = { ...operationState, error: error instanceof Error ? error.message : 'WebRTC unavailable' };
        throw error;
      }
    },
    state: () => ({ ...operationState }), requestContentKey: async () => false, ensureContentKey: async () => false
  } : legacyCollaborationManager;
  const usesIdentitySharing = async () => !operationSync && (await boardCollaboration.settings()).provider === "websocket";
  // Only the sharing UI dispatches here. Existing Drive persistence, discovery,
  // image transfer, deletion/ACL handling and default transport keep their service.
  const sharePermissions = {
    async myRole(board: string) { if (!await usesIdentitySharing()) return drivePermissions.myRole(board); await identitySharing.sync(board); return boardCollaboration.role(board); },
    async listCollaborators(board: string) { if (!await usesIdentitySharing()) return drivePermissions.listCollaborators(board); await identitySharing.sync(board); return identitySharing.collaborators(board); },
    async projectFileId(board: string) { return await usesIdentitySharing() ? ((await boardCollaboration.localBundle(board)) ? "signed-board-grant" : null) : drivePermissions.projectFileId(board); },
    async ensureSharedProject(board: string) { if (!await usesIdentitySharing()) return drivePermissions.ensureSharedProject(board); await identitySharing.sync(board, true); if (!await boardCollaboration.localBundle(board)) throw new Error("Connect Google to initialize account sharing"); return board; },
    async invite(board: string, email: string, role: "editor" | "viewer") {
      if (await usesIdentitySharing()) return await identitySharing.invite(board, email, role);
      await drivePermissions.invite(board, email, role);
      if (!googleAuth.getDriveIdentityCredentials) return;
      try {
        const session = await operationService.open(board);
        if (!driveAuthorityLogs.has(board)) await session.setRealtime(true);
        const log = driveAuthorityLogs.get(board);
        if (!log) throw new Error('Board relay is unavailable');
        const to = await hashBlob(new Blob([email.trim().toLowerCase()]));
        await log.publishAccountHint(to, crypto.randomUUID(), btoa('pboard-invitation-v1'));
      } catch {
        // The Drive invitation succeeded; discovery can retry through Drive.
        collaborationDiagnostic('account_hint.publish_failed');
      }
    },
    async updateRole(board: string, email: string, role: "editor" | "viewer") { if (!await usesIdentitySharing()) return drivePermissions.updateRole(board, email, role); await identitySharing.invite(board, email, role); },
    async removeCollaborator(board: string, email: string) { if (!await usesIdentitySharing()) return drivePermissions.removeCollaborator(board, email); await identitySharing.remove(board, email); },
    async canManageMembership(board: string) { if (!await usesIdentitySharing()) return null; await identitySharing.sync(board); return boardCollaboration.ownsAuthority(board); }
  };
  // --- Sync v2 buffered realtime (server op buffer + leader snapshots) ----
  // Inert unless `start(boardId)` is called explicitly (realtime UI with the
  // websocket provider and a Drive realtime folder). The server re-checks the
  // editor grant on every call, so a mid-session role loss fails closed; the
  // runtime itself stops on demand.
  const bufferContentKeys = createContentKeyStore();
  const bufferRuntimes = new Map<string, BufferRuntime>();
  async function bufferHttpOrigin(): Promise<string | null> {
    try {
      const endpoint = new URL((await boardCollaboration.settings()).url);
      if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
      if (endpoint.protocol === "ws:") endpoint.protocol = "http:";
      if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return null;
      return endpoint.origin;
    } catch { return null; }
  }
  const bufferRealtime = {
    active: () => [...bufferRuntimes.keys()],
    async start(boardId: string): Promise<boolean> {
      if (operationSync) return false;
      if (bufferRuntimes.has(boardId)) return true;
      if (!(await driveConnected())) return false;
      const origin = await bufferHttpOrigin();
      const security = origin ? await boardSecurityFor(boardId) : null;
      const role = security?.manifest.devices.find(device => device.deviceKeyId === security.signer.deviceKeyId)?.role;
      if (!origin || !security || (role !== "owner" && role !== "editor")) return false;
      const rx = await getRepository();
      if (!rx) return false;
      const drive = fetcher as unknown as DriveFetch;
      const store = createBufferSnapshotStore({ token: () => googleAuth.getAccessToken(), folderId: async () => await boardStore.boardFolder(boardId), fileName: BOARD_SNAPSHOT_FILENAME, fetcher: drive });
      const client = createBufferClient({ baseUrl: origin, authorizer: createGrantAuthorizer(boardSecurityFor, origin, drive) });
      const runtime = createBufferRuntime({
        boardId,
        // Server-side grant verification is authoritative; role revocation
        // mid-session surfaces as authentication failures, not local state.
        isWriter: () => true,
        contentKey: async () => {
          const key = await bufferContentKeys.get(boardId);
          if (key) return key;
          return await collaborationManager.requestContentKey() ? await bufferContentKeys.get(boardId) : undefined;
        },
        committedOps: async () => (await rx.journal.committedEntries())
          .filter(entry => entry.boardId === boardId)
          .map(entry => ({ opId: entry.id, document: entry.value as Record<string, unknown>, deleted: (entry.value as Record<string, unknown>)?.["deleted"] === true })),
        subscribe: next => rx.journal.subscribe(() => next()),
        client,
        drive: store
      });
      runtime.start();
      bufferRuntimes.set(boardId, runtime);
      return true;
    },
    async stop(boardId: string) {
      const runtime = bufferRuntimes.get(boardId);
      bufferRuntimes.delete(boardId);
      await runtime?.stop();
    }
  };
  return { operationService, driveFolderGardener, driveSyncState: {
    // The ledger exactly as the repository events and the composition root see
    // it. `markDirty` is what the repository's `projectChanged` event calls
    // (`src/storage/browser.ts:55`), and it is both announcement sites: a
    // creation is published here, at the moment the local row exists (the
    // mandated sequence — local write, socket event, peers, Drive afterwards),
    // and a rename is published here for the same reason, one record per name
    // rather than one per keystroke. Fire and forget — an announcement can never
    // delay or fail the dirty mark itself, and this path never waits on Drive.
    ...driveSyncState,
    markDirty: async (projectId: string, permanentDeletion = false) => {
      void announceBoardLifecycle(projectId);
      await driveSyncState.markDirty(projectId, permanentDeletion);
    }
  }, driveTombstones, projectSnapshots, driveTransport, googleDrive, authorizePrivatePersistence, privateErasureAccount, sharedProjects, drivePermissions, reestablishAuthorityFromDrive, sharePermissions, discoverSharedBoards, syncAccountPreferences, collaborationManager, bufferRealtime, experimentalEnrollment, renewBoardAuthorization, healRelay,
    /** The account-level discovery channel: its report for the console and the
     * sidebar, plus the four things a caller outside the runtime can
     * legitimately ask for (open it, close it for sign-out, queue a record,
     * re-verify the records a creation-time announcement left deferred). */
    accountChannel: {
      status: () => accountLifecycle.status(),
      /** Retries the account room's queue now — the same act its own `synced`
       * edge performs, exposed for a caller that has just changed something the
       * queue was waiting on. */
      flush: () => accountLifecycle.flush(),
      start: ensureAccountChannel,
      /** Stops and forgets the account, so the next `start()` — a sign-in, a
       * reconcile round, a board open — resolves the account, the pin and the key
       * from scratch instead of resuming a closed socket. */
      close: async () => {
        const previous = accountLifecycle.status().account;
        await accountLifecycle.reset(); resetAccountChannelLedger(previous);
        if (!operationProject) releaseRelaySessions();
      },
      publish: (kind: AccountLifecycleKind, boardId: string, extra?: { name?: string }) => accountLifecycle.publish(kind, boardId, extra),
      /** Carries one durable tombstone fact to the rest of the account. See
       * `AccountLifecycleChannel.publishTombstone` — this is the seam the
       * composition root's `projectTombstoned` event calls. */
      publishTombstone: (boardId: string, fact: AccountTombstoneFact, atMs?: number) => accountLifecycle.publishTombstone(boardId, fact, atMs),
      /** Queues this account list's total order as one record (the realtime path
       * for project sorting). Resolves false when there is no account room to
       * queue into, or the list is past the record's bound. */
      publishOrder: (ids: readonly string[], updatedAt: number) => accountLifecycle.publishOrder(ids, updatedAt),
      /** `projectOrderChanged` → one `board.order` record. See
       * `AccountLifecycleChannel.publishLocalOrder`. */
      publishLocalOrder: (order: { account: string | null; ids: string[]; updatedAt: number }) => accountLifecycle.publishLocalOrder(order),
      /** Re-verifies records that arrived before their board was on Drive. The
       * reconcile round calls this; a reconnect does too, from the channel's own
       * `synced` edge. */
      retryDeferred: () => accountLifecycle.retryDeferred(),
      /** The explicit escape from a `foreign` pin. **User-initiated only**: no
       * automatic path calls it (see `repinPublishedAccountAuthority`). Rejects
       * with the exact failed check; changes nothing when it rejects. */
      repinPublishedAuthority: () => operationSync
        ? Promise.reject(new Error('Account access is managed by Google Drive'))
        : repinPublishedAccountAuthority(),
      /** `subscribe` for "the channel reported a new status". Returns the
       * unsubscribe function, the shape React's `useEffect` wants. */
      subscribe: (listener: () => void) => { accountChannelListeners.add(listener); return () => { accountChannelListeners.delete(listener); }; }
    },
    boardCollaboration: { ...boardCollaboration, identitySharing,
    async createCopy(projectId: string) { const rx = await getRepository(); if (!rx) throw new Error("Local RxDB is unavailable"); return createCollaborativeCopy(rx, projectId); },
    async identifyLegacyBoard(projectId: string) {
      if (!await legacyDriveTrust(projectId)) throw new Error("No legacy shared-board trust record for this board");
      const rx = await getRepository(); if (!rx) throw new Error("Local RxDB is unavailable");
      await identifyLegacyBoard(storage, projectId, { hasLegacyPin: await legacyHasPin(projectId), hasSharedProjectFile: true });
      return legacyTransitionFor(storage, projectId);
    },
    async legacyTransition(projectId: string) {
      if (!await legacyDriveTrust(projectId)) throw new Error("No legacy shared-board trust record for this board");
      const rx = await getRepository(); if (!rx) throw new Error("Local RxDB is unavailable");
      const existing = await legacyTransitionFor(storage, projectId);
      if (!existing) throw new Error("Identify the legacy board before its transition; trust records are never inferred");
      await identifyLegacyBoard(storage, projectId, { hasLegacyPin: await legacyHasPin(projectId), hasSharedProjectFile: true });
      return transitionLegacyBoard(storage, rx, projectId);
    },
    async legacyBoardTransitionState(projectId: string) { return legacyTransitionFor(storage, projectId); }
  } };
}

import { replicateWebRTC } from "rxdb/plugins/replication-webrtc";
import type { RxWebRTCReplicationPool } from "rxdb/plugins/replication-webrtc";
import type { RxCollection, WithDeleted } from "rxdb";
import type { PboardRole } from "../sync/drivePermissions";
import type { BoardPermissionManifest } from "./security/manifest";
import { manifestHash, manifestIsCurrent, roleForDevice, validateManifest } from "./security/manifest";
import type { VerifiedSessionContext } from "./security/session";
import type { MutationGuardInstall } from "./security/mutation";
import type { RelayAuthorization } from "./security/relayAdmission";
import type { RxRepository } from "../storage/rxdbRepository";
import type { CardRecord, ProjectRecord, SettingRecord } from "../storage/rxdbSchemas";
import type { PboardSignaling } from "./signaling";
import { createPboardWebRTCConnectionHandler } from "./webrtcHandler";
import type { PboardPeer, PboardWrtc } from "./webrtcHandler";
import { scopeMasterChanges } from "./scopedPull";
import { createProjectImageSync, type SharedImageTransport } from "./imageSync";
import type { PeerHistorySession } from "./peerHistory";

/**
 * Current project role from the selected collaboration policy. Independent
 * collaboration uses board grants; legacy Drive sharing retains its adapter.
 * Roles gate direction/UI, while trusted manifests and signed writes independently
 * enforce board admission and mutation authorization.
 */
export type CollaborationRole = PboardRole | "private";

/** A single shared collection replicated over a WebRTC pool. */
type SharedCollection = "cards" | "projects";

export type CollaborationState = {
  role: CollaborationRole;
  /** Shared file id the owner has created, if any (owner/editors only). */
  sharedFileId: string | null;
  /** Signaling peer ids connected to the current project's shared-content pools. */
  connectedPeers: string[];
  /** True once the manager has resolved a role for the current start() call. */
  ready: boolean;
  error: string | null;
};

export interface CollaborationManagerOptions {
  /** Resolves the selected policy's project role; null when not shared. */
  myRole: (projectId: string) => Promise<PboardRole | null>;
  /** The shared Drive file id the owner created, or null when never shared. */
  getSharedFileId: (projectId: string) => Promise<string | null>;
  /**
   * Bootstraps a viewer/editor that has no local copy yet: downloads the shared
   * project snapshot from Drive and imports it. Returns true when an import
   * happened. Called at most once per start().
   */
  bootstrapFromDrive: (projectId: string) => Promise<boolean>;
  /** Read-only Drive catch-up shared by the project's reconnecting rooms. */
  refreshFromDrive?: (projectId: string, isActive: () => boolean) => Promise<void>;
  /**
   * Build the signaling provider for one collection room. The manager calls this
   * once per collection with the topic, so the transport is swappable (Drive for
   * the shipped extension, memory/WebSocket for dev and tests).
   */
  signalingFor: (topic: string, security?: CollaborationSecurityOptions) => PboardSignaling;
  getRepository: () => Promise<RxRepository | null>;
  wrtc?: PboardWrtc;
  imageTransport?: SharedImageTransport | (() => Promise<SharedImageTransport>);
  /** Some signaling-only boards have no shared image backend; it may also depend on account connectivity. */
  useImageTransport?: () => Promise<boolean> | boolean;
  /** Stable normalized account identity hash; null when Drive is disconnected. */
  getAccountId?: () => Promise<string | null>;
  /** Private preference scope, independent of live room admission. Undefined
   * preserves the scope already verified by private persistence. */
  getProjectOrderAccountId?: (fallback: string | null) => Promise<string | null | undefined>;
  /**
   * Protocol-2 board security, verified against the pinned authority by the runtime.
   * Missing providers or null contexts block collaboration. Account-order rooms
   * require their own `accountSecurity` context.
   */
  boardSecurity?: (projectId: string) => Promise<CollaborationSecurityOptions | null>;
  accountSecurity?: (account: string) => Promise<CollaborationSecurityOptions | null>;
  /** Opt-in broker polling; ordinary providers have no additional work. */
  securityChanged?: (projectId: string) => Promise<boolean>;
  /** Install per-project mutation verification on the repository (protocol 2). */
  installMutationGuard?: (projectId: string, security?: CollaborationSecurityOptions) => Promise<MutationGuardInstall | null>;
  removeMutationGuard?: (projectId: string) => Promise<void>;
  /** Durable private-backup intent; no remote I/O or authorization is performed here. */
  onHistoryReceived?: (projectId: string) => Promise<void>;
}

/** Everything the connection handler needs to run protocol 2 for one room. */
export type CollaborationSecurityOptions = {
  signer: { privateJwk: JsonWebKey; deviceKeyId: string };
  manifest: BoardPermissionManifest;
  boardId: string;
  ownSessionId: string;
  relayAuthorization?: RelayAuthorization;
  manifestHistory?: ReadonlyMap<number, BoardPermissionManifest>;
  grantHistory?: import("./security/manifest").SignedManifest[];
  /** Local root capability only; never serialized onto a transport. */
  historyAuthority?: { privateJwk: JsonWebKey; deviceKeyId: string };
};

export interface CollaborationManager {
  start(projectId: string): Promise<void>;
  stop(): Promise<void>;
  refreshRole(): Promise<void>;
  state(): CollaborationState;
}

const topicFor = (projectId: string, collection: SharedCollection) => `pboard-collab-${projectId}-${collection}`;
const isEditorRole = (role: CollaborationRole) => role === "owner" || role === "editor";

/**
 * One shared project's live collaboration plus account-only project ordering.
 *
 * The manager owns the full lifecycle for a single project:
 *   1. resolve the selected policy's role and require a trusted board manifest;
 *   2. bootstrap a viewer/editor that has no local copy from the shared file;
 *   3. run two WebRTC pools — one per shared collection — with role-based
 *      direction and project-scoped pull/push modifiers.
 *
 * Direction policy (the write-restriction enforcement, per the spec):
 *   - owner/editor: pull + push, scoped to this project.
 *   - viewer: pull-only (no push). A viewer never emits local writes, so nothing
 *     can be pushed; this is the replication-layer half of the read-only
 *     guarantee. The UI read-only + repository gate provide the primary
 *     enforcement for local writes. Signed mutation guards enforce authorization
 *     for remote writes before persistence.
 *
 * Scoping: the master's WebRTC handler streams its whole collection, so a room
 *   would otherwise leak a peer's private projects. Scoping is enforced in two
 *   places: the connection handler drops out-of-project docs on receive (the pull
 *   path — RxDB has no way to drop a doc via the pull modifier, which would
 *   instead crash `persistFromMaster`), and the push modifier returns `null` for
 *   out-of-project docs on send (the push path, which does filter nulls).
 *
 * Images: card references replicate live; a separate image sync uploads and
 *   downloads immutable assets through the shared Drive folder. Blob arrivals
 *   refresh cards without replacing their newer document data.
 *
 * Project list order: an independent account room replicates only its own
 *   projectOrder setting. It remains available on private projects and to
 *   viewers, and never replicates current selection or another account's settings.
 */
export function createCollaborationManager(options: CollaborationManagerOptions): CollaborationManager {
  let role: CollaborationRole = "private";
  let sharedFileId: string | null = null;
  let ready = false;
  let error: string | null = null;
  let startedProjectId: string | null = null;
  let startedRepo: RxRepository | null = null;
  type SharedPool = RxWebRTCReplicationPool<CardRecord, PboardPeer> | RxWebRTCReplicationPool<ProjectRecord, PboardPeer> | RxWebRTCReplicationPool<SettingRecord, PboardPeer>;
  const pools: SharedPool[] = [];
  let sessionGeneration = 0;
  let recovery: Promise<void> | null = null;
  let imageSync: ReturnType<typeof createProjectImageSync> | null = null;
  let activeGuard: MutationGuardInstall | null = null;
  /** Live history sessions for the active independent board; drained on stop. */
  const historySessions = new Set<PeerHistorySession>();

  function collectPeers(): string[] {
    const ids = new Set<string>();
    for (const pool of pools) {
      if (pool.collection.name === "settings") continue;
      for (const peer of pool.peerStates$.getValue().keys()) ids.add(String(peer.id));
    }
    return Array.from(ids).sort();
  }

  /** Verified session contexts reported by this manager's pools, by signaling id. */
  const verifiedContexts = new Map<string, VerifiedSessionContext>();

  /** Handler callback wiring: track verified contexts, drop them on teardown. */
  function securityHooksFor(securityContext: CollaborationSecurityOptions) {
    return {
      onSessionVerified: (remotePeerId: string, context: VerifiedSessionContext) => {
        verifiedContexts.set(remotePeerId, context);
      },
      onSessionRejected: (remotePeerId: string, reason: string) => {
        verifiedContexts.delete(remotePeerId);
        error = `Peer session rejected: ${reason}`;
      }
    };
  }

  /**
   * `isPeerValid` consults the verified session context only, never raw peer
   * JSON: unverified peers are rejected before RxDB creates a replication. The
   * connection handler stores contexts per remote session id; the pool resolves
   * the peer's context through that handler's exposed checker below.
   */
  function roleAllowsReplication(securityContext: CollaborationSecurityOptions, context: VerifiedSessionContext): boolean {
    // Any manifest role may receive content; replication direction is gated by
    // the pool pull/push configuration and the repository mutator role gate.
    return context.boardId === securityContext.boardId &&
      context.manifestHash === manifestHash(securityContext.manifest) &&
      context.manifestEpoch === securityContext.manifest.epoch;
  }

  /** The runtime verifies authority signatures; admission also requires a current, scoped context. */
  function requireSecurity(context: CollaborationSecurityOptions | null | undefined, boardId: string): CollaborationSecurityOptions {
    if (!context) throw new Error("Collaboration requires a trusted security manifest. Local boards remain available.");
    const manifest = validateManifest(context.manifest);
    if (context.boardId !== boardId || manifest.boardId !== boardId ||
        !manifestIsCurrent(manifest, Date.now()) || !roleForDevice(manifest, context.signer.deviceKeyId)) {
      throw new Error("Collaboration security manifest is expired or does not authorize this room and device.");
    }
    return context;
  }

  async function startPool<T extends CardRecord | ProjectRecord>(
    collection: SharedCollection,
    projectId: string,
    ref: RxCollection<T>,
    securityContext: CollaborationSecurityOptions
  ): Promise<void> {
    const editable = isEditorRole(role);
    const generation = sessionGeneration;
    const beforeReconnect = async () => {
      const isActive = () => generation === sessionGeneration && startedProjectId === projectId;
      if (!isActive() || !options.refreshFromDrive) return;
      recovery ??= options.refreshFromDrive(projectId, isActive).finally(() => {
        if (generation === sessionGeneration) recovery = null;
      });
      await recovery;
    };
    // Scope the room to this shared project. Cards carry `projectId`; the project
    // doc is keyed by id.
    const scopeProjectDoc = (doc: unknown): boolean => {
      if (typeof doc !== "object" || doc === null) return false;
      if (collection === "cards") return "projectId" in doc && doc.projectId === projectId;
      return "id" in doc && doc.id === projectId;
    };
    const pool = await replicateWebRTC<T, PboardPeer>({
      collection: ref,
      topic: topicFor(projectId, collection),
      connectionHandlerCreator: createPboardWebRTCConnectionHandler({
        signaling: options.signalingFor(topicFor(projectId, collection), securityContext),
        scopeDocument: scopeProjectDoc,
        existingDocuments: async ids => [...(await ref.findByIds(ids).exec()).values()].map(doc => doc.toJSON()),
        beforeReconnect,
        ...(startedRepo ? { history: { repository: startedRepo, security: securityContext, beforeReceive: () => options.onHistoryReceived?.(projectId) ?? Promise.resolve(),
          registry: { add: s => historySessions.add(s), remove: s => historySessions.delete(s), all: () => [...historySessions] } } } : {}),
        ...(options.wrtc ? { wrtc: options.wrtc } : {}),
        security: {
          signer: securityContext.signer, manifest: securityContext.manifest,
          boardId: securityContext.boardId, collection,
          ownSessionId: `${securityContext.ownSessionId}:${collection}:${crypto.randomUUID()}`,
          ...securityHooksFor(securityContext)
        }
      }),
      // Only a mutually proven session under this room's manifest may replicate.
      isPeerValid: async (peer) => {
        const context = verifiedContexts.get(String(peer.id));
        return Boolean(context) && roleAllowsReplication(securityContext, context!);
      },
      // Receive scoping happens in the connection handler (the pull path cannot
      // drop documents via a modifier — a null would crash persistFromMaster).
      pull: { batchSize: 100 },
      ...(editable ? { push: { batchSize: 100, modifier: (doc: WithDeleted<T>) => (scopeProjectDoc(doc) ? doc : null) } } : {})
    });
    scopeMasterChanges(pool.masterReplicationHandler, scopeProjectDoc);
    pools.push(pool as SharedPool);
    pool.subs.push(pool.error$.subscribe((err) => {
      error = String(err.parameters?.errorText ?? err.message ?? err);
    }));
    pool.subs.push(pool.connectionHandler.connect$.subscribe(() => { error = null; }));
  }

  async function applyRole(projectId: string): Promise<void> {
    const [resolved, fileId] = await Promise.all([options.myRole(projectId), options.getSharedFileId(projectId)]);
    role = resolved ?? "private";
    sharedFileId = fileId;
    ready = true;
  }

  async function startAccountOrder(rx: RxRepository, account: string | null, securityContext: CollaborationSecurityOptions | null): Promise<void> {
    const orderAccount = options.getProjectOrderAccountId ? await options.getProjectOrderAccountId(account) : account;
    if (orderAccount !== undefined) await rx.setProjectOrderAccount(orderAccount);
    if (!account || !securityContext) return;
    const id = `projectOrder:${account}`;
    const topic = `pboard-account-${account}-order`;
    const scoped = (doc: unknown) => !!doc && typeof doc === "object" && "id" in doc && doc.id === id;
    // The account room enforces its own scoped identity: shared-board credentials
    // are rejected by collection binding inside the handler (protocol 2).
    const pool = await replicateWebRTC<SettingRecord, PboardPeer>({
      collection: rx.db.settings, topic,
      connectionHandlerCreator: createPboardWebRTCConnectionHandler({
        signaling: options.signalingFor(topic, securityContext), scopeDocument: scoped,
        existingDocuments: async ids => [...(await rx.db.settings.findByIds(ids).exec()).values()].map(doc => doc.toJSON()),
        ...(options.wrtc ? { wrtc: options.wrtc } : {}),
        security: {
          signer: securityContext.signer, manifest: securityContext.manifest,
          boardId: securityContext.boardId, collection: "accountOrder" as const,
          ownSessionId: `${securityContext.ownSessionId}:accountOrder:${crypto.randomUUID()}`,
          ...securityHooksFor(securityContext)
        }
      }),
      isPeerValid: async (peer) => {
        const context = verifiedContexts.get(String(peer.id));
        return Boolean(context) && roleAllowsReplication(securityContext, context!);
      },
      pull: { batchSize: 100 },
      push: { batchSize: 100, modifier: (doc) => scoped(doc) ? doc : null }
    });
    scopeMasterChanges(pool.masterReplicationHandler, scoped);
    pools.push(pool);
    pool.subs.push(pool.error$.subscribe((err) => { error = String(err.parameters?.errorText ?? err.message ?? err); }));
  }

  /** Serialize start/stop so a rapid project switch or unmount never races the shared pool list. */
  let opChain: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = opChain.then(task, task);
    opChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function doStart(projectId: string): Promise<void> {
    await doStop();
    startedProjectId = projectId;
    await applyRole(projectId);

    // A viewer/editor with no local copy pulls the full snapshot (cards + blobs)
    // from the shared Drive file so the board renders before live replication.
    const rx = await options.getRepository();
    if (!rx) return;
    startedRepo = rx;
    // Resolve every requested room before creating transports, including account rooms
    // opened while viewing a private board. Null must never mean legacy admission.
    const account = await options.getAccountId?.() ?? null;
    const accountSecurity = account
      ? requireSecurity(await options.accountSecurity?.(account), `account:${account}`)
      : null;
    const boardSecurity = role !== "private"
      ? requireSecurity(await options.boardSecurity?.(projectId), projectId)
      : null;
    if (!boardSecurity) {
      await startAccountOrder(rx, account, accountSecurity);
      return;
    }
    // Authoritative viewer write-restriction. WebRTC picks master/slave by token
    // hash, not role, and the master streams its change log unconditionally, so a
    // viewer that is the master would otherwise leak local writes to peers even
    // though its pool is pull-only. Rejecting mutations at the repository layer
    // means no divergent local write exists to stream.
    await rx.setMutatorRole(projectId, role);
    if (!(await rx.getProject(projectId))) {
      await options.bootstrapFromDrive(projectId);
    }
    activeGuard = options.installMutationGuard ? await options.installMutationGuard(projectId, boardSecurity) : null;
    if (!activeGuard || activeGuard.projectId !== projectId) {
      throw new Error("Collaboration requires verified mutation protection. Local boards remain available.");
    }
    if (isEditorRole(role)) await rx.admitPendingWork(projectId);
    await startAccountOrder(rx, account, accountSecurity);
    await startPool("cards", projectId, rx.db.cards, boardSecurity);
    await startPool("projects", projectId, rx.db.projects, boardSecurity);
    if (options.imageTransport && await (options.useImageTransport?.() ?? true)) {
      const transport = typeof options.imageTransport === "function" ? await options.imageTransport() : options.imageTransport;
      imageSync = createProjectImageSync({ projectId, repository: rx, transport,
        canWrite: isEditorRole(role),
        requestFromPeers: async imageIds => {
          let missing = imageIds, lastError: unknown;
          for (const session of [...historySessions]) {
            if (!historySessions.has(session)) continue;
            try { await session.requestImages(missing); } catch (error) { lastError = error; }
            const availability = await Promise.all(missing.map(id => rx.hasImage(id)));
            missing = missing.filter((_, index) => !availability[index]);
            if (!missing.length) return;
          }
          if (missing.length && lastError) throw lastError;
        },
        onError: (err) => { error = err instanceof Error ? err.message : String(err); } });
      imageSync.start();
    }
  }

  async function doStop(): Promise<void> {
    ++sessionGeneration;
    recovery = null;
    for (const session of historySessions) session.close();
    historySessions.clear();
    await imageSync?.stop();
    imageSync = null;
    while (pools.length > 0) await (pools.pop() as SharedPool).cancel();
    if (startedRepo) {
      const orderAccount = options.getProjectOrderAccountId ? await options.getProjectOrderAccountId(null) : null;
      if (orderAccount !== undefined) await startedRepo.setProjectOrderAccount(orderAccount);
    }
    // Stopping transports must not clear durable offline permissions.
    if (activeGuard) {
      await options.removeMutationGuard?.(activeGuard.projectId).catch(() => {});
      await activeGuard.uninstall().catch(() => {});
      activeGuard = null;
    }
    verifiedContexts.clear();
    startedRepo = null;
    role = "private";
    sharedFileId = null;
    ready = false;
    error = null;
    startedProjectId = null;
  }

  const refreshRole = () => runExclusive(async () => {
    if (!startedProjectId) return;
    const projectId = startedProjectId;
    const wasReady = ready;
    const previousRole = role;
    const previousFileId = sharedFileId;
    try {
      await applyRole(startedProjectId);
      const securityChanged = await options.securityChanged?.(projectId) ?? false;
      if (!wasReady || securityChanged || role !== previousRole || sharedFileId !== previousFileId || (role !== "private" && pools.length === 0)) {
        await doStart(startedProjectId);
      }
    } catch (err) {
      await doStop();
      startedProjectId = projectId;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  });

  return {
    start: (projectId) => runExclusive(async () => {
      try { await doStart(projectId); }
      catch (err) {
        await doStop();
        startedProjectId = projectId;
        error = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }),
    stop: () => runExclusive(doStop),
    refreshRole,
    state: () => ({ role, sharedFileId, connectedPeers: collectPeers(), ready, error })
  };
}

import { replicateWebRTC } from "rxdb/plugins/replication-webrtc";
import type { RxWebRTCReplicationPool } from "rxdb/plugins/replication-webrtc";
import type { RxCollection, WithDeleted } from "rxdb";
import type { PboardRole } from "../sync/drivePermissions";
import type { RxRepository } from "../storage/rxdbRepository";
import type { CardRecord, ProjectRecord, SettingRecord } from "../storage/rxdbSchemas";
import type { PboardSignaling } from "./signaling";
import { createPboardWebRTCConnectionHandler } from "./webrtcHandler";
import type { PboardPeer, PboardWrtc } from "./webrtcHandler";
import { createProjectImageSync, type SharedImageTransport } from "./imageSync";

/**
 * pboard role as resolved for a project, used to gate replication direction and
 * UI mutability. "private" = the project is not shared (or the user has no Drive
 * role for it); "viewer" = Drive reader; "editor" = Drive writer; "owner" = the
 * owner's own account.
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
  /** Resolves the caller's Drive role for the shared file; null when not shared. */
  myRole: (projectId: string) => Promise<PboardRole | null>;
  /** The shared Drive file id the owner created, or null when never shared. */
  getSharedFileId: (projectId: string) => Promise<string | null>;
  /**
   * Bootstraps a viewer/editor that has no local copy yet: downloads the shared
   * project snapshot from Drive and imports it. Returns true when an import
   * happened. Called at most once per start().
   */
  bootstrapFromDrive: (projectId: string) => Promise<boolean>;
  /**
   * Build the signaling provider for one collection room. The manager calls this
   * once per collection with the topic, so the transport is swappable (Drive for
   * the shipped extension, memory/WebSocket for dev and tests).
   */
  signalingFor: (topic: string) => PboardSignaling;
  getRepository: () => Promise<RxRepository | null>;
  wrtc?: PboardWrtc;
  imageTransport?: SharedImageTransport;
  /** Stable normalized account identity hash; null when Drive is disconnected. */
  getAccountId?: () => Promise<string | null>;
}

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
 *   1. resolve the caller's role from Drive permissions (the authoritative ACL);
 *   2. bootstrap a viewer/editor that has no local copy from the shared file;
 *   3. run two WebRTC pools — one per shared collection — with role-based
 *      direction and project-scoped pull/push modifiers.
 *
 * Direction policy (the write-restriction enforcement, per the spec):
 *   - owner/editor: pull + push, scoped to this project.
 *   - viewer: pull-only (no push). A viewer never emits local writes, so nothing
 *     can be pushed; this is the replication-layer half of the read-only
 *     guarantee. The UI read-only + repository gate provide the primary
 *     enforcement; the malicious-modified-client case is out of scope for v1.
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
  let imageSync: ReturnType<typeof createProjectImageSync> | null = null;

  function collectPeers(): string[] {
    const ids = new Set<string>();
    for (const pool of pools) {
      if (pool.collection.name === "settings") continue;
      for (const peer of pool.peerStates$.getValue().keys()) ids.add(String(peer.id));
    }
    return Array.from(ids).sort();
  }

  async function startPool<T extends CardRecord | ProjectRecord>(
    collection: SharedCollection,
    projectId: string,
    ref: RxCollection<T>
  ): Promise<void> {
    const editable = isEditorRole(role);
    // Scope the room to this shared project. Cards carry `projectId`; the project
    // doc is keyed by id.
    const scopeProjectDoc = (doc: unknown): boolean => {
      if (typeof doc !== "object" || doc === null) return false;
      if (collection === "cards") return "projectId" in doc && doc.projectId === projectId;
      return "id" in doc && doc.id === projectId;
    };
    const pool = (await replicateWebRTC({
      collection: ref,
      topic: topicFor(projectId, collection),
      connectionHandlerCreator: createPboardWebRTCConnectionHandler({
        signaling: options.signalingFor(topicFor(projectId, collection)),
        scopeDocument: scopeProjectDoc,
        ...(options.wrtc ? { wrtc: options.wrtc } : {})
      }),
      isPeerValid: () => true,
      // Receive scoping happens in the connection handler (the pull path cannot
      // drop documents via a modifier — a null would crash persistFromMaster).
      pull: { batchSize: 100 },
      ...(editable ? { push: { batchSize: 100, modifier: (doc: WithDeleted<T>) => (scopeProjectDoc(doc) ? doc : null) } } : {})
    })) as SharedPool;
    pools.push(pool);
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

  async function startAccountOrder(rx: RxRepository): Promise<void> {
    const account = await options.getAccountId?.() ?? null;
    await rx.setProjectOrderAccount(account);
    if (!account) return;
    const id = `projectOrder:${account}`;
    const topic = `pboard-account-${account}-order`;
    const scoped = (doc: unknown) => !!doc && typeof doc === "object" && "id" in doc && doc.id === id;
    const pool = await replicateWebRTC<SettingRecord, PboardPeer>({
      collection: rx.db.settings, topic,
      connectionHandlerCreator: createPboardWebRTCConnectionHandler({
        signaling: options.signalingFor(topic), scopeDocument: scoped,
        ...(options.wrtc ? { wrtc: options.wrtc } : {})
      }),
      isPeerValid: () => true,
      pull: { batchSize: 100 },
      push: { batchSize: 100, modifier: (doc) => scoped(doc) ? doc : null }
    });
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
    await startAccountOrder(rx);
    if (role === "private") return;
    // Authoritative viewer write-restriction. WebRTC picks master/slave by token
    // hash, not role, and the master streams its change log unconditionally, so a
    // viewer that is the master would otherwise leak local writes to peers even
    // though its pool is pull-only. Rejecting mutations at the repository layer
    // means no divergent local write exists to stream.
    rx.setMutatorRole(projectId, role);
    if (!(await rx.getProject(projectId))) {
      await options.bootstrapFromDrive(projectId);
    }
    await startPool("cards", projectId, rx.db.cards);
    await startPool("projects", projectId, rx.db.projects);
    if (options.imageTransport) {
      imageSync = createProjectImageSync({ projectId, repository: rx, transport: options.imageTransport,
        canWrite: isEditorRole(role), onError: (err) => { error = err instanceof Error ? err.message : String(err); } });
      imageSync.start();
    }
  }

  async function doStop(): Promise<void> {
    await imageSync?.stop();
    imageSync = null;
    while (pools.length > 0) await (pools.pop() as SharedPool).cancel();
    await startedRepo?.setProjectOrderAccount(null);
    if (startedProjectId) startedRepo?.setMutatorRole(startedProjectId, null);
    startedRepo = null;
    role = "private";
    sharedFileId = null;
    ready = false;
    error = null;
    startedProjectId = null;
  }

  const refreshRole = () => runExclusive(async () => {
    if (!startedProjectId) return;
    const previousRole = role;
    const previousFileId = sharedFileId;
    try {
      await applyRole(startedProjectId);
      if (role !== previousRole || sharedFileId !== previousFileId || (role !== "private" && pools.length === 0)) {
        await doStart(startedProjectId);
      }
    } catch (err) {
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

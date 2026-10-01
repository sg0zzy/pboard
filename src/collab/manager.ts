import { replicateWebRTC } from "rxdb/plugins/replication-webrtc";
import type { RxWebRTCReplicationPool } from "rxdb/plugins/replication-webrtc";
import type { RxCollection, WithDeleted } from "rxdb";
import type { PboardRole } from "../sync/drivePermissions";
import type { RxRepository } from "../storage/rxdbRepository";
import type { CardRecord, ProjectRecord } from "../storage/rxdbSchemas";
import type { PboardSignaling } from "./signaling";
import { createPboardWebRTCConnectionHandler } from "./webrtcHandler";
import type { PboardPeer, PboardWrtc } from "./webrtcHandler";

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
  /** Signaling peer ids currently connected to at least one of the two pools. */
  connectedPeers: string[];
  /** True once the manager has resolved a role for the current start() call. */
  ready: boolean;
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
 * One shared project's live collaboration.
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
 * Images: card documents replicate live; image blobs travel in the Drive snapshot
 *   at bootstrap. A card whose image is added *after* a peer is already
 *   connected appears on the next Drive sync/refresh, not over WebRTC.
 */
export function createCollaborationManager(options: CollaborationManagerOptions): CollaborationManager {
  let role: CollaborationRole = "private";
  let sharedFileId: string | null = null;
  let ready = false;
  let startedProjectId: string | null = null;
  let startedRepo: RxRepository | null = null;
  type SharedPool = RxWebRTCReplicationPool<CardRecord, PboardPeer> | RxWebRTCReplicationPool<ProjectRecord, PboardPeer>;
  const pools: SharedPool[] = [];

  function collectPeers(): string[] {
    const ids = new Set<string>();
    for (const pool of pools) {
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
  }

  async function applyRole(projectId: string): Promise<void> {
    const [resolved, fileId] = await Promise.all([options.myRole(projectId), options.getSharedFileId(projectId)]);
    role = resolved ?? "private";
    sharedFileId = fileId;
    ready = true;
  }

  async function start(projectId: string): Promise<void> {
    await stop();
    startedProjectId = projectId;
    await applyRole(projectId);
    if (role === "private") return;

    // A viewer/editor with no local copy pulls the full snapshot (cards + blobs)
    // from the shared Drive file so the board renders before live replication.
    const rx = await options.getRepository();
    if (!rx) return;
    startedRepo = rx;
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
  }

  async function stop(): Promise<void> {
    while (pools.length > 0) await (pools.pop() as SharedPool).cancel();
    if (startedProjectId) startedRepo?.setMutatorRole(startedProjectId, null);
    startedRepo = null;
    role = "private";
    sharedFileId = null;
    ready = false;
    startedProjectId = null;
  }

  async function refreshRole(): Promise<void> {
    if (!startedProjectId) return;
    await applyRole(startedProjectId);
    // Role changes take effect on the next start() (pools are already running with
    // the previous direction). Re-resolving here keeps state() current for the UI.
  }

  return {
    start,
    stop,
    refreshRole,
    state: () => ({ role, sharedFileId, connectedPeers: collectPeers(), ready })
  };
}

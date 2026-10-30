/**
 * Legacy-asset migration pass for Sync v2 (connect is consent: it runs
 * automatically, no prompt). It detects two legacy shapes and relocates each
 * board into the unified `/pboard/<boardId>/board.json.gz` layout:
 *
 *  - private AppData copies (`project-<id>.pboard`, `history-<id>.pboard`),
 *    driven through the audited resumable engine in `privateMigration.ts` —
 *    read-back verification must pass before the flip, sources are never
 *    modified, and they become deletable only via `cleanupLegacySource`
 *    after the read-only window (verification first, deletion much later);
 *  - legacy shared `Pboard/<id>/` folders: the `project.json` snapshot is
 *    converted, uploaded, verified, and every collaborator ACL is copied to
 *    the new folder before the flip — a failed ACL listing skips the board
 *    rather than relocating it without its access list. The old folder is
 *    never touched.
 *
 * A board whose canonical file already exists is never overwritten.
 */
import { migratePrivateBoard, type MigrationDeps, type MigrationState } from "./privateMigration";
import { deserializeProjectSnapshot, type ProjectSnapshot, type ProjectSnapshotStore } from "./snapshot";
import { deserializeBoardSnapshotV2 as parseV2, serializeBoardSnapshotV2, v1SnapshotToEntities } from "./snapshotV2";
import type { DriveBoardStore } from "./driveBoardStore";
import type { RxRepository } from "../storage/rxdbRepository";

export type LegacySharedBoard = { projectId: string; folderId: string; projectFileId: string };

export type LegacyMigrationDeps = {
  skipBoard?: (boardId: string) => Promise<boolean>;
  store: DriveBoardStore;
  /** AppData board snapshots (`project-…`) and history archives (`history-…`). */
  listAppDataBoards(): Promise<{ id: string; name: string }[]>;
  listAppDataHistory(boardId: string): Promise<{ id: string; name: string }[]>;
  downloadFile(fileId: string): Promise<Uint8Array | null>;
  deleteAppDataFile(fileId: string): Promise<void>;
  snapshots: ProjectSnapshotStore;
  syncState: { get(projectId: string): Promise<{ dirty?: boolean } | undefined>; markSynced(projectId: string, revision: number, remoteFileId: string): Promise<void> };
  tombstones: { get(projectId: string): Promise<unknown> };
  getRepository: () => Promise<RxRepository | null>;
  deviceKeyId(): Promise<string>;
  appVersion?: string;
  sharedLegacy(): Promise<LegacySharedBoard[]>;
  listPermissions(folderId: string): Promise<{ type: string; role: string; emailAddress?: string }[]>;
  createPermission(folderId: string, role: "reader" | "writer", email: string): Promise<void>;
  migrations: {
    load(projectId: string): Promise<MigrationState | undefined>;
    save(state: MigrationState): Promise<void>;
    clear(projectId: string): Promise<void>;
  };
  now(): number;
};

export type LegacyMigrationResult = {
  migrated: string[];
  relocated: string[];
  skipped: string[];
  failed: { projectId: string; error: string }[];
};

const boardIdFromLegacyName = (name: string) => /^project-(.*)\.pboard$/.exec(name)?.[1] ?? null;

/** Serialize a v1 snapshot deterministically so verification can compare. */
async function canonicalBytes(snapshot: ProjectSnapshot, deviceKeyId: string, appVersion: string, exportedAt: string): Promise<Uint8Array> {
  return serializeBoardSnapshotV2(v1SnapshotToEntities(snapshot), {
    boardId: snapshot.project.id, appVersion, snapshotSeq: 1, epoch: 0,
    writtenBy: { deviceKeyId }, exportedAt
  });
}

/**
 * Upload → read back → parse → compare entities against the export input.
 * Throws on any mismatch; the engine only flips when this resolves.
 */
async function verifyCanonical(deps: LegacyMigrationDeps, projectId: string, expected: Uint8Array): Promise<void> {
  const uploaded = await deps.store.download(projectId);
  if (!uploaded) throw new Error("canonical snapshot missing after upload");
  const remote = await parseV2(uploaded, { expectBoardId: projectId });
  const local = await parseV2(expected, { expectBoardId: projectId });
  if (JSON.stringify(remote.entities) !== JSON.stringify(local.entities)) throw new Error("canonical snapshot differs from the export");
}

async function uploadCanonical(deps: LegacyMigrationDeps, projectId: string, bytes: Uint8Array): Promise<string> {
  const fileId = await deps.store.ensureSnapshotFile(projectId);
  const meta = await deps.store.meta(projectId);
  const outcome = await deps.store.publish(projectId, meta?.etag ?? "", bytes);
  if (outcome.status !== "published") throw new Error(`canonical publish failed (${outcome.status})`);
  return fileId;
}

/** One automatic pass over both legacy shapes; safe to re-run any time. */
export async function migrateLegacyBoards(deps: LegacyMigrationDeps): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { migrated: [], relocated: [], skipped: [], failed: [] };
  const rx = await deps.getRepository();
  if (!rx) return result;
  const appVersion = deps.appVersion ?? "0.11.0";

  let legacyFiles: { id: string; name: string }[] = [];
  try { legacyFiles = await deps.listAppDataBoards(); } catch { /* AppData unavailable or scope revoked: nothing to migrate. */ }
  for (const file of legacyFiles) {
    const projectId = boardIdFromLegacyName(file.name);
    if (!projectId) continue;
    try {
      if (await deps.skipBoard?.(projectId) || await deps.tombstones.get(projectId) || await rx.isDeletedProject(projectId)) { result.skipped.push(projectId); continue; }
      const state = await deps.migrations.load(projectId);
      // Probe by name so a skipped board leaves no folder behind
      // (`snapshotFileId` find-or-creates the board folder).
      if (await findCanonicalFileId(deps.store, projectId) && (!state || state.step === "sealed")) { result.skipped.push(projectId); continue; }
      // Local-first: migrate the local board; import the legacy file only
      // when this profile has no local copy yet (fresh device recovery).
      if (!await rx.getProject(projectId)) {
        const legacy = await deps.downloadFile((await findAppDataFile(deps, projectId))?.id ?? "");
        if (!legacy) { result.skipped.push(projectId); continue; }
        const snapshot = deserializeProjectSnapshot(new TextDecoder().decode(legacy));
        if (snapshot.project.id !== projectId) throw new Error("legacy snapshot belongs to a different board");
        await deps.snapshots.apply(snapshot);
      }
      const exportedAt = new Date(deps.now()).toISOString();
      let exportBytes: Uint8Array | undefined;
      const engineDeps: MigrationDeps = {
        loadState: deps.migrations.load, saveState: deps.migrations.save, clearState: deps.migrations.clear,
        exportBoard: async () => {
          exportBytes = await canonicalBytes(await deps.snapshots.read(projectId), await deps.deviceKeyId(), appVersion, exportedAt);
          return exportBytes;
        },
        ensureFolder: () => deps.store.boardFolder(projectId),
        uploadSnapshot: (_folderId, bytes) => uploadCanonical(deps, projectId, bytes),
        uploadHistory: async () => {
          for (const history of await deps.listAppDataHistory(projectId)) {
            const bytes = await deps.downloadFile(history.id);
            if (bytes) await deps.store.uploadBoardFile(projectId, history.name, bytes);
          }
        },
        verifySnapshot: async () => {
          if (!exportBytes) await canonicalBytes(await deps.snapshots.read(projectId), await deps.deviceKeyId(), appVersion, exportedAt);
          await verifyCanonical(deps, projectId, exportBytes!);
        },
        flipTarget: async (_projectId, _folderId, fileId) => {
          const local = await deps.snapshots.read(projectId);
          await deps.syncState.markSynced(projectId, local.project.revision, fileId);
        },
        sealSource: async () => undefined,
        now: () => deps.now()
      };
      await migratePrivateBoard(engineDeps, projectId);
      result.migrated.push(projectId);
    } catch (error) {
      result.failed.push({ projectId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const shared of await deps.sharedLegacy()) {
    try {
      if (await deps.skipBoard?.(shared.projectId) || await deps.tombstones.get(shared.projectId) || await rx.isDeletedProject(shared.projectId)) { result.skipped.push(shared.projectId); continue; }
      // Probe the canonical location by name so a skipped board leaves no
      // folder behind (`snapshotFileId` would create the folder).
      if (await findCanonicalFileId(deps.store, shared.projectId)) { result.skipped.push(shared.projectId); continue; }
      const raw = await deps.downloadFile(shared.projectFileId);
      if (!raw) { result.skipped.push(shared.projectId); continue; }
      const snapshot = deserializeProjectSnapshot(new TextDecoder().decode(raw));
      if (snapshot.project.id !== shared.projectId) throw new Error("shared snapshot belongs to a different board");
      if (!await rx.getProject(shared.projectId)) await deps.snapshots.apply(snapshot);
      // Read the collaborator ACL before creating anything: a listing
      // failure must skip the board with no partial state, and access can
      // never be downgraded because the new grants precede the upload.
      const permissions = await deps.listPermissions(shared.folderId);
      const folderId = await deps.store.boardFolder(shared.projectId);
      for (const permission of permissions) {
        if (permission.type !== "user" || !permission.emailAddress) continue;
        if (permission.role !== "reader" && permission.role !== "writer") continue;
        await deps.createPermission(folderId, permission.role, permission.emailAddress);
      }
      const bytes = await canonicalBytes(snapshot, await deps.deviceKeyId(), appVersion, new Date(deps.now()).toISOString());
      const fileId = await uploadCanonical(deps, shared.projectId, bytes);
      await verifyCanonical(deps, shared.projectId, bytes);
      const local = await deps.snapshots.read(shared.projectId);
      await deps.syncState.markSynced(shared.projectId, local.project.revision, fileId);
      result.relocated.push(shared.projectId);
    } catch (error) {
      result.failed.push({ projectId: shared.projectId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
/** Canonical file id without creating the board folder on the probe path. */
async function findCanonicalFileId(store: DriveBoardStore, projectId: string): Promise<string | null> {
  if (!(await store.listBoards()).includes(projectId)) return null;
  return await store.snapshotFileId(projectId);
}

async function findAppDataFile(deps: LegacyMigrationDeps, projectId: string): Promise<{ id: string } | undefined> {
  return (await deps.listAppDataBoards()).find(file => file.name === `project-${projectId}.pboard`);
}

/**
 * Delete one board's legacy AppData copies — only after the migration
 * verified, flipped, sealed, and the read-only window elapsed. The engine's
 * `cleanupDue` rule owns that ordering; this never guesses.
 */
export async function cleanupLegacySource(deps: LegacyMigrationDeps, projectId: string): Promise<boolean> {
  const { cleanupDue } = await import("./privateMigration");
  const state = await deps.migrations.load(projectId);
  if (!state) return false;
  if (!cleanupDue(state, deps.now())) throw new Error("The read-only window has not elapsed");
  const legacy = await findAppDataFile(deps, projectId);
  if (legacy) await deps.deleteAppDataFile(legacy.id);
  for (const history of await deps.listAppDataHistory(projectId)) await deps.deleteAppDataFile(history.id);
  await deps.migrations.clear(projectId);
  return true;
}

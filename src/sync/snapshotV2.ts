/**
 * Sync v2 board snapshot: versioned, application-defined, gzip-compressed.
 *
 * The file on Drive is gzip(JSON) of `BoardSnapshotV2` — never an RxDB
 * internal representation, so the storage engine can change underneath it.
 * The envelope carries everything reconciliation needs without reading the
 * document bodies: per-collection checkpoints, per-device op watermarks, and
 * the leader metadata (`snapshotSeq`, `epoch`, `writtenBy`) that makes a
 * stale-leader overwrite identifiable (detect-and-repair, design §8).
 *
 * Reading accepts an uncompressed JSON body too: a Drive file edited or
 * truncated by an external tool must fail as "invalid snapshot" with a clear
 * message, not as "not gzip", and a future write-side that skips compression
 * for tiny boards stays readable.
 */
import type { BoardItem, Project } from "../types";
import { normalizeCardDisplayMode } from "../cardDisplayModes";
import type { ProjectSnapshot } from "./snapshot";

export const BOARD_SNAPSHOT_SCHEMA_VERSION = 2;
export const BOARD_SNAPSHOT_FORMAT = "pboard-board-v2";

/** Hard caps; a board beyond them must split or prune, never upload oversized. */
export const MAX_SNAPSHOT_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_SNAPSHOT_FILE_BYTES = 12 * 1024 * 1024;

export type BoardSnapshotV2 = {
  format: typeof BOARD_SNAPSHOT_FORMAT;
  schemaVersion: typeof BOARD_SNAPSHOT_SCHEMA_VERSION;
  boardId: string;
  appVersion: string;
  exportedAt: string;
  /** Monotonic per board; bumped by every accepted snapshot write. */
  snapshotSeq: number;
  /** Leader fencing epoch; strictly increases across leader changes. */
  epoch: number;
  writtenBy: { deviceKeyId: string; at: string };
  /** Per-collection high-water info; digest is over the canonical collection JSON. */
  checkpoints: Record<string, { lastSeq: number; digest: string }>;
  /** deviceKeyId -> highest op sequence durable in this snapshot. */
  watermarks: Record<string, number>;
  /** ISO date before which tombstones were pruned, if ever. */
  prunedBefore?: string;
  entities: {
    projects: Project[];
    cards: BoardItem[];
    settings: Record<string, unknown>[];
  };
};

const GZIP_MAGIC = [0x1f, 0x8b];
const isGzip = (bytes: Uint8Array) => bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Digest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Stable per-collection digest of a snapshot body (sorted by id, items by order). */
export async function collectionDigests(entities: BoardSnapshotV2["entities"]): Promise<BoardSnapshotV2["checkpoints"]> {
  const digestOf = async (docs: { id?: string }[]) =>
    sha256Digest(JSON.stringify([...docs].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))));
  return {
    projects: { lastSeq: 0, digest: await digestOf(entities.projects) },
    cards: { lastSeq: 0, digest: await digestOf(entities.cards) },
    settings: { lastSeq: 0, digest: await digestOf(entities.settings) }
  };
}

export type SerializeOptions = {
  boardId: string;
  appVersion: string;
  snapshotSeq: number;
  epoch: number;
  writtenBy: { deviceKeyId: string; at?: string };
  watermarks?: Record<string, number>;
  prunedBefore?: string;
  checkpoints?: BoardSnapshotV2["checkpoints"];
  exportedAt?: string;
};

export async function serializeBoardSnapshotV2(
  entities: BoardSnapshotV2["entities"],
  options: SerializeOptions
): Promise<Uint8Array> {
  const cards = entities.cards.map((item) => ({ ...item, displayMode: normalizeCardDisplayMode(item.displayMode) }));
  const at = options.exportedAt ?? new Date().toISOString();
  const snapshot: BoardSnapshotV2 = {
    format: BOARD_SNAPSHOT_FORMAT,
    schemaVersion: BOARD_SNAPSHOT_SCHEMA_VERSION,
    boardId: options.boardId,
    appVersion: options.appVersion,
    exportedAt: at,
    snapshotSeq: options.snapshotSeq,
    epoch: options.epoch,
    writtenBy: { deviceKeyId: options.writtenBy.deviceKeyId, at: options.writtenBy.at ?? at },
    checkpoints: options.checkpoints ?? await collectionDigests({ ...entities, cards }),
    watermarks: options.watermarks ?? {},
    ...(options.prunedBefore ? { prunedBefore: options.prunedBefore } : {}),
    entities: { projects: structuredClone(entities.projects), cards: structuredClone(cards), settings: structuredClone(entities.settings) }
  };
  const json = JSON.stringify(snapshot);
  if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_JSON_BYTES) throw new Error("Board snapshot exceeds the uncompressed size limit; split the board or prune history");
  const compressed = await gzip(new TextEncoder().encode(json));
  if (compressed.byteLength > MAX_SNAPSHOT_FILE_BYTES) throw new Error("Board snapshot exceeds the compressed size limit; split the board or prune history");
  return compressed;
}

export async function deserializeBoardSnapshotV2(
  bytes: Uint8Array,
  options: { expectBoardId?: string; maxFileBytes?: number } = {}
): Promise<BoardSnapshotV2> {
  const maxFile = options.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
  if (bytes.byteLength > maxFile) throw new Error("Board snapshot file exceeds the size limit");
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
  const raw = isGzip(view) ? await gunzip(view) : view;
  if (raw.byteLength > MAX_SNAPSHOT_JSON_BYTES) throw new Error("Board snapshot exceeds the uncompressed size limit");
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<BoardSnapshotV2>;
  if (parsed.format !== BOARD_SNAPSHOT_FORMAT || parsed.schemaVersion !== BOARD_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Not a pboard-board-v2 snapshot");
  }
  if (typeof parsed.boardId !== "string" || !parsed.boardId) throw new Error("Board snapshot has no board identity");
  if (options.expectBoardId && parsed.boardId !== options.expectBoardId) throw new Error("Board snapshot belongs to a different board");
  if (!Number.isInteger(parsed.snapshotSeq) || (parsed.snapshotSeq ?? 0) < 0) throw new Error("Board snapshot has an invalid snapshotSeq");
  if (!Number.isInteger(parsed.epoch) || (parsed.epoch ?? 0) < 0) throw new Error("Board snapshot has an invalid epoch");
  if (!parsed.writtenBy || typeof parsed.writtenBy.deviceKeyId !== "string") throw new Error("Board snapshot has no writer identity");
  if (!parsed.entities || !Array.isArray(parsed.entities.cards) || !Array.isArray(parsed.entities.projects)) throw new Error("Board snapshot has no document collections");
  const projectIds = new Set(parsed.entities.projects.map((project) => project.id));
  if (parsed.entities.cards.some((item) => !projectIds.has(item.projectId))) throw new Error("Board snapshot references an unknown project");
  return parsed as BoardSnapshotV2;
}

/** Upgrade a v1 project snapshot (the current `project.json` body) to v2 entities. */
export function v1SnapshotToEntities(snapshot: ProjectSnapshot): BoardSnapshotV2["entities"] {
  return { projects: [snapshot.project], cards: snapshot.items.map((item) => ({ ...item, displayMode: normalizeCardDisplayMode(item.displayMode) })), settings: [] };
}

/** The inverse: a v1 snapshot view of v2 entities (single-project boards), for rollback. */
export function v2EntitiesToV1(entities: BoardSnapshotV2["entities"], exportedAt: string): ProjectSnapshot {
  const [project, ...rest] = entities.projects;
  if (!project || rest.length) throw new Error("v2 board does not map to a single-project v1 snapshot");
  return { format: "pboard-project", version: 1, exportedAt, project, items: entities.cards };
}

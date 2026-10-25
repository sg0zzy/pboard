/**
 * Drive-backed storage for the Sync v2 snapshot file (`pboard-board-v2.json`)
 * inside a board's realtime folder. Owns the file lifecycle (find-or-create)
 * and the If-Match revision state, exposing exactly the three functions the
 * leader publish cycle needs. All Drive access goes through the injected
 * fetcher so tests run without a network or OAuth.
 */
import { getSnapshotMeta, downloadSnapshotBytes, publishSnapshotConditional, type DriveFetch } from "./drivePublish";

export const BUFFER_SNAPSHOT_FILENAME = "pboard-board-v2.json";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

export type BufferSnapshotStore = {
  /** Current revision metadata, or null when the folder holds no snapshot yet. */
  meta(boardId: string): Promise<{ etag: string; version: string } | null>;
  download(boardId: string): Promise<Uint8Array | null>;
  publish(boardId: string, knownEtag: string, gzipBytes: Uint8Array): Promise<
    | { status: "published"; version: string }
    | { status: "conflict" | "missing" | "forbidden" | "error" }
  >;
  /** Drops the cached file id; the next operation re-discovers it. */
  reset(): void;
};

export function createBufferSnapshotStore(options: {
  token: () => Promise<string>;
  folderId: (boardId: string) => Promise<string | null>;
  fileName?: string;
  fetcher?: DriveFetch;
}): BufferSnapshotStore {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init as RequestInit));
  const fileName = options.fileName ?? BUFFER_SNAPSHOT_FILENAME;
  let fileId: string | undefined;

  async function discover(): Promise<string | undefined> {
    if (fileId) return fileId;
    const folder = await options.folderId("");
    if (!folder) return undefined;
    const token = await options.token();
    const query = encodeURIComponent(`name='${fileName}' and '${folder}' in parents and trashed = false`);
    const found = await fetcher(`${API}/files?fields=files(id%2Cversion)&q=${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!found.ok) throw new Error(`Buffer snapshot lookup failed (${found.status})`);
    const files = ((await found.json()) as { files?: { id: string }[] }).files ?? [];
    if (files.length) { fileId = files[0].id; return fileId; }
    // First publisher creates the file empty; the leader's conditional publish
    // then carries a known `If-Match` from the very first revision on.
    const metadata = JSON.stringify({ name: fileName, parents: [folder] });
    const boundary = "pboard-buffer-boundary";
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`;
    const created = await fetcher(`${UPLOAD_API}?uploadType=multipart&fields=id%2Cversion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary="${boundary}"` },
      body
    });
    if (!created.ok) {
      // A racing peer may have created it first: re-search once before failing.
      const retry = await fetcher(`${API}/files?fields=files(id)&q=${query}`, { headers: { Authorization: `Bearer ${token}` } });
      const raced = retry.ok ? (((await retry.json()) as { files?: { id: string }[] }).files ?? [])[0]?.id : undefined;
      if (raced) { fileId = raced; return fileId; }
      throw new Error(`Buffer snapshot creation failed (${created.status})`);
    }
    fileId = ((await created.json()) as { id: string }).id;
    return fileId;
  }

  return {
    async meta() {
      const id = await discover();
      if (!id) return null;
      return getSnapshotMeta(fetcher, id, await options.token());
    },
    async download() {
      const id = await discover();
      if (!id) return null;
      return downloadSnapshotBytes(fetcher, id, await options.token());
    },
    async publish(_boardId, knownEtag, gzipBytes) {
      const id = await discover();
      if (!id) return { status: "error" as const };
      const outcome = await publishSnapshotConditional(fetcher, id, await options.token(), knownEtag, gzipBytes);
      return outcome.status === "published" ? { status: "published", version: outcome.version } : outcome;
    },
    reset() { fileId = undefined; }
  };
}

/**
 * Conditional (If-Match) Drive snapshot publishing (Sync v2 leader path).
 *
 * The leader publishes `board.json.gz` with an `If-Match` precondition bound
 * to the revision it reconciled against, turning Drive's last-write-wins file
 * into optimistic concurrency: a concurrent publisher surfaces as 412 and the
 * leader re-merges instead of silently overwriting. This does not *prevent* a
 * stale upload that was already in flight (documented limit); it shrinks the
 * window and makes the loss detectable and repairable (see snapshotMerge).
 */
export type DriveFetch = (input: string, init?: Record<string, unknown>) => Promise<Response>;

export type PublishOutcome =
  | { status: "published"; version: string; md5Checksum?: string }
  | { status: "conflict" }
  | { status: "missing" }
  | { status: "forbidden" }
  | { status: "error"; code: number };

const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
const META_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

export async function getSnapshotMeta(
  fetcher: DriveFetch,
  fileId: string,
  token: string,
  abortSignal?: AbortSignal
): Promise<{ etag: string; version: string; md5Checksum?: string } | null> {
  const response = await fetcher(
    `${META_ENDPOINT}/${encodeURIComponent(fileId)}?fields=id%2Cversion%2Cmd5Checksum`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` }, ...(abortSignal ? { signal: abortSignal } : {}) }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Drive snapshot metadata read failed (${response.status})`);
  const meta = (await response.json()) as { version?: string; md5Checksum?: string };
  return { etag: meta.version ?? "", version: meta.version ?? "", ...(meta.md5Checksum ? { md5Checksum: meta.md5Checksum } : {}) };
}

export async function downloadSnapshotBytes(fetcher: DriveFetch, fileId: string, token: string, abortSignal?: AbortSignal): Promise<Uint8Array | null> {
  // Media downloads must use the v3 host; GET against the upload host is
  // rejected by the live API with 405 Method Not Allowed.
  const response = await fetcher(`${META_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    ...(abortSignal ? { signal: abortSignal } : {})
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Drive snapshot download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Upload-replaces the snapshot file only if it still matches `knownEtag`.
 * Returns the new Drive revision on success; `conflict` means re-read and
 * re-merge before trying again; `forbidden` means Drive revoked this client's
 * write permission mid-session, which must end the leadership immediately.
 */
export async function publishSnapshotConditional(
  fetcher: DriveFetch,
  fileId: string,
  token: string,
  knownEtag: string,
  gzipBytes: Uint8Array,
  abortSignal?: AbortSignal
): Promise<PublishOutcome> {
  const response = await fetcher(
    `${UPLOAD_ENDPOINT}/${encodeURIComponent(fileId)}?uploadType=media&fields=id%2Cversion%2Cmd5Checksum`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        ...(knownEtag ? { "If-Match": knownEtag } : {})
      },
      body: gzipBytes.slice().buffer as ArrayBuffer,
      ...(abortSignal ? { signal: abortSignal } : {})
    }
  );
  if (response.status === 412 || response.status === 409) return { status: "conflict" };
  if (response.status === 404) return { status: "missing" };
  if (response.status === 401 || response.status === 403) return { status: "forbidden" };
  if (!response.ok) return { status: "error", code: response.status };
  const meta = (await response.json().catch(() => ({}))) as { version?: string; md5Checksum?: string };
  return { status: "published", version: meta.version ?? "", ...(meta.md5Checksum ? { md5Checksum: meta.md5Checksum } : {}) };
}

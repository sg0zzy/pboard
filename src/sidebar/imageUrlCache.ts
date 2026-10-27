/**
 * Browser object URLs for content-hashed image blobs, refcounted so switching
 * to a board and back reuses already-decoded images instead of re-reading the
 * blob and creating a fresh URL for every card. Image ids are content hashes,
 * so a cached URL for an id always matches the bytes stored under it.
 * URLs with active holders are never revoked; the idle set is kept under a cap.
 */
const MAX_IDLE_URLS = 512;
type Entry = { url: string; refs: number };
const entries = new Map<string, Entry>();

export function peekImageUrl(imageId: string): string | null {
  const entry = entries.get(imageId);
  return entry ? entry.url : null;
}

export function acquireImageUrl(imageId: string, blob: Blob): string {
  let entry = entries.get(imageId);
  if (entry) {
    entries.delete(imageId); // Refresh recency.
    entry.refs += 1;
  } else {
    entry = { url: URL.createObjectURL(blob), refs: 1 };
  }
  entries.set(imageId, entry);
  let idle = 0;
  for (const held of entries.values()) if (held.refs <= 0) idle += 1;
  if (idle > MAX_IDLE_URLS) {
    for (const [key, held] of entries) {
      if (held.refs <= 0) {
        entries.delete(key);
        URL.revokeObjectURL(held.url);
        break;
      }
    }
  }
  return entry.url;
}

export function releaseImageUrl(imageId: string): void {
  const entry = entries.get(imageId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
}

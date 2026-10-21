import { canonicalize } from "../collab/security/canonical";
import { documentValue, type DocumentValue } from "./changeJournal";

const active = new WeakMap<object, Map<string, string>>();
/** Projection of already durable history, not a new authored change. Guards still run. */
export function isJournalMaterialization(collection: object, document: Record<string, unknown>): boolean {
  const expected = active.get(collection)?.get(String(document.id));
  if (expected === undefined) return false;
  // Concurrent replication can write another valid version of the same ID.
  // It must take the ordinary WAL/verification path, never this exact intent.
  return expected === canonicalize(documentValue(document));
}
export async function withJournalMaterialization<T>(collection: object, value: DocumentValue, operation: () => Promise<T>): Promise<T> {
  return withJournalMaterializations(collection, [value], operation);
}
/** Exact-value batch, used when seeding an isolated command scratchpad. */
export async function withJournalMaterializations<T>(collection: object, values: DocumentValue[], operation: () => Promise<T>): Promise<T> {
  let map = active.get(collection);
  if (!map) { map = new Map(); active.set(collection, map); }
  const expected = values.map(value => [String(value.id), canonicalize(value)] as const);
  if (new Set(expected.map(([id]) => id)).size !== expected.length || expected.some(([id]) => map.has(id))) throw new Error("Recovery for this document is already running");
  for (const [id, value] of expected) map.set(id, value);
  try { return await operation(); } finally { for (const [id] of expected) map.delete(id); }
}

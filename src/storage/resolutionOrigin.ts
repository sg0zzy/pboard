import { canonicalize } from "../collab/security/canonical";
import { documentValue } from "./changeJournal";

const intents = new WeakMap<object, Map<string, { parents: string[]; value: string }>>();
function comparable(document: Record<string, unknown>): string {
  const { _sec: _, ...value } = documentValue(document);
  return canonicalize(value);
}
/** Local command capability, matched to exact intended bytes. Never read from wire data. */
export function resolutionParents(collection: object, document: Record<string, unknown>): string[] | undefined {
  const intent = intents.get(collection)?.get(String(document.id));
  if (!intent) return;
  if (intent.value !== comparable(document)) throw new Error("Resolution changed during save; review the conflict again");
  return [...intent.parents];
}
export async function withResolutionOrigin<T>(collection: object, document: Record<string, unknown>, parents: string[], operation: () => Promise<T>): Promise<T> {
  const id = String(document.id);
  let map = intents.get(collection);
  if (!map) { map = new Map(); intents.set(collection, map); }
  if (map.has(id)) throw new Error("Another resolution is being saved");
  const intent = { parents: [...parents].sort(), value: comparable(document) };
  map.set(id, intent);
  try { return await operation(); }
  finally { if (map.get(id) === intent) map.delete(id); }
}

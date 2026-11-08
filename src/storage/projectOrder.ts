export type ProjectOrderPreference = { ids: string[]; updatedAt: string; deletedProjectIds?: string[]; restoreEvents?: Record<string, string> };

/**
 * Weave a received total order into the list this device actually holds.
 *
 * The rule, in the order it is applied:
 *
 * 1. **A received id this device does not have is never imported.** Order is
 *    a property of the list, not a creation: a board arrives only through the
 *    verified `board.created` path (or the Drive listing). So an unknown id is
 *    dropped rather than appended, and nothing here can make a board exist.
 * 2. **A local id the received order does not mention keeps its slot relative
 *    to the local ids around it.** Boards the sender has not seen yet (it has
 *    not polled, or the board is new) are not ordered by the record, so they
 *    must not be dragged to the front or the back: each unmentioned id is
 *    anchored to its predecessor in the *local* order, and the merged sequence
 *    is the received order with those runs re-inserted after their anchor.
 *    Concretely: walk the local list, and before emitting the local
 *    successor of an unmentioned id, emit that id. A local id whose anchor is
 *    itself unmentioned stays in the run; a run whose anchor is absent from
 *    the received order (impossible unless the whole local list is unknown)
 *    goes to the front in local order.
 * 3. **Known ids are ordered exactly as the record gives them.** The record is
 *    a total order over the set its author had, and over that set the merge is
 *    the identity.
 *
 * This is a pure list operation: the caller decides *whether* to apply it
 * (that is the clock's job, in the projection) and what to persist.
 */
export function mergeBoardOrder(local: readonly string[], received: readonly string[]): string[] {
  const known = new Set(local);
  const remote = [...new Set(received)].filter(id => known.has(id));
  const mentioned = new Set(remote);
  // Runs of local ids the record does not mention, keyed by the local id that
  // immediately precedes the run. `null` is the run at the head of the list.
  const runs = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of local) {
    if (mentioned.has(id)) { anchor = id; continue; }
    const run = runs.get(anchor);
    if (run) run.push(id); else runs.set(anchor, [id]);
  }
  const merged = [...(runs.get(null) ?? [])];
  for (const id of remote) {
    merged.push(id);
    merged.push(...(runs.get(id) ?? []));
  }
  return merged;
}

/**
 * Whether two project orders describe the same thing.
 *
 * The order is compared by content, not by its serialized text: the same
 * order can serialize differently when the merge reorders the keys, and that
 * difference is not a change worth writing.
 */
export function sameProjectOrder(left: ProjectOrderPreference, right: ProjectOrderPreference): boolean {
  const sameIds = left.ids.length === right.ids.length && left.ids.every((id, index) => id === right.ids[index]);
  if (!sameIds) return false;
  if (left.updatedAt !== right.updatedAt) return false;
  const leftDeleted = left.deletedProjectIds ?? [];
  const rightDeleted = right.deletedProjectIds ?? [];
  if (leftDeleted.length !== rightDeleted.length) return false;
  if (!leftDeleted.every((id, index) => id === rightDeleted[index])) return false;
  const leftRestores = Object.entries(left.restoreEvents ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightRestores = Object.entries(right.restoreEvents ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (leftRestores.length !== rightRestores.length) return false;
  return leftRestores.every(([id, when], index) => id === rightRestores[index][0] && when === rightRestores[index][1]);
}

/** Accepts the pre-preference array format and the object format, plus an additive `restoreEvents` map (project id → ISO restore time). */
export function parseProjectOrder(value: string): ProjectOrderPreference {
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed) && parsed.every((id: unknown) => typeof id === "string")) {
    return { ids: parsed, updatedAt: "1970-01-01T00:00:00.000Z" };
  }
  if (parsed && typeof parsed === "object" && "ids" in parsed && "updatedAt" in parsed &&
      Array.isArray(parsed.ids) && parsed.ids.every((id: unknown) => typeof id === "string") &&
      typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt))) {
    const deleted = "deletedProjectIds" in parsed ? parsed.deletedProjectIds : undefined;
    if (deleted !== undefined && (!Array.isArray(deleted) || !deleted.every((id: unknown) => typeof id === "string"))) {
      throw new Error("Invalid project deletion preference");
    }
    const rawRestores = "restoreEvents" in parsed ? parsed.restoreEvents : undefined;
    if (rawRestores !== undefined && (Array.isArray(rawRestores) || typeof rawRestores !== "object" ||
        Object.entries(rawRestores as Record<string, unknown>).some(([id, when]) =>
          typeof id !== "string" || !id || typeof when !== "string" || !Number.isFinite(Date.parse(when))))) {
      throw new Error("Invalid project restore preference");
    }
    return { ids: parsed.ids, updatedAt: parsed.updatedAt,
      ...(deleted ? { deletedProjectIds: deleted as string[] } : {}),
      ...(rawRestores ? { restoreEvents: rawRestores as Record<string, string> } : {}) };
  }
  throw new Error("Invalid project order preference");
}

/** Legacy deletion markers carry no per-entry time; their preference's updatedAt stands in. */
function deletionTime(preference: ProjectOrderPreference, projectId: string): number {
  return (preference.deletedProjectIds ?? []).includes(projectId) ? Date.parse(preference.updatedAt) : Number.NEGATIVE_INFINITY;
}

function restoreTime(preference: ProjectOrderPreference, projectId: string): number {
  const saved = preference.restoreEvents?.[projectId];
  return saved ? Date.parse(saved) : Number.NEGATIVE_INFINITY;
}

/** When a board left this account's list. Re-share detection needs the moment,
 * not only the flag: a later restore event outranks the deletion marker. */
export function projectDeletionTime(preference: ProjectOrderPreference, projectId: string): number | null {
  const deleted = deletionTime(preference, projectId);
  if (!Number.isFinite(deleted)) return null;
  return restoreTime(preference, projectId) > deleted ? null : deleted;
}

/**
 * Deletion markers merge across devices. Each side states its deletion fact; a
 * project stays deleted when EITHER side deleted it later than the last known
 * restore. `restoreEvents` records the last restore so a per-account restore is
 * not silently reverted by the next preference merge, while a NEWER deletion
 * still wins.
 */
export function mergeProjectOrder(current: ProjectOrderPreference, incoming: ProjectOrderPreference): ProjectOrderPreference {
  const comparison = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  const newest = comparison > 0 || (comparison === 0 && JSON.stringify(incoming.ids) > JSON.stringify(current.ids)) ? incoming : current;
  const restoreEvents: Record<string, string> = { ...current.restoreEvents };
  for (const [id, when] of Object.entries(incoming.restoreEvents ?? {})) {
    const existing = restoreEvents[id];
    if (!existing || Date.parse(when) > Date.parse(existing)) restoreEvents[id] = when;
  }
  const deletedCandidates = new Set([...(current.deletedProjectIds ?? []), ...(incoming.deletedProjectIds ?? [])]);
  const deleted = [...deletedCandidates]
    .filter(id => {
      const newestDeletion = Math.max(deletionTime(current, id), deletionTime(incoming, id));
      const newestRestore = Math.max(restoreTime(current, id), restoreTime(incoming, id));
      return newestDeletion > newestRestore;
    })
    // The newest known deletion marker competes with the newest known restore
    // event; the later action wins regardless of which side it came from.
    .sort();
  return { ...newest,
    ids: [...new Set([...newest.ids, ...Object.keys(restoreEvents)])].filter(id => !deleted.includes(id)),
    // `newest` may carry its own deletion list; the merged decision always
    // replaces it — an empty list is the observable restore outcome. When no
    // side recorded a deletion, the key stays absent: an invented empty list
    // would make the stored order differ from a remote copy that never had
    // one, and the account order would then be re-uploaded on every sync.
    ...(deleted.length || newest.deletedProjectIds ? { deletedProjectIds: deleted } : {}),
    ...(Object.keys(restoreEvents).length ? { restoreEvents } : {}) };
}


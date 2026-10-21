export type ProjectOrderPreference = { ids: string[]; updatedAt: string; deletedProjectIds?: string[]; restoreEvents?: Record<string, string> };

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


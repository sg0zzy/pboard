export type ProjectOrderPreference = { ids: string[]; updatedAt: string; deletedProjectIds?: string[] };

/** Accept the array format written before order preferences were persisted to Drive. */
export function parseProjectOrder(value: string): ProjectOrderPreference {
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
    return { ids: parsed, updatedAt: "1970-01-01T00:00:00.000Z" };
  }
  if (parsed && typeof parsed === "object" && "ids" in parsed && "updatedAt" in parsed &&
      Array.isArray(parsed.ids) && parsed.ids.every((id) => typeof id === "string") &&
      typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt))) {
    const deleted = "deletedProjectIds" in parsed ? parsed.deletedProjectIds : undefined;
    if (deleted !== undefined && (!Array.isArray(deleted) || !deleted.every((id) => typeof id === "string"))) {
      throw new Error("Invalid project deletion preference");
    }
    return { ids: parsed.ids, updatedAt: parsed.updatedAt,
      ...(deleted ? { deletedProjectIds: deleted as string[] } : {}) };
  }
  throw new Error("Invalid project order preference");
}

/** Deletions are permanent for these unique project ids, even with older order updates. */
export function mergeProjectOrder(current: ProjectOrderPreference, incoming: ProjectOrderPreference): ProjectOrderPreference {
  const comparison = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  const newest = comparison > 0 || (comparison === 0 && JSON.stringify(incoming.ids) > JSON.stringify(current.ids)) ? incoming : current;
  const deleted = [...new Set([...(current.deletedProjectIds ?? []), ...(incoming.deletedProjectIds ?? [])])].sort();
  return { ...newest, ids: newest.ids.filter((id) => !deleted.includes(id)),
    ...(deleted.length ? { deletedProjectIds: deleted } : {}) };
}

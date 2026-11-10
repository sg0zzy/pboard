/**
 * Account-identity resolution for Drive.
 *
 * `about?fields=user(emailAddress,displayName)` is how Pboard proves which
 * Google account it is working for (see docs/collaboration.md). Before this
 * module, every consumer that needed the account called the endpoint again:
 * the erasure sweep asked twice per pass, the preference round once, the
 * changes feed once per board synchronisation and once more when it persisted
 * its cursor, and the permission service once per role/ACL check. One measured
 * startup issued 17 of them for three boards — `DriveAbout.Get` was the second
 * most frequent Drive call Pboard makes at startup.
 *
 * The email belongs to the access token, so the cache is keyed by token: a
 * token refresh costs one lookup, and switching Google accounts costs one
 * lookup. Concurrent callers share the single in-flight lookup, so a failed
 * lookup fails everyone at once instead of being retried once per caller. A
 * failure is never cached.
 */
export type DriveIdentity = { email: string; name?: string };

export type DriveIdentityCache = {
  /** Resolve the account behind `token`, reusing a fresh lookup when possible. */
  resolve(token: string, lookup: (token: string) => Promise<DriveIdentity | null>): Promise<DriveIdentity | null>;
  /** Drop cached identities (disconnect, revoked authorization). */
  invalidate(): void;
  /** Counters for diagnostics: how many lookups the cache actually cost. */
  snapshot(): { lookups: number; hits: number; inFlightJoins: number };
};

const IDENTITY_TTL_MS = 60_000;

export function createDriveIdentityCache(options: { ttlMs?: number; now?: () => number } = {}): DriveIdentityCache {
  const ttlMs = options.ttlMs ?? IDENTITY_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { identity: DriveIdentity; at: number }>();
  const pending = new Map<string, Promise<DriveIdentity | null>>();
  let lookups = 0, hits = 0, inFlightJoins = 0;

  return {
    async resolve(token, lookup) {
      const cached = entries.get(token);
      if (cached && now() - cached.at < ttlMs) { hits += 1; return cached.identity; }
      const running = pending.get(token);
      if (running) { inFlightJoins += 1; return await running; }
      const operation = (async (): Promise<DriveIdentity | null> => {
        lookups += 1;
        const identity = await lookup(token);
        // A null (no account) is not a fact worth repeating for a minute.
        if (identity) entries.set(token, { identity, at: now() });
        return identity;
      })().finally(() => { if (pending.get(token) === operation) pending.delete(token); });
      pending.set(token, operation);
      return await operation;
    },
    invalidate() { entries.clear(); },
    snapshot: () => ({ lookups, hits, inFlightJoins })
  };
}

/** One cache per JS context, matching the single quota ledger per context. */
let shared: DriveIdentityCache | undefined;
export function defaultDriveIdentityCache(): DriveIdentityCache {
  if (!shared) shared = createDriveIdentityCache();
  return shared;
}

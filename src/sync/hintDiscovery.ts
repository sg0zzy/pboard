/** Share a recent Drive discovery among a burst of board hints for one account.
 * Explicit refreshes use the underlying discovery directly and stay fresh. */
export function createHintDiscovery<T>(options: {
  account: () => Promise<string | null>;
  discover: () => Promise<T>;
  now?: () => number;
  reuseMs?: number;
}): () => Promise<T> {
  let cached: { account: string; until: number; result: Promise<T> } | undefined;
  const now = options.now ?? Date.now;
  return async () => {
    const account = await options.account();
    if (!account) throw new Error('Google Drive account is not connected');
    if (cached?.account === account && cached.until > now()) return await cached.result;
    const entry: { account: string; until: number; result: Promise<T> } = {
      account, until: Number.POSITIVE_INFINITY, result: Promise.resolve(undefined as T) as Promise<T>
    };
    entry.result = options.discover().then(value => {
      if (cached === entry) entry.until = now() + (options.reuseMs ?? 5_000);
      return value;
    }, error => {
      if (cached === entry) cached = undefined;
      throw error;
    });
    cached = entry;
    return await entry.result;
  };
}

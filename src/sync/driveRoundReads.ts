/** Reuse successful Drive media reads only while a reconciliation is active. */
export function createDriveRoundReads(fetcher: typeof fetch) {
  let active: { users: number; reads: Map<string, Promise<Response>> } | undefined;

  const fetchRound: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const url = new URL(request?.url ?? String(input), 'https://invalid.local');
    const drive = url.protocol === 'https:' && url.hostname === 'www.googleapis.com';
    if (active && drive && method !== 'GET' && method !== 'HEAD') {
      const file = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (file && (method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
        for (const key of active.reads.keys()) {
          const [readUrl] = JSON.parse(key) as [string, unknown];
          if (new URL(readUrl).pathname === `/drive/v3/files/${file[1]}`) active.reads.delete(key);
        }
      } else if (!(method === 'POST' && ['/upload/drive/v3/files', '/drive/v3/files', '/drive/v3/files/generateIds'].includes(url.pathname))) {
        // Unknown Drive mutations may affect an existing file without naming
        // its ID in the path. Do not reuse any earlier read in that case.
        active.reads.clear();
      }
    }
    const headers = new Headers(request?.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const media = drive && method === 'GET' && /^\/drive\/v3\/files\/[^/]+$/.test(url.pathname)
      && url.searchParams.get('alt') === 'media';
    // Abort and range semantics belong to the caller, and never share a read
    // that lacks the Google account's bearer credential.
    if (!active || !media || init?.signal || request || headers.has('range') || !headers.has('authorization')) {
      return await fetcher(input, init);
    }
    const scope = active;
    const key = JSON.stringify([url.href, [...headers.entries()].sort(([a], [b]) => a.localeCompare(b))]);
    let read = scope.reads.get(key);
    if (!read) {
      read = fetcher(input, init).then(response => {
        if (!response.ok && scope.reads.get(key) === read) scope.reads.delete(key);
        return response;
      }, error => {
        if (scope.reads.get(key) === read) scope.reads.delete(key);
        throw error;
      });
      scope.reads.set(key, read);
    }
    return (await read).clone();
  };

  async function run<T>(work: () => Promise<T>): Promise<T> {
    const scope = active ?? { users: 0, reads: new Map<string, Promise<Response>>() };
    active = scope; scope.users++;
    try { return await work(); }
    finally {
      if (--scope.users === 0) {
        scope.reads.clear();
        if (active === scope) active = undefined;
      }
    }
  }
  return { fetch: fetchRound, run, invalidate: () => { active?.reads.clear(); } };
}

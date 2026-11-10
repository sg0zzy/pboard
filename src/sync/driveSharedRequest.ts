/**
 * In-flight request sharing for the Drive funnels.
 *
 * Startup reaches the same Drive URL from several independent callers in the
 * same JS context — the erasure sweep, the account-preference round, the
 * legacy migration pass and the board inventory can each list the same AppData
 * prefix within one tick. Every one of them used to open its own HTTPS request
 * and book its own quota units.
 *
 * Only requests that are already in flight are shared, and only idempotent
 * GETs. Nothing is cached across time: presence polling and change detection
 * still see a fresh answer on the next tick, which is the behaviour the
 * `cache: "no-store"` funnels were built to guarantee.
 *
 * A caller that joins mid-flight receives its own `Response` over the same
 * bytes (the body is buffered once, as an `ArrayBuffer`, so binary downloads
 * survive), and a rejection is delivered to every waiter.
 */
type SharedEntry = { response: Response; replay: () => Response };

const inFlight = new Map<string, Promise<SharedEntry>>();

/** Statuses that must not carry a response body. */
const bodyless = (status: number) => status === 204 || status === 205 || status === 304;

/** A response can be handed to a second caller only if its bytes can be read
 * again. Every `fetch` response can; a test double that answers from a closure
 * may hand back a one-shot object instead, and that one is passed through. */
const replayable = (response: Response) => typeof (response as Response | undefined)?.arrayBuffer === "function";

/** Drop the entry once settled, so a later caller always issues a fresh request;
 * keep a swallowed rejection so a joining waiter cannot leave an unhandled
 * rejection behind. */
function release(key: string, operation: Promise<SharedEntry>) {
  if (inFlight.get(key) === operation) { inFlight.delete(key); operation.catch(() => undefined); }
}

/**
 * Run `send` once per `key` at a time. Concurrent callers with the same key
 * share the single network request; the entry is dropped as soon as it settles,
 * so a later caller always asks Google again.
 */
export async function sharedGetResponse(key: string, send: () => Promise<Response>): Promise<Response> {
  const running = inFlight.get(key);
  if (running) return (await running).replay();
  const operation = (async (): Promise<SharedEntry> => {
    const response = await send();
    if (!replayable(response)) return { response, replay: () => response };
    // Buffer once, as bytes, so binary downloads survive being replayed.
    const body = bodyless(response.status) ? null : await response.arrayBuffer();
    const status = response.status, statusText = response.statusText, headers = new Headers(response.headers);
    return {
      response,
      replay: () => new Response(body === null ? null : body.slice(0), { status, statusText, headers })
    };
  })();
  inFlight.set(key, operation);
  try {
    return (await operation).replay();
  } finally {
    release(key, operation);
  }
}

/** True when a repeated request cannot change state. */
export function isSharedGetRequest(method?: string): boolean {
  return method === undefined || method === "GET" || method === "HEAD";
}

/**
 * Requests sharing for one funnel: shares a GET only while it is in flight.
 * A waiter that joined a request still books its own quota entry, so the local
 * ledger never under-states what this context tried to send.
 */
export async function shareGet(method: string | undefined, key: string, send: () => Promise<Response>): Promise<Response> {
  return isSharedGetRequest(method) ? await sharedGetResponse(key, send) : await send();
}

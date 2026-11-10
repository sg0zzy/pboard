/**
 * Stable identifiers for one diagnostic producer.
 *
 * Three identities, deliberately distinct (conflating them is what makes
 * "who owns this socket?" unanswerable):
 *  - clientId:  one browser profile / extension installation / harness process,
 *               persisted so it survives reloads and restarts.
 *  - sessionId: one boot of that client (a fresh value per process/context
 *               lifetime), so repeated background initialisations are visible.
 *  - connectionId: one WebSocket, minted at dial time by the transport.
 *
 * Never derived from user identity and never containing credentials.
 */

export type DebugIdStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<void>;
};

export const CLIENT_ID_KEY = "pboardDebugClientId";

/** Node/base32-ish random id with a readable prefix. `crypto` is available in
 * extension contexts and Node 24; the fallback keeps tests dependency-free. */
export function newDebugId(prefix: string): string {
  const bytes = new Uint8Array(10);
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${prefix}-${hex}`;
}

/**
 * The persistent client id for this storage scope (one extension profile =
 * one id). `explicit` (from `PBOARD_DEBUG_CLIENT_ID`) wins so two Firefox
 * profiles launched by the harness can be named `firefox-a` / `firefox-b`
 * without touching user data.
 */
export async function resolveClientId(explicit: string | undefined, storage: DebugIdStorage | undefined): Promise<string> {
  const supplied = sanitiseId(explicit);
  if (supplied) return supplied;
  const environment = sanitiseId(readEnv("PBOARD_DEBUG_CLIENT_ID"));
  if (environment) return environment;
  if (storage) {
    try {
      const stored = await storage.get(CLIENT_ID_KEY);
      if (typeof stored === "string" && stored.length > 0 && stored.length <= 128) return stored;
      const created = newDebugId("client");
      await storage.set(CLIENT_ID_KEY, created);
      return created;
    } catch {
      // Storage unavailable (no permission yet, private mode): a per-context
      // id is still better than no events.
    }
  }
  return newDebugId("client");
}

/** The per-boot session id; overridable so a harness can pin it. */
export function resolveSessionId(explicit?: string): string {
  return sanitiseId(explicit) ?? sanitiseId(readEnv("PBOARD_DEBUG_SESSION_ID")) ?? newDebugId("session");
}

const ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Ids travel inside event identity fields, so they are constrained at the
 * boundary rather than trusted from an environment variable. */
function sanitiseId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  return ID_SAFE.test(trimmed) ? trimmed : undefined;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

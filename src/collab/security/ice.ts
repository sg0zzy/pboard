/**
 * Explicit ICE configuration. simple-peer 9.11.1 embeds Google and Twilio STUN
 * as static defaults, and Pboard previously relied on that accident: an ICE
 * endpoint change in a dependency bump would have been invisible here. This
 * module pins the same defaults explicitly and lets an operator prepend their
 * own STUN/TURN endpoints without ever removing the pinned fallback — losing
 * every reachable endpoint must not be a configurable failure mode.
 *
 * The setting `pboardIceServers` holds a JSON array (array or JSON string in
 * storage) of URL strings or RTCIceServer objects, e.g.
 *   ["stun:stun.example.org:3478", { "urls": ["turn:turn.example.org:3478"], "username": "u", "credential": "c" }]
 * Credentials are only accepted for turn:/turns: endpoints and stay local.
 */
import type { KeyValueStorage } from "../../storage/repository";

export const ICE_SERVERS_SETTINGS = "pboardIceServers";

/** Frozen so a mutated copy can never leak back into the defaults. */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = Object.freeze([
  Object.freeze({ urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] })
]);

const ICE_URL = /^(stun|turn|turns):[A-Za-z0-9._-]+(?::\d{1,5})?(?:[/?#][!-~]*)?$/;

const urlsOf = (entry: unknown): string[] | null => {
  if (typeof entry === "string") return [entry];
  const urls = (entry as RTCIceServer | null)?.urls;
  if (typeof urls === "string") return [urls];
  if (Array.isArray(urls) && urls.length <= 4 && urls.every(u => typeof u === "string")) return [...urls];
  return null;
};

/** Strict validation; anything questionable rejects to null (defaults remain). */
export function validateIceServers(value: unknown): RTCIceServer[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 8) return null;
  const result: RTCIceServer[] = [];
  for (const entry of value) {
    const urls = urlsOf(entry);
    if (!urls?.length || !urls.every(url => ICE_URL.test(url) && url.length <= 300)) return null;
    const { username, credential } = (typeof entry === "object" && entry ? entry : {}) as RTCIceServer;
    const wantsCredential = username !== undefined || credential !== undefined;
    if (wantsCredential && (typeof username !== "string" || typeof credential !== "string"
      || !username.length || username.length > 200 || credential.length > 300
      || !urls.every(url => url.startsWith("turn:") || url.startsWith("turns:")))) return null;
    result.push(wantsCredential ? { urls, username, credential } : { urls });
  }
  return result;
}

/** Configured endpoints lead; pinned defaults follow for whatever URL is not
 * already configured, so a self-hosted STUN adds redundancy instead of being
 * a single point of failure. */
export function iceServersWithDefaults(configured: RTCIceServer[] | null): RTCIceServer[] {
  const extra = (configured ?? []).map(server => ({ ...server, urls: [...(typeof server.urls === "string" ? [server.urls] : server.urls)] }));
  const configuredUrls = new Set(extra.flatMap(server => server.urls));
  const fallbacks = DEFAULT_ICE_SERVERS
    .map(server => ({ urls: server.urls as string[] }).urls.filter(url => !configuredUrls.has(url)))
    .filter(urls => urls.length).map(urls => ({ urls }));
  return [...extra, ...fallbacks];
}

/** One storage read per caller; invalid or absent configuration degrades to
 * the pinned defaults rather than to an ICE-less connection. */
export async function loadIceServers(storage: KeyValueStorage): Promise<RTCIceServer[]> {
  try {
    const stored = (await storage.get(ICE_SERVERS_SETTINGS))[ICE_SERVERS_SETTINGS];
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    return iceServersWithDefaults(validateIceServers(parsed));
  } catch { return iceServersWithDefaults(null); }
}

/** Stable order for diagnostics; index 1=host, 2=srflx, 3=relay. Never the
 * address itself — only the type is ever logged. */
export const CANDIDATE_TYPES = ["host", "srflx", "relay"] as const;

/** Encodes the selected ICE pair as (localType * 10 + remoteType), e.g. 22 is
 * srflx<->srflx, 3x/13 means relay is involved. 0 when no pair is understood.
 * Accepts a raw `getStats()` report because browsers disagree on both the
 * selection marker (selected/isSelected/nominated) and key casing. */
export function selectedPairCode(report: Map<string, Record<string, unknown>>): number {
  const stats = [...report.values()];
  const pick = (value: unknown) => typeof value === "string" ? value : "";
  const typeCode = (id: string) => {
    const candidate = stats.find(entry => pick(entry.id) === id);
    const type = CANDIDATE_TYPES.indexOf(String(candidate?.candidateType ?? candidate?.["candidatetype"] ?? "") as typeof CANDIDATE_TYPES[number]);
    return type + 1;
  };
  const succeeded = stats.filter(entry => pick(entry.type) === "candidate-pair" && (entry.selected === true || entry.isSelected === true || entry.state === "succeeded"));
  const transports = stats.filter(entry => pick(entry.type) === "transport");
  const selectedId = transports.map(transport => pick(transport.selectedCandidateId) || pick(transport.selectedcandidateid)).find(Boolean)
    ?? succeeded.map(pair => pick(pair.id)).find(Boolean) ?? "";
  const pair = stats.find(entry => pick(entry.type) === "candidate-pair" && (pick(entry.id) === selectedId
    || transports.some(transport => pick(transport.id) === pick(entry.transportId)) && succeeded.includes(entry)));
  if (!pair) return 0;
  const local = typeCode(pick(pair.localCandidateId) || pick(pair.localcandidateid));
  const remote = typeCode(pick(pair.remoteCandidateId) || pick(pair.remotecandidateid));
  return local && remote ? local * 10 + remote : 0;
}

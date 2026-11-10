/**
 * Signaling seam for pboard collaboration.
 *
 * WebRTC needs two things before a data channel can carry replicated documents:
 * (1) a rendezvous — "who else is in this project's room right now" — and
 * (2) a relay for the opaque simple-peer handshake payloads (offer / answer /
 * ICE candidates), which are strictly 1:1 between two peers.
 *
 * `PboardSignaling` captures exactly those two needs and nothing more, so the
 * transport is swappable without touching the replication logic:
 *   - `createMemorySignalingScope`  — in-process, for tests and same-tab dev.
 *   - `createDriveSignaling`        — Drive-hosted ephemeral records, the
 *                                     shipped transport for the peer pools.
 *
 * The RxDB signaling-server wire protocol (`init` / `join` / `joined` /
 * `signal` / `ping`) used to have a factory here too. Nothing ever constructed
 * it — the relay posture carries the durable operation log over its own socket
 * (`operations/logSync.ts`), and the peer path uses Drive — so it was deleted
 * rather than kept as a third, untested signaling vocabulary.
 */
import { collaborationCounters } from "./counters";
import { DRIVE_PRESENCE_TTL_MS as PRESENCE_TTL_MS } from "./drivePresence";
import { manifestHash, type BoardPermissionManifest } from "./security/manifest";
import {
  buildSignedSignal, verifySignedSignal,
  createReplayCache, MAX_PENDING_SIGNALS_PER_SESSION,
  type EnvelopeContext, type ReplayCache, type SigningInput,
  type SignedSignal
} from "./security/session";

/** Opaque simple-peer signal: `{ type: "offer" | "answer", sdp }` or `{ type: "iceCandidate", candidate, ... }`. */
export type PboardSignal = unknown;

/** A signed presence envelope plus the verified manifest the sender declared. */
export type SignedPresenceEnvelope = {
  manifest: BoardPermissionManifest;
  presence: unknown;
};

export interface PboardSignaling {
  /**
   * Join the project's signaling room. Resolves with our assigned peer id and the
   * current roster of other peers. `onRoster` is called with the full set of other
   * peer ids whenever the room changes (a peer joins or leaves), so late joiners
   * and departures are both observed.
   */
  join(onRoster: (peerIds: string[]) => void): Promise<{ peerId: string; peers: string[] }>;
  /** Relay one of our simple-peer signals to a specific peer. */
  sendSignal(toPeerId: string, signal: PboardSignal): Promise<void>;
  /** Install the handler for signals relayed to us. Called with the sender's peer id. */
  onSignal(handler: (fromPeerId: string, signal: PboardSignal) => void): void;
  /**
   * Publish a signed presence record for this peer. Secure transports persist it
   * in the peer's own record; insecure providers (memory/tests) ignore it.
   */
  publishPresence?(presence: SignedPresenceEnvelope): Promise<void>;
  /** Signed remote identity; receiver verifies against its own pinned manifest. */
  onPresence?(handler: (peerId: string, envelope: SignedPresenceEnvelope) => void): void;
  /** Report transport failures after join, such as a failed presence poll. */
  onError?(handler: (error: unknown) => void): void;
  /** Leave the room and release transport resources. */
  leave(): Promise<void>;
}

type MemoryEntry = { onRoster: ((peerIds: string[]) => void) | null; onSignal: ((from: string, signal: PboardSignal) => void) | null };

/**
 * In-process signaling scope. All providers created from the same scope rendezvous
 * and relay signals with no network. Used by unit tests and by two tabs in the
 * same browser tab (same process). Not shared across browser tabs.
 */
export function createMemorySignalingScope() {
  const rooms = new Map<string, Map<string, MemoryEntry>>();
  function room(topic: string) {
    let r = rooms.get(topic);
    if (!r) {
      r = new Map();
      rooms.set(topic, r);
    }
    return r;
  }
  return {
    create(topic: string): PboardSignaling {
      let entry: MemoryEntry;
      const peerId = `mem-${Math.random().toString(36).slice(2, 12)}`;
      entry = { onRoster: null, onSignal: null };
      room(topic).set(peerId, entry);
      const rosterFor = (id: string) => Array.from(room(topic).keys()).filter((k) => k !== id);
      const announce = () => room(topic).forEach((e, id) => e.onRoster?.(rosterFor(id)));
      return {
        join: (onRoster) => {
          entry.onRoster = onRoster;
          announce();
          return Promise.resolve({ peerId, peers: rosterFor(peerId) });
        },
        sendSignal: async (to, signal) => {
          room(topic).get(to)?.onSignal?.(peerId, signal);
        },
        onSignal: (handler) => {
          entry.onSignal = handler;
        },
        leave: async () => {
          if (room(topic).get(peerId) === entry) {
            room(topic).delete(peerId);
            announce();
          }
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Drive-hosted signaling (Phase 2).
//
// Ephemeral per-peer records live in the shared project's `realtime/` folder.
// Each peer owns exactly one file, `sig-<topic>-<peerId>.json`, and never
// writes anyone else's — so concurrent peers can never race on the same file.
// A poll (a) refreshes this peer's own presence + outbox, (b) reads every other
// peer's file, and (c) relays each not-yet-delivered signal through `onSignal`.
//
// Delivery is at-least-once: a signal is delivered whenever it is still present
// in the sender's outbox and has not yet been handed to `onSignal`. The
// connection handler (`webrtcHandler.ts`) buffers signals that arrive before a
// data channel exists and deduplicates by simple-peer handshake, so re-delivery
// is harmless. The outbox is bounded by dropping signals older than `signalTtlMs`
// (a handshake completes in seconds), so a file does not grow unbounded.
//
// This transport is intentionally latency-tolerant (poll interval × Drive API
// latency ≈ seconds). A low-latency WebSocket fallback is documented, not
// implemented, for the first usable version.
// ---------------------------------------------------------------------------

/** One outbox signal: an opaque simple-peer signal plus a stable id for dedupe. */
export type PboardDriveSignal = {
  id: string;
  toPeerId: string;
  payload: PboardSignal;
  sentAt?: number;
  /** Protocol-2 signed envelope; receiver verifies before using `payload`. */
  security?: { manifest: BoardPermissionManifest; signedSignal: SignedSignal };
};

/** The JSON body of a single peer's realtime record. */
export type PboardDriveSignalRecord = {
  /** Epoch ms of the last write; used for presence/TTL. */
  updatedAt: number;
  /** The peer ids this peer believes are in the room (presence roster). */
  peers: string[];
  /** Signals this peer has sent and not yet pruned. */
  outbox: PboardDriveSignal[];
  /** Protocol-2 signed presence of this peer; verifiable by every reader. */
  security?: { manifest: BoardPermissionManifest; presence: unknown };
};

/**
 * The realtime-folder backing store for Drive signaling. One instance per
 * shared project; each peer gets its own record keyed by peer id. `now` is
 * injectable so tests can advance the clock deterministically.
 */
export interface PboardDriveSignalStore {
  /** A unique browser-session id; two sessions of the same account are separate peers. */
  readonly peerId: string;
  now(): number;
  /** Read a peer's record; null when the file does not exist (fresh peer). */
  readPeer(peerId: string): Promise<PboardDriveSignalRecord | null>;
  /** Create or overwrite this peer's own record. */
  writeOwn(record: PboardDriveSignalRecord): Promise<void>;
  /**
   * This session's own record as last written, without a Drive round trip.
   * Optional: a store without a cheap answer omits it and the poll reads Drive.
   */
  ownRecord?(): PboardDriveSignalRecord | null;
  /** All peer records in the room (any age); the caller applies the TTL. */
  listPeers(): Promise<Record<string, PboardDriveSignalRecord>>;
  /** Remove this peer's own record (idempotent). */
  deleteOwn(): Promise<void>;
}

export type PboardDriveSignalingOptions = {
  store: PboardDriveSignalStore;
  /** Poll cadence; drives both presence and signal delivery latency. Default 2000ms. */
  pollMs?: number;
  /**
   * Poll cadence once the room has had no live peer, no delivered signal and
   * no outbound signal for `idleSlowMs`. An empty room polled at the full rate
   * costs a steady stream of Drive round trips forever; backing off to this
   * interval keeps the presence heartbeat well inside `presenceTtlMs` so a
   * joining peer is still discovered, at the cost of at most one slow poll of
   * connect latency in each direction. Default 15000ms, never below `pollMs`
   * and never at or above a quarter of the presence TTL.
   */
  maxPollMs?: number;
  /** How long a room stays at the fast cadence after its last activity. Default `presenceTtlMs`. */
  idleSlowMs?: number;
  /** A peer file not rewritten within this window is considered gone. Default 60000ms. */
  presenceTtlMs?: number;
  /** A signal older than this is dropped from the outbox. Default 240000ms. */
  signalTtlMs?: number;
  /**
   * Protocol-2 security inputs. When absent the provider runs in legacy mode and
   * delivers raw payloads (tests, same-tab dev); secure runtimes always supply it.
   */
  security?: {
    /** The sender signing identity used for our envelopes. */
    signer: SigningInput;
    /** Board/collection/manifest/session identity for binding envelopes. */
    context: EnvelopeContext & { ownSessionId: string };
    /** Verified inbound envelopes are handed upstream with their inner payload. */
    onVerifiedSignal?: (fromPeerId: string, signed: SignedSignal) => void;
    onInvalidEnvelope?: (fromPeerId: string, reason: string) => void;
  };
};

/**
 * How long a presence record claims its session is alive. The poll loop renews
 * it at a quarter of this interval and the Drive presence store needs the same
 * number to tell a quiet peer from a session that is gone, so it is exported
 * rather than being a literal on both sides. The value lives in
 * `drivePresence.ts` because the runtime's diagnostics read it while the peer
 * transport is not loaded at all.
 */
export const DRIVE_PRESENCE_TTL_MS = PRESENCE_TTL_MS;

/**
 * Drive-backed `PboardSignaling`. One `PboardDriveSignalStore` per shared
 * project; this function owns the poll loop, presence TTL, outbox TTL, and
 * at-least-once signal dedupe. The returned object also exposes `tick()` so
 * tests (and the wiring layer) can force one poll without waiting for the timer.
 */
export type PboardDriveSignaling = PboardSignaling & {
  /** Force one poll cycle now; also used by the periodic timer. */
  tick(): Promise<void>;
};

export function createDriveSignaling(options: PboardDriveSignalingOptions): PboardDriveSignaling {
  const { store } = options;
  const pollMs = options.pollMs ?? 2000;
  const presenceTtlMs = options.presenceTtlMs ?? DRIVE_PRESENCE_TTL_MS;
  const signalTtlMs = options.signalTtlMs ?? 240_000;
  // The slow cadence must still rewrite our presence often enough for peers
  // to see it: keep it strictly inside a quarter of the presence TTL.
  const maxPollMs = Math.max(pollMs, options.maxPollMs ?? 15_000, presenceTtlMs / 4);
  const idleSlowMs = options.idleSlowMs ?? presenceTtlMs;
  /**
   * A presence record is only a claim of liveness for `presenceTtlMs`, so
   * rewriting it on every poll bought nothing and cost a Drive write per poll
   * (a list to find the file, an upload to change it). Heartbeat at a quarter of
   * the TTL — three times the safety margin a peer needs to keep seeing us — and
   * write immediately whenever the record's *content* changes instead.
   */
  const heartbeatMs = pollMs >= presenceTtlMs ? 0 : Math.max(pollMs, Math.floor(presenceTtlMs / 4));
  /** When the own record was last written, and what it held apart from `updatedAt`. */
  let ownWrittenAt = -Infinity;
  let ownFingerprint = "";
  const fingerprint = (record: PboardDriveSignalRecord) => {
    const { updatedAt: _ignoredUpdatedAt, ...body } = record;
    return JSON.stringify(body);
  };
  /** When the room last saw a live peer, delivered a signal, or sent one. */
  let lastActivityAt = store.now();
  const me = store.peerId;
  const security = options.security ?? null;
  const replay: ReplayCache = security ? createReplayCache() : { accepted: new Map() };
  let presenceEnvelope: SignedPresenceEnvelope | null = null;
  let onPresence: ((peerId: string, envelope: SignedPresenceEnvelope) => void) | null = null;
  let outboxSequence = 0;

  let onRoster: ((peerIds: string[]) => void) | null = null;
  let onSignal: ((from: string, signal: PboardSignal) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRoster = "";
  let started = false;
  let polling = false;
  let onError: ((error: unknown) => void) | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  function writeExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = writes.then(task);
    writes = run.catch(() => undefined);
    return run;
  }

  function schedulePoll() {
    if (!started || timer !== null) return;
    // An empty room is polled at the slow cadence: two idle browsers still
    // find each other (each presence stays fresh within its TTL), only the
    // connect latency grows to at most one slow poll per side.
    const idle = store.now() - lastActivityAt >= idleSlowMs;
    timer = setTimeout(() => {
      timer = null;
      collaborationCounters.countEvent("driveSignaling.tick");
      void tick().catch((error) => {
        if (onError) onError(error);
        else console.error("Pboard live collaboration signaling failed", error);
      });
    }, idle ? maxPollMs : pollMs);
  }
  // Outbound signals already handed to onSignal, keyed by sender peer id.
  const delivered = new Map<string, Set<string>>();

  async function readOwn(): Promise<PboardDriveSignalRecord> {
    // A store that wrote the record knows it already; asking Drive for our own
    // presence on every poll cost a name lookup and a download per tick.
    const record = store.ownRecord?.() ?? await store.readPeer(me);
    return record ?? { updatedAt: store.now(), peers: [], outbox: [] };
  }

  /** Write the own record and record when/what, so the poll never rewrites it. */
  async function writeOwnRecord(record: PboardDriveSignalRecord): Promise<void> {
    ownFingerprint = fingerprint(record);
    ownWrittenAt = record.updatedAt;
    await store.writeOwn(record);
  }

  /** Recompute the live roster from peer presence and emit it on change. */
  async function refreshRoster(now: number, all: Record<string, PboardDriveSignalRecord>): Promise<string[]> {
    const live = Object.keys(all).filter((id) => id !== me && now - (all[id]?.updatedAt ?? 0) < presenceTtlMs).sort();
    const key = live.join("\n");
    if (key !== lastRoster) {
      lastRoster = key;
      onRoster?.(live);
    }
    return live;
  }

  async function tick(): Promise<void> {
    if (polling || !started) return;
    polling = true;
    try {
      const now = store.now();
      // (a) Refresh our own presence (heartbeat) and drop expired outbox signals.
      await writeExclusive(async () => {
        const own = await readOwn();
        const pruned = own.outbox.filter((s) => now - (s.sentAt ?? own.updatedAt) < signalTtlMs);
        const record: PboardDriveSignalRecord = {
          updatedAt: now, peers: own.peers, outbox: pruned,
          ...(presenceEnvelope ? { security: presenceEnvelope } : {})
        };
        // Nothing changed and the claim of liveness is still young: the record
        // on Drive already says exactly this.
        if (fingerprint(record) === ownFingerprint && now - ownWrittenAt < heartbeatMs) return;
        await writeOwnRecord(record);
      });
      // (b) Read every peer, deliver new signals, then reconcile presence.
      const all = await store.listPeers();
      if (!started) return;
      for (const [peerId, record] of Object.entries(all)) {
        if (peerId === me || !record || now - record.updatedAt >= presenceTtlMs) continue;
        if (record.security?.presence) { onPresence?.(peerId, record.security); lastActivityAt = now; }
        const seen = delivered.get(peerId) ?? new Set<string>();
        // Bound per-remote-session pending work before verification (flood guard).
        const incoming = record.outbox.filter((s) => s.toPeerId === me && now - (s.sentAt ?? record.updatedAt) < signalTtlMs).slice(0, MAX_PENDING_SIGNALS_PER_SESSION);
        for (const signal of incoming) {
          if (seen.has(signal.id)) { lastActivityAt = now; continue; }
          seen.add(signal.id);
          lastActivityAt = now;
          if (security && signal.security) {
            try {
              const verifiedSignal: unknown = await verifySignedSignal(
                { payload: { ...signal.security.signedSignal.payload, signal: signal.payload }, signature: signal.security.signedSignal.signature },
                {
                  manifest: signal.security.manifest,
                  expected: {
                    boardId: security.context.boardId, collection: security.context.collection,
                    manifestHash: manifestHash(security.context.manifest), ownDeviceKeyId: security.signer.deviceKeyId,
                    ownSessionId: security.context.ownSessionId
                  },
                  now
                },
                replay
              );
              void verifiedSignal;
              security.onVerifiedSignal?.(peerId, signal.security.signedSignal);
            } catch (error) {
              security.onInvalidEnvelope?.(peerId, error instanceof Error ? error.message : String(error));
            }
          } else if (!security) {
            onSignal?.(peerId, signal.payload);
          }
          // Secure mode with a bare (unsigned) signal: dropped without delivery.
        }
        delivered.set(peerId, seen);
      }
      if ((await refreshRoster(now, all)).length) lastActivityAt = now;
    } finally {
      polling = false;
      schedulePoll();
    }
  }

  const signaling: PboardDriveSignaling = {
    tick,
    async join(rosterHandler) {
      onRoster = rosterHandler;
      started = true;
      lastActivityAt = store.now();
      try { await tick(); }
      catch (error) {
        // Keep the session identity usable while the scheduled poll retries.
        // Otherwise the connection handler never learns its own id and cannot
        // connect when Drive recovers and a later poll discovers peers.
        if (onError) onError(error); else throw error;
      }
      return { peerId: me, peers: lastRoster ? lastRoster.split("\n") : [] };
    },
    sendSignal(to, signal) { return writeExclusive(async () => {
      if (!started) return;
      const now = store.now();
      lastActivityAt = now;
      // A room idling on the slow cadence must not delay the presence and
      // outbox writes that carry this signal: re-arm the next poll at the
      // fast cadence immediately.
      if (timer !== null) { clearTimeout(timer); timer = null; schedulePoll(); }
      let securityEntry: { manifest: BoardPermissionManifest; signedSignal: SignedSignal } | undefined;
      if (security) {
        const signedEnvelope = await buildSignedSignal(
          security.signer, security.context,
          { deviceKeyId: to, sessionId: to }, signal, outboxSequence++
        );
        securityEntry = { manifest: security.context.manifest, signedSignal: signedEnvelope };
      }
      const own = await readOwn();
      own.outbox.push({ id: crypto.randomUUID(), toPeerId: to, payload: signal, sentAt: now, ...(securityEntry ? { security: securityEntry } : {}) });
      own.outbox = own.outbox.slice(-16); // bound the outbox
      own.peers = Array.from(new Set([...own.peers, to]));
      await writeOwnRecord({
        updatedAt: now, peers: own.peers, outbox: own.outbox,
        ...(presenceEnvelope ? { security: presenceEnvelope } : {})
      });
    }); },
    onPresence(handler) { onPresence = handler; },
    publishPresence(envelope) {
      presenceEnvelope = envelope;
      return Promise.resolve();
    },
    onSignal(handler) {
      onSignal = handler;
    },
    onError(handler) { onError = handler; },
    async leave() {
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onRoster = null;
      onSignal = null;
      onError = null;
      delivered.clear();
      lastRoster = "";
      await writeExclusive(() => store.deleteOwn()).catch(() => {});
    }
  };
  return signaling;
}

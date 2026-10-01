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
 *   - `createWebSocketSignaling`    — speaks the RxDB signaling-server wire
 *                                     protocol over a WebSocket. This is the
 *                                     "simplest temporary mechanism supported by
 *                                     RxDB/simple-peer"; it points at any endpoint
 *                                     running `startSignalingServerSimplePeer`.
 *   - `createDriveSignaling`        — Drive-hosted ephemeral records (Phase 2).
 */

/** Opaque simple-peer signal: `{ type: "offer" | "answer", sdp }` or `{ type: "iceCandidate", candidate, ... }`. */
export type PboardSignal = unknown;

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

type Resolvers<T> = { resolve(value: T): void; reject(reason?: unknown): void; promise: Promise<T> };
function createResolvers<T>(): Resolvers<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

/**
 * WebSocket signaling that speaks the RxDB signaling-server wire protocol
 * (`init` / `join` / `joined` / `signal` / `ping`). Point `url` at any endpoint
 * running `startSignalingServerSimplePeer`. This is the development and
 * fallback transport; pboard does not ship its own server.
 */

export function createWebSocketSignaling(topic: string, url: string, webSocket: typeof WebSocket = WebSocket): PboardSignaling {
  let socket: WebSocket | null = null;
  let ownPeerId: string | null = null;
  let onSignalHandler: ((from: string, signal: PboardSignal) => void) | null = null;
  let rosterHandler: ((peerIds: string[]) => void) | null = null;
  let closed = false;
  let pingTimer: number | undefined;

  const send = (message: Record<string, unknown>) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  function connect(): Promise<{ peerId: string; peers: string[] }> {
    const resolvers = createResolvers<{ peerId: string; peers: string[] }>();
    const ws = new webSocket(url);
    socket = ws;
    ws.onopen = () => {
      send({ type: "join", room: topic });
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      switch (message.type) {
        case "init":
          ownPeerId = String(message.yourPeerId);
          break;
        case "joined": {
          const peers: string[] = (Array.isArray(message.otherPeerIds) ? (message.otherPeerIds as string[]) : []).filter((id) => id !== ownPeerId);
          resolvers.resolve({ peerId: ownPeerId as string, peers });
          rosterHandler?.(peers);
          break;
        }
        case "signal":
          if (message.senderPeerId && message.senderPeerId !== ownPeerId) onSignalHandler?.(String(message.senderPeerId), message.data);
          break;
        default:
          break;
      }
    };
    ws.onerror = () => {
      resolvers.reject(new Error("pboard signaling WebSocket failed to connect"));
    };
    ws.onclose = () => {
      if (closed) return;
      resolvers.reject(new Error("pboard signaling WebSocket closed"));
      // Recreate the socket so an offline/online transition re-joins the room.
      if (!closed) connect().catch(() => {});
    };
    return resolvers.promise;
  }

  return {
    join: (onRoster) => {
      rosterHandler = onRoster;
      return connect().finally(() => {
        if (pingTimer) return;
        pingTimer = window.setInterval(() => {
          if (!closed) send({ type: "ping" });
        }, 2 * 60 * 1000);
      });
    },
    sendSignal: async (to, signal) => {
      if (ownPeerId) send({ type: "signal", senderPeerId: ownPeerId, receiverPeerId: to, room: topic, data: signal });
    },
    onSignal: (handler) => {
      onSignalHandler = handler;
    },
    leave: async () => {
      closed = true;
      window.clearInterval(pingTimer);
      socket?.close();
      socket = null;
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
export type PboardDriveSignal = { id: string; payload: PboardSignal; sentAt?: number };

/** The JSON body of a single peer's realtime record. */
export type PboardDriveSignalRecord = {
  /** Epoch ms of the last write; used for presence/TTL. */
  updatedAt: number;
  /** The peer ids this peer believes are in the room (presence roster). */
  peers: string[];
  /** Signals this peer has sent and not yet pruned. */
  outbox: PboardDriveSignal[];
};

/**
 * The realtime-folder backing store for Drive signaling. One instance per
 * shared project; each peer gets its own record keyed by peer id. `now` is
 * injectable so tests can advance the clock deterministically.
 */
export interface PboardDriveSignalStore {
  /** The authenticated peer id (stable across sessions, unique per account). */
  readonly peerId: string;
  now(): number;
  /** Read a peer's record; null when the file does not exist (fresh peer). */
  readPeer(peerId: string): Promise<PboardDriveSignalRecord | null>;
  /** Create or overwrite this peer's own record. */
  writeOwn(record: PboardDriveSignalRecord): Promise<void>;
  /** All peer records in the room (any age); the caller applies the TTL. */
  listPeers(): Promise<Record<string, PboardDriveSignalRecord>>;
  /** Remove this peer's own record (idempotent). */
  deleteOwn(): Promise<void>;
}

export type PboardDriveSignalingOptions = {
  store: PboardDriveSignalStore;
  /** Poll cadence; drives both presence and signal delivery latency. Default 2000ms. */
  pollMs?: number;
  /** A peer file not rewritten within this window is considered gone. Default 60000ms. */
  presenceTtlMs?: number;
  /** A signal older than this is dropped from the outbox. Default 240000ms. */
  signalTtlMs?: number;
};

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
  const presenceTtlMs = options.presenceTtlMs ?? 60_000;
  const signalTtlMs = options.signalTtlMs ?? 240_000;
  const me = store.peerId;

  let onRoster: ((peerIds: string[]) => void) | null = null;
  let onSignal: ((from: string, signal: PboardSignal) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRoster = "";
  let started = false;
  let polling = false;
  // Outbound signals already handed to onSignal, keyed by sender peer id.
  const delivered = new Map<string, Set<string>>();

  async function readOwn(): Promise<PboardDriveSignalRecord> {
    const record = await store.readPeer(me);
    return record ?? { updatedAt: store.now(), peers: [], outbox: [] };
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
    if (polling) return;
    polling = true;
    try {
      const now = store.now();
      // (a) Refresh our own presence (heartbeat) and drop expired outbox signals.
      const own = await readOwn();
      const pruned = own.outbox.filter((s) => now - (s.sentAt ?? own.updatedAt) < signalTtlMs);
      await store.writeOwn({ updatedAt: now, peers: own.peers, outbox: pruned });
      // (b) Read every peer, deliver new signals, then reconcile presence.
      const all = await store.listPeers();
      for (const [peerId, record] of Object.entries(all)) {
        if (peerId === me || !record) continue;
        const seen = delivered.get(peerId) ?? new Set<string>();
        for (const signal of record.outbox) {
          if (seen.has(signal.id)) continue;
          seen.add(signal.id);
          onSignal?.(peerId, signal.payload);
        }
        delivered.set(peerId, seen);
      }
      await refreshRoster(now, all);
    } finally {
      polling = false;
      if (started && timer === null) timer = setTimeout(() => { void tick(); }, pollMs);
    }
  }

  const signaling: PboardDriveSignaling = {
    tick,
    async join(rosterHandler) {
      onRoster = rosterHandler;
      started = true;
      await tick();
      return { peerId: me, peers: lastRoster ? lastRoster.split("\n") : [] };
    },
    async sendSignal(to, signal) {
      const now = store.now();
      const own = await readOwn();
      own.outbox.push({ id: crypto.randomUUID(), payload: signal, sentAt: now });
      own.outbox = own.outbox.slice(-16); // bound the outbox
      own.peers = Array.from(new Set([...own.peers, to]));
      await store.writeOwn({ updatedAt: now, peers: own.peers, outbox: own.outbox });
    },
    onSignal(handler) {
      onSignal = handler;
    },
    async leave() {
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onRoster = null;
      onSignal = null;
      delivered.clear();
      lastRoster = "";
      await store.deleteOwn().catch(() => {});
    }
  };
  return signaling;
}


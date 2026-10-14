// The package root requires Node globals and stream APIs. Use the bundled
// browser entry, as RxDB's own WebRTC handler does, in extension contexts.
import Peer from "simple-peer/simplepeer.min.js";
import { Subject } from "rxjs";
import { newRxError } from "rxdb";
import type { RxError, RxTypeError } from "rxdb";
import type {
  PeerWithMessage,
  PeerWithResponse,
  SimplePeerWrtc,
  WebRTCConnectionHandler,
  WebRTCConnectionHandlerCreator
} from "rxdb/plugins/replication-webrtc";
import type { PboardSignaling } from "./signaling";

/**
 * The simple-peer WebRTC seam. In the browser simple-peer uses the global
 * `RTCPeerConnection` / `RTCSessionDescription` / `RTCIceCandidate`; in Node (tests)
 * a polyfill is wrapped by `createSimplePeerWrtc` and injected here.
 */
export type PboardWrtc = SimplePeerWrtc;

/** A live simple-peer connection; `id` is the remote peer's signaling id. */
export type PboardPeer = InstanceType<typeof Peer> & { id: string };

export type PboardWebRTCConnectionOptions = {
  signaling: PboardSignaling;
  wrtc?: PboardWrtc;
  config?: RTCConfiguration;
  /** Non-trickle (default) so an offer/answer carries all candidates in one signal — bounded signaling traffic. */
  trickle?: boolean;
  /**
   * Drop received replication documents that do not belong to this room.
   *
   * The master's WebRTC handler is built over the whole collection, so its
   * change stream and `masterChangesSince` responses include every project's
   * documents. The pull path has no documented way to drop a document (a
   * `null` pull modifier crashes `persistFromMaster`), so the slave filters the
   * incoming `response$` here, before RxDB persists it. The push direction is
   * scoped separately by the replication push modifier.
   */
  scopeDocument?: (doc: unknown) => boolean;
  /** Await a read-only recovery step after the cooldown, before replacing a failed peer. */
  beforeReconnect?: () => Promise<void>;
};

type HandshakeState = {
  initiator: boolean;
  jsepState: string;
};

/** Signal type: `offer`/`answer`/`pranswer`/`rollback`, or `null` for an ICE candidate. */
function signalType(signal: unknown): string | null {
  if (signal && typeof signal === "object" && "type" in signal && typeof signal.type === "string") return signal.type;
  return null;
}

/**
 * Whether a signal may be applied to the connection for a remote peer.
 *
 * JSEP state check: an offer is only accepted by the peer that does not open it, and
 * an answer only answers the offer this instance itself sent. Without the check, a
 * stale answer replayed into a recreated instance makes the engine apply an answer
 * with no pending offer — the `InvalidStateError` the sidebar shows. The state has to
 * be advanced when a description is *applied* (`markApplied`), not only when this
 * instance emits one: an instance that only ever emits offers would otherwise stay in
 * `have-local-offer` forever and accept every answer that follows its first.
 */
function signalIsValid(state: HandshakeState, signal: unknown): boolean {
  const type = signalType(signal);
  if (!type) return true; // ICE candidate: simple-peer buffers it until a remote description exists
  if (type === "offer") return !state.initiator && ["new", "stable", "have-remote-pranswer"].includes(state.jsepState);
  if (type === "answer" || type === "pranswer") return state.jsepState === "have-local-offer";
  return true; // rollback
}

/** Advance the tracked JSEP state for a description this instance applies. */
function markApplied(state: HandshakeState, type: string | null): void {
  if (type === "offer") state.jsepState = "have-remote-offer";
  else if (type === "pranswer") state.jsepState = "have-remote-pranswer";
  else if (type === "answer" || type === "rollback") state.jsepState = "stable";
}

/**
 * Builds an RxDB `WebRTCConnectionHandler` creator for a single project+collection
 * room. The data channel is simple-peer; rendezvous and signal relay come from the
 * injected `PboardSignaling`, so the transport is swappable without touching the
 * replication logic.
 *
 * Deterministic initiator: the peer with the greater signaling id opens the offer,
 * so both peers always agree on who initiates. Signals are gated by the JSEP state of
 * the instance that would handle them (`signalIsValid`): a stale answer from an
 * instance that already completed its handshake is dropped, not applied to a fresh
 * instance. Signals that arrive before a connection exists are buffered when they are
 * valid for the prospective instance and flushed on creation.
 */
// RxDB passes its sync options to the creator; this handler is fully configured by
// `options`, so the argument is optional for direct use. The zero-arg form still
// satisfies `WebRTCConnectionHandlerCreator<PboardPeer>`.
export function createPboardWebRTCConnectionHandler(options: PboardWebRTCConnectionOptions): () => Promise<WebRTCConnectionHandler<PboardPeer>> {
  const { signaling, wrtc, config, trickle = false, scopeDocument, beforeReconnect } = options;
  // The master streams its whole collection; a received response may carry docs
  // from projects outside this room. Drop them here so they never reach RxDB's
  // pull persist (a `null` pull modifier would instead crash it).
  // result is `any` (WebRTCResponse.result). Only `masterChangesSince` / live
  // stream responses carry a `documents` array; leave anything else untouched.
  function scopeResult(result: unknown): unknown {
    if (!scopeDocument) return result;
    if (!result || typeof result !== "object" || !("documents" in result)) return result;
    const documents = result.documents;
    if (!Array.isArray(documents)) return result;
    return { ...result, documents: documents.filter((doc) => scopeDocument(doc)) };
  }
  return async () => {
    const connect$ = new Subject<PboardPeer>();
    const disconnect$ = new Subject<PboardPeer>();
    const message$ = new Subject<PeerWithMessage<PboardPeer>>();
    const response$ = new Subject<PeerWithResponse<PboardPeer>>();
    const error$ = new Subject<RxError | RxTypeError>();
    const peers = new Map<string, PboardPeer>();
    const pendingSignals = new Map<string, unknown[]>();
    const handshake = new Map<string, HandshakeState>();
    const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let closed = false;
    let ownPeerId: string | null = null;

    function createPeerConnection(remotePeerId: string) {
      if (closed || !ownPeerId || remotePeerId === ownPeerId || peers.has(remotePeerId) || reconnectTimers.has(remotePeerId)) return;
      let disconnected = false;
      const peer = new Peer({ initiator: remotePeerId > ownPeerId, wrtc, config, trickle }) as PboardPeer;
      peer.id = remotePeerId;
      peers.set(remotePeerId, peer);
      const state: HandshakeState = { initiator: remotePeerId > ownPeerId, jsepState: "new" };
      handshake.set(remotePeerId, state);
      peer.on("signal", (signal) => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        const type = signalType(signal);
        if (type === "offer") state.jsepState = "have-local-offer";
        else if (type === "answer" || type === "pranswer") state.jsepState = "stable";
        void signaling.sendSignal(remotePeerId, signal).catch((error) => {
          if (!closed && peers.get(remotePeerId) === peer) {
            error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
          }
        });
      });
      peer.on("data", (payload) => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        const parsed = JSON.parse(payload.toString());
        if (parsed && typeof parsed === "object" && "result" in parsed) response$.next({ peer, response: { ...parsed, result: scopeResult(parsed.result) } });
        else message$.next({ peer, message: parsed });
      });
      peer.on("error", (error) => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        // SCTP reports this when the other endpoint closes its data channel.
        // Still recreate the connection, but do not present an orderly close
        // as a collaboration failure. Other OperationErrors remain visible.
        if (!/User-Initiated Abort.*reason=Close called/i.test(String(error))) {
          error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
        }
        peer.destroy();
        if (!disconnected) { disconnected = true; disconnect$.next(peer); }
      });
      peer.on("connect", () => {
        if (!closed && peers.get(remotePeerId) === peer) connect$.next(peer);
      });
      peer.on("close", () => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        if (!disconnected) { disconnected = true; disconnect$.next(peer); }
        if (peers.get(remotePeerId) === peer) peers.delete(remotePeerId);
        pendingSignals.delete(remotePeerId);
        handshake.delete(remotePeerId);
        // Keep roster updates from bypassing the cooldown, and buffer valid
        // incoming signals until the replacement peer is created.
        reconnectTimers.set(remotePeerId, setTimeout(() => {
          // Keep the timer entry until Drive finishes so roster updates cannot
          // bypass recovery. Shutdown invalidates this attempt without waiting
          // for an in-flight HTTP request.
          void (async () => {
            try { await beforeReconnect?.(); }
            catch (error) {
              if (!closed) error$.next(newRxError("RC_WEBRTC_PEER", {
                errorText: `Drive refresh before reconnect failed: ${String(error)}`
              }));
            }
            if (closed) return;
            reconnectTimers.delete(remotePeerId);
            createPeerConnection(remotePeerId);
          })();
        }, 2_000));
      });
      const buffered = pendingSignals.get(remotePeerId);
      if (buffered) {
        pendingSignals.delete(remotePeerId);
        for (const signal of buffered) {
          if (!signalIsValid(state, signal)) continue;
          markApplied(state, signalType(signal));
          peer.signal(signal as Parameters<PboardPeer["signal"]>[0]);
        }
      }
    }

    function handleRoster(roster: string[]) {
      if (closed || !ownPeerId) return;
      for (const id of roster) createPeerConnection(id);
    }

    signaling.onSignal((from, data) => {
      if (closed) return;
      const state = handshake.get(from);
      if (!state) {
        // No connection yet. Buffer only what a fresh connection could accept; an
        // answer can never answer an offer we have not sent, so stale answers are
        // dropped. Before `join()` resolves the role is unknown, so buffer everything.
        if (ownPeerId && !signalIsValid({ initiator: from > ownPeerId, jsepState: "new" }, data)) return;
        const list = pendingSignals.get(from) ?? [];
        list.push(data);
        pendingSignals.set(from, list);
        return;
      }
      if (!signalIsValid(state, data)) return;
      markApplied(state, signalType(data));
      peers.get(from)?.signal(data as Parameters<PboardPeer["signal"]>[0]);
    });
    signaling.onError?.((error) => {
      if (!closed) error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
    });

    void (async () => {
      try {
        // `onRoster` fires (possibly synchronously) during `join()`, before our own
        // id is known, so buffer the latest roster and apply it once we have it.
        let latestRoster: string[] = [];
        const { peerId, peers: initial } = await signaling.join((roster) => {
          latestRoster = roster;
          handleRoster(roster);
        });
        if (closed) return;
        ownPeerId = peerId;
        for (const id of new Set([...initial, ...latestRoster])) createPeerConnection(id);
      } catch (error) {
        if (closed) return;
        error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
      }
    })();

    const handler: WebRTCConnectionHandler<PboardPeer> = {
      connect$, disconnect$, message$, response$, error$,
      async send(peer, message) {
        peer.send(JSON.stringify(message));
      },
      async close() {
        closed = true;
        for (const timer of reconnectTimers.values()) clearTimeout(timer);
        reconnectTimers.clear();
        for (const peer of peers.values()) peer.destroy();
        handshake.clear();
        peers.clear();
        await signaling.leave().catch(() => {});
        connect$.complete(); disconnect$.complete(); message$.complete(); response$.complete(); error$.complete();
      }
    };
    return handler;
  };
}

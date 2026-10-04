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
};

/**
 * Builds an RxDB `WebRTCConnectionHandler` creator for a single project+collection
 * room. The data channel is simple-peer; rendezvous and signal relay come from the
 * injected `PboardSignaling`, so the transport is swappable without touching the
 * replication logic.
 *
 * Deterministic initiator: the peer with the greater signaling id opens the offer,
 * so both peers always agree on who initiates. Signals that arrive before a peer
 * connection exists are buffered and flushed on creation (a late answer/ICE must not
 * be dropped just because the handshake raced).
 */
export function createPboardWebRTCConnectionHandler(options: PboardWebRTCConnectionOptions): WebRTCConnectionHandlerCreator<PboardPeer> {
  const { signaling, wrtc, config, trickle = false, scopeDocument } = options;
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
    let closed = false;
    let ownPeerId: string | null = null;

    function createPeerConnection(remotePeerId: string) {
      if (closed || !ownPeerId || remotePeerId === ownPeerId || peers.has(remotePeerId)) return;
      let disconnected = false;
      const peer = new Peer({ initiator: remotePeerId > ownPeerId, wrtc, config, trickle }) as PboardPeer;
      peer.id = remotePeerId;
      peers.set(remotePeerId, peer);
      peer.on("signal", (signal) => {
        void signaling.sendSignal(remotePeerId, signal).catch((error) => {
          error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
        });
      });
      peer.on("data", (payload) => {
        const parsed = JSON.parse(payload.toString());
        if (parsed && typeof parsed === "object" && "result" in parsed) response$.next({ peer, response: { ...parsed, result: scopeResult(parsed.result) } });
        else message$.next({ peer, message: parsed });
      });
      peer.on("error", (error) => {
        error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
        peer.destroy();
        if (!disconnected) { disconnected = true; disconnect$.next(peer); }
      });
      peer.on("connect", () => connect$.next(peer));
      peer.on("close", () => {
        if (!disconnected) { disconnected = true; disconnect$.next(peer); }
        if (peers.get(remotePeerId) === peer) peers.delete(remotePeerId);
        pendingSignals.delete(remotePeerId);
        createPeerConnection(remotePeerId);
      });
      const buffered = pendingSignals.get(remotePeerId);
      if (buffered) {
        pendingSignals.delete(remotePeerId);
        for (const signal of buffered) peer.signal(signal as Parameters<PboardPeer["signal"]>[0]);
      }
    }

    function handleRoster(roster: string[]) {
      if (closed || !ownPeerId) return;
      for (const id of roster) createPeerConnection(id);
    }

    signaling.onSignal((from, data) => {
      if (closed) return;
      const peer = peers.get(from);
      if (peer) peer.signal(data as Parameters<PboardPeer["signal"]>[0]);
      else {
        const list = pendingSignals.get(from) ?? [];
        list.push(data);
        pendingSignals.set(from, list);
      }
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
        for (const peer of peers.values()) peer.destroy();
        peers.clear();
        await signaling.leave().catch(() => {});
        connect$.complete(); disconnect$.complete(); message$.complete(); response$.complete(); error$.complete();
      }
    };
    return handler;
  };
}

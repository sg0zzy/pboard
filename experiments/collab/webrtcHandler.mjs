import Peer from "simple-peer";
import { Subject } from "rxjs";
import { newRxError } from "rxdb";

/**
 * Builds an RxDB WebRTCConnectionHandler creator for one topic, using simple-peer
 * for the data channel and an injected PboardSignaling for rendezvous + signal relay.
 *
 * PboardSignaling contract:
 *   join(onRoster): Promise<{ peerId, peers: string[] }>
 *   onSignal(from, signal): void
 *   sendSignal(to, signal): Promise<void>
 *   leave(): Promise<void>
 */
export function createPboardWebRTCConnectionHandler({ signaling, wrtc, config, trickle = false }) {
  return async () => {
    const connect$ = new Subject();
    const disconnect$ = new Subject();
    const message$ = new Subject();
    const response$ = new Subject();
    const error$ = new Subject();
    const peers = new Map();
    let closed = false;
    let ownPeerId = null;
    const pendingSignals = new Map(); // remotePeerId -> signal[]

    function createPeerConnection(remotePeerId) {
      if (closed || !ownPeerId || remotePeerId === ownPeerId || peers.has(remotePeerId)) return;
      let disconnected = false;
      const peer = new Peer({ initiator: remotePeerId > ownPeerId, wrtc, config, trickle });
      peer.id = remotePeerId;
      peers.set(remotePeerId, peer);
      const buffered = pendingSignals.get(remotePeerId);
      if (buffered) {
        pendingSignals.delete(remotePeerId);
        for (const signal of buffered) peer.signal(signal);
      }
      peer.on("signal", (signal) => { signaling.sendSignal(remotePeerId, signal); });
      peer.on("data", (payload) => {
        const parsed = JSON.parse(payload.toString());
        if (parsed.result !== undefined) response$.next({ peer, response: parsed });
        else message$.next({ peer, message: parsed });
      });
      peer.on("error", (err) => {
        error$.next(newRxError("RC_WEBRTC_PEER", { error: String(err) }));
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
    }

    function handleRoster(roster) {
      if (closed || !ownPeerId) return;
      for (const id of roster) createPeerConnection(id);
    }

    signaling.onSignal((from, data) => {
      const peer = peers.get(from);
      if (closed) return;
      if (peer) peer.signal(data);
      else {
        const list = pendingSignals.get(from) ?? [];
        list.push(data);
        pendingSignals.set(from, list);
      }
    });

    (async () => {
      try {
        // onRoster fires (possibly synchronously) during join(), before ownPeerId is
        // set, so buffer the latest roster and apply it once we have our own id.
        let latestRoster = [];
        const { peerId, peers: initial } = await signaling.join((roster) => {
          latestRoster = roster;
          handleRoster(roster);
        });
        if (closed) return;
        ownPeerId = peerId;
        for (const id of new Set([...initial, ...latestRoster])) createPeerConnection(id);
      } catch (err) {
        error$.next(newRxError("RC_WEBRTC_PEER", { error: String(err) }));
      }
    })();

    return {
      connect$, disconnect$, message$, response$, error$,
      async send(peer, message) { await peer.send(JSON.stringify(message)); },
      async close() {
        closed = true;
        for (const peer of peers.values()) peer.destroy();
        peers.clear();
        await signaling.leave().catch(() => {});
        connect$.complete(); disconnect$.complete(); message$.complete(); response$.complete(); error$.complete();
      }
    };
  };
}

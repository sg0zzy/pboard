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
  WebRTCConnectionHandlerCreator,
  WebRTCMessage,
  WebRTCResponse
} from "rxdb/plugins/replication-webrtc";
import type { PboardSignaling } from "./signaling";
import type { SigningInput } from "./security/session";
import {
  buildSessionProof, buildSignedSignal, buildPresence, verifySessionProof, verifySignedSignal, createReplayCache,
  type EnvelopeContext, type ProtocolCollection, type VerifiedSessionContext
} from "./security/session";
import type { BoardPermissionManifest } from "./security/manifest";
import { manifestHash, AUTH_TIMEOUT_MS } from "./security/manifest";

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
  /**
   * Protocol-2 authentication. When set, a peer signals only through signed,
   * session-bound envelopes; both sides exchange challenge proofs after DTLS
   * connects; `connect$` fires and content flows only after mutual proof. When
   * absent the handler runs the legacy unauthenticated flow (in-memory tests).
   */
  security?: SecuredHandlerSecurity;
};

/**
 * Per-handler security configuration, produced by the runtime wiring from the
 * locally verified manifest and this device's signing key.
 */
export type SecuredHandlerSecurity = {
  /** This device's signing identity from `keys.ts`. */
  signer: SigningInput;
  /** The locally verified board/account manifest this room participates in. */
  manifest: BoardPermissionManifest;
  boardId: string;
  collection: ProtocolCollection;
  /** This connection's session id; new on every (re)connection attempt. */
  ownSessionId: string;
  /** Monotonic clock; injectable for tests. */
  now?: () => number;
  /** Called once a remote peer completes the mutual proof successfully. */
  onSessionVerified?: (remotePeerId: string, context: VerifiedSessionContext) => void;
  /** Called when a session is closed by security policy (expiry, proof failure). */
  onSessionRejected?: (remotePeerId: string, reason: string) => void;
};

type HandshakeState = {
  initiator: boolean;
  jsepState: string;
  /** Set once the DTLS transport connected and proofs are being exchanged. */
  transportConnected?: boolean;
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
  const { signaling, wrtc, config, trickle = false, scopeDocument, beforeReconnect, security } = options;
  const now = security?.now ?? (() => Date.now());
  const ownSessionId = security?.ownSessionId ?? crypto.randomUUID();
  const signedManifest = security?.manifest ?? null;
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
    const replay = security ? createReplayCache() : { accepted: new Map() };
    /** Per-peer protocol-2 admission state: null until the peer is fully proven. */
    const verified = new Map<string, VerifiedSessionContext>();
    const authTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const remoteSessions = new Map<string, string>();
    const remoteDeviceKeys = new Map<string, string>();
    const transcripts = new Map<string, string[]>();
    /** Random challenge we sent to each remote peer (proof round-trip binding). */
    const challengesIssued = new Map<string, string>();
    let ownSequence = 0;
    let closed = false;
    let ownPeerId: string | null = null;

    function admissionStage(remotePeerId: string): "discovered" | "signaling-verified" | "transport-connected" | "mutual-proof-verified" | "replication-ready" {
      if (verified.has(remotePeerId)) return "replication-ready";
      if (peers.has(remotePeerId)) return "transport-connected";
      if (remoteSessions.has(remotePeerId)) return "signaling-verified";
      return "discovered";
    }

    function rejectSession(remotePeerId: string, reason: string) {
      if (!closed) security?.onSessionRejected?.(remotePeerId, reason);
      peers.get(remotePeerId)?.destroy();
      verified.delete(remotePeerId);
      const timer = authTimers.get(remotePeerId);
      if (timer) { clearTimeout(timer); authTimers.delete(remotePeerId); }
    }

    function createPeerConnection(remotePeerId: string) {
      if (closed || !ownPeerId || remotePeerId === ownPeerId || peers.has(remotePeerId) || reconnectTimers.has(remotePeerId)) return;
      let disconnected = false;
      const peer = new Peer({ initiator: remotePeerId > ownPeerId, wrtc, config, trickle }) as PboardPeer;
      peer.id = remotePeerId;
      peers.set(remotePeerId, peer);
      const state: HandshakeState = { initiator: remotePeerId > ownPeerId, jsepState: "new" };
      handshake.set(remotePeerId, state);
      // This connection attempt gets a fresh session id; old buffered signals
      // must not migrate to it (plan: reconnection anti-replay).
      remoteSessions.set(remotePeerId, remoteSessionIdFor(remotePeerId));
      transcripts.set(remotePeerId, []);
      peer.on("signal", (signal) => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        const type = signalType(signal);
        if (type === "offer") state.jsepState = "have-local-offer";
        else if (type === "answer" || type === "pranswer") state.jsepState = "stable";
        // The transcript accumulates our own emitted descriptions in order.
        if (type === "offer" || type === "answer") transcripts.get(remotePeerId)?.push(applyType(type, signal));
        void sendSigned(remotePeerId, signal).catch((error) => {
          if (!closed && peers.get(remotePeerId) === peer) {
            error$.next(newRxError("RC_WEBRTC_PEER", { errorText: String(error) }));
          }
        });
      });
      peer.on("data", (payload) => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        void onData(peer, remotePeerId, payload);
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
        if (closed || peers.get(remotePeerId) !== peer) return;
        state.transportConnected = true;
        if (security) beginMutualProof(peer, remotePeerId);
        else connect$.next(peer);
      });
      peer.on("close", () => {
        if (closed || peers.get(remotePeerId) !== peer) return;
        if (!disconnected) { disconnected = true; disconnect$.next(peer); }
        if (peers.get(remotePeerId) === peer) peers.delete(remotePeerId);
        pendingSignals.delete(remotePeerId);
        handshake.delete(remotePeerId);
        verified.delete(remotePeerId);
        const timer = authTimers.get(remotePeerId);
        if (timer) { clearTimeout(timer); authTimers.delete(remotePeerId); }
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
          if (signalType(signal) === "offer" || signalType(signal) === "answer") transcripts.get(remotePeerId)?.push(applyType(signalType(signal)!, signal));
          peer.signal(signal as Parameters<PboardPeer["signal"]>[0]);
        }
      }
    }

    /** Stable per-peer session salt for this handler instance (debug aid only). */
    function remoteSessionIdFor(remotePeerId: string): string {
      // The *remote* session id is learned from the peer's signed presence; a
      // placeholder keeps the admission stage deterministic until then.
      return `${ownSessionId}:${remotePeerId}`;
    }

    /** Complete admission: store the verified context, then emit connect$. */
    function completeAdmission(peer: PboardPeer, remotePeerId: string, context: VerifiedSessionContext) {
      if (closed || peers.get(remotePeerId) !== peer) return;
      verified.set(remotePeerId, context);
      const timer = authTimers.get(remotePeerId);
      if (timer) { clearTimeout(timer); authTimers.delete(remotePeerId); }
      security?.onSessionVerified?.(remotePeerId, context);
      connect$.next(peer);
    }

    function transcriptHashFor(remotePeerId: string): string {
      return hashTranscript(transcripts.get(remotePeerId) ?? []);
    }

    /** SDP description transcript entry: the type plus the exact emitted SDP text. */
    function applyType(type: string, signal: unknown): string {
      if (signal && typeof signal === "object" && "sdp" in signal && typeof signal.sdp === "string") {
        return `${type}:${signal.sdp}`;
      }
      return `${type}:`;
    }

    /** Ordered offer/answer transcript hash; binds proofs to this connection. */
    function hashTranscript(transcript: string[]): string {
      const joined = transcript.join("\u0000");
      return Array.from(new TextEncoder().encode(joined), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    // Protocol-2 flow helpers. All envelope construction/verification lives in
    // security/session; this handler only sequences the exchange.

    async function sendSigned(remotePeerId: string, signal: unknown): Promise<void> {
      if (!security || !signedManifest) {
        await signaling.sendSignal(remotePeerId, signal);
        return;
      }
      const remoteSession = remoteSessions.get(remotePeerId) ?? remoteSessionIdFor(remotePeerId);
      const remoteDevice = remoteDeviceKeys.get(remotePeerId) ?? remotePeerId;
      const signedEnvelope = await buildSignedSignal(
        { privateJwk: security.signer.privateJwk, deviceKeyId: security.signer.deviceKeyId },
        { boardId: security.boardId, collection: security.collection, manifest: signedManifest, ownSessionId, now: now() },
        { deviceKeyId: remoteDevice, sessionId: remoteSession },
        signal, ownSequence++
      );
      // The signed envelope rides as the signal; the Drive provider stores
      // `security` separately (see signaling.ts) when the transport supports it.
      await signaling.sendSignal(remotePeerId, signedEnvelope);
    }

    /** Starts the post-DTLS mutual proof: send our proof, arm the auth timeout. */
    function beginMutualProof(peer: PboardPeer, remotePeerId: string) {
      if (!security || !signedManifest) return;
      const remoteSession = remoteSessions.get(remotePeerId) ?? remoteSessionIdFor(remotePeerId);
      const remoteDevice = remoteDeviceKeys.get(remotePeerId) ?? remotePeerId;
      const challenge = crypto.randomUUID();
      challengesIssued.set(remotePeerId, challenge);
      const timeout = setTimeout(() => {
        rejectSession(remotePeerId, `Mutual authentication timed out after ${AUTH_TIMEOUT_MS}ms`);
      }, AUTH_TIMEOUT_MS);
      authTimers.set(remotePeerId, timeout);
      void (async () => {
        const proof = await buildSessionProof(
          { privateJwk: security.signer.privateJwk, deviceKeyId: security.signer.deviceKeyId },
          {
            boardId: security.boardId, collection: security.collection,
            ownSessionId, remoteDeviceKeyId: remoteDevice, remoteSessionId: remoteSession,
            manifest: signedManifest
          },
          challenge, transcriptHashFor(remotePeerId), now()
        );
        if (!closed && peers.get(remotePeerId) === peer) peer.send(JSON.stringify({ protocol: 2, kind: "sessionProof", proof }));
      })().catch((error) => rejectSession(remotePeerId, `Proof construction failed: ${String(error)}`));
    }

    /** Application data gate: only fully proven sessions may deliver frames. */
    async function onData(peer: PboardPeer, remotePeerId: string, payload: Uint8Array) {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(payload)); }
      catch { rejectSession(remotePeerId, "Unparseable data channel frame"); return; }
      if (isProofFrame(parsed)) {
        if (security) { await acceptSessionProof(peer, remotePeerId, parsed); }
        return;
      }
      if (security && !verified.has(remotePeerId)) {
        // Early application frames (RxDB token/write requests) are rejected:
        // nothing is delivered before mutual proof completes.
        rejectSession(remotePeerId, "Application frame received before mutual authentication");
        return;
      }
      // Replication wire frames carry an `id` plus either `result` (a response)
      // or `method`/`params` (a request); the shapes are RxDB contract.
      if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string" &&
          ("result" in parsed || ("method" in parsed || "params" in parsed))) {
        if ("result" in parsed) {
          response$.next({ peer, response: { ...parsed, id: parsed.id, result: scopeResult(parsed.result) } as WebRTCResponse });
        } else {
          message$.next({ peer, message: parsed as WebRTCMessage });
        }
      }
    }

    function isProofFrame(parsed: unknown): boolean {
      return Boolean(parsed && typeof parsed === "object" && "kind" in parsed && parsed.kind === "sessionProof");
    }

    /** Verifies the remote proof, answers with our own, completes admission. */
    async function acceptSessionProof(peer: PboardPeer, remotePeerId: string, parsed: unknown) {
      if (!security || !signedManifest) return;
      const remoteSession = remoteSessions.get(remotePeerId) ?? remoteSessionIdFor(remotePeerId);
      const frame = (parsed as { proof?: unknown }).proof;
      const context = verified.get(remotePeerId);
      try {
        const verifiedProof = await verifySessionProof(frame, signedManifest, {
          boardId: security.boardId, collection: security.collection,
          ownDeviceKeyId: security.signer.deviceKeyId, ownSessionId,
          manifestHash: manifestHash(signedManifest),
          issuedChallenge: challengeIssuedTo(remotePeerId),
          transcriptHash: transcriptHashFor(remotePeerId),
          now: now()
        });
        remoteDeviceKeys.set(remotePeerId, verifiedProof.deviceKeyId);
        if (!context) {
          // First proof received: answer with our own proof, then complete.
          completeAdmission(peer, remotePeerId, {
            boardId: security.boardId,
            collection: security.collection,
            ownDeviceKeyId: security.signer.deviceKeyId,
            remoteDeviceKeyId: verifiedProof.deviceKeyId,
            remoteRole: verifiedProof.role,
            ownSessionId,
            remoteSessionId: String((frame as { payload?: { fromSessionId?: unknown } }).payload?.fromSessionId ?? remoteSession),
            manifestEpoch: signedManifest.epoch,
            manifestHash: manifestHash(signedManifest),
            transcriptHash: transcriptHashFor(remotePeerId),
            manifestExpiresAt: signedManifest.expiresAt
          });
          beginMutualProof(peer, remotePeerId);
        } else if (verified.has(remotePeerId)) {
          // Both proofs complete.
          completeAdmission(peer, remotePeerId, { ...context, remoteDeviceKeyId: verifiedProof.deviceKeyId, remoteRole: verifiedProof.role });
        }
      } catch (error) {
        rejectSession(remotePeerId, `Session proof rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /** The challenge we sent in our own proof for this connection attempt. */
    function challengeIssuedTo(remotePeerId: string): string {
      return challengesIssued.get(remotePeerId) ?? "";
    }

    function handleRoster(roster: string[]) {
      if (closed || !ownPeerId) return;
      for (const id of roster) createPeerConnection(id);
    }

    /** Buffer or apply a verified inner signal for a remote peer. */
    function applyOrBufferVerifiedSignal(from: string, data: unknown) {
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
      const type = signalType(data);
      markApplied(state, type);
      if (type === "offer" || type === "answer") transcripts.get(from)?.push(applyType(type, data));
      peers.get(from)?.signal(data as Parameters<PboardPeer["signal"]>[0]);
    }

    signaling.onSignal((from, data) => {
      if (closed) return;
      if (!security || !signedManifest) {
        applyOrBufferVerifiedSignal(from, data);
        return;
      }
      // Protocol 2: the envelope carries the *signed signal*; the inner simple-peer
      // signal arrives through the transport's `security` member when supported.
      void (async () => {
        try {
          const innerSignal = (data && typeof data === "object" && "signal" in data) ? data.signal : undefined;
          const check = {
            manifest: signedManifest,
            expected: {
              boardId: security.boardId,
              collection: security.collection,
              manifestHash: manifestHash(signedManifest),
              ownDeviceKeyId: security.signer.deviceKeyId,
              ownSessionId
            },
            now: now()
          };
          const verifiedSignal = await verifySignedSignal(data, check, replay);
          const envelope = (data && typeof data === "object" && "payload" in data ? data : null) as { payload?: { fromSessionId?: unknown; fromDeviceKeyId?: unknown } } | null;
          const payloadSession = envelope?.payload?.fromSessionId;
          const payloadDevice = envelope?.payload?.fromDeviceKeyId;
          if (typeof payloadSession === "string") remoteSessions.set(from, payloadSession);
          if (typeof payloadDevice === "string") remoteDeviceKeys.set(from, payloadDevice);
          applyOrBufferVerifiedSignal(from, verifiedSignal);
        } catch (error) {
          security.onSessionRejected?.(from, `Signal envelope rejected: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
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
        if (security && signedManifest && signaling.publishPresence) {
          const presence = await buildPresence(
            { privateJwk: security.signer.privateJwk, deviceKeyId: security.signer.deviceKeyId },
            { boardId: security.boardId, collection: security.collection, manifest: signedManifest, ownSessionId, now: now() }
          );
          await signaling.publishPresence({ manifest: signedManifest, presence });
        }
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

/** Authenticated experimental transport. Room grants add admission; protocol-2
 * manifest, signal and DataChannel verification still run in webrtcHandler. */
import type { PboardSignaling, SignedPresenceEnvelope } from "./signaling";
import { importSigningKey, signBytes, type StoredDeviceKey } from "./security/keys";
import { parseStrictJson } from "./security/canonical";
import { validateWebSocketEndpoint } from "./security/endpoint";
import { prepareRelayAdmission, type RelayAuthorization } from "./security/relayAdmission";
import { collaborationDiagnostic } from "./diagnostics";

export type ServiceAdmissionRequest = { challenge: string; session: string; room: string; key: StoredDeviceKey };

export function createExperimentalWebSocketSignaling(options: {
  topic: string;
  url: string;
  getKey: () => Promise<StoredDeviceKey>;
  /** Omit only for explicit legacy operator-grant probes. Runtime uses proof admission. */
  getAuthorization?: () => Promise<RelayAuthorization>;
  /** Explicit build-owned exception, never populated from incoming data. */
  loopbackDevelopment?: boolean;
  webSocket?: typeof WebSocket;
  getServiceAdmission?: (request: ServiceAdmissionRequest) => Promise<string>;
}): PboardSignaling {
  const url = new URL(options.url);
  const loopback = import.meta.env.DEV && options.loopbackDevelopment && url.protocol === "ws:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (!loopback && validateWebSocketEndpoint(options.url).check !== "ok")) throw new Error("Invalid experimental signaling endpoint");
  const Socket = options.webSocket ?? WebSocket;
  let socket: WebSocket | undefined;
  let stopped = false;
  let presence: SignedPresenceEnvelope | undefined;
  let presenceHandler: (peer: string, envelope: SignedPresenceEnvelope) => void = () => {};
  function publishTo(peer: string) {
    if (presence && joined && peers.has(peer)) send({ type: "signal", to: peer, session: peers.get(peer), data: { kind: "pboard-presence", envelope: presence } });
  }
  let joined = false;
  let ownId = "";
  let ownSession = "";
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let rosterHandler: (peers: string[]) => void = () => {};
  let signalHandler: (from: string, signal: unknown) => void = () => {};
  let errorHandler: (error: unknown) => void = () => {};
  const peers = new Map<string, string>();
  const debug = (event: string, fields: { peer?: string; count?: number; code?: number } = {}) =>
    collaborationDiagnostic(event, { room: options.topic, session: ownSession, ...fields });
  let resolveJoin: ((value: { peerId: string; peers: string[] }) => void) | undefined;
  let rejectJoin: ((error: Error) => void) | undefined;
  let joining: Promise<{ peerId: string; peers: string[] }> | undefined;
  function roster() { rosterHandler([...peers.keys()].sort()); }
  function send(message: unknown) {
    if (!socket || socket.readyState !== Socket.OPEN) throw new Error("Experimental signaling is disconnected");
    socket.send(JSON.stringify(message));
  }
  async function connect() {
    if (stopped) return;
    const key = await options.getKey();
    const admission = options.getAuthorization
      ? await prepareRelayAdmission(options.topic, await options.getAuthorization(), key.keyId) : undefined;
    if (stopped) return;
    ownId = key.keyId;
    debug("relay.connecting");
    const ws = new Socket(options.url);
    socket = ws;
    joined = false;
    // Serialize signing and inbound processing so authentication cannot race close/rejoin.
    let inbound = Promise.resolve();
    let pending = 0;
    deadline = setTimeout(() => ws.close(), 10_000);
    ws.onmessage = (event) => {
      if (++pending > 64) { errorHandler(new Error("Experimental signaling inbound queue exceeded")); ws.close(); return; }
      inbound = inbound.then(async () => {
        if (stopped || socket !== ws || ws.readyState !== Socket.OPEN) return;
        const message = parseStrictJson(String(event.data), 128 * 1024) as Record<string, unknown>;
        switch (message.type) {
          case "welcome": {
            if (message.version !== 1 || typeof message.challenge !== "string" || typeof message.session !== "string" || ownSession) throw new Error("Invalid signaling welcome");
            ownSession = message.session;
            debug("relay.challenge_received");
            if (admission && (!Array.isArray(message.supportedVersions) || !message.supportedVersions.includes(2))) {
              fail(new Error("Relay does not support automatic authorization; no insecure downgrade permitted"));
              ws.close(); return;
            }
            const room = admission?.room ?? options.topic;
            const bytes = new TextEncoder().encode(JSON.stringify(admission
              ? ["pboard-ws-auth-v2", message.challenge, ownSession, room, ownId, admission.digest]
              : ["pboard-ws-auth-v1", message.challenge, ownSession, room, ownId]));
            let serviceAdmission: string | undefined;
            if (message.requiresServiceAdmission === true) {
              if (!options.getServiceAdmission) {
                fail(new Error("Verified Google service admission is required; board grants alone are insufficient")); ws.close(); return;
              }
              try {
                serviceAdmission = await options.getServiceAdmission({ challenge: message.challenge, session: ownSession, room, key });
                if (!/^[A-Za-z0-9_-]{43}$/.test(serviceAdmission)) throw new Error("Invalid service admission response");
              } catch {
                fail(new Error("Google service admission could not be verified. Local data remains available.")); ws.close(); return;
              }
            }
            const signature = await signBytes(await importSigningKey(key.privateJwk), bytes);
            if (stopped || socket !== ws || ws.readyState !== Socket.OPEN) return;
            send({ type: "authenticate", version: admission ? 2 : 1, room, deviceKeyId: ownId, signature,
              ...(admission ? { authorization: admission.authorization } : {}), ...(serviceAdmission ? { serviceAdmission } : {}) });
            break;
          }
          case "authenticated":
            if (message.peerId !== ownId || message.session !== ownSession) throw new Error("Signaling identity mismatch");
            debug("relay.authenticated");
            send({ type: "join" }); break;
          case "joined":
            if (joined || !Array.isArray(message.peers) || message.peers.length > 63) throw new Error("Invalid signaling roster");
            peers.clear();
            for (const peer of message.peers as Array<{ peerId: string; session: string }>) {
              if (typeof peer.peerId !== "string" || typeof peer.session !== "string") throw new Error("Invalid signaling peer");
              if (peer.peerId !== ownId) peers.set(peer.peerId, peer.session);
            }
            joined = true; attempts = 0; clearTimeout(deadline);
            debug("relay.joined", { count: peers.size });
            heartbeat = setInterval(() => { if (joined && socket?.readyState === Socket.OPEN) send({ type: "ping" }); }, 15_000);
            resolveJoin?.({ peerId: ownId, peers: [...peers.keys()] }); roster(); for (const id of peers.keys()) publishTo(id); break;
          case "peer_joined":
            if (joined && typeof message.peerId === "string" && typeof message.session === "string" && message.peerId !== ownId) {
              peers.set(message.peerId, message.session); roster(); publishTo(message.peerId);
              debug("relay.peer_joined", { peer: message.peerId, count: peers.size });
            }
            break;
          case "peer_left":
            debug("relay.peer_left", { peer: typeof message.peerId === "string" ? message.peerId : undefined });
            if (typeof message.peerId === "string" && peers.get(message.peerId) === message.session) { peers.delete(message.peerId); roster(); }
            break;
          case "signal":
            if (joined && typeof message.from === "string" && peers.get(message.from) === message.session) {
              const data = message.data as { kind?: string; envelope?: SignedPresenceEnvelope } | null;
              if (data?.kind === "pboard-presence") {
                const envelope = data.envelope;
                const payload = (envelope?.presence as { payload?: { deviceKeyId?: string } })?.payload;
                if (envelope && payload?.deviceKeyId === message.from) presenceHandler(message.from, envelope);
              } else signalHandler(message.from, message.data);
            }
            break;
          case "pong": break;
          case "error": {
            const code = String(message.code);
            const known = ["service_auth_required", "service_binding_invalid", "unauthorized", "malformed", "invalid_state", "grant_expired", "authorization_stale", "authorization_changed", "duplicate_or_full", "stale_target", "rate_limit", "auth_timeout", "idle_timeout", "server_shutdown", "server_busy", "slow_consumer", "closed", "invalid_frame"];
            debug(`relay.rejected.${known.includes(code) ? code : "unknown"}`);
            const error = new Error(`Experimental signaling rejected: ${String(message.code)}`);
            errorHandler(error);
            if (["service_auth_required", "service_binding_invalid", "unauthorized", "malformed", "invalid_state", "grant_expired", "authorization_stale", "authorization_changed"].includes(String(message.code))) {
              stopped = true; rejectJoin?.(error); ws.close();
            }
            break;
          }
          default: throw new Error("Unknown experimental signaling message");
        }
      }).catch(error => { errorHandler(error); ws.close(); }).finally(() => { --pending; });
    };
    ws.onerror = () => { debug("relay.network_error"); errorHandler(new Error("Experimental signaling WebSocket failed")); };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      debug("relay.closed", { code: event.code });
      joined = false; ownSession = ""; peers.clear(); roster(); clearInterval(heartbeat); clearTimeout(deadline);
      if (!stopped) {
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)) * (0.75 + Math.random() * 0.5);
        debug("relay.reconnect_scheduled", { count: Math.round(delay) });
        retry = setTimeout(() => { void connect().catch(fail); }, delay);
      }
    };
  }
  function fail(error: unknown) { debug("relay.start_failed"); stopped = true; rejectJoin?.(error instanceof Error ? error : new Error(String(error))); errorHandler(error); }
  return {
    join(handler) {
      rosterHandler = handler;
      joining ??= new Promise((resolve, reject) => { resolveJoin = resolve; rejectJoin = reject; void connect().catch(fail); });
      return joining;
    },
    async sendSignal(to, data) {
      const session = peers.get(to);
      if (!joined || !session) throw new Error("Signaling target is offline");
      send({ type: "signal", to, session, data });
    },
    onSignal(handler) { signalHandler = handler; },
    onPresence(handler) { presenceHandler = handler; },
    async publishPresence(envelope) { presence = envelope; for (const id of peers.keys()) publishTo(id); },
    onError(handler) { errorHandler = handler; },
    async leave() {
      stopped = true; clearTimeout(retry); clearTimeout(deadline); clearInterval(heartbeat);
      rejectJoin?.(new Error("Experimental signaling stopped"));
      if (joined && socket?.readyState === Socket.OPEN) send({ type: "leave" });
      joined = false; socket?.close(); socket = undefined; peers.clear();
    }
  };
}

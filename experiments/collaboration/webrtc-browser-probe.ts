import { collaborationSecurityFixture } from "../../tests/helpers/collaborationSecurity";
import { createCollaborationManager } from "../../src/collab/manager";
import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createDriveSignaling, createMemorySignalingScope, type PboardSignaling } from "../../src/collab/signaling";
import { createPboardWebRTCConnectionHandler } from "../../src/collab/webrtcHandler";
import { createDrivePermissionTransport, createDriveSignalStore } from "../../src/sync/drivePermissions";
import { createDriveTransport } from "../../src/sync/driveTransport";
import { createAccountSignalStore } from "../../src/sync/accountSignaling";

// Both isolated profiles represent the same owner. Only Drive HTTP is faked;
// IndexedDB, the WebRTC connection and RxDB replication run in native Chromium.
const auth = {
  getAccessToken: async () => "test", getConnectionState: async () => "connected" as const,
  isConfigured: () => true, connect: async () => {}, disconnect: async () => {}
};
const cloudFetch: typeof fetch = (input, init) =>
  fetch(String(input).replace("https://www.googleapis.com", location.origin), init);
const transport = createDrivePermissionTransport(auth, cloudFetch);
const accountTransport = createDriveTransport(auth, cloudFetch, "account-signal-");
const peerId = crypto.randomUUID();
const sharedProjects = {
  get: async () => ({ folderId: "folder", projectFileId: "shared", realtimeFolderId: "room" }),
  set: async () => {}, delete: async () => {}
};
const rx = await createRxRepository({ name: "livebrowsersmoke" });
// The shared project doc is not created at load: the driver writes it, so the driver controls
// which side holds an assumed master state for it.
const project = {
  id: "shared-project", name: "Live test", template: "project" as const, revision: 1,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
};
await rx.importProject({ ...project, id: "private-project", name: "Private board" }, []);
const manager = createCollaborationManager({
  ...collaborationSecurityFixture(),
  myRole: async (id) => id === project.id ? "owner" : null,
  getSharedFileId: async (id) => id === project.id ? "shared" : null,
  bootstrapFromDrive: async () => false, getRepository: async () => rx, getAccountId: async () => "account-A",
  signalingFor: (topic) => createDriveSignaling({ pollMs: 150, store: topic.startsWith("pboard-account-")
    ? createAccountSignalStore({ transport: accountTransport, account: "account-A", peerId })
    : createDriveSignalStore({
      transport, sharedProjects, projectId: project.id, peerId, topic, realtimeFolderId: async () => "room"
    }) })
});

// ---------------------------------------------------------------------------
// Native JSEP gate proof. Two handler instances rendezvous inside one page over
// native Chromium WebRTC (no `wrtc` injected, so simple-peer uses the page's
// `RTCPeerConnection`). The answer captured from that handshake is replayed to a
// fresh instance whose tracked state is still `new` — the same shape as a Drive
// outbox replay after a peer re-joins. The gate must drop it; applying the same
// description directly shows the native rule the gate encodes.
// ---------------------------------------------------------------------------

function signalTypeOf(signal: unknown): string | null {
  if (signal && typeof signal === "object" && "type" in signal && typeof signal.type === "string") return signal.type;
  return null;
}

function sdpOf(signal: unknown): string {
  if (signal && typeof signal === "object" && "sdp" in signal && typeof signal.sdp === "string") return signal.sdp;
  return "";
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps one room so every emitted signal is recorded and any signal can be re-injected. */
function recordingChannel(scope: ReturnType<typeof createMemorySignalingScope>, topic: string) {
  const inner = scope.create(topic);
  const published: Array<{ from: string; data: unknown }> = [];
  const rosters: string[] = [];
  let self = "";
  let receiver: ((from: string, signal: unknown) => void) | null = null;
  const provider: PboardSignaling = {
    join: async (onRoster) => {
      const joined = await inner.join((roster) => { rosters.push(roster.join(",")); onRoster(roster); });
      self = joined.peerId;
      return joined;
    },
    sendSignal: async (to, signal) => { published.push({ from: self, data: signal }); await inner.sendSignal(to, signal); },
    onSignal: (handler) => { receiver = handler; inner.onSignal(handler); },
    leave: () => inner.leave()
  };
  return { id: () => self, published, rosters, provider, deliver: (from: string, signal: unknown) => receiver?.(from, signal) };
}

export type GateProofResult = {
  /** Per-instance view: signals each handler published, errors it saw, whether it connected. */
  instances: Array<{ label: string; signals: string[]; rosters: string[]; errors: string[]; connected: boolean }>;
  /** Peer ids that reached `connect` on the two handshake instances. */
  connected: string[];
  handshakeErrors: string[];
  /** Errors raised by the instance that received the replayed answer. */
  replayErrors: string[];
  /** True when the replayed answer was applied, i.e. the gate let it through. */
  replayPublishedAnswer: boolean;
  nativeRemoteAnswerError: string;
  /** simple-peer's `_createAnswer()` path: answering with no pending offer. */
  nativeCreateAnswerError: string;
  answerFrom: string;
};
const gateScope = createMemorySignalingScope();
export async function gateProof(): Promise<GateProofResult> {
  const entries: Array<{
    label: string;
    signals: string[];
    errors: string[];
    connected: boolean;
    handler: Awaited<ReturnType<typeof open>>["handler"];
    channel: ReturnType<typeof recordingChannel>;
  }> = [];
  const connected: string[] = [];
  async function open(channel: ReturnType<typeof recordingChannel>, label: string) {
    const signals: string[] = [];
    const errors: string[] = [];
    const handler = await createPboardWebRTCConnectionHandler({ signaling: channel.provider, scopeDocument: () => true })();
    const entry = { label, signals, errors, connected: false, handler, channel };
    entries.push(entry);
    handler.error$.subscribe((error) => errors.push(String(error)));
    handler.connect$.subscribe((peer) => {
      entry.connected = true;
      connected.push(peer.id);
    });
    return entry;
  }
  const handshakeFirst = await open(recordingChannel(gateScope, "gate-handshake"), "first");
  const handshakeSecond = await open(recordingChannel(gateScope, "gate-handshake"), "second");
  const deadline = Date.now() + 20000;
  while (connected.length < 2 && Date.now() < deadline) await pause(100);

  // Either side can generate the offer, so the answer can come from either handshake instance;
  // polling for it keeps the native checks from running against an empty description.
  let answer: { from: string; data: unknown } | undefined;
  const answerDeadline = Date.now() + 10000;
  while (Date.now() < answerDeadline) {
    answer = [handshakeFirst, handshakeSecond].flatMap((entry) => entry.channel.published)
      .find((item) => signalTypeOf(item.data) === "answer");
    if (answer) break;
    await pause(100);
  }
  // A room of its own: nothing else can answer, so any answer this instance
  // publishes must come from the replayed description.
  const replay = await open(recordingChannel(gateScope, "gate-replay"), "replay");
  if (answer) replay.channel.deliver(answer.from, answer.data);
  await pause(1500);

  const sdp = sdpOf(answer?.data);
  const raw = new RTCPeerConnection();
  let nativeRemoteAnswerError = "";
  let nativeCreateAnswerError = "";
  try { await raw.setRemoteDescription({ type: "answer", sdp }); } catch (error) { nativeRemoteAnswerError = String(error); }
  // The exact violation the user hit as `Cannot set a local answer in 0`: an
  // answer generated by a peer that never received an offer.
  try { await raw.createAnswer(); } catch (error) { nativeCreateAnswerError = String(error); }
  raw.close();

  for (const entry of entries) entry.signals = entry.channel.published.map((item) => signalTypeOf(item.data) ?? "candidate");
  for (const entry of entries) await entry.handler.close();

  return {
    instances: entries.map((entry) => ({ label: entry.label, signals: entry.signals, rosters: entry.channel.rosters, errors: entry.errors, connected: entry.connected })),
    connected,
    handshakeErrors: entries[0].errors.concat(entries[1].errors),
    replayErrors: entries[2].errors,
    replayPublishedAnswer: replay.channel.published.some((item) => signalTypeOf(item.data) === "answer"),
    nativeRemoteAnswerError,
    nativeCreateAnswerError,
    answerFrom: answer?.from ?? ""
  };
}

// Conflict proof. RxDB hashes the two storage tokens to pick the master of a WebRTC pair, and only
// the fork runs the replication protocol, so only the fork can resolve a conflict. The driver
// therefore puts the newer write on the fork: master-wins and last-write-wins agree whenever the
// fork's own write is the older of the two states it saw. The fork also needs a stale assumed master
// state, which is built by receiving one agreed version and then writing a newer version while
// disconnected, because a failed push writes no meta row. Wrapping the handler is the only way to
// observe the decision here: `conflict$` lives on the replication state, not on the collection, and
// the replication input captures `collection.conflictHandler` at start, so this must run before
// `manager.start()`.
// ---------------------------------------------------------------------------

export type ConflictProofRecord = {
  peer: string;
  assumedUpdatedAt: string | null;
  realUpdatedAt: string;
  newUpdatedAt: string;
  resolvedUpdatedAt: string;
  resolvedTemplate: string;
};

const conflictRecords: ConflictProofRecord[] = [];
const shippedHandler = rx.db.projects.conflictHandler;
rx.db.projects.conflictHandler = {
  isEqual: shippedHandler.isEqual,
  async resolve(input, context) {
    const output = await shippedHandler.resolve(input, context);
    conflictRecords.push({
      peer: peerId,
      assumedUpdatedAt: input.assumedMasterState?.updatedAt ?? null,
      realUpdatedAt: input.realMasterState.updatedAt,
      newUpdatedAt: input.newDocumentState.updatedAt,
      resolvedUpdatedAt: output.updatedAt,
      resolvedTemplate: output.template
    });
    return output;
  }
};

export type ConflictProofResult = {
  peerId: string;
  records: ConflictProofRecord[];
  template: string | null;
};

export async function conflictObservation(): Promise<ConflictProofResult> {
  const doc = await rx.db.projects.findOne(project.id).exec();
  return { peerId, records: conflictRecords, template: doc?.template ?? null };
}

// Mirrors RxDB's isMasterInWebRTCReplication(): the master is the peer whose hash of the joined
// tokens is larger, so the other side is the fork that runs the replication protocol.
export async function isForkAgainst(otherPeerToken: string): Promise<boolean> {
  const own = await rx.db.storageToken;
  const hash = rx.db.hashFunction;
  return (await hash([own, otherPeerToken].join("|"))) < (await hash([otherPeerToken, own].join("|")));
}

const testWindow = window as typeof window & {
  probe: {
    rx: typeof rx; manager: typeof manager; peerId: string; errors: string[]; done: boolean;
    gate: { run: () => Promise<GateProofResult> };
    conflict: { observe: () => Promise<ConflictProofResult>; isFork: (otherPeerToken: string) => Promise<boolean> };
  }
};
testWindow.probe = { rx, manager, peerId, errors: [], done: false, gate: { run: gateProof }, conflict: { observe: conflictObservation, isFork: isForkAgainst } };
manager.start(project.id).then(() => { testWindow.probe.done = true; })
  .catch((error) => testWindow.probe.errors.push(String(error)));

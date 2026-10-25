import { canonicalize, parseStrictJson } from "./security/canonical";
import { portableJournalChanges, verifyJournalChange, certifyHistory, type HistoryAdmission, type JournalProof } from "./security/journalProof";
import { manifestIsCurrent, manifestHash } from "./security/manifest";
import { validateChange, validateRecord } from "../storage/causalReconciliation";
import { makeChange, type Change, type JournalEntry } from "../storage/changeJournal";
import { verifyImageAsset } from "./security/imageAsset";
import { blobToDataUrl } from "../storage/blobStore";
import type { BoardImage } from "../types";
import type { CollaborationSecurityOptions } from "./manager";
import type { VerifiedSessionContext } from "./security/session";
import type { RxRepository } from "../storage/rxdbRepository";
import { MAX_IMAGE_FILE_BYTES } from "../images/processing";

const KIND = "pboard-history";
const MAX_BYTES = 512 * 1024, MAX_RECORDS = 10000;
/**
 * The most rounds one exchange may spend. A round offers the records the
 * peer still needs, so a board with a long history needs more rounds; the
 * bound keeps a peer that keeps changing the history from stalling forever.
 */
const MAX_EXCHANGE_ROUNDS = 4096;
const IMAGE_PART = 32 * 1024;
const MAX_IMAGE_JSON = Math.ceil(MAX_IMAGE_FILE_BYTES * 4 / 3) + 2048;
const clean = ({ version, id, boardId, collection, documentId, parents, ancestry, value }: Change): Change => ({ version, id, boardId, collection, documentId, parents, ancestry, value });
type Record = { change: Change; proof?: JournalProof; admission?: HistoryAdmission };
type Frame = { kind: typeof KIND; version: 1; op: string; id: string; [key: string]: unknown };
export type PeerHistorySession = { receive(frame: unknown): Promise<void>; flush(): Promise<void>; requestImages(ids: string[]): Promise<void>; requestContentKey(): Promise<boolean>; close(): void };
export const isHistoryFrame = (value: unknown): boolean => !!value && typeof value === "object" && "kind" in value && value.kind === KIND;
const hashIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 16 || value.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || new Set(value).size !== value.length) throw new Error("Invalid history identity list");
  return value as string[];
};

/** Bounded history and explicitly requested board attachments. No private drafts or account settings. */
export function createPeerHistorySession(options: {
  repository: RxRepository; security: CollaborationSecurityOptions; context: VerifiedSessionContext;
  send(frame: unknown): void | Promise<void>; active(): boolean; onError(error: Error): void;
  beforeReceive?(): Promise<void>;
  /** Buffer content keys travel only writer-to-writer on this authenticated channel. */
  keyExchange?: { load(boardId: string): Promise<{ material: string; keyId: string } | undefined>; store(boardId: string, value: { material: string; keyId: string }): Promise<void> };
}): PeerHistorySession {
  const { repository: rx, security, context } = options;
  let closed = false, supported = false, announced = false;
  let negotiate!: () => void;
  const negotiated = new Promise<void>(resolve => { negotiate = resolve; });
  const capabilityTimer = setTimeout(() => negotiate(), 1500);
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  const delivered = new Set<string>();
  /**
   * The records the peer confirmed it already holds. The peer verifies a
   * record it has and answers with an empty request, which means the record is
   * delivered. Keeping that answer for the whole session stops the same
   * record from being offered again in every later exchange.
   */
  const confirmed = new Set<string>();
  /**
   * Already verified history records, by change id. Verifying a record means
   * checking its author signature against the board manifest, which is
   * expensive relative to a local edit. A committed journal row does not
   * change, so its verification stays valid while the board's authorization
   * does. The cache is dropped when the session closes.
   */
  const verifiedRecords = new Map<string, Record>();
  const pending = new Map<string, { resolve(frame: Frame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const offered = new Set<string>();
  const requestedImages = new Set<string>();
  let requestingImages = false, servingImages = false;
  let imageAssembly: { imageId: string; total: number; next: number; bytes: number; parts: string[] } | null = null;
  let imageTimer: ReturnType<typeof setTimeout> | undefined;
  let assemblyTimer: ReturnType<typeof setTimeout> | undefined;
  let rate = { start: Date.now(), count: 0 };
  let assembly: { id: string; next: number; total: number; bytes: number; parts: string[] } | null = null;
  function authorize() {
    if (closed || !options.active() || !manifestIsCurrent(security.manifest, Date.now())
      || context.boardId !== security.boardId || !["cards", "projects"].includes(context.collection)
      || context.manifestHash !== manifestHash(security.manifest)
      || !security.manifest.devices.some(d => d.deviceKeyId === context.remoteDeviceKeyId)
      || !security.manifest.devices.some(d => d.deviceKeyId === context.ownDeviceKeyId)) throw new Error("History session is no longer authorized");
  }
  let outbound: Promise<void> = Promise.resolve();
  function send(frame: Frame): Promise<void> {
    const work = outbound.then(async () => {
      authorize();
      const text = JSON.stringify(frame);
      if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("History record exceeds the 512 KiB transfer limit; local history is retained");
      if (text.length <= 8192 || frame.op === "image-part") { await options.send(frame); return; }
      const id = crypto.randomUUID(), total = Math.ceil(text.length / 8192);
      for (let index = 0; index < total; index++) {
        authorize();
        await options.send({ kind: KIND, version: 1, op: "chunk", id, index, total, data: text.slice(index * 8192, (index + 1) * 8192) });
      }
    });
    outbound = work.catch(() => {});
    return work;
  }
  function request(op: string, fields: object): Promise<Frame> {
    if (pending.size >= 4) return Promise.reject(new Error("History request quota exceeded"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("History acknowledgement timed out; delivery remains pending")); }, op === "image-want" ? 120000 : 10000);
      pending.set(id, { resolve, reject, timer });
      void send({ kind: KIND, version: 1, op, id, ...fields }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  function ids(value: unknown): string[] { return hashIds(value); }
  async function boardImageIds() {
    // Use verified, portable signed history, never the global blob inventory or
    // local pending overlays. Retained signed variants may still need their images.
    return new Set((await records("cards")).flatMap(record => typeof record.change.value.imageId === "string" ? [record.change.value.imageId] : []));
  }
  async function answerImages(wanting: string[]) {
    const allowed = await boardImageIds();
    if (wanting.some(id => !allowed.has(id))) throw new Error("Image is not authorized for this board");
    for (const imageId of wanting) {
      authorize();
      const stored = await rx.blobs.getBlob(imageId);
      if (!stored) throw new Error("A requested image is unavailable; transfer remains pending");
      const dataUrl = await blobToDataUrl(stored.blob);
      const image = { dataUrl, mimeType: stored.mimeType, width: stored.width, height: stored.height };
      await verifyImageAsset(imageId, image);
      const text = JSON.stringify(image);
      const checkAck = (ack: Frame) => {
        if (ack.op !== "image-ack" || canonicalize(ids(ack.ids)) !== canonicalize([imageId])) throw new Error("Invalid image acknowledgement");
      };
      if (text.length < MAX_BYTES - 1024) checkAck(await request("image-put", { imageId, image }));
      else {
        if (text.length > MAX_IMAGE_JSON) throw new Error("Image exceeds the attachment transfer limit");
        const total = Math.ceil(text.length / IMAGE_PART);
        for (let index = 0; index < total; index++) {
          // Stop-and-wait bounds the DataChannel queue. Pacing stays below the
          // existing receive rate limit, including on fast local transports.
          await new Promise(resolve => setTimeout(resolve, 12));
          authorize();
          checkAck(await request("image-part", { imageId, index, total, data: text.slice(index * IMAGE_PART, (index + 1) * IMAGE_PART) }));
        }
      }
    }
  }
  async function requestImages(wanting: string[]) {
    if (!wanting.length || context.collection !== "cards") return;
    if (requestingImages) throw new Error("Attachment request already in progress");
    hashIds(wanting); await negotiated; authorize();
    if (!supported) throw new Error("Peer attachment capability is unavailable");
    requestingImages = true;
    try {
      for (const imageId of wanting) {
        requestedImages.add(imageId);
        const ack = await request("image-want", { ids: [imageId] });
        if (ack.op !== "image-done" || canonicalize(ids(ack.ids)) !== canonicalize([imageId]) || requestedImages.has(imageId)) throw new Error("Incomplete image transfer");
      }
    } finally { requestingImages = false; requestedImages.clear(); imageAssembly = null; clearTimeout(imageTimer); }
  }
  async function records(collection = context.collection): Promise<Record[]> {
    const entries = (await rx.journal.entries.where("boardId").equals(security.boardId).toArray()).filter(e => e.state === "committed" && e.collection === collection);
    if (entries.length > MAX_RECORDS) throw new Error("Peer history exceeds this client's 10000-record window; local history is retained");
    const result = new Map<string, Record>();
    const portable = portableJournalChanges(entries);
    for (const entry of entries) {
      if (!entry.value._sec) continue; // Pre-enrollment private history is never disclosed.
      // A committed entry that was already verified for this board does not
      // need its signature checked again: the journal is append-only for
      // committed rows, and a cached verification stays valid until the
      // board's authorization changes.
      const cached = verifiedRecords.get(entry.id);
      if (cached) { result.set(entry.id, cached); continue; }
      const proof = portable.has(entry.id) ? entry.proof : undefined;
      const change = proof ? clean(entry) : await makeChange({ ...clean(entry), parents: [], ancestry: "unknown" });
      try {
        await validateChange(change); validateRecord(change); await verifyJournalChange(change, proof, security, (change.id === entry.id ? entry.admission : entries.find(e => e.id === change.id)?.admission));
        const admission = ((change.id === entry.id ? entry.admission : entries.find(e => e.id === change.id)?.admission)) ?? await certifyHistory(change, proof, security);
        if (admission && change.id === entry.id && !entry.admission) await rx.journal.entries.update(entry.id, { admission });
        if (admission && change.id !== entry.id && !entries.some(e => e.id === change.id && e.admission)) await rx.journal.accept([{ ...change, admission, state: 'committed', origin: 'observed' }]);
        const record: Record = { change, ...(proof ? { proof } : {}), ...(admission ? { admission } : {}) };
        verifiedRecords.set(entry.id, record);
        result.set(change.id, record);
      } catch { /* Historical authorization unavailable: retain locally, never attest it as a relay. */ }
    }
    return [...result.values()].sort((a, b) => a.change.id.localeCompare(b.change.id));
  }
  async function exchange() {
    authorize();
    // The board's history is read once for the whole exchange. Reading it
    // again in every round re-read and re-verified the whole log, so the
    // cost of one exchange grew with the square of the history.
    const history = await records();
    // One round offers the records that the peer still needs. A board with a
    // long history therefore needs more rounds than a small one: the budget
    // follows the pending work, so a large history is transferred completely
    // instead of failing after a fixed number of rounds.
    const pending = history.filter(record => !delivered.has(record.change.id) && !confirmed.has(record.change.id));
    const maxRounds = Math.min(MAX_EXCHANGE_ROUNDS, Math.max(8, pending.length + 8));
    for (let round = 0; round < maxRounds; round++) {
      const work = history.filter(record => !delivered.has(record.change.id) && !confirmed.has(record.change.id));
      if (!work.length) return;
      // A round that offers nothing new has nothing left to deliver. The
      // records it skipped were already delivered or confirmed, so the
      // exchange is complete even though the work list was not empty.
      let offered = 0;
      for (const record of work) {
        if (delivered.has(record.change.id) || confirmed.has(record.change.id)) continue;
        offered++;
        const wanted = await request("offer", { ids: [record.change.id] });
        if (wanted.op !== "wanted") throw new Error("Unexpected history response");
        const missing = ids(wanted.ids);
        if (missing.some(id => id !== record.change.id)) throw new Error("History requested an unoffered change");
        if (missing.length) {
          const ack = await request("put", { records: [record] });
          if (ack.op !== "ack" || canonicalize(ids(ack.ids)) !== canonicalize([record.change.id])) throw new Error("Invalid history acknowledgement");
        } else {
          // The peer already holds this record and verified it. It is delivered
          // from this side's point of view, so it is not offered again. Without
          // this the same record was offered in every round and the exchange
          // never settled.
          confirmed.add(record.change.id);
        }
        authorize();
        // Normalized legacy roots need not exist in our journal: only original IDs receive receipts.
        const local = await rx.journal.entries.get(record.change.id);
        if (local?.state === "committed") await rx.journal.acknowledge(record.change.id, `peer:${security.boardId}:${context.remoteDeviceKeyId}`);
        delivered.add(record.change.id);
      }
      if (!offered) return;
    }
    // The rounds ran out with work left. The records that remain are retained
    // locally and offered again by the next exchange.
    throw new Error("History changed continuously during transfer; delivery remains pending");
  }
  async function flush() {
    await negotiated;
    if (closed || !supported) return; // Explicit capability absence retains the existing RxDB path.
    // A running scan may have read before this caller's commit. Wait for it,
    // then establish a fresh barrier before releasing ordinary RxDB messages.
    // A rejection that races close() is a benign session end: close rejects
    // outstanding acknowledgements while callers in the RxDB send path have
    // no meaning for them anymore, and un-retaining the rejection here is
    // what surfaces as an unhandled rejection at teardown.
    const settle = async (work: Promise<void>) => {
      try { await work; } catch (error) { if (!closed) throw error; }
    };
    const previous = running;
    if (previous) await settle(previous);
    if (closed) return;
    if (!running) running = exchange().finally(() => { running = null; });
    await settle(running);
  }
  function wake() {
    if (closed || scheduled) return;
    scheduled = setTimeout(() => { scheduled = undefined; void flush().then(async () => {
      if (supported && !closed) await rx.privateRecovery.apply(security.boardId, async () => { authorize(); return !await rx.isDeletedProject(security.boardId); });
    }).catch(fail); }, 75);
  }
  function fail(error: unknown) { if (!closed) options.onError(new Error(error instanceof Error ? error.message : "Peer history failed")); }
  const unsubscribe = rx.journal.subscribe(wake);
  async function receive(raw: unknown): Promise<void> {
    authorize();
    if (Date.now() - rate.start >= 1000) rate = { start: Date.now(), count: 0 };
    if (++rate.count > 200) throw new Error("History message rate exceeded");
    const frame = raw as Frame;
    if (!frame || frame.kind !== KIND || frame.version !== 1 || typeof frame.id !== "string" || frame.id.length > 100) throw new Error("Invalid history frame");
    const allowed: { [op: string]: string[] } = { hello: [], chunk: ["index", "total", "data"], offer: ["ids"], wanted: ["ids"], put: ["records"], ack: ["ids"], "image-want": ["ids"], "image-put": ["imageId", "image"], "image-part": ["imageId", "index", "total", "data"], "image-ack": ["ids"], "image-done": ["ids"], "key-want": [], "key-put": ["material", "keyId"] };
    if (!Object.hasOwn(allowed, frame.op) || Object.keys(frame).some(key => !["kind", "version", "op", "id", ...allowed[frame.op]].includes(key))) throw new Error("Unknown history operation or field");
    if (frame.op === "chunk") {
      if (!Number.isSafeInteger(frame.index) || !Number.isSafeInteger(frame.total) || Number(frame.total) < 2 || Number(frame.total) > 64
        || typeof frame.data !== "string" || frame.data.length > 8192) throw new Error("Invalid history chunk");
      if (!assembly) {
        if (frame.index !== 0) throw new Error("Out-of-order history chunk");
        assembly = { id: frame.id, next: 0, total: Number(frame.total), bytes: 0, parts: [] };
        assemblyTimer = setTimeout(() => { assembly = null; fail(new Error("History chunk assembly timed out")); }, 10000);
      }
      if (assembly.id !== frame.id || frame.index !== assembly.next || frame.total !== assembly.total) throw new Error("Interleaved history chunks");
      assembly.bytes += new TextEncoder().encode(frame.data).length;
      if (assembly.bytes > MAX_BYTES) throw new Error("History assembly exceeds its quota");
      assembly.parts.push(frame.data); assembly.next++;
      if (assembly.next === assembly.total) {
        const complete = parseStrictJson(assembly.parts.join(""), MAX_BYTES); assembly = null; clearTimeout(assemblyTimer);
        if ((complete as unknown as Frame).op === "chunk") throw new Error("Nested history chunks");
        await receive(complete);
      }
      return;
    }
    if (frame.op === "hello") {
      if (announced) throw new Error("Repeated history capability");
      announced = true; supported = true; clearTimeout(capabilityTimer); negotiate(); wake(); return;
    }
    if (!supported) throw new Error("History capability was not negotiated");
    if (["wanted", "ack", "image-ack", "image-done"].includes(frame.op)) {
      const waiting = pending.get(frame.id);
      if (!waiting) throw new Error("Unsolicited history response");
      pending.delete(frame.id); clearTimeout(waiting.timer); waiting.resolve(frame); return;
    }
    if (frame.op === "key-want") {
      // Serving a content key requires: board grant present, this device holds
      // one, and the requesting peer is itself owner/editor on the manifest.
      if (!options.keyExchange || context.collection !== "cards" || (context.remoteRole !== "owner" && context.remoteRole !== "editor")) return;
      const entry = await options.keyExchange.load(context.boardId);
      if (entry) await send({ kind: KIND, version: 1, op: "key-put", id: frame.id, material: entry.material, keyId: entry.keyId });
      return;
    }
    if (frame.op === "key-put") {
      const waiting = pending.get(frame.id);
      if (!waiting) throw new Error("Unsolicited content-key response");
      pending.delete(frame.id);
      clearTimeout(waiting.timer);
      const material = String(frame.material ?? ""), keyId = String(frame.keyId ?? "");
      if (!/^[0-9a-f]{16}$/.test(keyId) || !/^[A-Za-z0-9_-]{43}$/.test(material)) {
        waiting.reject(new Error("Invalid content-key response"));
        return;
      }
      if (options.keyExchange && context.remoteRole !== "viewer") await options.keyExchange.store(context.boardId, { material, keyId });
      waiting.resolve(frame);
      return;
    }
    if (frame.op === "image-want") {
      authorize();
      if (servingImages) throw new Error("Attachment serving quota exceeded");
      const wantIds = ids(frame.ids), wantId = frame.id;
      if (!wantIds.length) throw new Error("Empty attachment request");
      servingImages = true;
      // Serving is decoupled from the receive pipeline: the per-image acks flow
      // through receive while this task continues, so blocking here would
      // deadlock the single DataChannel frame chain. The request resolves on
      // image-done.
      void (async () => {
        try { await answerImages(wantIds); }
        finally { servingImages = false; }
        authorize();
        await send({ kind: KIND, version: 1, op: "image-done", id: wantId, ids: wantIds });
      })().catch(fail);
      return;
    }
    if (frame.op === "image-part") {
      if (context.collection !== "cards" || typeof frame.imageId !== "string" || !requestedImages.has(frame.imageId)) throw new Error("Unrequested board image");
      if (!Number.isSafeInteger(frame.index) || !Number.isSafeInteger(frame.total) || Number(frame.total) < 2
        || Number(frame.total) > Math.ceil(MAX_IMAGE_JSON / IMAGE_PART) || typeof frame.data !== "string" || !frame.data.length || frame.data.length > IMAGE_PART) throw new Error("Invalid image part");
      if (!imageAssembly) {
        if (frame.index !== 0) throw new Error("Out-of-order image part");
        imageAssembly = { imageId: frame.imageId, total: Number(frame.total), next: 0, bytes: 0, parts: [] };
      }
      const assembly = imageAssembly;
      if (assembly.imageId !== frame.imageId || assembly.total !== frame.total || assembly.next !== frame.index) throw new Error("Interleaved or stale image part");
      assembly.bytes += new TextEncoder().encode(frame.data).length;
      if (assembly.bytes > MAX_IMAGE_JSON) throw new Error("Image assembly exceeds its quota");
      assembly.parts.push(frame.data); assembly.next++;
      clearTimeout(imageTimer);
      imageTimer = setTimeout(() => { imageAssembly = null; fail(new Error("Image assembly timed out")); }, 10000);
      if (assembly.next === assembly.total) {
        const image = parseStrictJson(assembly.parts.join(""), MAX_IMAGE_JSON) as unknown as BoardImage;
        imageAssembly = null; clearTimeout(imageTimer);
        const blob = await verifyImageAsset(frame.imageId, image);
        authorize();
        await rx.blobs.putBlob(blob, image); requestedImages.delete(frame.imageId);
      }
      await send({ kind: KIND, version: 1, op: "image-ack", id: frame.id, ids: [frame.imageId] }); return;
    }
    if (frame.op === "image-put") {
      if (typeof frame.imageId !== "string" || !/^[a-f0-9]{64}$/.test(frame.imageId)) throw new Error("Invalid image identity");
      if (context.collection !== "cards" || !requestedImages.has(frame.imageId) || imageAssembly) throw new Error("Unrequested board image");
      // The receiver independently derives the hash: no remote claim is trusted.
      const verifiedBlob = await verifyImageAsset(frame.imageId, frame.image as BoardImage);
      authorize();
      await rx.blobs.putBlob(verifiedBlob, frame.image as BoardImage);
      requestedImages.delete(frame.imageId);
      await send({ kind: KIND, version: 1, op: "image-ack", id: frame.id, ids: [frame.imageId] });
      return;
    }
    if (frame.op === "offer") {
      // One change may be in flight at a time. The offered set is released
      // when the change arrives, or when the peer answers that it already
      // holds the record, so the next offer is accepted.
      if (offered.size) throw new Error("History offer quota exceeded");
      const asked = ids(frame.ids);
      const wanted: string[] = [];
      for (const id of asked) {
        const entry = await rx.journal.entries.get(id);
        if (!entry || entry.state !== "committed" || entry.boardId !== security.boardId || entry.collection !== context.collection || !entry.proof && entry.ancestry !== "unknown" || !entry.admission && !security.manifest.devices.some(d => d.deviceKeyId === (entry.value._sec as any)?.provenance?.authorKeyId && d.role !== "viewer")) { wanted.push(id); offered.add(id); }
        else {
          // Presence in a private recovery file is not itself proof of peer
          // authorization. Reverify stored evidence before confirming delivery.
          // The peer holds this record, so nothing is in flight for it and the
          // next offer is accepted.
          await validateChange(entry); validateRecord(entry); await verifyJournalChange(entry, entry.proof, security, entry.admission);
        }
      }
      await send({ kind: KIND, version: 1, op: "wanted", id: frame.id, ids: wanted }); return;
    }

    if (frame.op === "put") {
      if (!Array.isArray(frame.records) || frame.records.length !== 1) throw new Error("Invalid history batch");
      const entries: JournalEntry[] = [];
      for (const rawRecord of frame.records) {
        const record = rawRecord as Record;
        if (!record || !offered.has(record.change?.id)) throw new Error("Unrequested history change");
        if (record.change.collection !== context.collection) throw new Error("History belongs to another collection room");
        await validateChange(record.change); validateRecord(record.change); await verifyJournalChange(record.change, record.proof, security, record.admission);
        const admission = record.admission ?? await certifyHistory(record.change, record.proof, security);
        entries.push({ ...clean(record.change), ...(record.proof ? { proof: record.proof } : {}), ...(admission ? { admission } : {}), state: "committed", origin: "observed" });
      }
      authorize();
      // Persist private-backup intent before admission: a crash must not leave
      // a successful peer receipt with no recoverable account backup marker.
      await options.beforeReceive?.();
      authorize();
      // Admission metadata is verified above, before any guarded projection.
      // Persist it first so old-author source bytes can be reverified locally.
      await rx.journal.accept(entries);
      authorize();
      // Reuse the exact guarded materialization path. No remote value is signed here.
      await rx.privateRecovery.apply(security.boardId, async () => { authorize(); return !await rx.isDeletedProject(security.boardId); });
      authorize();
      entries.forEach(e => offered.delete(e.id));
      await send({ kind: KIND, version: 1, op: "ack", id: frame.id, ids: entries.map(e => e.id) }); return;
    }
    throw new Error("Unknown history operation");
  }
  async function requestContentKey(): Promise<boolean> {
    authorize();
    if (!options.keyExchange || context.collection !== "cards") return false;
    const ownRole = security.manifest.devices.find(device => device.deviceKeyId === context.ownDeviceKeyId)?.role;
    if (ownRole !== "owner" && ownRole !== "editor") return false;
    if (await options.keyExchange.load(context.boardId)) return true;
    try {
      const frame = await request("key-want", {});
      const material = String(frame.material ?? ""), keyId = String(frame.keyId ?? "");
      if (!/^[0-9a-f]{16}$/.test(keyId) || !/^[A-Za-z0-9_-]{43}$/.test(material)) throw new Error("Invalid content-key response");
      await options.keyExchange.store(context.boardId, { material, keyId });
      return true;
    } catch {
      return false;
    }
  }
  void send({ kind: KIND, version: 1, op: "hello", id: crypto.randomUUID() }).catch(fail);
  return { receive, flush, requestImages, requestContentKey, close() {
    if (closed) return; closed = true; unsubscribe(); clearTimeout(capabilityTimer); clearTimeout(scheduled); clearTimeout(assemblyTimer); clearTimeout(imageTimer); negotiate(); assembly = null; imageAssembly = null; offered.clear(); requestedImages.clear(); verifiedRecords.clear();
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("History session closed before acknowledgement")); }
    pending.clear();
  } };
}

import { verifyManifest } from "../collab/security/manifest";
import { publicKeyFingerprint } from "../collab/security/keys";
import { validatePending } from "../storage/pendingWork";
import type { JournalProof, HistoryAdmission } from "../collab/security/journalProof";
import { canonicalize, parseStrictJson, type Json } from "../collab/security/canonical";
import { validateChange, validateRecord } from "../storage/causalReconciliation";
import { type Change, type ConflictDraft, type PendingEdit, type PublicGrant } from "../storage/changeJournal";
import { blobToDataUrl, hashBlob, imageToBlob } from "../storage/blobStore";
import type { RxRepository } from "../storage/rxdbRepository";
import type { DriveAppDataFile, DriveTransport } from "./driveTransport";
import type { ProjectSnapshot, ProjectSnapshotStore } from "./snapshot";
import { deserializeProjectSnapshot } from "./snapshot";
import { reconcile } from "../storage/causalReconciliation";
import { scope } from "../storage/changeJournal";

const LIMIT = 32 * 1024 * 1024;
type SavedImage = { imageId: string; dataUrl: string; mimeType: string; width: number; height: number };
type SavedDraft = Omit<ConflictDraft, "id">;
type Bundle = { format: "pboard-private-history"; version: 1; boardId: string; changes: Change[]; proofs?: JournalProof[]; admissions?: HistoryAdmission[]; pending?: PendingEdit[]; grants?: PublicGrant[]; images: SavedImage[]; drafts: SavedDraft[]; snapshots: string[] };
const cleanPending = (edit: PendingEdit): PendingEdit => {
  const { admittedChangeId: _, projected: __, ...value } = edit;
  return { ...value, base: cleanChange(value.base), supersedes: value.supersedes ?? [] };
};
type Saved = { file: DriveAppDataFile; value: Bundle; digest: string };
const json = (value: unknown) => canonicalize(value as Json);
const digest = (value: unknown) => hashBlob(new Blob([json(value)]));
const cleanChange = ({ version, id, boardId, collection, documentId, parents, ancestry, value }: Change): Change => ({ version, id, boardId, collection, documentId, parents, ancestry, value });
export const snapshotFingerprint = (snapshot: ProjectSnapshot) => digest({ project: snapshot.project, items: snapshot.items });


export interface PrivateDriveHistory {
  available(): Promise<boolean>;
  /** The durable per-board account binding recorded at first private persistence; null when never uploaded. */
  boundAccount(rx: RxRepository, boardId: string): Promise<string | null>;
  /** Repository-free convenience form of boundAccount. */
  boundAccountFor(boardId: string): Promise<string | null>;
  /** Optionally isolate unreadable archives while discovering other boards. */
  boards(onError?: (error: unknown) => void): Promise<string[]>;
  sync(boardId: string, legacy: ProjectSnapshot[], canApply: () => Promise<boolean>): Promise<DriveTransport | null>;
  flushErasures?(): Promise<void>;
  erasureStatus?(boardId: string): Promise<{ cloudPending: boolean } | undefined>;
}

/** Append-only, authenticated ACCOUNT-PRIVATE persistence. Never a board grant. */
export function createPrivateDriveHistory(options: {
  transport: DriveTransport; snapshots: ProjectSnapshotStore;
  getRepository(): Promise<RxRepository | null>;
  getAccountId(): Promise<string | null>;
  captureSession?(): Promise<{ account: string; history: DriveTransport; snapshots: DriveTransport; erasures?: DriveTransport; images?: DriveTransport } | null>;
  snapshotTransport?: DriveTransport;
  erasureTransport?: DriveTransport;
  imageTransport?: DriveTransport;
}): PrivateDriveHistory {
  const { transport } = options;
  /**
   * The archives this device has already downloaded, parsed and verified, by
   * the file's content fingerprint.
   *
   * The archive's name carries its content fingerprint, and an archive is
   * immutable: the same fingerprint always means the same bytes. The sidebar
   * reconciles every 30 seconds, and every reconciliation used to download
   * and re-verify every archive of every board. The archives grow with the
   * board's history, so that cost grew without bound and ran on the sidebar's
   * main thread. A verified fingerprint is remembered and its bytes are not
   * downloaded again.
   */
  const verifiedArchives = new Map<string, Saved>();
  /** The file id a verified fingerprint was seen under, so a renamed file is fetched again. */
  const verifiedFileIds = new Map<string, string>();

  async function read(file: DriveAppDataFile, using = transport, downloaded?: string): Promise<Saved> {
    const contents = downloaded ?? await using.download(file.id);
    const value = parseStrictJson(contents, LIMIT) as unknown as Bundle;
    if (!value || value.format !== "pboard-private-history" || value.version !== 1 || typeof value.boardId !== "string"
      || !Array.isArray(value.changes) || value.changes.length > 128 || !Array.isArray(value.images) || value.images.length > 128
      || !Array.isArray(value.drafts) || value.drafts.length > 128 || !Array.isArray(value.snapshots) || value.snapshots.length > 128
      || value.snapshots.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid private recovery history");
    if (value.proofs !== undefined && (!Array.isArray(value.proofs) || value.proofs.length > 128
      || value.proofs.some(proof => !proof?.payload || typeof proof.signature !== "string" || !value.changes.some(change => change.id === proof.payload.changeId && change.boardId === proof.payload.boardId)))) throw new Error("Invalid private history proofs");
    if (value.grants !== undefined && (!Array.isArray(value.grants) || value.grants.length > 128)) throw new Error('Invalid private public-grant batch');
    for (const grant of value.grants ?? []) {
      const pin = await publicKeyFingerprint(grant.authority), m = await verifyManifest(grant.manifest, grant.authority, pin);
      if (grant.boardId !== value.boardId || m.boardId !== value.boardId || grant.id !== JSON.stringify([value.boardId, pin, m.epoch])) throw new Error('Private public grant binding mismatch');
    }
    if (value.pending !== undefined && (!Array.isArray(value.pending) || value.pending.length > 128)) throw new Error("Invalid private pending work batch");
    for (const edit of value.pending ?? []) await validatePending(edit, value.boardId);
    if (value.admissions !== undefined && (!Array.isArray(value.admissions) || value.admissions.length > 128 || value.admissions.some(a => !a?.payload || typeof a.signature !== 'string' || !value.changes.some(c => c.id === a.payload.changeId && c.boardId === a.payload.boardId)))) throw new Error("Invalid private admission metadata");
    for (const change of value.changes) {
      await validateChange(change);
      validateRecord(change);
      if (change.boardId !== value.boardId) throw new Error("Private history contains a cross-board change");
    }
    const fingerprint = await digest(value);
    if (file.name !== `history-${value.boardId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${fingerprint}.pboard`) throw new Error("Private history content identity mismatch");
    return { file, value, digest: fingerprint };
  }
  async function all(using = transport, boardId?: string, onError?: (error: unknown) => void): Promise<Saved[]> {
    const files = await using.listProjectFiles();
    if (files.length > 10000) throw new Error("Private history inventory exceeds this client's recovery limit");
    const result: Saved[] = [];
    let bytes = 0;
    // Bounded processing, not an unbounded Promise.all of private data downloads.
    for (const file of files) {
      if (boardId !== undefined) {
        const prefix = `history-${boardId.replace(/[^a-zA-Z0-9_-]/g, '_')}_`;
        if (!file.name.startsWith(prefix) || !/^[a-f0-9]{64}\.pboard$/.test(file.name.slice(prefix.length))) continue;
      }
      // The archive's name carries its content fingerprint, and an archive is
      // immutable, so an archive this device already verified is not fetched
      // and parsed again.
      const fingerprint = /_([a-f0-9]{64})\.pboard$/.exec(file.name)?.[1];
      const known = fingerprint ? verifiedArchives.get(fingerprint) : undefined;
      if (fingerprint && known && verifiedFileIds.get(fingerprint) === file.id) {
        result.push(known);
        continue;
      }
      let contents: string;
      try { contents = await using.download(file.id); }
      catch (error) { if (!onError) throw error; onError(error); continue; }
      // Invalid archives still count against the aggregate processing limit.
      bytes += new TextEncoder().encode(contents).length;
      if (bytes > 128 * 1024 * 1024) throw new Error("Private history exceeds this client's 128 MiB recovery window; data is retained");
      try {
        const saved = await read(file, using, contents);
        if (fingerprint) {
          verifiedArchives.set(fingerprint, saved);
          verifiedFileIds.set(fingerprint, file.id);
        }
        result.push(saved);
      }
      catch (error) { if (!onError) throw error; onError(error); }
    }
    return result;
  }
  async function bind(rx: RxRepository, boardId: string, account: string) {
    const id = `privateDrive:${await hashBlob(new Blob([boardId]))}`;
    let current = await rx.db.settings.findOne(id).exec();
    if (!current) {
      try { await rx.db.settings.insert({ id, value: account }); }
      catch (error) { if (!await rx.db.settings.findOne(id).exec()) throw error; }
      current = await rx.db.settings.findOne(id).exec();
    }
    if (current?.value !== account) throw new Error("This board is bound to another private Drive account. Its local data is retained.");
  }
  /** The durable per-board account binding recorded at first private persistence; null when never uploaded. */
  async function boundAccount(rx: RxRepository, boardId: string): Promise<string | null> {
    const current = await rx.db.settings.findOne(`privateDrive:${await hashBlob(new Blob([boardId]))}`).exec();
    return typeof current?.value === "string" ? current.value : null;
  }
  async function sync(boardId: string, legacy: ProjectSnapshot[], canApply: () => Promise<boolean>): Promise<DriveTransport | null> {
    const session = options.captureSession ? await options.captureSession() : null;
    const rx = await options.getRepository(), account = session?.account ?? await options.getAccountId();
    if (!rx || !account || options.captureSession && !session) return null;
    const using = session?.history ?? transport, compatibility = session?.snapshots ?? options.snapshotTransport;
    /**
     * Whether the connected account is still the one this sync started with.
     *
     * The account was read once, above. The check used to read it again on
     * every call, and one board's sync makes several, so the account's
     * identity was fetched from Drive repeatedly during a single sync. The
     * account cannot change in the middle of a sync, so the check compares
     * against the value read at the start, and the account is read again once
     * when the sync is about to finish.
     */
    let accountChanged = false;
    let accountChecked = false;
    const currentSession = async () => {
      if (accountChanged) return false;
      if (accountChecked) return true;
      const current = await options.getAccountId();
      accountChecked = true;
      if (current === account) return true;
      accountChanged = true;
      return false;
    };
    if (!await currentSession()) return null;
    const erasures = session?.erasures ?? options.erasureTransport;
    if (erasures) {
      const erased = await erasures.findProjectFile(boardId);
      if (erased) {
        const value = parseStrictJson(await erasures.download(erased.id)) as any;
        if (value.format !== 'pboard-board-erasure' || value.version !== 1 || value.boardId !== boardId) throw new Error('Invalid private board erasure');
        if (!await currentSession()) return null;
        await rx.applyPrivateBoardErasure(boardId, account); return null;
      }
    }
    if (await rx.journal.boardErasure(boardId)) return null;
    await bind(rx, boardId, account);
    const archives = (await all(using, boardId)).filter(saved => saved.value.boardId === boardId);
    if (session) {
      legacy = [];
      const name = `project-${boardId.replace(/[^a-zA-Z0-9_-]/g, "_")}.pboard`;
      for (const file of await session.snapshots.listProjectFiles()) if (file.name === name) {
        const snapshot = deserializeProjectSnapshot(await session.snapshots.download(file.id));
        if (snapshot.project.id !== boardId) throw new Error("Private snapshot board binding mismatch");
        legacy.push(snapshot);
      }
    }
    if (!await currentSession()) return null;
    await rx.privateRecovery.capture(boardId);
    const knownSnapshots = new Set(archives.flatMap(saved => saved.value.snapshots));
    // Match a local v1 projection before interpreting an old-client snapshot as
    // an unknown branch. Absence of a card in v1 is never a deletion proof.
    const local = await options.snapshots.read(boardId).catch(() => null);
    const localFingerprint = local && await snapshotFingerprint(local);
    const observedSnapshots: string[] = [];
    for (const snapshot of legacy) {
      const id = await snapshotFingerprint(snapshot); observedSnapshots.push(id);
      if (knownSnapshots.has(id) || localFingerprint === id) continue;
      const changes = await rx.privateRecovery.legacyChanges(snapshot);
      for (const change of changes) { await validateChange(change); validateRecord(change); }
      await rx.journal.accept(changes.map(change => ({ ...change, state: "committed" as const, origin: "observed" as const })));
    }
    for (const archive of archives) {
      const decoded: Array<{ blob: Blob; image: SavedImage }> = [];
      for (const image of archive.value.images) {
        if (!image || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/") || typeof image.mimeType !== "string"
          || !image.mimeType.startsWith("image/") || !Number.isFinite(image.width) || image.width <= 0 || !Number.isFinite(image.height) || image.height <= 0) throw new Error("Invalid private history image");
        const blob = await imageToBlob(image.dataUrl);
        if (await hashBlob(blob) !== image.imageId) throw new Error("Private history image identity mismatch");
        decoded.push({ blob, image });
      }
      for (const draft of archive.value.drafts) {
        if (!draft || typeof draft.target !== "string" || JSON.parse(draft.target)[0] !== boardId || typeof draft.writerId !== "string"
          || typeof draft.content !== "string" || typeof draft.title !== "string" || !Array.isArray(draft.heads)
          || draft.heads.some(id => typeof id !== "string") || typeof draft.variantId !== "string") throw new Error("Invalid private history draft");
      }
      if (!await currentSession()) return null;
      for (const { blob, image } of decoded) await rx.blobs.putBlob(blob, image);
      // This is recovery of a user's private copy, not peer authentication.
      // No live signing hook runs here; mutation guards still verify projections.
      await rx.journal.accept(archive.value.changes.map(change => ({ ...cleanChange(change), ...(archive.value.admissions?.find(a => a.payload.changeId === change.id) ? { admission: archive.value.admissions.find(a => a.payload.changeId === change.id)! } : {}), ...(archive.value.proofs?.find(proof => proof.payload.changeId === change.id) ? { proof: archive.value.proofs.find(proof => proof.payload.changeId === change.id)! } : {}), state: "committed" as const, origin: "observed" as const })));
      for (const grant of archive.value.grants ?? []) {
        const existing = await rx.journal.publicGrants.get(grant.id);
        if (existing && json(existing) !== json(grant)) throw new Error('Private public grant history fork rejected');
        if (!existing) await rx.journal.publicGrants.put(grant);
      }
      for (const edit of archive.value.pending ?? []) {
        // Immutable draft identity wins over a stale archive; delivery flags are local.
        await rx.journal.restorePendingWork(edit, existing => {
          if (json(cleanPending(existing)) !== json(cleanPending(edit))) throw new Error("Private pending work identity conflict");
        });
      }
      const drafts = await rx.journal.drafts.toArray();
      for (const draft of archive.value.drafts) {
        if (drafts.some(({ id: _, ...existing }) => json(existing) === json(draft))) continue;
        await rx.journal.drafts.put({ ...draft, id: `private:${await digest(draft)}` });
      }
    }
    // Account HTTP must never run while the repository's local command queue is
    // locked. Check it before entering; the per-write guard below is local-only.
    if (await currentSession() && await canApply()) await rx.privateRecovery.apply(boardId, canApply);
    if (!await currentSession()) return null;
    const committed = (await rx.journal.entries.where("boardId").equals(boardId).toArray()).filter(e => e.state === "committed");
    const proofs = new Map(committed.filter(e => e.proof).map(e => [e.id, e.proof!]));
    const admissions = new Map(committed.filter(e => e.admission).map(e => [e.id, e.admission!]));
    const remoteAdmissions = new Set(archives.flatMap(saved => (saved.value.admissions ?? []).map(a => a.payload.changeId)));
    const remoteProofs = new Set(archives.flatMap(saved => (saved.value.proofs ?? []).map(proof => proof.payload.changeId)));
    let changes = committed.map(cleanChange);
    const remotelySaved = new Set(archives.flatMap(saved => saved.value.changes.map(c => c.id)));
    changes = changes.filter(change => !remotelySaved.has(change.id) || proofs.has(change.id) && !remoteProofs.has(change.id) || admissions.has(change.id) && !remoteAdmissions.has(change.id)).sort((a, b) => a.id.localeCompare(b.id));
    const drafts = (await rx.journal.drafts.toArray()).filter(draft => JSON.parse(draft.target)[0] === boardId)
      .map(({ id: _, ...draft }) => draft);
    const savedDrafts = new Set(archives.flatMap(saved => saved.value.drafts.map(json)));
    const pendingDrafts = drafts.filter(draft => !savedDrafts.has(json(draft)));
    const savedGrants = new Set(archives.flatMap(saved => (saved.value.grants ?? []).map(json)));
    const publicGrants = (await rx.journal.publicGrants.where('boardId').equals(boardId).toArray()).filter(g => !savedGrants.has(json(g)));
    const savedPending = new Set(archives.flatMap(saved => (saved.value.pending ?? []).map(edit => json(cleanPending(edit)))));
    // Preserve the entire immutable supersession chain. Omitting admitted
    // descendants can resurrect an older superseded draft on a fresh device.
    // Delivery flags stay local; signed history reconstructs exact admissions.
    const pendingWork = (await rx.journal.pendingEdits.toArray()).filter(e => e.boardId === boardId).map(cleanPending).filter(e => !savedPending.has(json(e)));
    const projection = await options.snapshots.read(boardId).catch(() => null);
    const fingerprints = [...new Set([...observedSnapshots, ...(projection ? [await snapshotFingerprint(projection)] : [])])].filter(id => !knownSnapshots.has(id));
    const destination = `private-drive:${account}`;
    let batchSize = 16;
    // No receipt can suppress missing remote data. List/read is authoritative.
    while (changes.length || pendingDrafts.length || pendingWork.length || publicGrants.length || fingerprints.length) {
      const work = pendingWork.splice(0, batchSize), grants = publicGrants.splice(0, batchSize);
      const batch = changes.splice(0, batchSize), batchDrafts = pendingDrafts.splice(0, batchSize), snapshots = fingerprints.splice(0, batchSize);
      for (const change of batch) { await validateChange(change); validateRecord(change); }
      const images: SavedImage[] = [];
      for (const imageId of new Set([...batch.map(c => c.value), ...work.flatMap(e => [e.value, e.base.value])].flatMap(value => typeof value.imageId === "string" ? [value.imageId] : []))) {
        const image = await rx.blobs.getBlob(imageId);
        if (!image) throw new Error("A retained image is missing; private recovery remains pending");
        images.push({ imageId, dataUrl: await blobToDataUrl(image.blob), mimeType: image.mimeType, width: image.width, height: image.height });
      }
      const value: Bundle = { format: "pboard-private-history", version: 1, boardId, changes: batch, images, drafts: batchDrafts, snapshots };
      const batchProofs = batch.flatMap(change => proofs.has(change.id) ? [proofs.get(change.id)!] : []);
      if (batchProofs.length) value.proofs = batchProofs;
      const batchAdmissions = batch.flatMap(change => admissions.has(change.id) ? [admissions.get(change.id)!] : []);
      if (batchAdmissions.length) value.admissions = batchAdmissions;
      if (work.length) value.pending = work;
      if (grants.length) value.grants = grants;
      const contents = json(value), fingerprint = await digest(value);
      if (new TextEncoder().encode(contents).length > LIMIT) {
        if (batchSize === 1) throw new Error("A private recovery record exceeds 32 MiB; local history is retained");
        publicGrants.unshift(...grants); pendingWork.unshift(...work); changes.unshift(...batch); pendingDrafts.unshift(...batchDrafts); fingerprints.unshift(...snapshots);
        batchSize = Math.ceil(batchSize / 2); continue;
      }
      if (!await currentSession()) return null;
      const key = `${boardId}_${fingerprint}`;
      const existing = await using.findProjectFile(key);
      if (existing) { if ((await read(existing, using)).digest !== fingerprint) throw new Error("Private recovery retry identity mismatch"); }
      else await using.upload(key, contents); // Never PATCH immutable history.
      if (!await currentSession()) return null;
      await rx.journal.acknowledgeMany(batch.map(change => change.id), destination);
      batch.forEach(change => remotelySaved.add(change.id));
      batchDrafts.forEach(draft => savedDrafts.add(json(draft)));
      work.forEach(edit => savedPending.add(json(edit)));
      grants.forEach(grant => savedGrants.add(json(grant)));
    }
    const received = [...remotelySaved];
    for (let index = 0; index < received.length; index += 128) await rx.journal.acknowledgeMany(received.slice(index, index + 128), destination);
    const latest = (await rx.journal.entries.where("boardId").equals(boardId).toArray()).filter(e => e.state === "committed");
    const latestDrafts = (await rx.journal.drafts.toArray()).filter(draft => JSON.parse(draft.target)[0] === boardId).map(({ id: _, ...draft }) => draft);
    const groups = new Map<string, Change[]>();
    for (const entry of latest) { const id = scope(entry), group = groups.get(id); if (group) group.push(entry); else groups.set(id, [entry]); }
    const completeAncestry = [...groups.values()].every(group => reconcile(group).reason !== "missing-ancestry");
    // The account is read again here, once, to confirm it did not change
    // during the sync.
    accountChecked = false;
    return await currentSession() && completeAncestry && latest.every(change => remotelySaved.has(change.id)) && latestDrafts.every(draft => savedDrafts.has(json(draft)))
      && (await rx.journal.pendingEdits.toArray()).filter(e => e.boardId === boardId && !e.admittedChangeId).every(e => savedPending.has(json(cleanPending(e))))
      && (await rx.journal.publicGrants.where('boardId').equals(boardId).toArray()).every(g => savedGrants.has(json(g)))
      ? compatibility ?? null : null;
  }
  let erasureInFlight: Promise<void> | undefined;
  function flushErasures(): Promise<void> {
    if (erasureInFlight) return erasureInFlight;
    const operation = performErasures().finally(() => { if (erasureInFlight === operation) erasureInFlight = undefined; });
    erasureInFlight = operation; return operation;
  }
  async function performErasures() {
    const session = options.captureSession ? await options.captureSession() : null;
    const account = session?.account ?? await options.getAccountId();
    if (!account || options.captureSession && !session) return;
    const rx = await options.getRepository(); if (!rx) return;
    const using = session?.history ?? transport, snapshots = session?.snapshots ?? options.snapshotTransport;
    const erasures = session?.erasures ?? options.erasureTransport, images = session?.images ?? options.imageTransport;
    const current = async () => { if (await options.getAccountId() !== account) throw new Error('Private deletion is waiting for its original account'); };
    if (erasures) {
      const files = await erasures.listProjectFiles();
      if (files.length > 10000) throw new Error('Private erasure inventory exceeds capacity');
      for (const file of files) {
        const value = parseStrictJson(await erasures.download(file.id), 1024 * 1024) as any;
        if (value.format !== 'pboard-board-erasure' || value.version !== 1 || typeof value.boardId !== 'string'
          || file.name !== `erased-${value.boardId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pboard`
          || value.imageIds !== undefined && (!Array.isArray(value.imageIds) || value.imageIds.length > 10000 || value.imageIds.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) throw new Error('Invalid private board erasure');
        await current(); await rx.applyPrivateBoardErasure(value.boardId, account);
        const marker = (await rx.journal.boardErasure(value.boardId))!;
        if (value.imageIds?.length) await rx.journal.receipts.update(marker.id, { imageIds: [...new Set([...marker.imageIds, ...value.imageIds])] } as any);
      }
    }
    for (const marker of await rx.journal.boardErasures()) {
      if (marker.accountId !== account) continue;
      await current();
      if (!erasures || !snapshots) throw new Error('Private board erasure transport is unavailable');
      await rx.applyPrivateBoardErasure(marker.boardId, account);
      const existing = await erasures.findProjectFile(marker.boardId);
      if (!existing) await erasures.upload(marker.boardId, JSON.stringify({ format: 'pboard-board-erasure', version: 1, boardId: marker.boardId, imageIds: marker.imageIds }));
      await current();
      const safe = marker.boardId.replace(/[^a-zA-Z0-9_-]/g, '_'), prefix = `history-${safe}_`;
      const files = await using.listProjectFiles();
      for (const file of files) if (file.name.startsWith(prefix) && /^[a-f0-9]{64}\.pboard$/.test(file.name.slice(prefix.length))) {
        if ((await read(file, using)).value.boardId !== marker.boardId) continue;
        await current(); await using.delete(file.id);
      }
      for (const file of await snapshots.listProjectFiles()) if (file.name === `project-${safe}.pboard`) {
        if (deserializeProjectSnapshot(await snapshots.download(file.id)).project.id !== marker.boardId) continue;
        await current(); await snapshots.delete(file.id);
      }
      if (images && marker.imageIds.length) {
        const remaining = await all(using), references = new Set(remaining.flatMap(saved => saved.value.images.map(image => image.imageId)));
        // A content-addressed asset can serve another board. Keep it whenever
        // another private snapshot or history still references the same hash.
        for (const file of await snapshots.listProjectFiles()) {
          const snapshot = deserializeProjectSnapshot(await snapshots.download(file.id));
          for (const item of snapshot.items) if (item.imageId) references.add(item.imageId);
        }
        for (const imageId of marker.imageIds) if (!references.has(imageId)) {
          for (const file of await images.listProjectFiles()) if (file.name === `image-${imageId}.pboard`) { await current(); await images.delete(file.id); }
        }
      }
      await current();
      await rx.journal.receipts.update(marker.id, { cloudPending: false } as any);
    }
  }
  return { available: async () => !!await options.getRepository(), boundAccount, flushErasures,
    erasureStatus: async boardId => (await options.getRepository())?.journal.boardErasure(boardId),
    boundAccountFor: async (boardId: string) => { const rx = await options.getRepository(); return rx ? await boundAccount(rx, boardId) : null; },
    boards: async onError => [...new Set([...(await all(transport, undefined, onError)).map(saved => saved.value.boardId), ...((await options.getRepository()) ? (await (await options.getRepository())!.journal.pendingEdits.toArray()).map(e => e.boardId) : [])])], sync };
}

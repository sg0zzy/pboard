import { signedBytes, canonicalize } from "./canonical";
import { importSigningKey, signBytes, verifyBytes, publicKeyFingerprint } from "./keys";
import { manifestHash, manifestIsCurrent } from "./manifest";
import { createMutationReplayCache, verifyMutation, signMutation } from "./mutation";
import { makeChange, type PendingEdit } from "../../storage/changeJournal";
import type { CollaborationSecurityOptions } from "../manager";
import type { Change, JournalEntry } from "../../storage/changeJournal";
import { documentValue } from "../../storage/changeJournal";
import { validateChange } from "../../storage/causalReconciliation";

const DOMAIN = "pboard-journal-change-v1";
export type HistoryAdmission = { payload: { version: 1; boardId: string; changeId: string; authorityKeyId: string }; signature: string };
export type JournalProof = { payload: { version: 1; changeId: string; boardId: string; authorKeyId: string; epoch: number; manifestHash: string }; signature: string };
const origins = new WeakMap<object, Map<string, CollaborationSecurityOptions>>();
export function installJournalOrigin(collection: object, board: string, security: CollaborationSecurityOptions): () => void {
  let map = origins.get(collection); if (!map) { map = new Map(); origins.set(collection, map); }
  map.set(board, security);
  return () => { if (map.get(board) === security) map.delete(board); };
}
export function hasJournalOrigin(collection: object, board: string) { return !!origins.get(collection)?.has(board); }
/** Rebuild only an exact operation receipt; private backup flags are untrusted. */
export async function verifyPendingAdmission(collection: object, pending: PendingEdit, entry: JournalEntry): Promise<void> {
  const security = origins.get(collection)?.get(pending.boardId);
  const provenance = (entry.value._sec as any)?.provenance;
  const { _sec: _, ...value } = documentValue(entry.value);
  if (!security || security.manifest.authorityKeyId !== pending.authorityKeyId || entry.state !== 'committed'
    || entry.boardId !== pending.boardId || entry.collection !== pending.base.collection || entry.documentId !== pending.base.documentId
    || provenance?.operationId !== `pending:${pending.id}` || provenance?.authorKeyId !== pending.deviceKeyId
    || canonicalize(value) !== canonicalize(pending.value)
    || canonicalize([...entry.parents].sort()) !== canonicalize([...(pending.parents ?? (pending.creation ? [] : [pending.base.id]))].sort())) throw new Error('Pending admission does not match the original edit');
  await validateChange(entry);
  await verifyJournalChange(entry, entry.proof, security, entry.admission);
}
/** Re-admission is a new operation by the SAME device, with the saved original base. */
export async function admitPendingEdit(collection: object, pending: PendingEdit): Promise<JournalEntry> {
  const security = origins.get(collection)?.get(pending.boardId);
  if (!security || security.signer.deviceKeyId !== pending.deviceKeyId || security.manifest.authorityKeyId !== pending.authorityKeyId
    || !manifestIsCurrent(security.manifest, Date.now()) || !security.manifest.devices.some(d => d.deviceKeyId === pending.deviceKeyId && d.role !== "viewer")) throw new Error("Pending work needs current authorization for its original device and authority");
  const value = await signMutation(pending.value, security.signer, { boardId: pending.boardId, collection: pending.base.collection,
    manifest: security.manifest, sequence: 0, operationId: `pending:${pending.id}`, parents: pending.parents ?? (pending.creation ? [] : [pending.base.id]) });
  const entry: JournalEntry = { ...await makeChange({ boardId: pending.boardId, collection: pending.base.collection, documentId: pending.base.documentId,
    ancestry: "known", parents: pending.parents ?? (pending.creation ? [] : [pending.base.id]), value: value as Change["value"] }), state: "committed", origin: "local" };
  entry.proof = await proveJournalChange(collection, entry);
  return entry;
}
/** Author-only proof of the complete content identity, including causal parents. */
export async function proveJournalChange(collection: object, change: JournalEntry): Promise<JournalProof | undefined> {
  const security = origins.get(collection)?.get(change.boardId);
  if (!security || change.origin !== "local") return;
  const mutation = await verifyMutation(change.value, { manifest: security.manifest, history: security.manifestHistory,
    boardId: change.boardId, collection: change.collection }, createMutationReplayCache());
  if (!manifestIsCurrent(security.manifest, Date.now()) || mutation.authorKeyId !== security.signer.deviceKeyId) throw new Error("Journal origin does not authorize this author");
  const payload = { version: 1 as const, changeId: change.id, boardId: change.boardId, authorKeyId: mutation.authorKeyId,
    epoch: security.manifest.epoch, manifestHash: manifestHash(security.manifest) };
  return { payload, signature: await signBytes(await importSigningKey(security.signer.privateJwk), signedBytes(DOMAIN, payload)) };
}
export async function verifyJournalChange(change: Change, proof: JournalProof | undefined, security: CollaborationSecurityOptions, admission?: HistoryAdmission): Promise<void> {
  if (change.boardId !== security.boardId || !manifestIsCurrent(security.manifest, Date.now())) throw new Error("History authorization is unavailable");
  let admitted = false;
  if (admission) {
    const p = admission.payload, root = security.relayAuthorization?.authority;
    if (!p || Object.keys(admission).sort().join(',') !== 'payload,signature' || Object.keys(p).sort().join(',') !== 'authorityKeyId,boardId,changeId,version'
      || p.version !== 1 || p.boardId !== change.boardId || p.changeId !== change.id || p.authorityKeyId !== security.manifest.authorityKeyId
      || !root || await publicKeyFingerprint(root) !== p.authorityKeyId || !await verifyBytes(root, admission.signature, signedBytes("pboard-history-admission-v1", p))) throw new Error("Historical admission certificate is invalid");
    admitted = true;
  }
  let mutation;
  if (admitted) {
    const provenance = (change.value._sec as unknown as { provenance?: { epoch?: number; issuedAt?: number } })?.provenance;
    const historical = security.manifestHistory?.get(provenance?.epoch ?? -1);
    if (!historical || historical.authorityKeyId !== security.manifest.authorityKeyId || historical.boardId !== change.boardId
      || historical.driveFolderId !== security.manifest.driveFolderId || historical.driveProjectFileId !== security.manifest.driveProjectFileId
      || !Number.isSafeInteger(provenance?.issuedAt) || provenance!.issuedAt! < historical.issuedAt - 30_000 || provenance!.issuedAt! > historical.expiresAt) throw new Error("Historical grant is unavailable");
    mutation = await verifyMutation(change.value, { manifest: historical, boardId: change.boardId, collection: change.collection,
      now: () => provenance!.issuedAt! }, createMutationReplayCache());
  } else mutation = await verifyMutation(change.value, { manifest: security.manifest, history: security.manifestHistory,
    boardId: change.boardId, collection: change.collection }, createMutationReplayCache());
  // Legacy signed values prove their bytes, not parentage. No known ancestry is inferred.
  if (!proof) {
    if (change.ancestry !== "unknown" || change.parents.length) throw new Error("History ancestry has no author proof");
    return;
  }
  const p = proof.payload;
  if (!p || p.version !== 1 || p.changeId !== change.id || p.boardId !== change.boardId || p.authorKeyId !== mutation.authorKeyId) throw new Error("History proof binding is invalid");
  const manifest = p.epoch === security.manifest.epoch ? security.manifest : security.manifestHistory?.get(p.epoch);
  const device = manifest?.devices.find(d => d.deviceKeyId === p.authorKeyId);
  const current = security.manifest.devices.find(d => d.deviceKeyId === p.authorKeyId);
  if (!manifest || manifest.authorityKeyId !== security.manifest.authorityKeyId || manifest.boardId !== change.boardId || manifestHash(manifest) !== p.manifestHash
    || !device || device.role === "viewer" || (!admitted && (!current || current.role === "viewer"))
    || !await verifyBytes(device.publicKey, proof.signature, signedBytes(DOMAIN, p))) throw new Error("History author proof is invalid");
}

/** Iterative closure: long histories and cycles cannot overflow the call stack. */
export function portableJournalChanges(entries: JournalEntry[]): Set<string> {
  const eligible = new Set<string>(), waiting = new Map<string, number>(), children = new Map<string, string[]>();
  const ready: string[] = [];
  for (const entry of entries) {
    if (entry.state !== "committed" || !entry.value._sec) continue;
    if (entry.ancestry === "unknown" && !entry.parents.length || entry.proof && !entry.parents.length) ready.push(entry.id);
    else if (entry.proof) {
      waiting.set(entry.id, entry.parents.length);
      for (const parent of entry.parents) { const list = children.get(parent) ?? []; list.push(entry.id); children.set(parent, list); }
    }
  }
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]; if (eligible.has(id)) continue; eligible.add(id);
    for (const child of children.get(id) ?? []) {
      const left = waiting.get(child)! - 1; waiting.set(child, left); if (!left) ready.push(child);
    }
  }
  return eligible;
}

/** Root admission proves acceptance of this exact history, never future authorship or membership. */
export async function certifyHistory(change: Change, proof: JournalProof | undefined, security: CollaborationSecurityOptions): Promise<HistoryAdmission | undefined> {
  if (!security.historyAuthority) return;
  if (security.historyAuthority.deviceKeyId !== security.manifest.authorityKeyId || security.manifest.expiresAt <= Date.now()) throw new Error("Current root authority is required for historical admission");
  await verifyJournalChange(change, proof, security);
  const payload = { version: 1 as const, boardId: change.boardId, changeId: change.id, authorityKeyId: security.manifest.authorityKeyId };
  return { payload, signature: await signBytes(await importSigningKey(security.historyAuthority.privateJwk), signedBytes("pboard-history-admission-v1", payload)) };
}
export async function certifyLocalHistory(collection: object, entry: JournalEntry) {
  const security = origins.get(collection)?.get(entry.boardId);
  return security ? certifyHistory(entry, entry.proof, security) : undefined;
}

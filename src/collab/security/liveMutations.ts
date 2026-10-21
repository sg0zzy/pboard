import { installJournalOrigin, verifyJournalChange } from "./journalProof";
import type { RxCollection } from "rxdb";
import type { CollaborationSecurityOptions } from "../manager";
import { installCollectionMutationGuard, createMutationReplayCache, signMutation, verifyMutation, type MutationGuardInstall } from "./mutation";
import { manifestIsCurrent, verifyManifest } from "./manifest";
import { resolutionParents } from "../../storage/resolutionOrigin";
import { documentValue, makeChange, type ChangeJournal } from "../../storage/changeJournal";
import { publicKeyFingerprint } from "./keys";
import { canonicalize } from "./canonical";
import { isJournalMaterialization } from "../../storage/journalMaterialization";

const journals = new WeakMap<object, ChangeJournal>();
export function registerAuthorizationJournal(collection: object, journal: ChangeJournal) { journals.set(collection, journal); }
const admissionWriters = new WeakMap<object, Map<string, (document: Record<string, unknown>) => Promise<void>>>();
/** The installed verifier must validate the original bytes before recording admission. */
export async function recordLiveBoardAdmission(collection: object, board: string, document: Record<string, unknown>) {
  await admissionWriters.get(collection)?.get(board)?.(document);
}

const liveEntitlements = new WeakMap<object, Map<string, () => 'owner' | 'editor' | 'viewer' | 'revoked'>>();
export function liveBoardEntitlement(collection: object, boardId: string) { return liveEntitlements.get(collection)?.get(boardId)?.(); }
const liveRoles = new WeakMap<object, Map<string, () => "owner" | "editor" | "viewer" | null>>();
const liveVerifiers = new WeakMap<object, Map<string, (document: Record<string, unknown>) => Promise<void>>>();
/** Only an installed, currently trusted manifest can authorize a shared resolution. */
export function liveBoardRole(collection: object, boardId: string) {
  return liveRoles.get(collection)?.get(boardId)?.() ?? null;
}
export async function verifyLiveBoardVariant(collection: object, boardId: string, document: Record<string, unknown>): Promise<void> {
  const verify = liveVerifiers.get(collection)?.get(boardId);
  if (!verify || !liveBoardRole(collection, boardId)) throw new Error("Current trusted board authorization is required");
  await verify(document);
}

/** Origin hooks run for repository writes, never for replication storage writes.
 * The storage guard verifies BOTH paths; a remote document is never signed for it. */
const externalWrites = new WeakMap<object, number>();
export function isUntrustedImport(collection: object): boolean { return !!externalWrites.get(collection); }
export async function withUntrustedImport<T>(collections: object[], operation: () => Promise<T>): Promise<T> {
  collections.forEach(collection => externalWrites.set(collection, (externalWrites.get(collection) ?? 0) + 1));
  try { return await operation(); }
  finally { collections.forEach(collection => externalWrites.set(collection, (externalWrites.get(collection) ?? 1) - 1)); }
}
const originHooks = new WeakMap<object, Map<string, (doc: Record<string, unknown>) => Promise<void>>>();
export async function installLiveBoardMutations(options: {
  projectId: string;
  cards: RxCollection<any>;
  projects: RxCollection<any>;
  security: CollaborationSecurityOptions;
  /** Explicit owner attestation of existing local data, only at initial enrollment. */
  attestExisting?: boolean;
  /** A new authority must not silently re-sign another authority's documents. */
  preserveSignedData?: boolean;
}): Promise<MutationGuardInstall> {
  const { security, projectId } = options;
  const journal = journals.get(options.cards);
  const oldPermission = await journal?.permissions.get(projectId);
  if (oldPermission?.authorityKeyId && oldPermission.authorityKeyId !== security.manifest.authorityKeyId) throw new Error("Offline board authority differs; automatic replacement is forbidden");
  const entitlement = security.manifest.devices.find(d => d.deviceKeyId === security.signer.deviceKeyId)?.role;
  if (!entitlement || (!manifestIsCurrent(security.manifest, Date.now()) || security.manifest.expiresAt <= Date.now())) throw new Error("Current board authorization is required");
  if (journal && security.relayAuthorization) {
    const root = security.relayAuthorization.authority, pin = await publicKeyFingerprint(root);
    if (pin !== security.manifest.authorityKeyId) throw new Error('Public grant authority does not match the installed pin');
    const history = security.grantHistory ?? [security.relayAuthorization.manifest];
    if (history.length > 4096) throw new Error('Public grant history exceeds capacity');
    for (const signed of history) {
      const manifest = await verifyManifest(signed, root, pin);
      if (manifest.boardId !== projectId) throw new Error('Public grant belongs to another board');
      const value = { id: JSON.stringify([projectId, pin, manifest.epoch]), boardId: projectId, authority: root, manifest: signed };
      const existing = await journal.publicGrants.get(value.id);
      if (existing && canonicalize(existing.manifest as any) !== canonicalize(signed as any)) throw new Error('Public grant history fork rejected');
      if (!existing) await journal.publicGrants.put(value);
    }
  }
  const replay = createMutationReplayCache();
  const handles: MutationGuardInstall[] = [];
  const deactivations: Array<() => void> = [];
  let sequence = 0;
  // Check every previously signed record before initial attestation changes any
  // local data. A new independent authority cannot partially convert a board
  // belonging to an older collaboration authority.
  if (options.attestExisting && options.preserveSignedData) {
    for (const [collection, name] of [[options.cards, "cards"], [options.projects, "projects"]] as const) {
      for (const doc of await collection.find().exec()) {
        const value = doc.toJSON();
        if ((name === "cards" ? value.projectId === projectId : value.id === projectId) && value._sec) {
          try { await verifyMutation(value, { boardId: projectId, collection: name, manifest: security.manifest, history: security.manifestHistory }, replay); }
          catch { throw new Error("This board contains signed collaboration data that this independent authority cannot verify. Keep the original provider; automatic authority migration is not supported."); }
        }
      }
    }
  }
  try {
  for (const [collection, name] of [[options.cards, "cards"], [options.projects, "projects"]] as const) {
    const matches = (doc: Record<string, unknown>) => name === "cards" ? doc.projectId === projectId : doc.id === projectId;
    const context = { manifest: security.manifest, boardId: projectId, collection: name, history: security.manifestHistory };
    const admissionId = async (doc: Record<string, unknown>) => `${security.manifest.authorityKeyId}:${(await makeChange({ boardId: projectId,
      collection: name, documentId: String(doc.id), ancestry: "unknown", parents: [], value: documentValue({ ...doc, _deleted: doc._deleted === true }) })).id}`;
    const certified = async (doc: Record<string, unknown>) => {
      if (!journal) return false;
      for (const entry of await journal.entries.where("[collection+documentId]").equals([name, String(doc.id)]).toArray()) {
        if (entry.boardId !== projectId || entry.state !== "committed" || !entry.admission) continue;
        if (canonicalize(documentValue({ ...entry.value, _deleted: entry.value._deleted === true })) !== canonicalize(documentValue({ ...doc, _deleted: doc._deleted === true }))) continue;
        await verifyJournalChange(entry, entry.proof, security, entry.admission); return true;
      }
      return false;
    };
    const admitted = async (doc: Record<string, unknown>) => !!await journal?.admissions.get(await admissionId(doc));
    const recordAdmission = async (doc: Record<string, unknown>) => {
      try { await verifyMutation(doc, context, createMutationReplayCache()); } catch (error) { if (!await certified(doc)) throw error; }
      if (journal) await journal.admissions.put({ id: await admissionId(doc), boardId: projectId,
        authorityKeyId: security.manifest.authorityKeyId, epoch: (doc._sec as { provenance: { epoch: number } }).provenance.epoch });
    };
    let writers = admissionWriters.get(collection);
    if (!writers) { writers = new Map(); admissionWriters.set(collection, writers); }
    writers.set(projectId, recordAdmission);
    const registeredWriters = writers;
    deactivations.push(() => { if (registeredWriters.get(projectId) === recordAdmission) registeredWriters.delete(projectId); });
    let active = true;
    let entitlements = liveEntitlements.get(collection);
    if (!entitlements) { entitlements = new Map(); liveEntitlements.set(collection, entitlements); }
    const entitlement = () => security.manifest.devices.find(d => d.deviceKeyId === security.signer.deviceKeyId)?.role ?? 'revoked';
    entitlements.set(projectId, entitlement);
    const installedEntitlements = entitlements;
    deactivations.push(() => { if (installedEntitlements.get(projectId) === entitlement) installedEntitlements.delete(projectId); });
    deactivations.push(installJournalOrigin(collection, projectId, security));
    const sign = async (doc: Record<string, unknown>) => {
      if (!active || !matches(doc) || externalWrites.get(collection)) return;
      if ((!manifestIsCurrent(security.manifest, Date.now()) || security.manifest.expiresAt <= Date.now())) throw new Error("Board authorization expired; renew enrollment before editing");
      const role = security.manifest.devices.find(d => d.deviceKeyId === security.signer.deviceKeyId)?.role;
      if (role !== "owner" && role !== "editor") throw new Error("View-only device cannot sign board changes");
      Object.assign(doc, await signMutation(doc, security.signer, { ...context, sequence: sequence++, parents: resolutionParents(collection, doc) }));
      await recordAdmission(doc);
    };
    let dispatch = originHooks.get(collection);
    if (!dispatch) {
      dispatch = new Map(); originHooks.set(collection, dispatch);
      const hooks = dispatch;
      const run = async (doc: Record<string, unknown>) => { for (const hook of hooks.values()) await hook(doc); };
      collection.preInsert(run, false); collection.preSave(run, false);
      collection.preRemove(async (doc: Record<string, unknown>) => {
        if (typeof doc.updatedAt === "string" && !externalWrites.get(collection)) {
          doc.updatedAt = new Date(Math.max(Date.now(), (Date.parse(doc.updatedAt) || 0) + 1)).toISOString();
        }
        const removed = { ...doc, _deleted: true };
        await run(removed);
        if ("_sec" in removed) doc._sec = removed._sec;
      }, false);
    }
    dispatch.set(projectId, sign);
    const hooks = dispatch;
    deactivations.push(() => { active = false; if (hooks.get(projectId) === sign) hooks.delete(projectId); });
    if (options.attestExisting) {
      const role = security.manifest.devices.find(d => d.deviceKeyId === security.signer.deviceKeyId)?.role;
      if (role !== "owner") throw new Error("Only the approved owner may attest existing board data");
      for (const doc of await collection.find().exec()) {
        if (!matches(doc.toJSON())) continue;
        if (security.manifestHistory) {
          try { await verifyMutation(doc.toJSON(), context, replay); continue; }
          catch (error) {
            if (options.preserveSignedData && doc.toJSON()._sec) throw error;
            /* Owner explicitly attests unsigned local data. */
          }
        }
        await doc.incrementalModify((value: Record<string, unknown>) => ({ ...value, updatedAt: new Date(Math.max(Date.now(), (typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : 0) || 0) + 1).toISOString() }));
        // An overlapping untrusted import must never turn an unsigned save into
        // a successful bootstrap. Only verified signed bytes complete enrollment.
        const saved = await collection.findOne(doc.primary).exec();
        if (!saved) throw new Error("Board changed during initial authorization; retry collaboration");
        await verifyMutation(saved.toJSON(), context, replay);
      }
    }
    handles.push(installCollectionMutationGuard(collection, async doc => !matches(doc) ? null : await journal?.boardErasure(projectId) ? {
      verify: async doc => isJournalMaterialization(collection, doc) && doc._deleted === true && !doc._sec ? 'accept' : 'reject'
    } : {
      verify: async doc => {
        try { await verifyMutation(doc, context, replay); await recordAdmission(doc); return "accept"; }
        catch { return await certified(doc) || (isJournalMaterialization(collection, doc) && await admitted(doc)) ? "accept" : "reject"; }
      }
    }));
    let roles = liveRoles.get(collection);
    if (!roles) { roles = new Map(); liveRoles.set(collection, roles); }
    const role = () => active && security.manifest.expiresAt > Date.now() && manifestIsCurrent(security.manifest, Date.now())
      ? security.manifest.devices.find(device => device.deviceKeyId === security.signer.deviceKeyId)?.role ?? null : null;
    roles.set(projectId, role);
    const registered = roles;
    deactivations.push(() => { if (registered.get(projectId) === role) registered.delete(projectId); });
    let verifiers = liveVerifiers.get(collection);
    if (!verifiers) { verifiers = new Map(); liveVerifiers.set(collection, verifiers); }
    const verify = async (document: Record<string, unknown>) => {
      try { await verifyMutation(document, context, createMutationReplayCache()); }
      catch (error) { if (!await admitted(document) && !await certified(document)) throw error; }
    };
    verifiers.set(projectId, verify);
    const registeredVerifiers = verifiers;
    deactivations.push(() => { if (registeredVerifiers.get(projectId) === verify) registeredVerifiers.delete(projectId); });
  }
  await journal?.permissions.put({ id: projectId, role: entitlement, deviceKeyId: security.signer.deviceKeyId, authorityKeyId: security.manifest.authorityKeyId });
  } catch (error) {
    deactivations.forEach(fn => fn());
    for (const handle of [...handles].reverse()) await handle.uninstall();
    throw error;
  }
  return { projectId, async uninstall() {
    deactivations.forEach(fn => fn());
    for (const handle of [...handles].reverse()) await handle.uninstall();
  } };
}

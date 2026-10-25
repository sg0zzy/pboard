import { canonicalize } from "../collab/security/canonical";
import { withUntrustedImport } from "../collab/security/liveMutations";
import { isTypeSupported } from "../templates/boardTemplates";
import { initialOrderKeys, orderKeyBetween } from "./orderKey";
import { documentValue, makeChange, scope, type Change, type ChangeJournal } from "./changeJournal";
import { reconcile } from "./causalReconciliation";
import { withJournalMaterialization } from "./journalMaterialization";
import type { RxDatabase } from "rxdb";
import type { RxCollections } from "./rxdbRepository";
import type { ProjectSnapshot } from "../sync/snapshot";
import type { BlobStore } from "./blobStore";

/** Account-private recovery. This grants no shared-board membership or signing key. */
export function createPrivateRecovery(options: {
  db: RxDatabase<RxCollections>; journal: ChangeJournal; blobs: BlobStore;
  locked<T>(operation: () => Promise<T>): Promise<T>;
}) {
  const { db, journal } = options;
  async function capture(boardId: string) {
    return options.locked(async () => {
      const existing = (await journal.entries.where("boardId").equals(boardId).toArray()).filter(e => e.state === "committed");
      // Documents that already have journal history never get a baseline
      // root: a value mismatch there means replication seal churn or an
      // untrusted snapshot update, and a parentless root would fork the
      // author's own chain — every later author entry then parents to one
      // branch while the capture root anchors the other, which surfaces on
      // every collaborator as an authorship conflict. Baseline capture
      // exists only to carry genuine pre-journal documents.
      const journaled = new Set(existing.map(e => `${e.collection}\u0000${e.documentId}`));
      const records = [
        ...(await db.projects.storageInstance.findDocumentsById([boardId], true)).map(value => ({ collection: "projects" as const, value })),
        ...(await db.cards.find({ selector: { projectId: boardId } }).exec()).map(doc => ({ collection: "cards" as const, value: doc.toJSON(true) }))
      ];
      for (const { collection, value } of records) {
        if (journaled.has(`${collection}\u0000${value.id}`)) continue;
        const normalized = documentValue(value);
        if (existing.some(e => e.collection === collection && e.documentId === value.id && canonicalize(e.value) === canonicalize(normalized))) continue;
        const change = await makeChange({ boardId, collection, documentId: value.id, parents: [], ancestry: "unknown", value: normalized });
        await journal.accept([{ ...change, state: "committed", origin: "baseline" }]);
      }
    });
  }
  async function legacyChanges(snapshot: ProjectSnapshot): Promise<Change[]> {
    const boardId = snapshot.project.id;
    const current = await db.projects.findOne(boardId).exec();
    const changes: Change[] = [];
    const project = { ...snapshot.project, orderKey: current?.orderKey ?? orderKeyBetween(null, null), _deleted: false };
    changes.push(await makeChange({ boardId, collection: "projects", documentId: boardId, parents: [], ancestry: "unknown", value: documentValue(project) }));
    const items = [...snapshot.items].sort((a, b) => a.order - b.order), keys = initialOrderKeys(items.length);
    for (const [index, item] of items.entries()) {
      const { order: _, image, ...rest } = item;
      let imageId = item.imageId;
      if (image) {
        if (typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")) throw new Error("Private snapshot image must contain inline image bytes");
        const response = await fetch(image.dataUrl);
        imageId = await options.blobs.putBlob(await response.blob(), image);
      }
      const value = { ...rest, orderKey: keys[index], _deleted: false,
        ...(imageId ? { imageId, imageMimeType: image?.mimeType ?? item.imageMimeType, imageWidth: image?.width ?? item.imageWidth, imageHeight: image?.height ?? item.imageHeight } : {}) };
      changes.push(await makeChange({ boardId, collection: "cards", documentId: item.id, parents: [], ancestry: "unknown", value: documentValue(value) }));
    }
    return changes;
  }
  async function apply(boardId: string, canApply: () => Promise<boolean>) {
    return options.locked(async () => {
      if (!await canApply()) return;
      let entries = (await journal.entries.where("boardId").equals(boardId).toArray()).filter(e => e.state === "committed");
      const signedBoard = entries.some(e => e.value._sec);
      const groups = new Map<string, Change[]>();
      for (const entry of entries) { const id = scope(entry), group = groups.get(id); if (group) group.push(entry); else groups.set(id, [entry]); }
      const ordered = [...groups.values()].sort((a, b) => a[0].collection === b[0].collection ? a[0].documentId.localeCompare(b[0].documentId) : a[0].collection === "projects" ? -1 : 1);
      for (const changes of ordered) {
        if (!await canApply()) return;
        let result = reconcile(changes);
        if (result.reason === "missing-ancestry") continue;
        const target = changes[0];
        const collection = db[target.collection];
        const current = (await collection.storageInstance.findDocumentsById([target.documentId], true))[0];
        if (result.kind === "mergeable" && !signedBoard && result.preview && result.heads.length <= 8) {
          const value = { ...result.preview };
          value.updatedAt = result.variants.map(c => String(c.value.updatedAt)).sort().at(-1)!;
          if (target.collection === "projects") {
            value.revision = Math.max(...result.variants.map(c => Number(c.value.revision) || 0)) + 1;
            const tail = result.variants.map(c => c.value.tailOrderKey).filter((key): key is string => typeof key === "string").sort().at(-1);
            if (tail) value.tailOrderKey = tail;
          }
          const merged = await makeChange({ boardId, collection: target.collection, documentId: target.documentId, ancestry: "known", parents: result.heads, value });
          await journal.accept([{ ...merged, state: "committed", origin: "local" }]);
          result = reconcile([...changes, merged]);
        }
        // An unresolved conflict keeps the current head where possible. A fresh
        // device gets a deterministic readable projection; every head remains.
        const existing = current && result.variants.find(c => canonicalize(c.value) === canonicalize(documentValue(current)));
        const chosen = existing
          ?? result.variants.find(c => c.value._sec && !c.value._deleted && !c.value.deletedAt)
          ?? result.variants.find(c => c.value._sec)
          ?? result.variants.find(c => !c.value._deleted && !c.value.deletedAt) ?? result.variants[0];
        if (!chosen) continue;
        if (current && canonicalize(documentValue(current)) === canonicalize(chosen.value)) continue;
        if (target.collection === "projects" && chosen.value._deleted === true && !current) continue;
        if (target.collection === "cards") {
          const project = await db.projects.findOne(boardId).exec();
          if (!project) continue;
          if (!isTypeSupported(project.template, chosen.value.type as never)) throw new Error("Private history contains a card incompatible with the current template. Retained versions require review.");
        }
        await withUntrustedImport([collection], () => withJournalMaterialization(collection, chosen.value,
          () => (collection as typeof db.cards).upsert(chosen.value as never)));
      }
      // Selection is device-local. Do not import any account/authority settings.
      if (!(await db.settings.findOne("currentProjectId").exec())?.value && await db.projects.findOne(boardId).exec()) {
        await db.settings.upsert({ id: "currentProjectId", value: boardId });
      }
    });
  }
  return { capture, legacyChanges, apply };
}

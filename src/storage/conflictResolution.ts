import type { RxCollection } from "rxdb";
import { BOARD_TEMPLATES, BOARD_ITEM_STATUSES, CARD_DISPLAY_MODES } from "../types";
import { isTypeSupported } from "../templates/boardTemplates";
import { liveBoardRole, isUntrustedImport, verifyLiveBoardVariant } from "../collab/security/liveMutations";
import { documentValue, scope, type Change, type ChangeJournal, type ConflictDraft } from "./changeJournal";
import { canonicalize } from "../collab/security/canonical";
import { reconcile, type Reconciliation } from "./causalReconciliation";
import { withResolutionOrigin } from "./resolutionOrigin";

export type ConflictTarget = Pick<Change, "boardId" | "collection" | "documentId">;
export type ConflictRecord = ConflictTarget & { result: Reconciliation; boardMissing: boolean; boardName: string; restriction: string | null; pendingAuthorization?: boolean; drafts: ConflictDraft[] };
export type ResolutionRequest = ConflictTarget & { heads: string[]; variantId: string; edits?: { title: string; content: string } | { name: string } };
type Collections = { cards: RxCollection<any>; projects: RxCollection<any> };
const isDeleted = (value: Record<string, unknown>) => value._deleted === true || !!value.deletedAt;
const equalHeads = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((id, index) => id === [...b].sort()[index]);

export function createConflictResolution(options: {
  journal: ChangeJournal;
  collections: Collections;
  canDraft?(boardId: string): Promise<boolean>;
  assertCanMutate(boardId: string): void | Promise<void>;
  isDeletedProject(boardId: string): Promise<boolean>;
  /** Boards the current account list can show; defaults to every locally stored project document. */
  listVisibleBoards?(): Promise<string[]>;
  changed(boardId: string): Promise<void>;
  touchProject(boardId: string): Promise<void>;
  hasImage(imageId: string): Promise<boolean>;
  locked<T>(operation: () => Promise<T>): Promise<T>;
}) {
  const { journal, collections } = options;
  /**
   * The reconciliation outcome per document, with the change ids it was
   * computed from. Reconciling walks a document's whole change history, and
   * the panel is refreshed on every journal change, so an unchanged document
   * keeps its previous outcome.
   */
  const reconciled = new Map<string, { fingerprint: string; outcome: Reconciliation }>();
  journal.onChange((tables) => { if (tables.includes("entries")) reconciled.clear(); });
  async function history(target: ConflictTarget) {
    return (await journal.entries.where("boardId").equals(target.boardId).toArray()).filter(e => e.state === "committed");
  }
  async function restriction(target: ConflictTarget, result: Reconciliation, signedBoard: boolean): Promise<string | null> {
    const pending = signedBoard && await options.canDraft?.(target.boardId);
    try { if (!pending) await options.assertCanMutate(target.boardId); } catch (error) { return error instanceof Error && error.message.includes("view-only") ? "View-only authorization: an authorized editor must resolve this conflict." : "Current trusted editor authorization is required. Reconnect or renew board access."; }
    if (signedBoard && !pending) {
      const role = liveBoardRole(collections[target.collection], target.boardId);
      if (role !== "editor" && role !== "owner") return "Current trusted editor authorization is required. Reconnect or renew board access.";
      if (target.collection === "projects" && result.variants.some(v => isDeleted(v.value)) && role !== "owner") return "Only the board owner may resolve a board deletion.";
      try {
        for (const variant of result.variants) if (variant.value._sec) await verifyLiveBoardVariant(collections[target.collection], target.boardId, variant.value);
      } catch { return "These signed versions cannot be verified by the current board authority. Keep the original authority and recover its authorization."; }
    }
    if (result.reason === "missing-ancestry") return "Some earlier changes are missing. Keep these versions until recovery completes.";
    if (result.heads.length > 8) return "More than eight concurrent versions need a future staged resolution. All versions are retained.";
    if (await options.isDeletedProject(target.boardId) || !await collections.projects.findOne(target.boardId).exec()) return "Restore this board before applying a resolution. Its versions remain available here.";
    if (!await collections[target.collection].findOne(target.documentId).exec()) return "This document needs recovery before a resolution can be applied. All versions are retained.";
    return null;
  }
  async function listConflicts(): Promise<ConflictRecord[]> {
    const erased = new Set((await journal.boardErasures()).map(entry => entry.boardId));
    const entries = (await journal.committedEntries()).filter(e => !erased.has(e.boardId));
    const groups = new Map<string, typeof entries>();
    const signedBoards = new Set(entries.filter(e => e.value._sec).map(e => e.boardId));
    // "No handle" boards: anything the current account list cannot show gets a
    // restore handle in the recovery panels instead of looking actionable-blocked.
    const visibleBoards = new Set(await options.listVisibleBoards?.() ?? await collections.projects.find().exec().then(docs => docs.map(doc => String((doc.toJSON() as { id: unknown }).id))));
    for (const entry of entries) {
      const id = scope(entry), group = groups.get(id);
      if (group) group.push(entry); else groups.set(id, [entry]);
    }
    const records: ConflictRecord[] = [];
    for (const [id, changes] of groups) {
      // Reconciling a document walks its whole change history. The result only
      // changes when that document's history does, so an unchanged document
      // keeps its previous outcome instead of being reconciled again.
      const fingerprint = changes.map(change => change.id).join("|");
      let result = reconciled.get(id);
      if (!result || result.fingerprint !== fingerprint) {
        result = { fingerprint, outcome: reconcile(changes) };
        reconciled.set(id, result);
      }
      if (result.outcome.kind !== "conflict" && result.outcome.kind !== "mergeable") continue;
      const { boardId, collection, documentId } = changes[0];
      const target = { boardId, collection, documentId };
      const board = await collections.projects.findOne(boardId).exec();
      const boardMissing = !board || !visibleBoards.has(boardId);
      const name = board?.name ?? entries.find(e => e.collection === "projects" && e.boardId === boardId)?.value.name;
      records.push({ ...target, result: result.outcome, boardMissing, boardName: typeof name === "string" ? name : "Recovered board",
        pendingAuthorization: !boardMissing && signedBoards.has(boardId) && !!await options.canDraft?.(boardId), restriction: await restriction(target, result.outcome, signedBoards.has(boardId)), drafts: await journal.drafts.where("target").equals(id).toArray() });
    }
    return records.sort((a, b) => scope(a).localeCompare(scope(b)));
  }
  async function saveConflictDraft(target: ConflictTarget, draft: Omit<ConflictDraft, "id" | "target">): Promise<void> {
    if (!Array.isArray(draft.heads) || draft.heads.length > 128 || typeof draft.variantId !== "string"
      || typeof draft.title !== "string" || typeof draft.content !== "string" || typeof draft.writerId !== "string"
      || !/^[a-zA-Z0-9-]{1,100}$/.test(draft.writerId) || draft.title.length + draft.content.length > 1024 * 1024) throw new Error("Invalid resolution draft");
    // Each editor window owns a slot: parallel drafts never overwrite each other.
    await journal.drafts.put({ ...structuredClone(draft), target: scope(target), id: JSON.stringify([scope(target), draft.writerId]) });
    await options.changed(target.boardId); // Reuse the existing idle private-backup scheduler.
  }
  async function resolveConflict(input: ResolutionRequest): Promise<void> {
    // Clone before waiting for the queue; callers cannot replace the reviewed versions.
    const request = structuredClone(input);
    await options.locked(async () => {
      const entries = await history(request);
      const result = reconcile(entries.filter(e => scope(e) === scope(request)));
      if (!Array.isArray(request.heads) || !equalHeads(result.heads, request.heads) || new Set(request.heads).size !== request.heads.length
        || !["conflict", "mergeable"].includes(result.kind)) throw new Error("Conflict changed. Review the current versions before saving.");
      const denied = await restriction(request, result, entries.some(e => e.value._sec));
      if (denied) throw new Error(denied);
      const selected = result.variants.find(v => v.id === request.variantId);
      if (!selected) throw new Error("Select one of the reviewed conflict versions");
      const collection = collections[request.collection];
      if (isUntrustedImport(collection)) throw new Error("Recovery is in progress. Review the conflict again when it completes.");
      const doc = (await collection.findOne(request.documentId).exec())!;
      const current = doc.toJSON(true) as Record<string, any>;
      const value = structuredClone(selected.value);
      delete value._sec;
      if (request.edits) {
        if (isDeleted(value)) throw new Error("A deleted version cannot be manually edited");
        if (request.collection === "cards" && "title" in request.edits && typeof request.edits.title === "string" && typeof request.edits.content === "string") {
          value.title = request.edits.title; value.content = request.edits.content;
        } else if (request.collection === "projects" && "name" in request.edits && typeof request.edits.name === "string") value.name = request.edits.name;
        else throw new Error("Invalid manual resolution fields");
      }
      if (request.collection === "projects") {
        if (isDeleted(value)) throw new Error("Board deletion resolution requires the later board-wide recovery transaction. All versions are retained.");
        if (!BOARD_TEMPLATES.some(t => t === value.template) || value.template !== current.template) throw new Error("Resolve the board template separately before applying this version. All versions are retained.");
        if (typeof value.name !== "string" || !value.name.trim()) throw new Error("A board name is required");
        value.revision = Number(current.revision) + 1;
        if (current.tailOrderKey && (!value.tailOrderKey || current.tailOrderKey > value.tailOrderKey)) value.tailOrderKey = current.tailOrderKey;
      } else {
        const board = (await collections.projects.findOne(request.boardId).exec())!;
        if (typeof value.content !== "string" || (value.title !== undefined && typeof value.title !== "string")
          || !isTypeSupported(board.template, value.type as never) || !BOARD_ITEM_STATUSES.some(s => s === value.status)
          || (value.displayMode !== undefined && !CARD_DISPLAY_MODES.some(m => m === value.displayMode))) throw new Error("This version is incompatible with the current board. All versions are retained.");
        if (typeof value.imageId === "string" && !await options.hasImage(value.imageId)) throw new Error("Recover this version's image before applying the resolution.");
        if (isDeleted(value)) value.deletedAt = new Date().toISOString(); else delete value.deletedAt;
      }
      if (typeof value.orderKey !== "string" || !value.orderKey) throw new Error("This version has invalid ordering metadata");
      value.id = current.id;
      value.createdAt = current.createdAt;
      value.updatedAt = new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
      value._deleted = false; // Card deletion is a recoverable soft tombstone.
      const candidate = { ...current, ...value };
      for (const key of Object.keys(candidate)) {
        if (!["_rev", "_meta", "_attachments"].includes(key) && !(key in value)) delete candidate[key];
      }
      delete candidate._sec;
      await withResolutionOrigin(collection, candidate, request.heads, () => doc.incrementalModify(async (latest: Record<string, unknown>) => {
        // RxDB strips revision internals before public incremental modifiers.
        if (canonicalize(documentValue(latest)) !== canonicalize(documentValue(current))) throw new Error("Document changed. Review the current conflict before saving.");
        // Recheck authorization at the actual write; signing and storage guards
        // independently enforce manifest expiry and the new mutation's signature.
        await options.assertCanMutate(request.boardId);
        if (entries.some(e => e.value._sec) && !["owner", "editor"].includes(liveBoardRole(collection, request.boardId) ?? "")) throw new Error("Current trusted editor authorization is required");
        if (entries.some(e => e.value._sec) && request.collection === "projects" && result.variants.some(v => isDeleted(v.value))
          && liveBoardRole(collection, request.boardId) !== "owner") throw new Error("Only the board owner may resolve a board deletion");
        return candidate;
      }));
      if (request.collection === "cards") await options.touchProject(request.boardId);
      await options.changed(request.boardId);
    });
  }
  return { listConflicts, saveConflictDraft, resolveConflict };
}

import { canonicalize, type Json } from "../collab/security/canonical";
import { changeId, scope, type Change, type ChangeJournal, type DocumentValue, type JournalEntry } from "./changeJournal";
import { BOARD_TEMPLATES, BOARD_ITEM_TYPES, BOARD_ITEM_STATUSES, CARD_DISPLAY_MODES } from "../types";

export type Reconciliation = {
  heads: string[];
  variants: Change[];
  kind: "empty" | "current" | "deleted" | "mergeable" | "conflict";
  reason?: "missing-ancestry" | "unrelated-history" | "concurrent-delete" | "concurrent-fields" | "structural-change";
  /** An unsigned UI preview, NEVER a document eligible for replication. */
  preview?: DocumentValue;
};
const compare = (value: Json | undefined) => value === undefined ? "undefined" : canonicalize(value);
const deleted = (change: Change) => change.value._deleted === true || !!change.value.deletedAt;
const ignored = new Set(["_sec", "updatedAt", "revision"]);
const mergeableCardFields = new Set(["title", "content", "displayMode"]);
function preview(change: Change): DocumentValue {
  const { _sec: _, ...value } = change.value;
  return structuredClone(value);
}

/** No clock comparisons. Every original signed variant remains in the journal. */
export function reconcile(changes: Change[]): Reconciliation {
  if (!changes.length) return { kind: "empty", heads: [], variants: [] };
  const boardScope = scope(changes[0]);
  if (changes.some(c => scope(c) !== boardScope)) throw new Error("Mixed reconciliation scope");
  // A legacy observation of the exact SAME signed operation carries no ancestry
  // claim. A verified author proof can supply that operation's missing ancestry.
  // Preserve both source records; alias only exact signed bytes, never equal text.
  const aliases = new Map<string, string>();
  const provenValues = new Map(changes.filter(c => c.ancestry === "known" && (c as JournalEntry).proof && c.value._sec)
    .map(c => [canonicalize(c.value), c.id]));
  for (const change of changes) if (change.ancestry === "unknown" && !change.parents.length && change.value._sec) {
    const proven = provenValues.get(canonicalize(change.value));
    if (proven) aliases.set(change.id, proven);
  }
  changes = changes.filter(c => !aliases.has(c.id));
  const graph = new Map(changes.map(c => [c.id, c]));
  const parentsOf = (change: Change) => change.parents.map(id => aliases.get(id) ?? id);
  const parents = new Set(changes.flatMap(parentsOf));
  const heads = changes.filter(c => !parents.has(c.id)).sort((a, b) => a.id.localeCompare(b.id));
  const base = { heads: heads.map(c => c.id), variants: heads };
  const conflict = (reason: Reconciliation["reason"]): Reconciliation => ({ ...base, kind: "conflict", reason });
  const ancestry = new Map<string, Set<string>>();
  let missing = false;
  // Iterative traversal handles long offline histories without recursive overflow.
  function ancestors(id: string): Set<string> {
    const known = ancestry.get(id); if (known) return known;
    const seen = new Set<string>(), pending = [id];
    while (pending.length) {
      const next = pending.pop()!; if (seen.has(next)) continue;
      seen.add(next); const change = graph.get(next);
      if (!change) { missing = true; continue; }
      pending.push(...parentsOf(change));
    }
    ancestry.set(id, seen); return seen;
  }
  heads.forEach(h => ancestors(h.id));
  if (missing || !heads.length) return conflict("missing-ancestry");
  if (heads.length === 1) return { ...base, kind: deleted(heads[0]) ? "deleted" : "current", preview: preview(heads[0]) };
  // Journals written before snapshot imports stopped entering the WAL hold a
  // parentless observation root per pull generation, and every private
  // backup's `capture` seeds a parentless `baseline` root on a device whose
  // documents arrived from Drive. Such entries assert no authorship — no
  // proof, unknown ancestry, root-only — so they are observations of one
  // serialized history, never authored branches. When every head is
  // unowned, the newest observation is the document's state; when exactly
  // one head carries a verified author proof, that author chain IS the
  // document and the residue roots are inert. Same-account second browsers
  // hit this constantly: their backup capture seeds baseline roots beside
  // the replicated author chain, and a subsequent author delete must
  // replicate as an ordinary update, not a conflict panel.
  const residue = (change: Change) => { const e = change as JournalEntry; return !e.proof && e.ancestry === "unknown" && !e.parents.length && (e.origin === "observed" || e.origin === "baseline"); };
  const unowned = (change: Change) => residue(change) && !(change as JournalEntry).value._sec;
  if (heads.every(unowned)) {
    const newest = [...heads].sort((a, b) => (Date.parse(String(b.value.updatedAt ?? "")) || 0) - (Date.parse(String(a.value.updatedAt ?? "")) || 0))[0];
    return { heads: heads.map(h => h.id), variants: [newest], kind: deleted(newest) ? "deleted" : "current", preview: preview(newest) };
  }
  const provenHeads = heads.filter(h => (h as JournalEntry).proof && h.value._sec);
  if (provenHeads.length === 1 && heads.some(residue) && heads.every(h => h === provenHeads[0] || residue(h))) {
    const author = provenHeads[0];
    return { heads: heads.map(h => h.id), variants: [author], kind: deleted(author) ? "deleted" : "current", preview: preview(author) };
  }
  // A fork whose extra heads all descend from synthetic `baseline` roots —
  // an interrupted write's re-anchor or a private-backup capture seed — is
  // not concurrent authorship: this device serialized its writes and the
  // baseline chain merely continues the durable bytes. Observation roots
  // stay conflicting (a peer's unknown-history snapshot is a real variant).
  const syntheticChain = (change: Change) => {
    const roots = [...ancestors(change.id)].filter(id => !(graph.get(id)?.parents.length ?? 1));
    return roots.length > 0 && roots.every(id => { const e = graph.get(id)! as JournalEntry; return residue(e) && e.origin === "baseline"; });
  };
  if (heads.some(syntheticChain) && heads.filter(h => !syntheticChain(h)).length <= 1) {
    const newest = [...heads].sort((a, b) => (Date.parse(String(b.value.updatedAt ?? "")) || 0) - (Date.parse(String(a.value.updatedAt ?? "")) || 0))[0];
    return { heads: heads.map(h => h.id), variants: [newest], kind: deleted(newest) ? "deleted" : "current", preview: preview(newest) };
  }
  const shared = [...ancestors(heads[0].id)].filter(id => heads.every(h => ancestors(h.id).has(id)));
  // A unique maximal common ancestor is required; criss-cross merge bases are ambiguous.
  const nonMaximal = new Set(shared.flatMap(id => parentsOf(graph.get(id)!)));
  const nearest = shared.filter(id => !nonMaximal.has(id));
  if (nearest.length !== 1) return conflict("unrelated-history");
  if (heads.some(deleted)) return conflict("concurrent-delete");
  const ancestor = graph.get(nearest[0])!;
  if (deleted(ancestor)) return conflict("concurrent-delete");
  const merged = preview(ancestor);
  const keys = new Set([...Object.keys(ancestor.value), ...heads.flatMap(h => Object.keys(h.value))]);
  for (const key of keys) {
    if (ignored.has(key) || ancestor.collection === "projects" && key === "tailOrderKey") continue;
    const edits = heads.filter(h => compare(h.value[key]) !== compare(ancestor.value[key]));
    if (!edits.length) continue;
    if (ancestor.collection !== "cards" || !mergeableCardFields.has(key)) return conflict("structural-change");
    if (edits.some(h => key === "displayMode" ? !CARD_DISPLAY_MODES.some(mode => mode === h.value[key])
      : typeof h.value[key] !== "string" && !(key === "title" && h.value[key] === undefined))) return conflict("structural-change");
    if (edits.some(h => compare(h.value[key]) !== compare(edits[0].value[key]))) return conflict("concurrent-fields");
    if (edits[0].value[key] === undefined) delete merged[key]; else merged[key] = structuredClone(edits[0].value[key]);
  }
  return { ...base, kind: "mergeable", preview: merged };
}

/** Validate envelopes before the caller verifies the board-specific authorization.
 * Current protocol-2 signatures do NOT authenticate journal ancestry; a future
 * transport must supply an authenticated change envelope, not trust `_sec` alone.
 */
export async function validateChange(change: Change): Promise<void> {
  if (!change || change.version !== 1 || !["cards", "projects"].includes(change.collection)
    || !["known", "unknown"].includes(change.ancestry) || typeof change.boardId !== "string" || typeof change.documentId !== "string"
    || !change.boardId || !change.documentId
    || change.boardId.length > 120 || change.documentId.length > 100
    || !Array.isArray(change.parents) || change.parents.length > 8
    || change.parents.some(p => typeof p !== "string" || !/^[a-f0-9]{64}$/.test(p))
    || new Set(change.parents).size !== change.parents.length
    || !change.value || Array.isArray(change.value) || typeof change.value !== "object"
    || ["_rev", "_meta", "_attachments"].some(key => key in change.value)
    || (change.value._deleted !== undefined && typeof change.value._deleted !== "boolean")
    || (change.value.deletedAt !== undefined && typeof change.value.deletedAt !== "string")
    || change.value.id !== change.documentId
    || (change.collection === "cards" ? change.value.projectId : change.value.id) !== change.boardId
    || change.parents.includes(change.id) || (change.ancestry === "unknown" && change.parents.length > 0)
    || change.parents.some((parent, index) => index > 0 && parent <= change.parents[index - 1])) throw new Error("Invalid causal change envelope");
  const { id, version, boardId, collection, documentId, parents, ancestry, value } = change;
  if (new TextEncoder().encode(canonicalize(value)).length > 2 * 1024 * 1024) throw new Error("Causal document exceeds admission limit");
  if (await changeId({ version, boardId, collection, documentId, parents, ancestry, value }) !== id) throw new Error("Change identity mismatch");
}

export function createCausalReconciliation(journal: ChangeJournal) {
  return {
    async inspect(target: Pick<Change, "boardId" | "collection" | "documentId">): Promise<Reconciliation> {
      const entries = await journal.entries.where("[collection+documentId]").equals([target.collection, target.documentId]).toArray();
      return reconcile(entries.filter(c => c.state === "committed" && scope(c) === scope(target)));
    },
    /** An explicit verifier is mandatory; there is no permissive default.
     * Authorization is checked even on replay and before any incoming persistence.
     * This method is not wired to legacy snapshots or WebRTC in Jobs 3/4.
     */
    async receive(changes: Change[], verify: (change: Change) => Promise<boolean>): Promise<void> {
      if (!Array.isArray(changes) || changes.length > 128 || typeof verify !== "function") throw new Error("Bounded, verified change batch required");
      const accepted: JournalEntry[] = [];
      for (const input of changes) {
        const change = structuredClone(input); await validateChange(change);
        if (!await verify(structuredClone(change))) throw new Error("Board change authorization rejected");
        const { version, id, boardId, collection, documentId, parents, ancestry, value } = change;
        accepted.push({ version, id, boardId, collection, documentId, parents, ancestry, value, state: "committed", origin: "observed" });
      }
      await journal.accept(accepted);
    }
  };
}

/** Shared application validation for private persistence and peer history. */
export function validateRecord(change: Change) {
  const v = change.value;
  if (typeof v.orderKey !== "string" || !v.orderKey || v.orderKey.length > 100 || typeof v._deleted !== "boolean"
    || typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt)) || typeof v.updatedAt !== "string" || !Number.isFinite(Date.parse(v.updatedAt))) throw new Error("Causal history has invalid document metadata");
  if (change.collection === "projects") {
    if (typeof v.name !== "string" || !BOARD_TEMPLATES.some(t => t === v.template) || typeof v.revision !== "number" || !Number.isSafeInteger(v.revision) || v.revision < 0) throw new Error("Causal history has an invalid board");
  } else if (typeof v.content !== "string" || !BOARD_ITEM_TYPES.some(t => t === v.type) || !BOARD_ITEM_STATUSES.some(s => s === v.status)
    || (v.title !== undefined && typeof v.title !== "string") || (v.displayMode !== undefined && !CARD_DISPLAY_MODES.some(m => m === v.displayMode))) throw new Error("Causal history has an invalid card");
}

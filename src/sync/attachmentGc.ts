/**
 * Attachment garbage collection (Sync v2, milestone M6).
 *
 * Board attachments (images) live in an `attachments/` layout and are only
 * referenced indirectly, through card documents, so a delete race or a
 * dropped journal entry can orphan bytes. Collection is deliberately late:
 * an attachment is collectable only when it is referenced by no local
 * document, no pending journal op, no buffered op, *and* it has already been
 * absent from at least one published snapshot revision — a document that is
 * merely mid-edit (deleted locally, still present in the newest snapshot)
 * never loses its bytes, and an undo two revisions back is still safe
 * because the grace requires absence from two consecutive snapshots.
 */

export type AttachmentRecord = {
  id: string;
  /** Newest snapshot revision in which this attachment was still referenced. */
  lastPresentInSeq: number | null;
  /** When the blob was first stored locally (never collect brand-new files). */
  storedAt: number;
};

export type GcFacts = {
  attachments: AttachmentRecord[];
  /** Snapshot revision the local board state was last merged against. */
  snapshotSeq: number;
  /** Ids referenced by live documents, pending journal entries, or buffered ops. */
  liveReferences: Set<string>;
  now: number;
  /** Revisions an attachment must be absent from before collection (>= 2). */
  graceRevisions?: number;
  /** Files stored within this window are never collected (in-flight uploads). */
  freshMs?: number;
};

export function collectableAttachments(facts: GcFacts): string[] {
  const grace = Math.max(2, facts.graceRevisions ?? 2);
  const freshMs = facts.freshMs ?? 10 * 60 * 1000;
  const collect: string[] = [];
  for (const attachment of facts.attachments) {
    if (facts.liveReferences.has(attachment.id)) continue;
    if (facts.now - attachment.storedAt < freshMs) continue;
    if (attachment.lastPresentInSeq === null) {
      // Never observed in any snapshot: only collectable if snapshots exist
      // (otherwise there is no revision that ever proved it referenced).
      if (facts.snapshotSeq >= grace) collect.push(attachment.id);
      continue;
    }
    if (facts.snapshotSeq - attachment.lastPresentInSeq >= grace) collect.push(attachment.id);
  }
  return collect;
}

/**
 * Applies one published snapshot's references to the GC ledger: everything
 * referenced gets its `lastPresentInSeq` bumped; unreferenced records keep
 * their age, which is what drives the two-revision grace.
 */
export function applySnapshotReferences(
  ledger: Map<string, AttachmentRecord>,
  snapshotSeq: number,
  references: Iterable<string>,
  storedAt: (id: string) => number
): void {
  for (const id of references) {
    const existing = ledger.get(id);
    if (existing) existing.lastPresentInSeq = snapshotSeq;
    else ledger.set(id, { id, lastPresentInSeq: snapshotSeq, storedAt: storedAt(id) });
  }
}

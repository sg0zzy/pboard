/**
 * Attachment GC safety envelope: live references, brand-new blobs and
 * anything missing from fewer than two snapshot revisions are untouchable.
 */
import { describe, expect, it } from "vitest";
import { applySnapshotReferences, collectableAttachments, type AttachmentRecord } from "../../src/sync/attachmentGc";

const record = (id: string, lastPresentInSeq: number | null, storedAt = 0): AttachmentRecord => ({ id, lastPresentInSeq, storedAt });

describe("attachment garbage collection", () => {
  it("collects only long-orphaned attachments", () => {
    const facts = {
      attachments: [
        record("live", 5), record("freshly-gone", 10), record("gone-one-rev", 9),
        record("gone-two-revs", 8), record("never-seen", null)
      ],
      snapshotSeq: 10, liveReferences: new Set(["live"]), now: 10 ** 13, freshMs: 0
    };
    expect(collectableAttachments({ ...facts, attachments: facts.attachments.filter(a => a.id === "live") })).toEqual([]);
    expect(collectableAttachments(facts)).toEqual(["gone-two-revs", "never-seen"]);
  });

  it("protects in-flight uploads and pre-snapshot databases", () => {
    const now = 1_000_000;
    expect(collectableAttachments({
      attachments: [record("uploading", 1, now - 1000), record("orphan-before-first-snapshot", null, 0)],
      snapshotSeq: 0, liveReferences: new Set(), now, freshMs: 10_000
    })).toEqual([]);
  });

  it("keeps an undo window: delete at seq 10, snapshot 11 still references it, snapshot 12 frees it", () => {
    const ledger = new Map<string, AttachmentRecord>([["img", record("img", 11, 0)]]);
    // Card deleted locally at snapshot 11 (still referenced there).
    const facts = (snapshotSeq: number) => ({
      attachments: [...ledger.values()], snapshotSeq, liveReferences: new Set<string>(), now: 10 ** 13, freshMs: 0
    });
    expect(collectableAttachments(facts(11))).toEqual([]);
    expect(collectableAttachments(facts(12))).toEqual([]);
    // Snapshot 12 was published without the reference (ledger not bumped).
    expect(collectableAttachments(facts(13))).toEqual(["img"]);
  });

  it("applies snapshot references, bumping recency and inventoring new ids", () => {
    const ledger = new Map<string, AttachmentRecord>([["old", record("old", 3, 0)]]);
    applySnapshotReferences(ledger, 4, ["old", "new"], id => id === "new" ? 4000 : 0);
    expect(ledger.get("old")!.lastPresentInSeq).toBe(4);
    expect(ledger.get("new")).toEqual({ id: "new", lastPresentInSeq: 4, storedAt: 4000 });
  });
});

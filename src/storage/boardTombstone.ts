import type { ProjectOrderPreference } from "./projectOrder";

/**
 * Durable board deletion tombstones.
 *
 * A deletion is represented only as `projectOrder.deletedProjectIds` in this
 * build's history, and that field is a mutable part of an account-scoped
 * preference document: a preference merge, a `board.order` record that carries
 * nothing but ids, a Drive pull, or a session that never saw the delete can all
 * drop it. This module defines the record that the deletion actually is, so no
 * copy of the board — old `board.created`, old snapshot, old segment, old
 * preference file, old order record, buffered replay, or a Drive file adopted by
 * the reconcile round — can re-admit it.
 *
 * ## The record
 *
 * A tombstone is a *fact*: `deleted` or `restored`. Facts for one board share
 * one record keyed by the board id (`BoardTombstoneRecord`). A fact carries a
 * globally unique `opId` (`actorId:seq`), the writing actor and its sequence,
 * the causal *context* the writer had observed (an operation vector), the
 * device that wrote it, the role the deletion was performed as, and a
 * timestamp (`at`). The timestamp is informational — it is the value the
 * re-share check reads — and it is **never** the ordering authority.
 *
 * ## The ordering rule
 *
 * 1. **Causal dominance.** Fact `b` is later than fact `a` when `b`'s context
 *    contains `a`: `b.context[a.actorId] >= a.seq`. A fact written by a device
 *    that had seen the other necessarily wins; nothing else is needed for the
 *    ordinary case (one device deletes, another restores).
 * 2. **Concurrency.** When neither dominates (two devices deleted, or deleted
 *    and restored, without having seen each other), the tie is broken by
 *    `clock` (the Lamport clock carried in the fact), then `actorId`, then
 *    `seq`. That is a total, antisymmetric order every receiver computes from
 *    the same bytes, so no two devices pick different winners. Concurrent
 *    *deletions* are the same fact, so the tie-break only decides which record
 *    a later restore must dominate.
 *
 * ## Tombstone versus creation
 *
 * A creation (or any copy of the board: a Drive snapshot, a legacy AppState
 * row, a `board.created` record, a replayed segment) is admissible only when it
 * carries a causal context that **dominates the latest tombstone fact**. Every
 * copy in this build carries no context at all, and an absent context never
 * dominates anything, so every such copy is ordered *before* the tombstone and
 * is refused. No wall clock is consulted — an old creation with a future
 * timestamp still loses.
 *
 * A `restored` fact is the supported resurrection: it is written into the same
 * record, with the prior facts folded into its context, so it dominates the
 * deletion it reverses and the board becomes admissible again. This is what an
 * explicit user restore (`unhideProject`) means; nothing else may produce one.
 *
 * ## Retention
 *
 * Facts are retained indefinitely. There is no compaction, no age cutoff and no
 * gardening rule for them: until a safe rule is proven (for example a
 * provable "every device that ever held this board is gone"), removing a
 * tombstone is exactly the bug this module exists to prevent. Snapshot and log
 * gardening only trashes Drive objects and never touches this store.
 */
export type CausalContext = Record<string, number>;
/** The role the deletion was performed as. `private` is an unshared local
 *  board (no grant, no Drive ACL); `revoked` is a collaborator whose access
 *  was withdrawn, which leaves only their own list copy to remove. */
export type DeletionRole = "owner" | "editor" | "viewer" | "revoked" | "private";
export type BoardTombstoneKind = "deleted" | "restored";

export type BoardTombstoneFact = {
  kind: BoardTombstoneKind;
  /**
   * The account list this fact speaks for. A deletion is an account-list
   * decision (a collaborator leaves; the owner keeps the board), so two
   * accounts on one device have independent facts for the same board. `null`
   * is the no-account/local scope the preference document also uses.
   */
  accountId: string | null;
  /** `actorId:seq`; globally unique, so replaying the same fact is idempotent. */
  opId: string;
  actorId: string;
  seq: number;
  /** Lamport clock: `1 + max(observed clock, prior fact clocks)`. Tie-breaker only. */
  clock: number;
  /** The operation vector this writer had observed when it wrote the fact. */
  context: CausalContext;
  /** The browser profile that wrote the fact (the actor stream is its writer). */
  deviceId: string;
  role: DeletionRole;
  /** Informational. Re-share detection reads it; ordering never does. */
  at: string;
  /** How the fact came to exist (`local-delete`, `explicit-restore`, `legacy-preference:…`). */
  evidence: string;
};

/** One row per board: the store is keyed by board id, and the facts inside it are
 *  per account list. */
export type BoardTombstoneRecord = { boardId: string; facts: BoardTombstoneFact[] };

export type BoardDeletionState = { deleted: boolean; fact?: BoardTombstoneFact };

/** The facts that speak for one account list. */
export function scopedFacts(facts: readonly BoardTombstoneFact[], accountId: string | null): BoardTombstoneFact[] {
  return facts.filter(fact => fact.accountId === accountId);
}

/** Whether `context` records having observed `fact`. */
export function dominates(context: CausalContext, fact: Pick<BoardTombstoneFact, "actorId" | "seq">): boolean {
  return (context[fact.actorId] ?? 0) >= fact.seq;
}

/** Total, deterministic order over facts: Lamport clock, actor, sequence. */
export function totalOrder(left: BoardTombstoneFact, right: BoardTombstoneFact): number {
  if (left.clock !== right.clock) return left.clock - right.clock;
  if (left.actorId !== right.actorId) return left.actorId < right.actorId ? -1 : 1;
  return left.seq - right.seq;
}

/** The later of two facts — causal dominance first, then the total order. */
export function newerFact(next: BoardTombstoneFact, current: BoardTombstoneFact): BoardTombstoneFact {
  const nextDominates = dominates(next.context, current);
  const currentDominates = dominates(current.context, next);
  if (nextDominates !== currentDominates) return nextDominates ? next : current;
  return totalOrder(next, current) >= 0 ? next : current;
}

/** The fact that decides the board's state within one account list. */
export function latestFact(facts: readonly BoardTombstoneFact[], accountId: string | null = null): BoardTombstoneFact | undefined {
  return scopedFacts(facts, accountId).reduce<BoardTombstoneFact | undefined>(
    (latest, fact) => latest ? newerFact(fact, latest) : fact, undefined);
}

/**
 * Whether a copy of the board that observed `context` may be admitted. A copy
 * with no context (`{}`) never dominates a deletion, so it is refused; that is
 * the whole point.
 */
export function admissionAllowed(facts: readonly BoardTombstoneFact[], context: CausalContext = {}, accountId: string | null = null): boolean {
  const latest = latestFact(facts, accountId);
  if (!latest || latest.kind === "restored") return true;
  return dominates(context, latest);
}

/**
 * A fact in the one shape the store keeps it in: fixed field order, sorted
 * context keys.
 *
 * Field order is not semantic to the ordering rule, but it *is* what makes "two
 * receivers that accepted the same facts in different orders store the same
 * bytes" checkable rather than merely true in spirit: a fact decoded from the
 * wire and the same fact re-read from storage are built by different code
 * paths, and `JSON.stringify` reflects insertion order. Building every stored
 * fact through this one function makes that claim a byte comparison.
 *
 * Local provenance (`at`, `evidence`) is device-local and therefore part of the
 * fact's own row, not of the ordering-relevant content: a receiver records when
 * *it* learned the fact and how, and those fields are never compared.
 */
export function canonicalFact(fact: BoardTombstoneFact): BoardTombstoneFact {
  const context: CausalContext = {};
  for (const actor of Object.keys(fact.context).sort()) context[actor] = fact.context[actor];
  return { kind: fact.kind, accountId: fact.accountId, opId: fact.opId, actorId: fact.actorId, seq: fact.seq,
    clock: fact.clock, context, deviceId: fact.deviceId, role: fact.role, at: fact.at, evidence: fact.evidence };
}

/**
 * Union of two fact lists, deduplicated by `opId` and sorted by the total
 * order. Applying the same facts twice is the same as applying them once, and
 * two devices that received the same facts in different orders store the same
 * bytes.
 */
export function mergeFacts(current: readonly BoardTombstoneFact[], incoming: readonly BoardTombstoneFact[]): BoardTombstoneFact[] {
  const byOpId = new Map<string, BoardTombstoneFact>();
  for (const fact of [...current, ...incoming]) if (!byOpId.has(fact.opId)) byOpId.set(fact.opId, canonicalFact(fact));
  return [...byOpId.values()].sort(totalOrder);
}

/** A preference document as migration reads it. */
export type DeletionPreferenceInput = {
  preferenceId: string;
  preference: Pick<ProjectOrderPreference, "ids" | "updatedAt" | "deletedProjectIds" | "restoreEvents">;
};

export type LegacyDeletionPlan = {
  /** Markers with reliable evidence become tombstones. */
  adopt: { boardId: string; preferenceId: string; updatedAt: string }[];
  /** A restore event already outranks the marker: no tombstone, the board stays. */
  restored: { boardId: string; preferenceId: string }[];
  /**
   * Boards this device holds that no preference lists and no tombstone covers.
   * Absence is not evidence of deletion and not evidence of life: it is
   * reported and nothing is decided.
   */
  ambiguous: { boardId: string; reason: "absent-from-preference" }[];
};

/**
 * Turns legacy `deletedProjectIds` markers into tombstone candidates.
 *
 * Reliable evidence is exactly "the preference document carries the field and
 * the field names this board". Anything else is left undecided: a board missing
 * from every existing preference's `ids` while no tombstone records it is
 * reported as ambiguous, never deleted. Boards that already have a tombstone are
 * skipped so a repeated migration (or a restore that followed it) cannot
 * re-delete them.
 *
 * A device with **no** preference document at all has no evidence about any
 * board, so nothing is reported there: an absent document is not a claim that
 * every board is gone.
 */
export function planLegacyDeletionMigration(input: {
  preferences: readonly DeletionPreferenceInput[];
  localProjectIds: readonly string[];
  /** Whether a fact (of any kind) already exists for this board in the account
   *  list the preference speaks for. A fact from another account list is a
   *  different list's decision and must not stop this one being adopted. */
  alreadyRecorded: (boardId: string, preferenceId: string) => boolean;
}): LegacyDeletionPlan {
  const ordered = [...input.preferences].sort((a, b) => a.preferenceId.localeCompare(b.preferenceId));
  const adopt = new Map<string, { boardId: string; preferenceId: string; updatedAt: string }>();
  const restored = new Map<string, { boardId: string; preferenceId: string }>();
  for (const { preferenceId, preference } of ordered) {
    for (const boardId of preference.deletedProjectIds ?? []) {
      if (adopt.has(boardId) || input.alreadyRecorded(boardId, preferenceId)) continue;
      const restoredAt = preference.restoreEvents?.[boardId];
      if (restoredAt && Date.parse(restoredAt) >= Date.parse(preference.updatedAt)) {
        restored.set(boardId, { boardId, preferenceId });
        continue;
      }
      adopt.set(boardId, { boardId, preferenceId, updatedAt: preference.updatedAt });
    }
  }
  const known = new Set<string>([
    ...adopt.keys(),
    ...ordered.flatMap(({ preference }) => preference.ids),
    ...ordered.flatMap(({ preference }) => preference.deletedProjectIds ?? []),
    ...ordered.flatMap(({ preference }) => Object.keys(preference.restoreEvents ?? {}))
  ]);
  const ambiguous = !ordered.length ? [] : [...new Set(input.localProjectIds)]
    .filter(boardId => !known.has(boardId)
      && !ordered.some(({ preferenceId }) => input.alreadyRecorded(boardId, preferenceId)))
    .sort()
    .map(boardId => ({ boardId, reason: "absent-from-preference" as const }));
  return { adopt: [...adopt.values()], restored: [...restored.values()], ambiguous };
}

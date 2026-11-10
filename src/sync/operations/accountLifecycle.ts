/**
 * Account-level board lifecycle records: the wire format and the projection.
 *
 * A board's own operation log can never announce that a board exists — WAL to
 * operation conversion requires a Drive binding that only adoption creates
 * (`operations/source.ts:88`), so on the creating device the event happens
 * before there is anything to attach. The account room
 * (`pboard-account-<hash>-order`, admitted by `admission.rs:181-188` with an
 * empty Drive binding) therefore carries these records itself: a small
 * append-only stream of *hints* that one browser of a Google account is
 * telling its other browsers a board appeared, went away, or was renamed.
 *
 * Three rules are load-bearing and are the whole reason this is a separate
 * module rather than two more collections in `SyncLogEngine`:
 *
 * 1. **A record is a hint, never an authorization.** Applying a record may
 *    only cause a verification attempt against Drive (the existing role/board
 *    read); nothing here marks a board interactive, imports content, or grants
 *    anything. A forged or replayed record can therefore cost a reader one
 *    extra Drive read and nothing else.
 * 2. **Last write wins per board id, with no cross-entity references.** There
 *    is no project/card invariant to hold (the board engine's
 *    `projectId === boardId` and "cards need a project" rules are what make it
 *    structurally wrong here), so the projection is a map of board id to the
 *    newest record it has accepted, compared by `updatedAt` with the logical
 *    `seq` as the tie-breaker. An older record arriving after a newer one is
 *    dropped rather than reverting state, which is what makes replay of a
 *    reconnected cursor harmless.
 * 3. **Unknown kinds are ignored, not rejected.** The relay never parses a
 *    payload and this build must not be the reason a future kind wedges an old
 *    browser, so an unrecognized `kind` is counted and skipped while everything
 *    else in the batch still applies.
 *
 * Nothing in here touches a socket, storage, or a clock: `now` and `nextSeq`
 * are supplied by the caller so a scenario never needs a wall-clock sleep.
 */

/**
 * Every kind this build understands. Additive: a kind absent from this list
 * is a forward-compatible skip, never a parse failure.
 *
 * `board.tombstone` is separate from `board.deleted` on purpose. The other
 * board kinds are *hints*: the projection keeps the newest one per board by
 * `updatedAt`/`seq`, and the receiver verifies it against Drive before acting.
 * A tombstone is a *fact* from `storage/boardTombstone.ts`: it has a globally
 * unique `opId`, its own causal context and its own ordering rule (context
 * dominance, then Lamport clock, actor, sequence), and it is merged into the
 * durable tombstone store by that rule. Folding it into `board.deleted` would
 * have to either run a fact through last-write-wins — which silently drops a
 * concurrent or causally later fact the total order says must be kept — or
 * keep two orderings for one store, which is the merge duplication this build
 * must not have. It also gives a `restored` fact a way to travel at all: the
 * hint vocabulary has no restore.
 */
export const ACCOUNT_LIFECYCLE_KINDS = ['board.created', 'board.deleted', 'board.metadata', 'board.order', 'board.tombstone'] as const;
export type AccountLifecycleKind = typeof ACCOUNT_LIFECYCLE_KINDS[number];

/**
 * The board id a `board.order` record is addressed to. The account list is not
 * a board, but the projection is keyed by board id and that is exactly the
 * property an order needs: all order records for one account collapse into
 * one entry, so the newest order wins and the room cannot grow a second,
 * competing order row. It is a plain id in the wire charset, so a record that
 * names it parses like any other.
 */
export const ACCOUNT_ORDER_SCOPE = 'account-order';

/**
 * The causal fields a `board.tombstone` record carries — exactly the fields of
 * a `BoardTombstoneFact` that decide ordering and state, and nothing else.
 *
 * `accountId` is deliberately absent: the account room this record travels in
 * *is* one account list (`pboard-account-<hash>-order`), so the receiver fills
 * it from the room's own account. Carrying it would let a record claim to
 * speak for another account's list, which is the one thing a deletion fact
 * must not be able to do. `deviceId` and `evidence` are local provenance: a
 * receiver records its own evidence string, never the sender's claim about
 * itself.
 */
export type AccountTombstoneFact = {
  kind: 'deleted' | 'restored';
  opId: string;
  actorId: string;
  seq: number;
  clock: number;
  context: Record<string, number>;
  role: 'owner' | 'editor' | 'viewer' | 'revoked' | 'private';
};

/** A record's tombstone payload, present only on `board.tombstone`. */
export type AccountLifecycleRecord = {
  /** Discriminator, on the wire as `kind`. */
  kind: AccountLifecycleKind;
  /** The board this record is about: a `crypto.randomUUID()`
   * (`storage/rxdbRepository.ts:705`), and the only field a receiver needs —
   * its Drive location is derived from it (`sync/driveBoardStore.ts:26-28`). */
  boardId: string;
  /** Device clock at publication, ms since the epoch: the LWW field. */
  updatedAt: number;
  /** This device's monotonic send sequence: the LWW tie-breaker when two
   * browsers disagree by clock skew, and the record's logical clock. */
  seq: number;
  /** Display name, carried only by `board.metadata`; absent elsewhere. */
  name?: string;
  /** The total order of this account's board list, carried only by
   * `board.order`; absent elsewhere. See {@link ACCOUNT_ORDER_SCOPE}. */
  ids?: string[];
  /** The causal fact, carried only by `board.tombstone`. */
  fact?: AccountTombstoneFact;
};

/** The envelope as it appears inside the sealed log payload. `v` is the record
 * format version, separate from the log's own `protocolVersion`. */
type AccountLifecycleWire = {
  v: 1;
  kind: string;
  boardId: string;
  updatedAt: number;
  seq: number;
  name?: string;
  ids?: string[];
  fact?: AccountTombstoneFact;
};

/** A record's payload is a few hundred bytes; the relay caps one at 48 KiB
 * before decryption, so this bound only catches a hostile decoded object. */
const MAX_NAME_BYTES = 512;
/** The ceiling for every non-order kind, `board.tombstone` included. It is a
 * *decoded* bound as well as a *produced* one: a fact whose causal context is
 * so large that its envelope exceeds this cannot be read back by any receiver,
 * so `publishTombstone` refuses it up front (see `AccountLifecycleChannel`). */
export const MAX_CANDIDATE_BYTES = 4096;
/** A `board.order` record carries board ids, and an id is bounded at 200 bytes
 * (`validBoardId`). 512 ids is ~100 KiB of ids — far past any real account list
 * and past the relay's 64 KiB per-operation cap, so the *payload* cap is what
 * actually binds; this list bound is the second gate, kept explicit so a
 * hostile envelope can be refused before it is serialized into the log. Past
 * it a publication is refused (see `accountChannel.publish`) and the Drive
 * preference document remains the durable record. A *received* record past it
 * is skipped as `too-large`, never partially applied: half an order is a wrong
 * order. */
export const MAX_ORDER_IDS = 512;

const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** Board ids are UUIDs and the account hash is hex; both are id-charset
 * strings, and the charset is what keeps a record id from being a path. */
const validBoardId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

/** Why a payload was not applied. Reported to diagnostics; never thrown,
 * because a malformed record is somebody else's bug on a shared room. */
export type AccountLifecycleSkip = 'malformed' | 'unknown-kind' | 'too-large';

/** A whole order record's ceiling: below the relay's per-operation payload cap
 * (`sync_api.rs` `operation_bytes`, 64 KiB) so a record this build produces is
 * always one this build can read back, and a received one cannot exceed what a
 * single log row may carry. */
const MAX_ORDER_BYTES = 60 * 1024;

/** The ordered board ids of a `board.order` record, or null when the list is
 * not a total order over id-charset strings. Duplicates are refused: two ranks
 * for one board is not an order, and picking one silently would make two
 * receivers disagree. */
function orderIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ORDER_IDS) return null;
  if (!value.every(validBoardId)) return null;
  return new Set(value).size === value.length ? value as string[] : null;
}

/**
 * How many actors one fact's causal context may name. A context is one entry
 * per writer a device has observed of that board, and a board's operation
 * actors are its devices — a handful. The bound exists so a hostile envelope
 * cannot turn "fold this into the observed vector" into an unbounded map on
 * every receiver; past it the record is refused outright (`too-large`), never
 * truncated, because a truncated vector is a *weaker* claim that could then
 * lose facts it should have dominated.
 */
export const MAX_CONTEXT_ACTORS = 1024;
/** Ceiling on one context entry's sequence: far past any real actor's frontier
 * and still a safe integer, so `observed[actor] = max(...)` cannot be made to
 * lose precision by a hostile value. */
const MAX_CONTEXT_SEQ = Number.MAX_SAFE_INTEGER;
const DELETION_ROLES = ['owner', 'editor', 'viewer', 'revoked', 'private'] as const;

/** An `actorId:seq` op id: the fact's globally unique identity. Validated with
 * the id charset so it can never be a path or an unbounded string. */
const validOpId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}:[0-9]{1,16}$/.test(value);

/** A fact's causal context, or null when it is not a vector of finite,
 * non-negative integer sequences over id-charset actors. */
function causalContext(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CONTEXT_ACTORS) return null;
  const context: Record<string, number> = {};
  for (const [actor, seq] of entries) {
    if (!validBoardId(actor) || !isFiniteNumber(seq) || !Number.isInteger(seq)
      || seq < 0 || seq > MAX_CONTEXT_SEQ) return null;
    context[actor] = seq;
  }
  return context;
}

/**
 * The causal fact a `board.tombstone` record carries, or null when any part of
 * it would make two receivers disagree: the ordering rule is only total if
 * every field it reads is well formed. `opId` must also agree with
 * `actorId`/`seq`, because the op id *is* the fact's identity — a record whose
 * two names for its writer disagree would merge under one id and order under
 * another.
 */
function tombstoneFact(value: unknown): AccountTombstoneFact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fact = value as Partial<AccountTombstoneFact>;
  if (fact.kind !== 'deleted' && fact.kind !== 'restored') return null;
  if (!validOpId(fact.opId) || !validBoardId(fact.actorId)) return null;
  if (!isFiniteNumber(fact.seq) || !Number.isInteger(fact.seq) || fact.seq < 1 || fact.seq > MAX_CONTEXT_SEQ) return null;
  if (fact.opId !== `${fact.actorId}:${fact.seq}`) return null;
  if (!isFiniteNumber(fact.clock) || !Number.isInteger(fact.clock) || fact.clock < 1 || fact.clock > MAX_CONTEXT_SEQ) return null;
  const context = causalContext(fact.context);
  if (!context) return null;
  if (!DELETION_ROLES.includes(fact.role as typeof DELETION_ROLES[number])) return null;
  return { kind: fact.kind, opId: fact.opId!, actorId: fact.actorId!, seq: fact.seq!, clock: fact.clock!,
    context, role: fact.role as AccountTombstoneFact['role'] };
}

/** Reads a record envelope. Returns the skip reason for anything it cannot
 * use, so the caller can count it; only a well-formed known kind applies. */
export function decodeAccountLifecycle(payload: string): { record: AccountLifecycleRecord } | { skip: AccountLifecycleSkip } {
  if (payload.length > MAX_ORDER_BYTES) return { skip: 'too-large' };
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return { skip: 'malformed' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { skip: 'malformed' };
  const wire = raw as Partial<AccountLifecycleWire>;
  // Everything but an order is a few hundred bytes; an order is ids only and
  // has its own, larger ceiling.
  if (wire.kind !== 'board.order' && payload.length > MAX_CANDIDATE_BYTES) return { skip: 'too-large' };
  if (wire.v !== 1 || !isString(wire.kind) || !validBoardId(wire.boardId)
    || !isFiniteNumber(wire.updatedAt) || !isFiniteNumber(wire.seq)
    || wire.updatedAt <= 0 || !Number.isInteger(wire.seq) || wire.seq < 1) return { skip: 'malformed' };
  if (!(ACCOUNT_LIFECYCLE_KINDS as readonly string[]).includes(wire.kind)) return { skip: 'unknown-kind' };
  // `board.metadata` is the only kind that may carry a name, and only a
  // bounded one: an unbounded string here is a memory claim on every device
  // of this account.
  if (wire.name !== undefined && !(isString(wire.name) && new TextEncoder().encode(wire.name).byteLength <= MAX_NAME_BYTES)) return { skip: 'malformed' };
  const kind = wire.kind as AccountLifecycleKind;
  if (kind === 'board.order') {
    if (Array.isArray(wire.ids) && wire.ids.length > MAX_ORDER_IDS) return { skip: 'too-large' };
    const ids = orderIds(wire.ids);
    if (!ids || wire.boardId !== ACCOUNT_ORDER_SCOPE) return { skip: 'malformed' };
    return { record: { kind, boardId: wire.boardId, updatedAt: wire.updatedAt, seq: wire.seq, ids } };
  }
  if (kind === 'board.tombstone') {
    // The fact is the whole record. A tombstone that cannot be ordered is not a
    // tombstone: it is refused rather than applied with a guess, because every
    // receiver must compute the same winner from the same bytes.
    const fact = tombstoneFact(wire.fact);
    if (!fact) return { skip: 'malformed' };
    return { record: { kind, boardId: wire.boardId, updatedAt: wire.updatedAt, seq: wire.seq, fact } };
  }
  return { record: kind === 'board.metadata' && wire.name !== undefined
    ? { kind, boardId: wire.boardId, updatedAt: wire.updatedAt, seq: wire.seq, name: wire.name }
    : { kind, boardId: wire.boardId, updatedAt: wire.updatedAt, seq: wire.seq } };
}

/**
 * Whether a record is well formed *before* its send sequence is stamped.
 *
 * A queued record legitimately carries `seq: 0`: the sequence belongs to the
 * context that finally flushes it (`accountChannel.flush`), and an eager one
 * would spend a frontier slot for a row another context might replace. So the
 * durable queue validates shapes with this, and {@link encodeAccountLifecycle}
 * — which is what actually goes on the wire — keeps demanding a real sequence.
 * Without the split, every queued record would fail its own re-read after a
 * restart and vanish from the outbox, which is precisely the case the outbox
 * exists for.
 */
export function validQueuedRecord(record: AccountLifecycleRecord): boolean {
  if (!(ACCOUNT_LIFECYCLE_KINDS as readonly string[]).includes(record.kind) || !validBoardId(record.boardId)
    || !isFiniteNumber(record.updatedAt) || record.updatedAt <= 0
    || !isFiniteNumber(record.seq) || record.seq < 0 || !Number.isInteger(record.seq)) return false;
  if (record.name !== undefined && !(isString(record.name) && new TextEncoder().encode(record.name).byteLength <= MAX_NAME_BYTES)) return false;
  if (record.kind === 'board.order') return record.boardId === ACCOUNT_ORDER_SCOPE && !!orderIds(record.ids);
  if (record.kind === 'board.tombstone') return !!tombstoneFact(record.fact) && record.ids === undefined && record.name === undefined;
  return record.ids === undefined;
}

/** Writes a record envelope. Throws only on a record this module itself would
 * refuse to read back, which is a programming error, not a runtime condition. */
export function encodeAccountLifecycle(record: AccountLifecycleRecord): string {
  if (!(ACCOUNT_LIFECYCLE_KINDS as readonly string[]).includes(record.kind) || !validBoardId(record.boardId)
    || !isFiniteNumber(record.updatedAt) || record.updatedAt <= 0
    || !Number.isInteger(record.seq) || record.seq < 1) throw new Error('Invalid account lifecycle record');
  let wire: AccountLifecycleWire;
  if (record.kind === 'board.order') {
    if (record.boardId !== ACCOUNT_ORDER_SCOPE || !orderIds(record.ids)) throw new Error('Invalid account order record');
    wire = { v: 1, kind: record.kind, boardId: record.boardId, updatedAt: record.updatedAt, seq: record.seq, ids: record.ids };
  } else if (record.kind === 'board.tombstone') {
    const fact = tombstoneFact(record.fact);
    if (!fact) throw new Error('Invalid board tombstone record');
    wire = { v: 1, kind: record.kind, boardId: record.boardId, updatedAt: record.updatedAt, seq: record.seq, fact };
  } else wire = record.kind === 'board.metadata' && record.name !== undefined
    ? { v: 1, kind: record.kind, boardId: record.boardId, updatedAt: record.updatedAt, seq: record.seq, name: record.name }
    : { v: 1, kind: record.kind, boardId: record.boardId, updatedAt: record.updatedAt, seq: record.seq };
  const payload = JSON.stringify(wire);
  if (payload.length > MAX_ORDER_BYTES) throw new Error('Account lifecycle record exceeds size limit');
  return payload;
}

/**
 * The outbox slot a record occupies. Everything else collapses per (kind,
 * board) — a burst of reorders is one order, a second announcement before the
 * relay accepts the first is one record. A tombstone must not collapse that
 * way for *two* reasons:
 *
 * 1. Two facts for one board (a delete and the restore that reverses it) are
 *    both real and both must cross, in the order the total order gives them.
 *    Collapsing them would drop the restore and leave the peer believing the
 *    board is gone after this device re-admitted it.
 * 2. A retried tombstone must keep its identity: the slot is keyed by the
 *    fact's `opId`, so a re-flush of the same fact is the same queue entry,
 *    never a second one.
 */
export function outboxSlot(record: AccountLifecycleRecord): string {
  const identity = record.kind === 'board.tombstone' && record.fact ? record.fact.opId : '';
  return `${record.kind}\u0000${record.boardId}\u0000${identity}`;
}

/**
 * Enforces the outbox bound without ever letting a tombstone be the record that
 * silently disappears.
 *
 * The bound exists because an unbounded queue on a broken relay is a memory
 * leak and Drive remains the authority for every *hint*. A tombstone is not a
 * hint: its loss is the one loss that breaks the invariant (a peer keeps
 * presenting a board this device deleted, and an old creation can re-admit it
 * there). So eviction is ordered by what is safe to lose:
 *
 * 1. the oldest non-tombstone rows go first, however new the tombstone is;
 * 2. only a queue that is *entirely* tombstones (which takes more than 64
 *    deletions/restores this device never managed to announce) drops the
 *    oldest tombstone, and the caller is handed it so it can say so.
 *
 * `evicted` is what the caller must report: a dropped hint is a lost hint, a
 * dropped tombstone is a lost decision and must be visible in diagnostics
 * rather than inferred from a shorter queue.
 */
export function trimOutbox<T extends { record: AccountLifecycleRecord }>(rows: readonly T[], max: number): { rows: T[]; evicted: AccountLifecycleRecord[] } {
  const keep = [...rows];
  const evicted: AccountLifecycleRecord[] = [];
  let excess = keep.length - max;
  for (let index = 0; index < keep.length && excess > 0;) {
    if (keep[index].record.kind !== 'board.tombstone') { evicted.push(keep.splice(index, 1)[0].record); excess--; }
    else index++;
  }
  while (excess > 0 && keep.length) { evicted.push(keep.shift()!.record); excess--; }
  return { rows: keep, evicted };
}

/** What the projection knows about one board id: the newest record accepted
 * for it, plus how many times it saw a record it chose to ignore. */
export type AccountLifecycleEntry = AccountLifecycleRecord & { skipped: number; tie?: string };

/** A record as delivered: the decoded envelope plus the log row's own id, which
 * is the final tie-breaker — see {@link createAccountLifecycleProjection}. */
export type AccountLifecycleDelivery = AccountLifecycleRecord & { tie?: string };

/** One record the projection was asked to apply, and whether it moved state.
 * `duplicate: true` means the record restated what is already known or was
 * older than it, and the caller must not turn it into a second import. */
export type AccountLifecycleChange = { record: AccountLifecycleRecord; duplicate: boolean };

/** The named contract of {@link createAccountLifecycleProjection}. */
export type AccountLifecycleProjection = {
  /** Newest record accepted per board id, in insertion order. */
  entries(): AccountLifecycleEntry[];
  entry(boardId: string): AccountLifecycleEntry | undefined;
  apply(records: readonly AccountLifecycleDelivery[]): AccountLifecycleChange[];
  /** Entries that are not deletions — see {@link createAccountLifecycleProjection}. */
  live(): AccountLifecycleEntry[];
};

/**
 * The per-account projection: board id to the newest record accepted for it.
 *
 * `apply` returns exactly the records that changed state, in input order, so
 * the caller performs one verification attempt per *change* — that is the
 * property the duplicate-delivery scenario asserts (same record twice, one
 * row, one subscription). A record that restates what is already known (same
 * kind, `updatedAt` and `seq`) is reported as a duplicate rather than re-run.
 */
export function createAccountLifecycleProjection(): AccountLifecycleProjection {
  const entries = new Map<string, AccountLifecycleEntry>();

  /** Strict "newer wins": `updatedAt` first, `seq` as the tie-breaker so two
   * devices whose clocks agree still order deterministically, and — for two
   * devices whose clocks and sequences *both* agree, which two browsers with a
   * shared injected clock can produce — the log row id as the final tie-break.
   * That last step is what makes the winner the same on every receiver: every
   * device of the account sees the same two rows and compares the same strings,
   * so no two browsers can keep different orders. It is not a second
   * convergence mechanism; it completes the documented one. */
  const newer = (next: AccountLifecycleDelivery, current: AccountLifecycleDelivery) => {
    if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
    if (next.seq !== current.seq) return next.seq > current.seq;
    return (next.tie ?? '') > (current.tie ?? '');
  };

  function apply(records: readonly AccountLifecycleDelivery[]): AccountLifecycleChange[] {
    const changed: AccountLifecycleChange[] = [];
    for (const record of records) {
      const current = entries.get(record.boardId);
      if (!current) {
        entries.set(record.boardId, { ...record, skipped: 0 });
        changed.push({ record, duplicate: false });
        continue;
      }
      if (!newer(record, current)) {
        // Stale or replayed: counted, never applied. A reconnect that replays
        // from a cursor behind the projection lands here for every row. An
        // equal-clock loser is reported the same way on purpose: the winner is
        // already applied, so the outcome is visible rather than dropped — the
        // projection never reverts to a strictly older order.
        current.skipped++;
        changed.push({ record, duplicate: true });
        continue;
      }
      const restated = current.kind === record.kind && current.updatedAt === record.updatedAt
        && current.seq === record.seq && (current.tie ?? '') === (record.tie ?? '');
      entries.set(record.boardId, { ...record, skipped: current.skipped });
      changed.push({ record, duplicate: restated });
    }
    return changed;
  }

  return {
    entries: () => [...entries.values()],
    entry: boardId => entries.get(boardId),
    apply,
    /** Everything the projection believes exists: created or renamed, not
     * deleted. Deletion is a state, not a removal from the map — a later
     * `board.created` with a newer clock must be able to resurrect it, and
     * forgetting the delete would let an old record bring the board back. */
    live: () => [...entries.values()].filter(entry => entry.kind !== 'board.deleted' && entry.boardId !== ACCOUNT_ORDER_SCOPE)
  };
}

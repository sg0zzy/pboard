/**
 * The account-level discovery channel: one operation-log connection per browser
 * on the account room, carrying board lifecycle records.
 *
 * Why this exists: creating a board writes locally and publishes nothing that
 * leaves the device (the WAL→operation conversion in `operations/source.ts:88`
 * needs a Drive binding that only adoption creates), so a second browser of the
 * same Google account learns the board only by polling the Drive listing. The
 * account room (`pboard-account-<hash>-order`, admitted by `admission.rs:181-188`
 * with an empty Drive binding, pinned client-side as `account:<hash>`) already
 * exists and is already admissible; in `operationSync` mode nothing opened it
 * (`runtime.ts` binds board topics only), so this is a new connection, not a
 * reuse. No service change is required: the log is payload-opaque
 * (`sync_api.rs:107`) and a never-subscribed room answers `liveFromSeq: 1,
 * synced: true` with its own `next_seq` and its own capacity budget.
 *
 * Records ride the log as operations whose field name is outside this build's
 * vocabulary (`protocol.ts:isKnownVocabulary`). That is deliberate and buys four
 * things for free: the transport's structural validation, the log's `(board,
 * op_id)` uniqueness (the idempotency key), the per-connection seq cursor
 * (replay after a reconnect), and the skip-forward behaviour a future kind needs.
 * The channel never touches `SyncLogEngine`, whose per-board invariants
 * (`engine.ts:70,213,321`) are structurally wrong for account entities.
 *
 * Two rules bound what this can do, and neither is negotiable:
 *
 * 1. **A record is a hint.** Applying one hands the board id to the caller's
 *    verification callback, which is the existing Drive role/board path. A forged
 *    or replayed record can therefore only ever trigger a verification attempt;
 *    it cannot make a board interactive, import content, or grant access the
 *    Drive ACL does not already grant.
 * 2. **A publication must never become a user-visible failure.** A record is
 *    queued durably and flushed when the channel can send it; every error path
 *    ends in a diagnostic and no method here rejects or throws. A relay that is
 *    down, a grant that 403s, or a Drive outage must not turn "you made a board"
 *    into an error dialog, and a relay ack is never reported as Drive durability
 *    (`sync_api.rs` acks its own SQLite write, nothing more).
 *
 * Status of this build: the channel, its record codec (`accountLifecycle.ts`), the
 * runtime wiring — publish at the end of a successful board sync and on rename and
 * deletion, consume through the existing create-free-verified discovery path, the
 * `pboardCollaboration()` report including the missing-pin cause — and the scenarios
 * in `tests/multiBrowser/boardLifecycle.test.ts` are complete: realtime discovery
 * without a Drive poll, duplicate delivery leaving one row and one subscription,
 * `absent-pin`, a record that grants nothing (verified by a second device of the
 * authoring room, so the verification path itself is under test), a rename reaching
 * a peer that holds the board, a record queued while the transport is down flushing
 * on the next connection, an expired manifest plus dead transport recovering by
 * itself, and two contexts sharing one browser profile publishing without op-id
 * collisions or lost queues. Still not asserted by a scenario: delete reaching a
 * peer that holds no room for the board (T3 — the verified-absence rule is now the
 * create-free `boardFolderExists`, not the snapshot probe), relay restart and
 * unusable history (T10/T11), reconnect pacing (T7). Two known-open limits carry no
 * test because they carry no code yet: the account room has no server-side
 * committer, so its log grows under the relay's generic retention rather than a
 * board's snapshot cadence, and the projection's LWW tiebreak on equal
 * `(updatedAt, seq)` resolves by op-id, which two devices can produce in different
 * orders for the same rename.
 */
import { collaborationDiagnostic } from '../../collab/diagnostics';
import { createPlaintextOperationCodec } from './plaintextCodec';
import { OperationBindingError } from './logRoom';
import type { GoogleDriveCredentials } from './googleDriveAdmission';
import type { RelayAuthorization } from '../../collab/security/relayAdmission';
import type { ServiceAdmissionRequest } from '../../collab/experimentalWebSocketSignaling';
import type { StoredDeviceKey } from '../../collab/security/keys';
import type { KeyValueStorage } from '../../storage/repository';
import { withStorageLock } from '../../storage/lock';
import { createOperationLogCodec, createOperationLogSync, type LogSyncStatus, type OperationLogSync } from './logSync';
import type { AuthBudget } from '../../collab/authBudget';
import type { BoardContentKey } from '../bufferCrypto';
import type { Operation } from './protocol';
import {
  ACCOUNT_ORDER_SCOPE,
  createAccountLifecycleProjection,
  decodeAccountLifecycle,
  encodeAccountLifecycle,
  MAX_CANDIDATE_BYTES,
  outboxSlot,
  trimOutbox,
  type AccountLifecycleDelivery,
  type AccountLifecycleKind,
  type AccountLifecycleRecord,
  type AccountLifecycleSkip,
  type AccountTombstoneFact,
  validQueuedRecord
} from './accountLifecycle';

/** Field name carrying the lifecycle envelope inside an operation's `fields`.
 * It is deliberately absent from `cardFields`, which is what makes the row
 * unreadable to the board engine and forward-compatible for kinds this build
 * cannot parse. */
export const ACCOUNT_LIFECYCLE_FIELD = 'pboardAccountLifecycle';

/** The account room's topic, exactly as `relayAdmission.ts:22-24` admits it and
 * `admission.rs:181-188` derives it from the `account:<hash>` board id. */
export const accountLifecycleTopic = (account: string) => `pboard-account-${account}-order`;

/** Where the channel stands, in words a person can read in
 * `pboardCollaboration()`. `absent-pin` is the one that matters most: it is the
 * difference between "this browser was never enrolled in the account room" and
 * silence, and muteness is what made the grant-404 loop undiagnosable. */
export type AccountChannelState = 'disabled' | 'starting' | 'connected' | 'failed' | 'absent-pin' | 'gap' | 'closed';

/** Where the account room's own admission stands, in words a person can read.
 *
 * `absent-pin` is a *state*, and a state without its cause is what made this
 * channel's silence undiagnosable: a browser can hold no pin because it never
 * tried (before this field: every shipped browser), because another browser of
 * the account has not admitted it yet, or because the pin could not be
 * established at all. The channel only ever knows "no pin"; the runtime — which
 * owns the bootstrap — answers *why* here, next to the state it explains.
 */
export type AccountAuthorityReport = {
  /** `idle` (not attempted), `pinned` (no pin existed and this browser created
   * one), `adopted` (an existing pin was reused and this browser holds its
   * authority key), `authority-not-local` (an existing pin was reused but its
   * private key is not in this browser, so it can use the room but never renew
   * the manifest), `renewed`, `awaiting-admission` (an authority exists; this
   * device filed its request and the authority browser admits it on its next
   * pass, `failed`. */
  state: 'idle' | 'pinned' | 'adopted' | 'authority-not-local' | 'renewed' | 'awaiting-admission' | 'failed';
  /** The cause, as a fixed sentence. Never a token, key or payload. */
  reason: string;
  /** The admission's own last refusal once a pin exists (`not a member`,
   * `expired`, …). `absent-pin` alone would be a false explanation then. */
  authorization?: string;
};

/** The channel's report: state, applied sequence, last record kind, the queue
 * depth, forward-compatibility counters, and why it is not working. */
export type AccountChannelStatus = {
  account: string | null;
  state: AccountChannelState;
  /** Why the channel is not usable, or `ready`. Fixed phrases plus at most a
   * transport reason — never a token, key or payload. */
  reason: string;
  /** Why the account *authority* is or is not available; see
   * {@link AccountAuthorityReport}. */
  authority?: AccountAuthorityReport;
  appliedSeq: number;
  /** `kind` of the last record applied, for "did it arrive?" triage. */
  lastKind: string | null;
  /** Records waiting to go out: non-zero while the relay or Drive is broken. */
  outbox: number;
  /** Records received before the board they name was verifiable — a creation is
   * announced at the moment the local row exists, so "Drive does not have it
   * yet" is an expected answer, not a refusal. They are re-verified on every
   * reconcile round and bounded. */
  deferred: number;
  /** The boards those records name, so a report can say *which* board is waiting
   * rather than only how many. */
  deferredBoards: string[];
  /** Received records this build could not use, by reason. Forward compatibility
   * has to be visible or it is indistinguishable from loss. */
  skipped: Record<AccountLifecycleSkip, number>;
  /** Records handed to verification, by kind. */
  appliedByKind: Record<string, number>;
  error: string | null;
  reconnectReason: string | null;
  throttled: boolean;
};

/** What the caller's verification made of one received record.
 *
 * `deferred` is the answer a *creation-time* announcement needs: the record now
 * arrives before the board exists on Drive, so "Drive does not name this board
 * yet" is an expected answer rather than a refusal. The channel keeps such a
 * record and re-verifies it on every reconcile round
 * ({@link AccountLifecycleChannel.retryDeferred}) and whenever the publisher's
 * confirmation record arrives, which is what a creation-time announcement owes
 * the peer once the board reaches Drive; after
 * {@link MAX_DEFER_ATTEMPTS} passes it is dropped with a diagnostic, because
 * the Drive listing remains the authority for a board no record could vouch for.
 */
export type AccountRecordOutcome = 'applied' | 'deferred' | 'ignored';

/** The named contract of {@link createAccountLifecycleChannel}. Every method is
 * safe to call at any time; none rejects. */
export type AccountLifecycleChannel = {
  status(): AccountChannelStatus;
  /** Queues a record for publication. Never rejects and never throws: resolves
   * true once the record is durably queued, false when there was nothing to
   * queue into (no account or no pin), or when the record could not be encoded
   * (an order past {@link MAX_ORDER_IDS}), which is the caller's cue not to mark
   * the board announced. */
  publish(kind: AccountLifecycleKind, boardId: string, extra?: { name?: string; ids?: string[]; atMs?: number }): Promise<boolean>;
  /**
   * Carries one durable tombstone fact to the rest of the account, so a device
   * that never saw the deletion receives the *evidence* rather than a hint it
   * would have to infer.
   *
   * This is the only publication that is a fact: the record carries the causal
   * fields (`opId`, `actorId`, `seq`, `clock`, `context`, `role`) that the
   * receiver's durable store orders by, and the receiver merges it through the
   * same `mergeFacts`/`latestFact` rule the local delete/restore path writes
   * through. `accountId` is filled from the room, never from the record.
   *
   * Never rejects. Resolves false only when the fact cannot be carried at all:
   * no durable queue (no account or no pin) — the caller must then treat the
   * peer as uninformed, which is the case the Drive preference fallback covers
   * — or an envelope past {@link MAX_CANDIDATE_BYTES}/the context bound, which
   * is refused before it can occupy a slot and expire at every receiver.
   *
   * A queued tombstone is never the record the outbox bound drops while a hint
   * could go instead, and it takes its own slot (`outboxSlot`), so a delete and
   * the restore that reverses it are two facts, each retried as itself.
   */
  publishTombstone(boardId: string, fact: AccountTombstoneFact, atMs?: number): Promise<boolean>;
  /** Publishes this account list's total order. One record per settling
   * reorder: the outbox holds at most one order record, so a burst of reorders
   * collapses into the last one instead of queueing one per step. `updatedAt`
   * is the reorder's own clock (the preference document's `updatedAt`), so the
   * record and the durable Drive copy share one clock and a receiver that
   * writes the record's clock stores the same document the sender has. */
  publishOrder(ids: readonly string[], updatedAt: number): Promise<boolean>;
  /** The name already announced for a board, so a rename publishes once. */
  announcedName(boardId: string): string | undefined;
  /** Attaches a repository's `projectOrderChanged` to the account room: one
   * `board.order` record per settling reorder, gated on the account scope the
   * reorder was made under. Fire-and-forget — it resolves when the record is
   * queued, and can never fail the reorder. */
  publishLocalOrder(order: { account: string | null; ids: string[]; updatedAt: number }): Promise<void>;
  /** Opens the channel if it is not open. Idempotent, never rejects. */
  start(): Promise<void>;
  /** Retries the queue now (after a reconnect, or from an explicit action). */
  flush(): Promise<void>;
  /** Re-verifies the records whose board was not on Drive when they arrived.
   * Called by every reconcile round; idempotent, bounded, and never rejects.
   * The other trigger is the publisher's confirmation record — a normal
   * received record, so it needs no special case here. */
  retryDeferred(): Promise<void>;
  /** Applies a record received by another context's channel instance — the seam
   * a browser uses when the same account channel is owned elsewhere. */
  receive(operations: readonly Operation[]): Promise<void>;
  close(): Promise<void>;
  /** Forgets the account and re-opens on the next `start()` (sign-out/switch). */
  reset(): Promise<void>;
};

/** One queued record plus the context that assigned its send sequence and
 * the send failures it has survived. `record.seq` belongs to the stamping
 * actor: a context sends a foreign row only after re-stamping it onto its
 * own chain, which is what makes a retry the *same* op id while two
 * contexts' chains can never collide on the log's `(board, op_id)` index. */
type QueuedRecord = { record: AccountLifecycleRecord; stamp: string; attempts: number };

/** Durable per-account state — shared through storage by every runtime
 * context of this browser (the MV3 worker and the sidebar each build one),
 * which is why every mutation is a read-merge-write under
 * {@link withStorageLock} and not a whole-object overwrite: the send frontier
 * deliberately is *not* here (the actor is unique per context, so a frontier
 * it cannot reuse outlives nothing), while the applied cursor (so a restart
 * does not re-read retained history), the outbox (so a creation made while
 * the relay was down is still announced — by whichever context holds the
 * live socket), and the announced names (so a rename is reported once, not
 * per edit) all have to survive either context's last write. */
type SharedAccountState = {
  cursor: number;
  outbox: QueuedRecord[];
  names: Record<string, string>;
};

const STATE_KEY = 'pboardAccountLifecycle';
/** Bound on the queue: the Drive listing stays the authority, so a record that
 * cannot be announced is a lost hint, not a lost board — and an unbounded queue
 * on a broken relay is a memory leak. */
const MAX_OUTBOX = 64;
/** Send failures one record may survive before it is dropped with a
 * diagnostic — counted *on the record*, so one record the log rejects
 * (a full room, a hostile payload) ages itself out without taking the
 * records behind it down with it, which is what a per-pass bound gets
 * wrong: an outage costs one round of attempts per record, not the queue.
 * Dropping calls {@link AccountChannelOptions.onRecordExpired} so the
 * caller can un-mark the board announced and let a later round re-queue
 * it; until the log acknowledges a record, it has not been announced. */
const MAX_FLUSH_ATTEMPTS = 5;
/** How many verification passes a received record may survive before it is
 * dropped. A creation is announced before its board reaches Drive, so the first
 * answer is routinely "not there yet"; Drive publication is asynchronous and can
 * wait behind a publication flush, so the bound has to be generous in *passes*
 * (each pass is one reconcile round, never a timer) yet finite:
 * an unverifiable record is a hint, and the Drive listing is the authority that
 * still finds the board. Bounded at {@link MAX_DEFERRED} records as well, so a
 * room full of records for boards this device cannot see cannot grow memory. */
const MAX_DEFER_ATTEMPTS = 8;
/** Distinct deferred records held at once. A creation-time announcement makes
 * this reachable in normal use — a device that creates more boards than one
 * reconcile round can publish — so the bound is what the oldest-unpublished
 * case degrades to, not an anomaly. */
const MAX_DEFERRED = 128;

export type AccountChannelOptions = {
  storage: KeyValueStorage;
  googleDrive?: { getCredentials(): Promise<GoogleDriveCredentials>; fetcher?: typeof fetch; onHint?: (boardId: string) => void };
  /** The connected account's hash, or null when Drive is disconnected. Resolved
   * on every `start()` so a sign-out or account switch cannot leave a channel
   * attached to the previous account's room. */
  account: () => Promise<string | null>;
  /** The account room's admission — `accountSecurityFor(account).relayAuthorization`
   * in the runtime, re-resolved for every connection so an expired manifest is
   * refreshed rather than re-presented. A missing `account:<hash>` pin resolves
   * null (or throws); both mean `absent-pin`, and neither may propagate to a
   * board opening. */
  authorization: (account: string) => Promise<RelayAuthorization | null>;
  /** The relay endpoint for the account room (the runtime's collaboration
   * setting). Supplied here rather than read here, so there is still exactly one
   * settings cache in the process. */
  relayUrl: () => Promise<string>;
  /** Device signing key for the account scope (`account-device:<hash>`). */
  getKey: (account: string) => Promise<StoredDeviceKey>;
  /**
   * One key-courier pass for the account room: publishes this device's wrap key,
   * collects a grant addressed to it, and — for the device that holds the account
   * authority — wraps the account key for every peer whose wrap key is known.
   * Returns the key this device holds afterwards, if any. Must never throw: a
   * relay that refuses the courier leaves the channel without a key, which is a
   * reported state, not an exception.
   *
   * A channel with no key is not a channel: every inbound row would be inert
   * wire, so `start()` waits for a key the way the board path does (publish a
   * hand-off beacon the key-holders can read, poll the courier a bounded number
   * of times) and then reports the reason instead of connecting blind. The
   * account room is not a plaintext plane.
   */
  acquireKey: (account: string) => Promise<BoardContentKey | undefined>;
  getServiceAdmission?: (request: ServiceAdmissionRequest) => Promise<string>;
  /** True for an admission refusal reconnecting cannot fix (a service 403): the
   * connection ends with that reason instead of re-presenting it every backoff. */
  isTerminalAdmissionError?: (error: unknown) => boolean;
  /** Hands a record that moved the projection to the caller's verification path.
   * The answer decides its fate: `applied`/`ignored` finish it, `deferred` keeps
   * it for the bounded re-verification described at {@link AccountRecordOutcome}.
   * A throwing implementation is caught and recorded, never rethrown, and the
   * record is `deferred` — a failed verification is the direction that must not
   * lose a board. */
  onRecord: (record: AccountLifecycleRecord) => Promise<AccountRecordOutcome>;
  /** Tells the caller that one queued record gave up after
   * {@link MAX_FLUSH_ATTEMPTS} send failures — the record was never
   * acknowledged, so a caller that tracks "already announced" per board MUST
   * forget it here, or the board never becomes re-announcable. The Drive
   * listing stays the authority either way. */
  onRecordExpired?: (record: AccountLifecycleRecord) => void;
  onStatus?: (status: AccountChannelStatus) => void;
  /** Why the account authority is or is not available, for the report. Read
   * only when a status is produced, never on the connect path, and given the
   * account this channel is attached to — a callback that asked the channel
   * for its own status would recurse. */
  authority?: (account: string | null) => AccountAuthorityReport;
  /** Injectable clock, so a scenario never needs a wall-clock sleep. */
  now?: () => number;
  /** Tests shorten the backoff; nobody else should. */
  reconnectBaseMs?: number;
  /** The shared per-context automatic-auth budget: the account channel's own
   * `GET /ws` and its reconnect attempts are counted by the proxy like any
   * board's. Production omits it and shares the module singleton. */
  authBudget?: AuthBudget;
};

/** One account channel per browser context. */
export function createAccountLifecycleChannel(options: AccountChannelOptions): AccountLifecycleChannel {
  const projection = createAccountLifecycleProjection();
  const now = options.now ?? (() => Date.now());
  const skipped: Record<AccountLifecycleSkip, number> = { malformed: 0, 'unknown-kind': 0, 'too-large': 0 };
  const appliedByKind: Record<string, number> = {};

  let account: string | null = null;
  let state: AccountChannelState = 'disabled';
  let reason = 'not started';
  let lastKind: string | null = null;
  let error: string | null = null;
  let appliedSeq = 0;
  let log: OperationLogSync | undefined;
  let starting: Promise<void> | undefined;
  let flushing: Promise<void> | undefined;
  let reconnectReason: string | null = null;
  let throttled = false;
  let durable: SharedAccountState | undefined;
  let closed = false;
  // Queued publications must not reopen a channel after explicit teardown.
  // A later explicit start enables automatic retries again.
  let allowImplicitStart = true;
  /**
   * Records whose board was not verifiable when they arrived, keyed by board
   * id. In memory on purpose: a deferral is a wait for *this* session's next
   * Drive answer, and a record that survives a restart is re-delivered by the
   * log's cursor anyway — persisting it would duplicate the transport's own
   * replay with a second, weaker one.
   *
   * Each entry keeps the newest record seen for the board (the projection's own
   * rule: a `board.deleted` that arrived later wins) and how many verification
   * passes it has survived. Bounded by {@link MAX_DEFERRED} and
   * {@link MAX_DEFER_ATTEMPTS}; both are reported in
   * {@link AccountChannelStatus.deferred} and in the console.
   */
  const deferredRecords = new Map<string, { record: AccountLifecycleRecord; attempts: number }>();
  let retrying: Promise<void> | undefined;
  /** This context's send identity. The device key alone is not one: the MV3
   * worker and the sidebar of the same profile both run a runtime over the
   * same storage and the same `account-device:<hash>` key, and two actors
   * incrementing their own frontiers produce identical `actorId:seq` op ids —
   * which the log answers `duplicate: true`, silently swallowing the loser.
   * A per-context suffix (id charset, so `valid_id` admits it) makes every
   * frontier private, and the suffix dies with the context, which is why the
   * frontier never needs to be durable: an op id can only be reused by the
   * context that minted it, and only while its queue already reflects the
   * acknowledged row. */
  const contextNonce = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  let sendActor = '';
  /** The actor's own frontier: the last sequence this context ever stamped
   * (acknowledged or not — never rewound, because an attempt that timed out
   * may have landed). Reconnects inside one context continue it; a new
   * context is a new actor and starts from zero again. */
  let sendSeq = 0;
  /** Whether the last reported log phase was `synced` — the edge trigger for
   * the reconnect flush, so a hundred heartbeats do not mean a hundred passes. */
  let wasSynced = false;

  const stateKey = (scope: string) => `${STATE_KEY}${options.googleDrive ? ':google-v1' : ''}:${scope}`;

  const report = (cause: unknown, context: string) => {
    error = cause instanceof Error ? cause.message : String(cause);
    collaborationDiagnostic('account_channel.failed');
    void context;
  };

  const announce = () => options.onStatus?.(status());

  const status = (): AccountChannelStatus => ({
    account, state, reason, appliedSeq, lastKind,
    ...(!options.googleDrive && options.authority ? { authority: options.authority(account) } : {}),
    outbox: durable?.outbox.length ?? 0,
    deferred: deferredRecords.size,
    deferredBoards: [...deferredRecords.keys()],
    skipped: { ...skipped }, appliedByKind: { ...appliedByKind }, error, reconnectReason, throttled
  });

  const safeEncode = (row: AccountLifecycleRecord) => {
    try { return encodeAccountLifecycle(row); } catch { return ''; }
  };

  /** Reads one stored blob into a usable state. A record is only kept if it
   * still decodes (an older or damaged write is dropped, not fatal); a row of
   * the pre-per-context-actor shape — a bare record — is adopted as an
   * unstamped queue entry, which sends it under whoever flushes it next. */
  function normalize(raw: unknown): SharedAccountState {
    const stored = raw && typeof raw === 'object' ? raw as Partial<SharedAccountState> & Partial<AccountLifecycleRecord> : undefined;
    const rows = Array.isArray(stored?.outbox) ? stored!.outbox : [];
    const outbox: QueuedRecord[] = [];
    for (const row of rows) {
      const wrapped = row && typeof row === 'object' && 'record' in row ? row as { record?: unknown; stamp?: unknown; attempts?: unknown } : undefined;
      const record = (wrapped ? wrapped.record : row) as AccountLifecycleRecord | undefined;
      if (!record || typeof record.boardId !== 'string' || typeof record.updatedAt !== 'number' || typeof record.seq !== 'number') continue;
      // Shape-only: a queued record has no send sequence yet (`seq: 0`), so
      // re-encoding it — which demands one — would drop the queue on every read.
      if (!validQueuedRecord(record)) continue;
      outbox.push({ record, stamp: typeof wrapped?.stamp === 'string' ? wrapped.stamp : '', attempts: Number.isSafeInteger(wrapped?.attempts) ? wrapped!.attempts as number : 0 });
    }
    // A tombstone is never the record the bound drops while a hint could go
    // instead: see `trimOutbox`. A queue read back with one over the bound
    // (an older build wrote it, or the bound shrank) is trimmed by that rule,
    // not by arrival order.
    const trimmed = trimOutbox(outbox, MAX_OUTBOX);
    for (const dropped of trimmed.evicted) if (dropped.kind === 'board.tombstone') report(new Error('A queued tombstone was evicted by the outbox bound'), 'outbox-evicted');
    return {
      cursor: Number.isSafeInteger(stored?.cursor) ? stored!.cursor! : 0,
      outbox: trimmed.rows,
      names: stored?.names && typeof stored.names === 'object' ? stored.names as Record<string, string> : {}
    };
  }

  /** The only way state is written: re-read it under the browser-wide lock,
   * hand it to the mutator, store the result, and adopt it. Re-reading fresh
   * (rather than overwriting with the local view) is what keeps another
   * context's rows, names, and cursor: the worker and the sidebar share this
   * one key, and a whole-object overwrite of a stale local copy silently
   * deletes whatever the other context queued in between. */
  async function mutateState(mutate: (state: SharedAccountState) => void): Promise<void> {
    const scope = account;
    if (!scope) return;
    await withStorageLock(options.storage, STATE_KEY, async () => {
      const fresh = normalize((await options.storage.get(stateKey(scope)))[stateKey(scope)]);
      mutate(fresh);
      // The bound is enforced by the priority rule, never by arrival order: a
      // hint is droppable, a tombstone is the decision itself.
      const trimmed = trimOutbox(fresh.outbox, MAX_OUTBOX);
      for (const dropped of trimmed.evicted) if (dropped.kind === 'board.tombstone') report(new Error('A queued tombstone was evicted by the outbox bound'), 'outbox-evicted');
      fresh.outbox = trimmed.rows;
      await options.storage.set({ [stateKey(scope)]: fresh });
      if (account === scope) durable = fresh;
    });
  }

  /** The operation that carries one record. The identity fields are the log's
   * own contract (`opId === actorId:seq`, frontier exactly one behind, clock
   * ahead of every dependency) and the record's `seq` is reused as the operation
   * sequence, which — with the seq stamped at send time and never rewound —
   * makes a retry of a queued record the *same* op id, and therefore idempotent
   * against the log's unique `(board, op_id)` index. */
  function operationFor(record: AccountLifecycleRecord): Operation {
    const actorId = sendActor;
    return {
      collection: 'cards', entityId: record.boardId, kind: 'patch',
      fields: { [ACCOUNT_LIFECYCLE_FIELD]: encodeAccountLifecycle(record) }, unset: [],
      schemaVersion: 1, boardId: account ?? '', actorId, seq: record.seq, opId: `${actorId}:${record.seq}`,
      // The frontier is *empty* for the first record: a dependency on sequence
      // zero is not a dependency, and the protocol's frontier admits only
      // positive sequences. From the second record on it is the actor's own
      // predecessor, which is what makes the retry of a queued record the same
      // operation and a gap in it visible.
      clock: record.seq, deps: record.seq > 1 ? { [actorId]: record.seq - 1 } : {}
    };
  }

  /** Keeps one record for a later verification pass, or finishes with it.
   *
   * A record is *newer wins* per board, the projection's own rule: a
   * `board.deleted` that arrived for a board whose creation is still deferred
   * replaces it, because a delete is the newer fact. Attempts count verification
   * *passes*, not timer ticks — the channel never schedules a retry by itself.
   */
  function defer(record: AccountLifecycleRecord, attempt: number) {
    const kept = deferredRecords.get(record.boardId);
    const attempts = kept && kept.record.updatedAt > record.updatedAt ? kept.attempts : attempt;
    if (attempts >= MAX_DEFER_ATTEMPTS) {
      deferredRecords.delete(record.boardId);
      collaborationDiagnostic('account_channel.deferred_expired', { count: 1 });
      return;
    }
    if (!kept && deferredRecords.size >= MAX_DEFERRED) {
      // Oldest first: the record that has waited longest for a Drive answer no
      // longer names a board worth a verification pass, and the Drive listing
      // still finds whatever it announced.
      const oldest = deferredRecords.keys().next().value as string;
      deferredRecords.delete(oldest);
      collaborationDiagnostic('account_channel.deferred_evicted', { count: 1 });
    }
    deferredRecords.set(record.boardId, { record, attempts });
  }

  /** Hands one record to the caller's verification path and routes its answer.
   * A throwing verifier is `deferred`, never a drop: the direction that must not
   * lose a board is the one that keeps trying. */
  async function verify(record: AccountLifecycleRecord, attempt: number): Promise<AccountRecordOutcome> {
    let outcome: AccountRecordOutcome;
    try { outcome = await options.onRecord(record); }
    catch (cause) { report(cause, 'verify'); outcome = 'deferred'; }
    if (outcome === 'deferred') defer(record, attempt);
    else deferredRecords.delete(record.boardId);
    return outcome;
  }

  /** Applies received operations to the projection and hands every record that
   * moved state to the verification path. Never throws.
   *
   * A `board.tombstone` record does not go through the LWW projection: it is a
   * causal fact, and the projection's per-board last-write-wins would silently
   * drop a fact the total order says must be kept (a concurrent delete whose
   * clock is lower, or the restore that reverses a deletion). Its deduplication
   * and ordering happen in the one place they already happen for locally
   * written facts — the durable tombstone store — so the record is handed
   * straight to `onRecord` and a `duplicate` answer is counted, never applied. */
  async function receive(operations: readonly Operation[]) {
    const records: AccountLifecycleDelivery[] = [];
    const facts: AccountLifecycleRecord[] = [];
    for (const row of operations) {
      const envelope = row.fields[ACCOUNT_LIFECYCLE_FIELD];
      if (typeof envelope !== 'string') { skipped['unknown-kind']++; continue; }
      const decoded = decodeAccountLifecycle(envelope);
      if ('skip' in decoded) {
        skipped[decoded.skip]++;
        collaborationDiagnostic('account_channel.skipped', { count: skipped[decoded.skip] });
        continue;
      }
      if (decoded.record.kind === 'board.tombstone') { facts.push(decoded.record); continue; }
      // The row's own id is the projection's last tie-breaker: every device of
      // the account sees the same rows, so two records with identical clocks
      // and sequences still resolve to the same winner everywhere.
      records.push({ ...decoded.record, tie: row.opId });
    }
    for (const change of projection.apply(records)) {
      lastKind = change.record.kind;
      // A duplicate restates what is already applied: seen, counted, and
      // deliberately not handed over again. That is what makes "the same record
      // twice, one row and one subscription" true however the log delivered it.
      if (change.duplicate) continue;
      appliedByKind[change.record.kind] = (appliedByKind[change.record.kind] ?? 0) + 1;
      await verify(change.record, 1);
    }
    // Facts last, and in the order the log delivered them: the store's own total
    // order decides which wins, so delivery order cannot change the result.
    for (const record of facts) {
      lastKind = record.kind;
      appliedByKind[record.kind] = (appliedByKind[record.kind] ?? 0) + 1;
      await verify(record, 1);
    }
    announce();
  }

  /** Re-verifies every deferred record once. Concurrent callers share one pass,
   * and the pass never rejects: a failing verification is exactly what a
   * deferral already models. Called by the reconcile round, which is the
   * product's own "ask Drive again" cadence; the publisher's confirmation
   * record is the other way a deferred board becomes verifiable, and it needs
   * no pass here because it arrives as an ordinary record. */
  function retryDeferred(): Promise<void> {
    if (retrying) return retrying;
    const pass = (async () => {
      if (!deferredRecords.size) return;
      for (const [boardId, entry] of [...deferredRecords]) {
        // Removed from the map while this pass runs (another context, or a newer
        // record replacing it) means the row is no longer this pass's business.
        const current = deferredRecords.get(boardId);
        if (!current || current.record !== entry.record) continue;
        await verify(entry.record, entry.attempts + 1);
      }
    })().catch(cause => report(cause, 'retry')).then(() => { announce(); });
    retrying = pass.then(() => { retrying = undefined; });
    return retrying;
  }

  /** Sends everything queued and drops only what the log acknowledged.
   * Concurrent callers share one pass. A failed send costs its record one
   * attempt — never the queue: the bound is counted on the record, so one
   * poisoned record expires alone (and says so through
   * {@link AccountChannelOptions.onRecordExpired}, because a record that was
   * never acknowledged was never announced), while an outage costs every
   * record one attempt per try it actually took part in. */
  function flush(): Promise<void> {
    if (flushing) return flushing;
    // Whether this pass stopped because the relay was not taking anything.
    // A `break` on a failed send leaves its row for the next `synced` edge and
    // must not be retried here, or a refusing relay would be dialled in a tight
    // loop; the field is set only by that path.
    let relayRefused = false;
    const pass = (async () => {
      const handle = log;
      if (!handle || !durable || !sendActor || !durable.outbox.length) return;
      // The queue slot, not (kind, board): a tombstone keeps its own identity
      // (`fact.opId`) so a delete and the restore that reverses it are two
      // entries and a retried fact is still one.
      const isRow = (row: QueuedRecord, of: AccountLifecycleRecord) => outboxSlot(row.record) === outboxSlot(of);
      for (const row of [...durable.outbox]) {
        // Stamp at send time. A row this context did not queue belongs to
        // another actor — the browser's other runtime, or this runtime before
        // a reload — and this actor's chain must be contiguous from one: the
        // protocol demands every operation depend on exactly its actor's
        // sequence minus one, and a chain that skips a sequence strands the
        // cursor behind it at every receiver. The stamp is persisted before
        // the row is sent, so the retry after a dropped connection carries
        // the identical op id.
        if (row.stamp !== sendActor) {
          row.stamp = sendActor;
          row.record = { ...row.record, seq: ++sendSeq };
          await mutateState(next => {
            next.outbox = [...next.outbox.filter(other => !isRow(other, row.record)), row];
          });
        }
        let operation: Operation;
        try { operation = operationFor(row.record); } catch (cause) { report(cause, 'build'); break; }
        // `broadcast` never throws; false means "not durably in the log yet",
        // which is a retry, not an error, and never a message to the user.
        if (await handle.broadcast([operation])) {
          const sent = row.record;
          await mutateState(next => { next.outbox = next.outbox.filter(other => !isRow(other, sent)); });
          continue;
        }
        row.attempts++;
        if (row.attempts >= MAX_FLUSH_ATTEMPTS) {
          collaborationDiagnostic('account_channel.record_expired', { count: 1 });
          const expired = row.record;
          await mutateState(next => { next.outbox = next.outbox.filter(other => !isRow(other, expired)); });
          // The caller's "already announced" mark outlives the record only
          // when the record was acknowledged; this one was not, so the board
          // goes back to being re-announcable by the next sync round.
          try { options.onRecordExpired?.(expired); } catch { /* a hint never fails its holder */ }
          // The poison is plausibly this record (a full room, a payload the
          // log will not take); try the rest of the queue rather than
          // blocking behind it.
          continue;
        }
        const retried = row;
        await mutateState(next => {
          let seen = false;
          next.outbox = next.outbox.map(other => isRow(other, retried.record) ? (seen = true, retried) : other);
          if (!seen) next.outbox.push(retried);
        });
        // A failed send means the relay is not taking anything right now;
        // stop the pass and let the next `synced` edge try again.
        relayRefused = true;
        break;
      }
      announce();
    })().catch(cause => report(cause, 'flush'));
    flushing = pass.then(() => {
      flushing = undefined;
      // A record queued while this pass was reading the outbox is *not* in the
      // snapshot it iterated, and nothing else would send it until the next
      // `synced` edge — which a healthy connection never reaches again. The
      // publisher's own queue therefore stalled for the rest of the session
      // (an `outbox: 1` that never drains, the board never re-announced). The
      // pass is the only thing that has to know, so it re-runs itself while
      // the queue it left behind is non-empty and the connection is usable; a
      // send failure leaves the row for the next edge, exactly as below.
      if (!relayRefused && durable?.outbox.length && log && state === 'connected' && !throttled) void flush();
    });
    return flushing;
  }

  function replayHints(scope: string, handle: OperationLogSync): void {
    if (!options.googleDrive?.onHint) return;
    void handle.replayAccountHints(0).then(reply => {
      if (!Array.isArray(reply.hints)) return;
      for (const hint of reply.hints) if (hint && typeof hint === 'object') {
        const row = hint as Record<string, unknown>;
        if (row.inbox === scope && typeof row.board === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.board)) options.googleDrive?.onHint?.(row.board);
      }
    }).catch(() => undefined);
  }

  /** Reflects the transport's own status into the channel's report, persists
   * the cursor so a restart resumes instead of re-reading retained history,
   * and flushes the queue on the transition into `synced` — the edge that
   * makes "a board created while the relay was unreachable is announced when
   * the socket comes back on its own" true without a publish, a reload, or
   * any other event the creation does not itself produce. */
  function onLogStatus(next: LogSyncStatus) {
    reconnectReason = next.reconnectReason;
    throttled = next.throttled;
    appliedSeq = next.appliedSeq;
    if (next.phase === 'synced') {
      if (!wasSynced && durable?.outbox.length) void flush();
      if (!wasSynced && account && log) replayHints(account, log);
      // A reconnect is also a fresh chance for Drive to have caught up with a
      // record that arrived before its board did. The channel's own contract
      // says deferred records are re-verified on every reconcile round *and*
      // on the publisher's confirmation; a `synced` edge after an outage is the
      // third case the product already relies on (the reconnect that flushes
      // the outbox proves the relay is back, and the same round may now be
      // answerable). Bounded by the same pass counters, so this cannot loop.

      wasSynced = true;
      state = 'connected'; reason = 'ready';
    }
    else { wasSynced = false;
      if (next.phase === 'error') { state = 'failed'; reason = next.error ?? 'refused'; }
      else if (next.phase === 'snapshot') { state = 'gap'; reason = next.error ?? 'history unavailable'; }
      else { state = 'starting'; reason = next.phase; }
    }
    error = next.error;
    announce();
  }

  /** Opens the channel. Idempotent, never rejects, and never makes a board
   * opening wait for anything it does not need. A settled handle that has
   * entered the transport's terminal territory — a refusal no dial can undo,
   * a throttled ceiling — is not reopened by calling this again: `logSync`'s
   * own `stopped` semantics mean such a connection never dials by itself
   * again. For those the settled handle is closed and a fresh one built,
   * which is also what re-resolves the account, the pin, the courier key and
   * the admission manifest. The rebuild does not outrun anything: the
   * per-topic reconnect ledger lives in `logSync` module scope across handles
   * on purpose, so a fresh handle inside a burst of failures hits the same
   * ceiling the dead one did — this is the recovery path, not a way around
   * the rate limit that once locked an owner out through a proxy. */
  function start(): Promise<void> {
    if (closed) return Promise.resolve();
    allowImplicitStart = true;
    if (starting) return starting;
    if (log && (state === 'failed' || throttled)) {
      const dead = log;
      log = undefined;
      wasSynced = false;
      void dead.close().catch(() => { /* already gone */ });
    } else if (log) return Promise.resolve();
    const pass = (async () => {
      try {
        const scope = await options.account();
        account = scope;
        if (!scope) { state = 'disabled'; reason = 'no connected Google account'; announce(); return; }
        state = 'starting'; reason = 'starting'; announce();
        // The shared state and the outbox are loaded before anything network
        // related is attempted: a record made while the relay is unreachable has
        // to have somewhere to go, or "background retry" is a lie.
        const device = options.googleDrive ? undefined : await options.getKey(scope);
        sendActor = device ? `${device.keyId}-${contextNonce}` : `account-${crypto.randomUUID()}-${contextNonce}`;
        durable = normalize((await options.storage.get(stateKey(scope)))[stateKey(scope)]);
        appliedSeq = durable.cursor;
        const security = options.googleDrive ? null : await options.authorization(scope).catch(() => null);
        if (!options.googleDrive && !security) {
          // Fail closed and quietly. No pin means this browser was never
          // enrolled in the account room: a configuration fact to be read in the
          // console, not a transport fault to be retried into a reconnect storm.
          state = 'absent-pin'; reason = 'no account pin'; error = null; announce(); return;
        }
        const key = options.googleDrive ? undefined : await options.acquireKey(scope).catch(() => undefined);
        if (!options.googleDrive && !key) {
          // Records are queued locally and go out once a key arrives through the
          // courier; nothing here can or should block a board opening.
          state = 'failed'; reason = 'no account content key'; announce(); return;
        }
        const codec = options.googleDrive ? createPlaintextOperationCodec(scope) : createOperationLogCodec(key!);
        const reconnects: { reason: string; delayMs: number }[] = [];
        log = await createOperationLogSync({
          boardId: scope,
          topic: accountLifecycleTopic(scope),
          url: await options.relayUrl(),
          // The account channel is the first thing a board open starts, so it is
          // routinely the room whose attach dials the context's one socket; the
          // console must say that rather than attributing it to a board.
          dialTrigger: 'account:attach',
          getKey: async () => { if (!device) throw new Error('Device authority is unavailable'); return device; },
          ...(options.googleDrive ? { googleDrive: { ...options.googleDrive, folderId: '', accountRoom: true, actorId: sendActor } } : {}),
          // Re-resolved for every connection, as this option's contract demands:
          // the manifest captured here is valid for five minutes, a backgrounded
          // tab outlives it routinely, and re-presenting it at every admission
          // turns one expired minute into a channel that cannot reconnect for
          // the session. A fresh read that fails falls back to the captured
          // manifest rather than failing the dial — a transient Drive error
          // must not strand a still-valid manifest, and a genuinely expired
          // one is refused at admission either way.
          getAuthorization: async () => {
            const current = await options.authorization(scope).catch(() => null) ?? security;
            if (!current) throw new Error('Account authority is unavailable');
            return current;
          },
          getServiceAdmission: options.getServiceAdmission,
          isTerminalAdmissionError: options.isTerminalAdmissionError,
          seal: codec.seal,
          open: options.googleDrive ? async (payload, opId) => {
            try { return await codec.open(payload, opId); }
            catch { throw new OperationBindingError('Invalid account operation'); }
          } : codec.open,
          receive,
          onAccountHint: frame => {
            if (frame.inbox === scope && typeof frame.board === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(frame.board)) options.googleDrive?.onHint?.(frame.board);
          },
          // A row sealed with a key this device does not hold is inert wire:
          // skip forward exactly as the board log does, so one unreadable record
          // cannot wedge the cursor below it forever.
          foreignRow: () => collaborationDiagnostic('account_channel.foreign_seal'),
          // Unusable history is a working connection with nothing useful to
          // replay. The Drive listing already contains every board this room
          // could have announced, so say so and stop rather than resubscribe.
          gap: gap => { state = 'gap'; reason = `account history unavailable (${gap.reason}); Drive discovery is authoritative`; announce(); },
          status: onLogStatus,
          cursor: {
            load: async () => durable?.cursor ?? 0,
            save: async sequence => {
              if (!durable || sequence <= durable.cursor) return;
              appliedSeq = sequence;
              await mutateState(next => { next.cursor = Math.max(next.cursor, sequence); });
            }
          },
          reconnects,
          reconnectBaseMs: options.reconnectBaseMs,
          authBudget: options.authBudget,
          loopbackDevelopment: import.meta.env.DEV
        });
        state = 'connected'; reason = 'ready'; announce();
        // Initial synchronization can finish before `log` is assigned;
        // subsequent reconnects replay on the synced edge above.
        replayHints(scope, log);
        // Anything queued while the channel was down goes out now, including a
        // `board.created` made while the relay was unreachable — and on every
        // later reconnect the `synced` edge in `onLogStatus` flushes again,
        // so the guarantee holds mid-session and not only across a restart.
        void flush();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        state = 'failed';
        reason = error ?? 'account channel unavailable';
        collaborationDiagnostic('account_channel.unavailable');
        announce();
      } finally {
        starting = undefined;
      }
    })();
    starting = pass;
    return pass;
  }

  /** Queues a record durably and resolves once it is on disk. The caller is the
   * creation path, so this must not be able to fail it: the board exists whether
   * or not the relay ever hears about it, and Drive remains the copy that
   * matters. Resolves false when there was nothing durable to queue into (no
   * account, no pin), which is the caller's cue not to mark the board announced. */
  function publish(kind: AccountLifecycleKind, boardId: string, extra: { name?: string; ids?: string[]; atMs?: number } = {}): Promise<boolean> {
    return enqueue(() => {
      const name = kind === 'board.metadata' ? extra.name : undefined;
      if (kind === 'board.metadata' && name !== undefined && durable?.names[boardId] === name) return { record: null, accepted: true };
      // The send sequence is stamped at flush (see `flush`): a queued record
      // belongs to whichever context actually gets it through the relay, and
      // an eager seq here would spend a frontier slot for a row that is
      // replaced before it ever sends.
      const record: AccountLifecycleRecord = {
        kind, boardId, updatedAt: extra.atMs ?? now(), seq: 0,
        ...(name !== undefined ? { name } : {}),
        ...(kind === 'board.order' && extra.ids ? { ids: extra.ids } : {})
      };
      // An order past the record's own bound is refused *here*, at the
      // producer, before it can occupy an outbox slot and then expire at the
      // receiver: the Drive preference document is still the durable record
      // for a list this long, and `false` tells the caller so.
      if (kind === 'board.order' && !validQueuedRecord(record)) return { record: null, accepted: false };
      return { record, accepted: true };
    }, 'publish');
  }

  /**
   * The shared queue step every publication goes through: ensure the durable
   * state and a live handle, build the record (`prepare` returns null for a
   * no-op or a refused record), and write it into its own slot.
   *
   * `prepare` runs *after* the durable state exists, because a record that
   * depends on it (a metadata rename already announced) can only be recognised
   * there. Returning `accepted: true` with no record is "nothing to do, and
   * that is success"; `accepted: false` is "this cannot be carried".
   */
  function enqueue(prepare: () => { record: AccountLifecycleRecord | null; accepted: boolean }, label: string): Promise<boolean> {
    const attempt = async (): Promise<boolean> => {
      try {
        // Queue only once the durable state *and* a live (or retryable)
        // connection exist: a record appended between the two would otherwise
        // land after the connect-time flush had already looked at an empty
        // outbox, and sit there until something else happened to flush. A
        // settled-but-dead handle counts as no connection: `start()` rebuilds
        // it, and the record goes out on the rebuilt one.
        if (!durable || !log || state === 'failed' || throttled) {
          if (!allowImplicitStart) return false;
          await start();
        }
        if (!durable) {
          // Nothing durable to queue into yet (no account, or no pin): the next
          // `start()` re-attempts nothing for this board, so say so out loud in
          // the console rather than pretending the record was kept.
          collaborationDiagnostic('account_channel.record_dropped');
          return false;
        }
        const prepared = prepare();
        if (!prepared.record) return prepared.accepted;
        const record = prepared.record;
        await mutateState(next => {
          // One queued record per slot: a creation announced twice before the
          // relay accepts either is one record, not two, and a tombstone keeps
          // its own identity (see `outboxSlot`).
          next.outbox = [...next.outbox.filter(row => outboxSlot(row.record) !== outboxSlot(record)), { record, stamp: '', attempts: 0 }];
          if (record.kind === 'board.metadata' && record.name !== undefined) next.names[record.boardId] = record.name;
        });
        announce();
        void flush();
        return true;
      } catch (cause) { report(cause, label); announce(); return false; }
    };
    return attempt();
  }

  /**
   * Carries one durable tombstone fact. See the contract on
   * {@link AccountLifecycleChannel.publishTombstone}.
   *
   * The envelope is encoded here, before it is queued, for the same reason an
   * order is validated here: a fact a receiver could not read back is a fact
   * that does not exist. The bounds are the record's own — every field of the
   * fact is bounded by `decodeAccountLifecycle`, so a fact this build produced
   * is always one this build can read back.
   */
  function publishTombstone(boardId: string, fact: AccountTombstoneFact, atMs?: number): Promise<boolean> {
    return enqueue(() => {
      const record: AccountLifecycleRecord = { kind: 'board.tombstone', boardId, updatedAt: atMs ?? now(), seq: 0, fact };
      // Shape *and* size: `encodeAccountLifecycle` is the only writer of the
      // wire form, so round-tripping through it is the proof the receiver can.
      try {
        const encoded = encodeAccountLifecycle({ ...record, seq: 1 });
        if (encoded.length > MAX_CANDIDATE_BYTES) return { record: null, accepted: false };
      } catch { return { record: null, accepted: false }; }
      return { record, accepted: true };
    }, 'publish-tombstone');
  }

  /** The account list's order, published as one record. Ids are the list this
   * device holds; a list past the record bound is refused (see `publish`), and
   * the Drive preference document remains the durable copy for it. The clock is
   * the reorder's own (the preference document's `updatedAt`, in epoch ms) so
   * the record and the durable document agree on which order is newer. */
  function publishOrder(ids: readonly string[], updatedAt: number): Promise<boolean> {
    return publish('board.order', ACCOUNT_ORDER_SCOPE, { ids: [...ids], atMs: updatedAt });
  }

  /**
   * The realtime half of "the project list order is a property of the account,
   * not of one board".
   *
   * `reorderProjects` is the settling point — it runs once per dropped or
   * committed order, never per drag preview — and it emits
   * `projectOrderChanged` with the ids it just stored and the clock those ids
   * were stored under. This turns that into one `board.order` record on the
   * account room. Three properties are load-bearing:
   *
   *  - **Bounded.** The outbox is keyed by `(kind, boardId)` and every order
   *    records under the same scope id, so a burst of reorders collapses to the
   *    newest one; a list at or past {@link MAX_ORDER_IDS} is refused by
   *    `publish` and the Drive preference document stays the durable record.
   *  - **Never awaited by the reorder.** A relay that is down leaves the record
   *    queued and the local list already stored.
   *  - **Scoped.** The scope the reorder was stored under must be the account
   *    this channel is attached to; a repository still scoped to the previous
   *    account (a sign-out or account switch) must not speak into the new one.
   */
  async function publishLocalOrder(order: { account: string | null; ids: string[]; updatedAt: number }): Promise<void> {
    try {
      // A repository that has not yet chosen an account scope writes the
      // local-only list; its ids are still this device's view of *this*
      // account's list, so they speak under the channel's account. An explicit
      // *different* scope is the one case that must stay silent: a sign-out or
      // account switch leaves a repository pointing at the previous account,
      // and publishing there would move another account's list.
      if (!order.ids.length || (order.account !== null && order.account !== account)) return;
      if (!await publishOrder(order.ids, order.updatedAt)) collaborationDiagnostic('account_channel.order_refused');
    } catch (cause) { report(cause, 'publish-order'); }
  }

  return {
    status,
    publish,
    publishTombstone,
    publishOrder,
    publishLocalOrder,
    announcedName: boardId => durable?.names[boardId],
    start,
    flush,
    retryDeferred,
    receive,
    async close() {
      closed = true;
      const handle = log;
      log = undefined;
      state = 'closed';
      reason = 'closed';
      announce();
      await handle?.close().catch(() => { /* already gone */ });
    },
    async reset() {
      await this.close();
      allowImplicitStart = false;
      closed = false;
      account = null;
      durable = undefined;
      appliedSeq = 0;
      deferredRecords.clear();
      state = 'disabled';
      reason = 'not started';
      announce();
    }
  };
}

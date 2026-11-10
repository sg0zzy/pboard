import { canonical, digest, isKnownVocabulary, positive, record, validId, validateFrontier, validateOperation, type Collection, type Frontier, type Operation } from './protocol';
import type { Json } from '../../collab/security/canonical';

type Stamp = { clock: number; actorId: string; seq: number };
type Register = { stamp: Stamp; value: Json; unset: boolean };
/** `bootstrap` marks an entity the board already had when its receipted
 * history began — a card or project first *observed* through an update, with
 * no create operation inside this history or any snapshot's receipts. Only a
 * snapshot build for the very first log checkpoint (nothing pruned, nothing
 * committed) ever writes the marker, and restoring one requires every field
 * the entity carries to be stamped by a receipted operation — the marker
 * claims the entity existed, never manufactures content for it. */
type Entity = { collection: Collection; id: string; created: boolean; deleted: boolean; fields: Record<string, Register>; bootstrap?: boolean;
  /** Largest edit timestamp this entity has ever been *shown* — every
   * applied operation's `updatedAt`, including values a concurrent contest
   * retired from the field register. Provenance the projection may rely on:
   * the materialized register proves what the document displays, this proves
   * what the entity's receipted history carried. */
  seenUpdatedAt?: string };
export type EngineCheckpoint = {
  schemaVersion: 1; boardId: string; frontier: Frontier; clock: number;
  receipts: Record<string, { hash: string; clock: number }>; entities: Entity[];
  /** Ids of operations this build received but could not read (unknown vocabulary).
   * Emitted only when non-empty so every checkpoint of understood history stays
   * byte-identical; carried through the local checkpoint because the refusal to
   * consolidate must survive a reload, not just the page that first skipped. */
  skipped?: string[];
};
const compare = (a: Stamp, b: Stamp) => a.clock - b.clock || (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0) || a.seq - b.seq;
const keyOf = (op: Pick<Operation, 'collection' | 'entityId'>) => `${op.collection}:${op.entityId}`;
/** The per-actor sequence encoded in an opId (`actorId:seq`; actor ids never contain a colon). */
const skippedSequence = (opId: string) => Number(opId.slice(opId.lastIndexOf(':') + 1)) || 0;

/** No transport, wall clock, peer role, RxDB internals, or board replay in application. */
export class OperationEngine {
  private frontier: Frontier = Object.create(null);
  private receipts = new Map<string, { hash: string; clock: number }>();
  private invalid = new Map<string, string>();
  private entities = new Map<string, Entity>();
  private pending = new Map<string, Operation>();
  /** Operations that passed structural validation but speak vocabulary this
   * build cannot read. Owned here, at the engine, because the engine is the one
   * materializer every ingestion path funnels through — Drive segments, the log
   * via `receiveRealtime`, peer realtime, WAL replay and checkpoint joins alike
   * — and the skip is a property of materialization (an op receipted and
   * sequenced but never applied), not of any transport. Callers read it with
   * `skippedOperations()`; the session acts on it before publishing snapshots. */
  private skipped = new Map<string, number>();
  private waiting = new Map<string, Map<number, Set<string>>>();
  private clock = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly metrics = { applied: 0, duplicates: 0, received: 0, skipped: 0, applyMilliseconds: 0 };
  constructor(readonly boardId: string) { if (!validId(boardId)) throw new Error('Invalid board identity'); }
  vector(): Frontier { return { ...this.frontier }; }
  logicalClock(): number { return this.clock; }
  inconsistencies(): Record<string, string> { return Object.fromEntries(this.invalid); }
  /** Operations received structurally valid but unreadable for this build, with
   * the per-actor sequence each carried. Non-empty for the rest of the engine's
   * life — reloads re-derive it from the checkpoint that carried it — and every
   * path that would publish history this device cannot reproduce must refuse
   * while it is. */
  skippedOperations(): { opId: string; seq: number }[] {
    return [...this.skipped.entries()]
      .map(([opId, seq]) => ({ opId, seq }))
      .sort((a, b) => a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0);
  }
  unresolvedReferences(): string[] {
    const missing = [...this.entities.values()].filter(entity => !entity.created && !entity.deleted && !entity.bootstrap).map(entity => `${entity.collection}:${entity.id}`);
    const project = this.entities.get(`projects:${this.boardId}`);
    if ([...this.entities.values()].some(entity => entity.collection === 'cards') && !project?.created && !project?.bootstrap)
      missing.push(`projects:${this.boardId}`);
    return missing.sort();
  }
  /** A copy of this engine prepared for snapshot publication. With
   * `bootstrapUnresolved` the copy records every entity that is neither
   * created nor deleted as a bootstrap entity — the claim that the board
   * already had it when the receipted history began — and seeds the project
   * entity itself when cards exist without one, because a board cannot hold
   * cards without its project. The caller has already established that this
   * is sound (nothing below this point has been pruned or committed); the
   * copy changes provenance metadata only, never a field value, and the live
   * engine is not touched, so no local projection adopts the marker. */
  snapshotEngine(options: { bootstrapUnresolved?: boolean } = {}): OperationEngine {
    const data = this.serialize();
    if (options.bootstrapUnresolved) {
      for (const entity of data.entities) if (!entity.created && !entity.deleted) entity.bootstrap = true;
      const key = `projects:${this.boardId}`;
      const project = data.entities.find(entity => entity.collection === 'projects' && entity.id === this.boardId);
      if (!project && data.entities.some(entity => entity.collection === 'cards')) {
        data.entities.push({ collection: 'projects', id: this.boardId, created: false, deleted: false, fields: Object.create(null), bootstrap: true });
      }
    }
    return OperationEngine.restoreVerified(data);
  }
  pendingCount(): number { return this.pending.size; }
  /** Serialize callers so WebCrypto completion order never admits conflicting IDs. */
  receive(operations: Operation[]): Promise<string[]> {
    const run = this.queue.then(() => this.ingest(operations));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async check(inputs: Operation[]): Promise<{ operations: Operation[]; hashes: Map<string, string> }> {
    if (!Array.isArray(inputs) || inputs.length > 128) throw new Error('Bounded operation batch required');
    const operations = structuredClone(inputs);
    const hashes = new Map<string, string>();
    for (const op of operations) {
      validateOperation(op, this.boardId);
      const hash = await digest(op), previous = hashes.get(op.opId) ?? this.receipts.get(op.opId)?.hash;
      if (previous && previous !== hash) throw new Error(`Conflicting operation identity: ${op.opId}`);
      hashes.set(op.opId, hash);
    }
    return { operations, hashes };
  }
  async validate(inputs: Operation[]): Promise<void> { await this.check(inputs); }
  private async ingest(inputs: Operation[]): Promise<string[]> {
    const { operations, hashes } = await this.check(inputs);
    // Validate the entire batch before changing the materialization.
    const started = performance.now(), touched = new Set<string>();
    for (const op of operations) {
      this.metrics.received++;
      if (this.receipts.has(op.opId)) { this.metrics.duplicates++; continue; }
      this.receipts.set(op.opId, { hash: hashes.get(op.opId)!, clock: op.clock });
      // Remembered before materialization and kept for the engine's life: the
      // op is receipted and sequenced like any other — so its stream is never
      // permanently blocked behind it — but never applied to an entity.
      if (!isKnownVocabulary(op)) { this.skipped.set(op.opId, op.seq); this.metrics.skipped++; }
      this.pending.set(op.opId, op);
      this.tryApply(op, touched);
    }
    this.metrics.applyMilliseconds += performance.now() - started;
    return [...touched].sort();
  }
  private wait(actor: string, seq: number, id: string): void {
    const actorWait = this.waiting.get(actor) ?? new Map<number, Set<string>>();
    const atSequence = actorWait.get(seq) ?? new Set<string>();
    atSequence.add(id); actorWait.set(seq, atSequence); this.waiting.set(actor, actorWait);
  }
  private tryApply(op: Operation, touched: Set<string>): void {
    // Index one unmet dependency. When it advances, recheck the others.
    const missing = Object.entries(op.deps).find(([actor, seq]) => (this.frontier[actor] ?? 0) < seq);
    if (missing) {
      this.wait(missing[0], missing[1], op.opId); return;
    }
    const ready = [op];
    while (ready.length) {
      const current = ready.pop()!;
      if (!this.pending.has(current.opId)) continue;
      const unmet = Object.entries(current.deps).find(([actor, seq]) => (this.frontier[actor] ?? 0) < seq);
      if (unmet) {
        this.wait(unmet[0], unmet[1], current.opId); continue;
      }
      if (Object.entries(current.deps).some(([actor, seq]) => (this.receipts.get(`${actor}:${seq}`)?.clock ?? Infinity) >= current.clock)) {
        this.invalid.set(current.opId, 'Logical clock does not follow causal dependencies');
        continue; // Retain corrupt input for diagnosis; never advance its prefix.
      }
      // A skipped operation advances causality — its stream moves on, its
      // dependents stop waiting — but never touches an entity: half-applying
      // fields this build cannot interpret is exactly the corruption the skip
      // exists to prevent.
      if (!this.skipped.has(current.opId)) {
        const key = keyOf(current);
        const entity: Entity = this.entities.get(key) ?? { collection: current.collection, id: current.entityId, created: false, deleted: false, fields: Object.create(null) };
        if (current.kind === 'create') entity.created = true;
        if (current.kind === 'delete') entity.deleted = true;
        const stamp = { clock: current.clock, actorId: current.actorId, seq: current.seq };
        for (const field of [...Object.keys(current.fields), ...current.unset]) {
          const old = entity.fields[field];
          if (!old || compare(stamp, old.stamp) > 0) entity.fields[field] = {
            stamp, unset: current.unset.includes(field), value: current.fields[field] ?? null
          };
        }
        // Admission retires a value from the register on losing a contest; it
        // never un-shows it. `seenUpdatedAt` keeps what was admitted monotone.
        if (typeof current.fields.updatedAt === 'string' && current.fields.updatedAt > (entity.seenUpdatedAt ?? '')) {
          entity.seenUpdatedAt = current.fields.updatedAt;
        }
        this.entities.set(key, entity);
        if (current.collection === 'cards' && typeof current.fields.updatedAt === 'string') {
          const projectKey = `projects:${this.boardId}`;
          const project: Entity = this.entities.get(projectKey) ?? { collection: 'projects' as const, id: this.boardId, created: false, deleted: false, fields: Object.create(null) };
          this.entities.set(projectKey, project);
          if (current.fields.updatedAt > (project.seenUpdatedAt ?? '')) project.seenUpdatedAt = current.fields.updatedAt;
          if ( (!project.fields.updatedAt || compare(stamp, project.fields.updatedAt.stamp) > 0)) {
            project.fields.updatedAt = { stamp, value: current.fields.updatedAt, unset: false }; touched.add(projectKey);
          }
        }
        this.metrics.applied++; touched.add(key);
      }
      this.pending.delete(current.opId);
      this.frontier[current.actorId] = current.seq;
      this.clock = Math.max(this.clock, current.clock);
      const actorWait = this.waiting.get(current.actorId), waiting = actorWait?.get(current.seq);
      if (waiting) {
        actorWait!.delete(current.seq);
        if (!actorWait!.size) this.waiting.delete(current.actorId);
        for (const id of waiting) { const next = this.pending.get(id); if (next) ready.push(next); }
      }
    }
  }
  /** Missing contiguous ranges; observed maxima never become watermarks. */
  missing(): Record<string, { from: number; to: number }> {
    const result: Record<string, { from: number; to: number }> = Object.create(null);
    for (const op of this.pending.values()) for (const [actor, seq] of Object.entries(op.deps)) {
      const from = (this.frontier[actor] ?? 0) + 1;
      if (from <= seq) result[actor] = { from, to: Math.max(result[actor]?.to ?? 0, seq) };
    }
    return result;
  }
  entity(collection: Collection, id: string): Record<string, Json> | null {
    const entity = this.entities.get(`${collection}:${id}`);
    if (!entity || (!entity.created && !entity.bootstrap) || entity.deleted) return null;
    const result: Record<string, Json> = { id };
    if (collection === 'cards') result.projectId = this.boardId;
    for (const field of Object.keys(entity.fields).sort()) {
      const register = entity.fields[field];
      if (!register.unset) result[field] = structuredClone(register.value);
    }
    return result;
  }
  /** Largest edit timestamp this entity's receipted history has ever carried —
   * including the value a concurrent contest retired from the field register.
   * A projection guard asks whether the entity was shown a document's newer
   * timestamp, not whether the register still displays it: a winner chosen at
   * equal logical clocks may carry an older wall clock than this device's own
   * losing edit, and that retired value is provenance the entity has, not a
   * local change the engine is missing. */
  seenUpdatedAt(collection: Collection, id: string): string {
    const entity = this.entities.get(`${collection}:${id}`);
    if (!entity) return '';
    // The register itself is always a shown value too: checkpoints written
    // before provenance tracking carry the value without the tracker.
    const register = entity.fields.updatedAt;
    const shown = register && !register.unset && typeof register.value === 'string' ? register.value : '';
    const seen = entity.seenUpdatedAt ?? '';
    return seen > shown ? seen : shown;
  }
  state(): { project: Record<string, Json> | null; cards: Record<string, Json>[] } {
    const project = this.entity('projects', this.boardId);
    const cards = [...this.entities.values()].filter(e => e.collection === 'cards')
      .map(e => this.entity('cards', e.id)).filter((e): e is Record<string, Json> => !!e)
      .sort((a, b) => String(a.orderKey) < String(b.orderKey) ? -1 : String(a.orderKey) > String(b.orderKey) ? 1 : String(a.id) < String(b.id) ? -1 : 1);
    return { project, cards: project ? cards : [] };
  }
  canonicalState(): string { return canonical(this.state()); }
  checkpoint(): EngineCheckpoint {
    // The invariant, kept meaningful for every caller that hands a checkpoint
    // to a durable store: nothing unacked (`pending`), no entity whose
    // existence is unproven (`unresolvedReferences()` — bootstrap-marked
    // entities count as proven for a board whose history predates its log),
    // so a snapshot built here reproduces exactly what this engine applied.
    if (this.pending.size || this.unresolvedReferences().length) throw new Error('Cannot snapshot incomplete operation history');
    return this.serialize();
  }
  private serialize(): EngineCheckpoint {
    return structuredClone({ schemaVersion: 1 as const, boardId: this.boardId, frontier: this.vector(), clock: this.clock,
      receipts: Object.fromEntries([...this.receipts].sort(([a], [b]) => a < b ? -1 : 1)),
      entities: [...this.entities.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, entity]) => entity),
      ...(this.skipped.size ? { skipped: [...this.skipped.keys()].sort() } : {}) });
  }
  /** Join verified causal checkpoints without replay or a preferred owner.
   * Register max and tombstone OR form the same join as operation delivery. */
  static join(checkpoints: EngineCheckpoint[], verified = false): OperationEngine {
    if (!checkpoints.length) throw new Error('Checkpoint required');
    const engines = checkpoints.map(checkpoint => verified ? OperationEngine.restoreVerified(checkpoint) : OperationEngine.restore(checkpoint));
    const result = engines[0];
    for (const other of engines.slice(1)) {
      if (other.boardId !== result.boardId) throw new Error('Mixed checkpoint boards');
      for (const [id, receipt] of other.receipts) {
        const previous = result.receipts.get(id);
        if (previous && (previous.hash !== receipt.hash || previous.clock !== receipt.clock)) throw new Error('Conflicting checkpoint identity');
        result.receipts.set(id, receipt);
      }
      for (const [actor, seq] of Object.entries(other.frontier)) result.frontier[actor] = Math.max(result.frontier[actor] ?? 0, seq);
      result.clock = Math.max(result.clock, other.clock);
      // A skip known to any branch is known to the join: the refusal it carries
      // is monotone, and losing it through a merge would reopen the hole.
      for (const [id, seq] of other.skipped) result.skipped.set(id, seq);
      for (const [key, entity] of other.entities) {
        const target = result.entities.get(key);
        if (!target) { result.entities.set(key, entity); continue; }
        target.created ||= entity.created; target.deleted ||= entity.deleted;
        // A bootstrap provenance known to one branch is known to the join: it
        // is the same monotone claim the skip ledger is — losing it through a
        // merge would make an explained entity unresolved again.
        if (entity.bootstrap) target.bootstrap = true;
        // Provenance seen by any branch is provenance the join holds: like the
        // bootstrap marker and the skip ledger, losing it would let a merged
        // engine forget a value it legitimately projected with.
        if ((entity.seenUpdatedAt ?? '') > (target.seenUpdatedAt ?? '')) target.seenUpdatedAt = entity.seenUpdatedAt;
        for (const [field, register] of Object.entries(entity.fields)) {
          const previous = target.fields[field];
          if (!previous || compare(register.stamp, previous.stamp) > 0) target.fields[field] = register;
        }
      }
    }
    return result;
  }
  /** Only after the bundled snapshot worker (or the local engine) validates
   * this checkpoint. Rebuild maps without repeating per-register admission on
   * the UI thread. External callers must use restore/validateSnapshot. */
  static restoreVerified(input: EngineCheckpoint): OperationEngine {
    const data = structuredClone(input), engine = new OperationEngine(data.boardId);
    engine.frontier = Object.assign(Object.create(null), data.frontier); engine.clock = data.clock;
    engine.receipts = new Map(Object.entries(data.receipts));
    engine.skipped = new Map((data.skipped ?? []).map(id => [id, skippedSequence(id)]));
    engine.entities = new Map(data.entities.map(entity => [`${entity.collection}:${entity.id}`, entity]));
    return engine;
  }
  static restore(input: EngineCheckpoint): OperationEngine {
    const data = structuredClone(input);
    if (!record(data) || data.schemaVersion !== 1 || !validId(data.boardId) || !Number.isSafeInteger(data.clock) || data.clock < 0
      || !record(data.receipts) || !Array.isArray(data.entities)) throw new Error('Invalid operation checkpoint');
    validateFrontier(data.frontier);
    const engine = new OperationEngine(data.boardId);
    const count = Object.values(data.frontier).reduce((sum, seq) => sum + seq, 0);
    if (count !== Object.keys(data.receipts).length) throw new Error('Checkpoint frontier does not cover receipts');
    for (const [actor, seq] of Object.entries(data.frontier)) {
      for (let n = 1; n <= seq; n++) if (!record(data.receipts[`${actor}:${n}`]) || !/^[a-f0-9]{64}$/.test(data.receipts[`${actor}:${n}`].hash ?? '') || !positive(data.receipts[`${actor}:${n}`].clock) || data.receipts[`${actor}:${n}`].clock > data.clock) throw new Error('Checkpoint has incomplete identity history');
    }
    for (const entity of data.entities) {
      if (!record(entity) || !['cards', 'projects'].includes(entity.collection) || !validId(entity.id)
        || typeof entity.created !== 'boolean' || typeof entity.deleted !== 'boolean' || !record(entity.fields)
        || (entity.bootstrap !== undefined && entity.bootstrap !== true)
        || (entity.seenUpdatedAt !== undefined && typeof entity.seenUpdatedAt !== 'string')
        || (entity.collection === 'projects' && entity.id !== data.boardId)) throw new Error('Invalid checkpoint entity');
      for (const [field, register] of Object.entries(entity.fields) as [string, Register][]) {
        if (!record(register) || !record(register.stamp) || !positive(register.stamp.clock) || register.stamp.clock > data.clock
          || !validId(register.stamp.actorId) || !positive(register.stamp.seq) || register.stamp.seq > (data.frontier[register.stamp.actorId] ?? 0)
          || data.receipts[`${register.stamp.actorId}:${register.stamp.seq}`]?.clock !== register.stamp.clock
          || typeof register.unset !== 'boolean') throw new Error('Invalid checkpoint register');
        // Reuse domain validation; do not accept arbitrary snapshot properties.
        validateOperation({ schemaVersion: 1, boardId: data.boardId, actorId: register.stamp.actorId,
          seq: 1, opId: `${register.stamp.actorId}:1`, clock: register.stamp.clock, deps: {},
          collection: entity.collection, entityId: entity.id, kind: 'patch',
          fields: register.unset ? {} : { [field]: register.value }, unset: register.unset ? [field] : [] }, data.boardId);
      }
      const key = `${entity.collection}:${entity.id}`;
      if (engine.entities.has(key)) throw new Error('Duplicate checkpoint entity');
      if (entity.created) {
        const required = entity.collection === 'projects' ? ['name', 'template', 'createdAt', 'updatedAt']
          : ['content', 'type', 'status', 'orderKey', 'createdAt', 'updatedAt'];
        if (required.some(field => !entity.fields[field] || entity.fields[field].unset)) throw new Error('Incomplete checkpoint entity');
      }
      engine.entities.set(key, entity);
    }
    engine.frontier = Object.assign(Object.create(null), data.frontier);
    engine.clock = data.clock;
    engine.receipts = new Map(Object.entries(data.receipts));
    // Skipped ids must be well-formed identities with receipts in this very
    // checkpoint: the marker claims "this client saw and could not read it",
    // and a checkpoint that renames or drops the operation would be claiming
    // a history its receipts do not actually carry.
    if (data.skipped !== undefined) {
      if (!Array.isArray(data.skipped)) throw new Error('Invalid checkpoint skipped operations');
      for (const id of data.skipped) {
        const at = typeof id === 'string' ? id.lastIndexOf(':') : -1;
        if (at < 1 || !validId(id.slice(0, at)) || !positive(Number(id.slice(at + 1)))
          || !record(data.receipts[id]) || engine.skipped.has(id)) throw new Error('Invalid checkpoint skipped operation');
        engine.skipped.set(id, skippedSequence(id));
      }
    }
    return engine;
  }
}

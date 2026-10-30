import { canonical, digest, positive, record, validId, validateFrontier, validateOperation, type Collection, type Frontier, type Operation } from './protocol';
import type { Json } from '../../collab/security/canonical';

type Stamp = { clock: number; actorId: string; seq: number };
type Register = { stamp: Stamp; value: Json; unset: boolean };
type Entity = { collection: Collection; id: string; created: boolean; deleted: boolean; fields: Record<string, Register> };
export type EngineCheckpoint = {
  schemaVersion: 1; boardId: string; frontier: Frontier; clock: number;
  receipts: Record<string, { hash: string; clock: number }>; entities: Entity[];
};
const compare = (a: Stamp, b: Stamp) => a.clock - b.clock || (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0) || a.seq - b.seq;
const keyOf = (op: Pick<Operation, 'collection' | 'entityId'>) => `${op.collection}:${op.entityId}`;

/** No transport, wall clock, peer role, RxDB internals, or board replay in application. */
export class OperationEngine {
  private frontier: Frontier = Object.create(null);
  private receipts = new Map<string, { hash: string; clock: number }>();
  private invalid = new Map<string, string>();
  private entities = new Map<string, Entity>();
  private pending = new Map<string, Operation>();
  private waiting = new Map<string, Map<number, Set<string>>>();
  private clock = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly metrics = { applied: 0, duplicates: 0, received: 0, applyMilliseconds: 0 };
  constructor(readonly boardId: string) { if (!validId(boardId)) throw new Error('Invalid board identity'); }
  vector(): Frontier { return { ...this.frontier }; }
  logicalClock(): number { return this.clock; }
  inconsistencies(): Record<string, string> { return Object.fromEntries(this.invalid); }
  unresolvedReferences(): string[] {
    const missing = [...this.entities.values()].filter(entity => !entity.created && !entity.deleted).map(entity => `${entity.collection}:${entity.id}`);
    if ([...this.entities.values()].some(entity => entity.collection === 'cards') && !this.entities.get(`projects:${this.boardId}`)?.created)
      missing.push(`projects:${this.boardId}`);
    return missing.sort();
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
      const key = keyOf(current);
      const entity = this.entities.get(key) ?? { collection: current.collection, id: current.entityId, created: false, deleted: false, fields: Object.create(null) };
      if (current.kind === 'create') entity.created = true;
      if (current.kind === 'delete') entity.deleted = true;
      const stamp = { clock: current.clock, actorId: current.actorId, seq: current.seq };
      for (const field of [...Object.keys(current.fields), ...current.unset]) {
        const old = entity.fields[field];
        if (!old || compare(stamp, old.stamp) > 0) entity.fields[field] = {
          stamp, unset: current.unset.includes(field), value: current.fields[field] ?? null
        };
      }
      this.entities.set(key, entity);
      if (current.collection === 'cards' && typeof current.fields.updatedAt === 'string') {
        const projectKey = `projects:${this.boardId}`;
        const project = this.entities.get(projectKey) ?? { collection: 'projects' as const, id: this.boardId, created: false, deleted: false, fields: Object.create(null) };
        this.entities.set(projectKey, project);
        if ( (!project.fields.updatedAt || compare(stamp, project.fields.updatedAt.stamp) > 0)) {
          project.fields.updatedAt = { stamp, value: current.fields.updatedAt, unset: false }; touched.add(projectKey);
        }
      }
      this.pending.delete(current.opId);
      this.frontier[current.actorId] = current.seq;
      this.clock = Math.max(this.clock, current.clock);
      this.metrics.applied++; touched.add(key);
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
    if (!entity?.created || entity.deleted) return null;
    const result: Record<string, Json> = { id };
    if (collection === 'cards') result.projectId = this.boardId;
    for (const field of Object.keys(entity.fields).sort()) {
      const register = entity.fields[field];
      if (!register.unset) result[field] = structuredClone(register.value);
    }
    return result;
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
    if (this.pending.size || this.unresolvedReferences().length) throw new Error('Cannot snapshot incomplete operation history');
    return structuredClone({ schemaVersion: 1, boardId: this.boardId, frontier: this.vector(), clock: this.clock,
      receipts: Object.fromEntries([...this.receipts].sort(([a], [b]) => a < b ? -1 : 1)),
      entities: [...this.entities.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, entity]) => entity) });
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
      for (const [key, entity] of other.entities) {
        const target = result.entities.get(key);
        if (!target) { result.entities.set(key, entity); continue; }
        target.created ||= entity.created; target.deleted ||= entity.deleted;
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
    return engine;
  }
}

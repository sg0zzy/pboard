import { canonicalize, type Json } from '../../collab/security/canonical';
import { BOARD_ITEM_STATUSES, BOARD_ITEM_TYPES, BOARD_TEMPLATES, CARD_DISPLAY_MODES } from '../../types';

export type Frontier = Record<string, number>;
export type Collection = 'projects' | 'cards';
export type Command = {
  collection: Collection; entityId: string; kind: 'create' | 'patch' | 'delete';
  fields: Record<string, Json>; unset: string[];
};
export type Operation = Command & {
  schemaVersion: 1; boardId: string; actorId: string; seq: number; opId: string;
  clock: number; deps: Frontier;
};
export const PROTOCOL = 'pboard-operations-v1';
export const MAX_OPERATION_BYTES = 2 * 1024 * 1024;
export const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
export const MAX_SEGMENT_OPERATIONS = 128;
const identifier = /^[A-Za-z0-9_-]{1,100}$/;
const own = (value: object, key: string) => Object.hasOwn(value, key);
export const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
export const validId = (id: unknown): id is string => typeof id === 'string' && identifier.test(id) && !Object.hasOwn(Object.prototype, id) && id !== 'prototype';
export function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function canonical(value: unknown): string { return canonicalize(value as Json); }
export async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateFrontier(value: unknown): asserts value is Frontier {
  if (!record(value) || Object.keys(value).length > 4096 || Object.entries(value).some(([id, seq]) => !validId(id) || !positive(seq)))
    throw new Error('Invalid operation frontier');
}
const projectFields = new Set(['name', 'template', 'createdAt', 'updatedAt']);
const cardFields = new Set(['title', 'content', 'type', 'status', 'displayMode', 'source', 'image', 'orderKey', 'createdAt', 'updatedAt', 'deletedAt']);
const optional = new Set(['title', 'displayMode', 'source', 'image', 'deletedAt']);
function validField(collection: Collection, key: string, value: Json): boolean {
  if (!(collection === 'projects' ? projectFields : cardFields).has(key)) return false;
  if (key === 'name' || key === 'content') return typeof value === 'string';
  if (key === 'title') return typeof value === 'string';
  if (key === 'template') return BOARD_TEMPLATES.includes(value as never);
  if (key === 'type') return BOARD_ITEM_TYPES.includes(value as never);
  if (key === 'status') return BOARD_ITEM_STATUSES.includes(value as never);
  if (key === 'displayMode') return CARD_DISPLAY_MODES.includes(value as never);
  if (key === 'orderKey') return typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value);
  if (key.endsWith('At')) return typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (key === 'source') return record(value) && Object.keys(value).every(k => ['provider', 'conversationUrl', 'sourceText'].includes(k))
    && Object.values(value).every(v => typeof v === 'string');
  if (key === 'image') {
    if (!record(value)) return false;
    const image = value as Record<string, any>;
    return record(image) && Object.keys(image).sort().join(',') === 'height,id,mimeType,width'
    && typeof image.id === 'string' && /^[a-f0-9]{64}$/.test(image.id)
    && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) && positive(image.width) && positive(image.height);
  }
  return false;
}
export function validateCommand(command: Command): void {
  if (!record(command) || !['projects', 'cards'].includes(command.collection) || !validId(command.entityId)
    || !['create', 'patch', 'delete'].includes(command.kind) || !record(command.fields) || !Array.isArray(command.unset)
    || command.unset.some(key => typeof key !== 'string' || !optional.has(key) || command.collection !== 'cards' || own(command.fields, key))
    || new Set(command.unset).size !== command.unset.length
    || Object.entries(command.fields).some(([key, value]) => !validField(command.collection, key, value))) throw new Error('Invalid board command');
  if (command.kind === 'delete' && (Object.keys(command.fields).length || command.unset.length)) throw new Error('Delete must not contain property edits');
  if (command.kind === 'create') {
    const required = command.collection === 'projects' ? ['name', 'template', 'createdAt', 'updatedAt']
      : ['content', 'type', 'status', 'orderKey', 'createdAt', 'updatedAt'];
    if (command.unset.length || required.some(key => !own(command.fields, key))) throw new Error('Incomplete entity creation');
  }
  if (command.kind === 'patch' && !Object.keys(command.fields).length && !command.unset.length) throw new Error('Empty property edit');
}
export function validateOperation(op: Operation, boardId: string): void {
  validateCommand(op);
  if (op.schemaVersion !== 1 || op.boardId !== boardId || !validId(op.boardId) || !validId(op.actorId)
    || !positive(op.seq) || !positive(op.clock) || op.opId !== `${op.actorId}:${op.seq}`) throw new Error('Unsupported or invalid operation identity');
  validateFrontier(op.deps);
  if ((op.deps[op.actorId] ?? 0) !== op.seq - 1 || Object.values(op.deps).some(seq => seq >= op.clock)
    || (op.collection === 'projects' && op.entityId !== boardId)) throw new Error('Invalid operation dependencies');
  if (new TextEncoder().encode(canonical(op)).byteLength > MAX_OPERATION_BYTES) throw new Error('Operation exceeds size limit');
  const keys = ['schemaVersion', 'boardId', 'actorId', 'seq', 'opId', 'clock', 'deps', 'collection', 'entityId', 'kind', 'fields', 'unset'];
  if (Object.keys(op).some(key => !keys.includes(key))) throw new Error('Unknown operation fields');
}
export type Segment = { protocol: typeof PROTOCOL; boardId: string; segmentId: string; operations: Operation[] };
export function validateSegment(segment: Segment, boardId: string): void {
  if (!record(segment) || Object.keys(segment).some(key => !['protocol', 'boardId', 'segmentId', 'operations'].includes(key)) || segment.protocol !== PROTOCOL || segment.boardId !== boardId || !validId(segment.segmentId)
    || !Array.isArray(segment.operations) || !segment.operations.length || segment.operations.length > MAX_SEGMENT_OPERATIONS
    || new TextEncoder().encode(canonical(segment)).byteLength > MAX_SEGMENT_BYTES) throw new Error('Invalid operation segment');
  const ids = new Set<string>();
  for (const op of segment.operations) {
    validateOperation(op, boardId);
    if (ids.has(op.opId)) throw new Error('Repeated operation in segment');
    ids.add(op.opId);
  }
}

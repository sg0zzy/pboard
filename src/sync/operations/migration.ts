import type { ProjectSnapshot } from '../snapshot';
import type { RxRepository } from '../../storage/rxdbRepository';
import { OperationEngine } from './engine';
import { canonical, digest, type Operation } from './protocol';
import { initialOrderKeys } from '../../storage/orderKey';
import { operationFields } from './source';

/** Same frozen legacy bytes yield the same bootstrap operations on all owners.
 * Migration identity is content-addressed; ordinary editing uses random streams. */
export async function legacyBootstrap(snapshot: ProjectSnapshot, rx: RxRepository): Promise<{ engine: OperationEngine; operations: Operation[] }> {
  const normalized = { project: snapshot.project, items: [...snapshot.items].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)) };
  const actor = `legacy-${(await digest(normalized)).slice(0, 40)}`;
  const engine = new OperationEngine(snapshot.project.id), keys = initialOrderKeys(normalized.items.length);
  const commands = [{ collection: 'projects' as const, entityId: snapshot.project.id, fields: operationFields('projects', snapshot.project as never) }];
  for (const [index, card] of normalized.items.entries()) {
    const imageId = card.image ? await rx.putImage(card.image) : card.imageId;
    const fields = operationFields('cards', { ...card, orderKey: keys[index], ...(imageId ? { imageId,
      imageMimeType: card.image?.mimeType ?? card.imageMimeType, imageWidth: card.image?.width ?? card.imageWidth, imageHeight: card.image?.height ?? card.imageHeight } : {}) } as never);
    commands.push({ collection: 'cards' as never, entityId: card.id, fields });
  }
  const operations: Operation[] = [];
  for (let start = 0; start < commands.length; start += 128) {
    const ops: Operation[] = commands.slice(start, start + 128).map((command, index) => {
      const seq = start + index + 1;
      return { ...command, kind: 'create', unset: [], schemaVersion: 1, boardId: snapshot.project.id, actorId: actor, seq,
        opId: `${actor}:${seq}`, clock: seq, deps: seq > 1 ? { [actor]: seq - 1 } : {} };
    });
    await engine.receive(ops); operations.push(...ops);
  }
  return { engine, operations };
}
/** Ambiguous legacy local forks are preserved as visible, ordinary local boards,
 * instead of guessing that old cached fields overwrite a newer shared snapshot. */
export async function preserveLocalFork(rx: RxRepository, local: Awaited<ReturnType<RxRepository['exportProject']>>, baseline: ProjectSnapshot): Promise<string | null> {
  const semantic = async (value: typeof local) => ({ project: { name: value.project.name, template: value.project.template },
    items: await Promise.all(value.items.map(async card => {
      const imageId = card.image ? await rx.putImage(card.image) : card.imageId;
      const fields = operationFields('cards', { ...card, ...(imageId ? { imageId, imageMimeType: card.image?.mimeType ?? card.imageMimeType,
        imageWidth: card.image?.width ?? card.imageWidth, imageHeight: card.image?.height ?? card.imageHeight } : {}) } as never);
      delete fields.createdAt; delete fields.updatedAt; delete fields.orderKey;
      return { id: card.id, order: card.order, ...fields };
    })) });
  const localValue = await semantic(local), baseValue = await semantic(baseline);
  if (canonical(localValue) === canonical(baseValue)) return null;
  const id = `recovery-${(await digest(localValue)).slice(0, 40)}`;
  if (await rx.getProject(id)) return id;
  const timestamp = new Date().toISOString();
  await rx.importProject({ id, name: `${local.project.name} (local recovery)`, template: local.project.template, revision: 1,
    createdAt: timestamp, updatedAt: timestamp }, local.items.map(card => ({ ...Object.fromEntries(Object.entries(card).filter(([key]) => key !== '_sec')), id: `${id.slice(0, 28)}-${card.id.slice(-36)}`, projectId: id, createdAt: timestamp, updatedAt: timestamp } as typeof card)));
  return id;
}


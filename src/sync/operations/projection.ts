import type { RxRepository } from '../../storage/rxdbRepository';
import { documentValue } from '../../storage/changeJournal';
import { withJournalMaterialization } from '../../storage/journalMaterialization';
import { canonical } from './protocol';
import type { OperationEngine } from './engine';
import { orderKeyBetween } from '../../storage/orderKey';

/** Project verified operations, never manufacture local changes from a receive.
 * Existing document/WAL commands remain the write origin; no network is awaited. */
export async function projectOperations(rx: RxRepository, engine: OperationEngine, touched: string[]) {
  const boardId = engine.boardId;
  if (await rx.journal.boardErasure(boardId)) return;
  const full = touched.length === 0;
  const root = await rx.db.projects.findOne(boardId).exec();
  let tail = root?.tailOrderKey ?? '';
  const keys = new Set(touched);
  if (full) {
    keys.add(`projects:${boardId}`);
    for (const card of engine.state().cards) keys.add(`cards:${card.id}`);
    for (const card of await rx.db.cards.find({ selector: { projectId: boardId } }).exec()) keys.add(`cards:${card.id}`);
  }
  // A revision is a compatibility/UI field. It does not resolve operations.
  keys.add(`projects:${boardId}`);
  for (const key of [...keys].sort((a, b) => a.startsWith('cards:') === b.startsWith('cards:') ? 0 : a.startsWith('cards:') ? -1 : 1)) {
    const split = key.indexOf(':'), collection = key.slice(0, split) as 'projects' | 'cards', id = key.slice(split + 1);
    const target = rx.db[collection] as typeof rx.db.cards;
    const existing = await target.findOne(id).exec();
    const value = engine.entity(collection, id);
    if (!value) {
      if (existing) {
        const removed = documentValue({ ...existing.toJSON(true), _deleted: true });
        await withJournalMaterialization(target, removed, () => existing.remove());
      }
      continue;
    }
    const candidate: Record<string, any> = { ...value, _deleted: false };
    if (collection === 'projects') {
      const last = root ? [] : await rx.db.projects.find({ selector: {}, sort: [{ orderKey: 'desc' }], limit: 1 }).exec();
      candidate.orderKey = root?.orderKey ?? orderKeyBetween(last[0]?.orderKey ?? null, null);
      candidate.revision = Object.values(engine.vector()).reduce((sum, seq) => sum + seq, 0);
      if (tail) candidate.tailOrderKey = tail;
    } else {
      const image = candidate.image; delete candidate.image;
      if (image) Object.assign(candidate, { imageId: image.id, imageMimeType: image.mimeType, imageWidth: image.width, imageHeight: image.height });
      if (candidate.orderKey > tail) tail = candidate.orderKey;
    }
    if (existing && canonical(documentValue(existing.toJSON(true))) === canonical(candidate)) continue;
    await withJournalMaterialization(target, candidate as never, () => target.upsert(candidate as never));
  }
  if (!await rx.getCurrentProject() && await rx.getProject(boardId)) await rx.selectProject(boardId);
}

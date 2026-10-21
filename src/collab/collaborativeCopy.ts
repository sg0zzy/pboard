import type { RxRepository } from '../storage/rxdbRepository';
import { blobToDataUrl } from '../storage/blobStore';
import { verifyImageAsset } from './security/imageAsset';

/** An explicit new board identity, never an in-place authority/signature migration. */
export async function createCollaborativeCopy(rx: RxRepository, boardId: string): Promise<string> {
  const snapshot = await rx.exportProject(boardId);
  const id = crypto.randomUUID(), timestamp = new Date().toISOString();
  // Attachment bytes carry over as their own content-addressed blobs; the copy's
  // cards reference the same immutable imageId, re-verified before storage.
  // Signatures and authority identity are not migrated: the copy is unsigned.
  for (const item of snapshot.items) {
    if (!item.imageId) continue;
    const stored = await rx.getImage(item.imageId);
    if (!stored) throw new Error('A referenced image is missing; the original board is unchanged.');
    await rx.blobs.putBlob(await verifyImageAsset(item.imageId, { dataUrl: await blobToDataUrl(stored.blob), mimeType: stored.mimeType, width: stored.width, height: stored.height }), stored);
  }
  const { _sec: oldAuthority, ...project } = snapshot.project as typeof snapshot.project & { _sec?: unknown };
  const items = snapshot.items.map(item => {
    const { _sec: oldSignature, ...fields } = item as typeof item & { _sec?: unknown };
    return { ...fields, id: crypto.randomUUID(), projectId: id, createdAt: timestamp, updatedAt: timestamp };
  });
  await rx.importProject({ ...project, id, name: `${project.name} (collaboration copy)`, revision: 1, createdAt: timestamp, updatedAt: timestamp }, items);
  await rx.selectProject(id);
  return id;
}
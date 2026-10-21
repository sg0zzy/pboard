import type { KeyValueStorage } from '../storage/repository';
import type { RxRepository } from '../storage/rxdbRepository';
import { blobToDataUrl } from '../storage/blobStore';
import { verifyImageAsset } from './security/imageAsset';

export const TRANSITIONS_KEY = 'pboardLegacyTransitions';

export type LegacyTransitionState = 'identified' | 'copy-in-progress' | 'copied';
export type LegacyTransition = {
  boardId: string;
  state: LegacyTransitionState;
  copyBoardId?: string;
  updatedAt: string;
};

type TransitionStore = Record<string, LegacyTransition>;

async function readTransitions(storage: KeyValueStorage): Promise<TransitionStore> {
  const saved = (await storage.get(TRANSITIONS_KEY))[TRANSITIONS_KEY] as TransitionStore | undefined;
  return saved && typeof saved === 'object' ? saved : {};
}

async function writeTransition(storage: KeyValueStorage, transition: LegacyTransition): Promise<void> {
  const all = await readTransitions(storage);
  all[transition.boardId] = transition;
  await storage.set({ [TRANSITIONS_KEY]: all });
}

/**
 * Identifies a previously trust-bound legacy board. Missing signatures alone
 * never identify an old shared copy; only an existing recorded trust marker
 * (legacy pin or shared Drive project file) does. Purely local bookkeeping: the
 * original board, its content, membership and stored trust stay untouched.
 */
export async function identifyLegacyBoard(storage: KeyValueStorage, boardId: string, marker: { hasLegacyPin: boolean; hasSharedProjectFile: boolean }): Promise<LegacyTransition> {
  const transitions = await readTransitions(storage);
  const existing = transitions[boardId];
  if (existing) return existing;
  if (!marker.hasLegacyPin && !marker.hasSharedProjectFile) throw new Error('No legacy shared-board trust record for this board');
  const transition: LegacyTransition = { boardId, state: 'identified', updatedAt: new Date().toISOString() };
  await writeTransition(storage, transition);
  return transition;
}

export async function legacyTransitionFor(storage: KeyValueStorage, boardId: string): Promise<LegacyTransition | null> {
  return (await readTransitions(storage))[boardId] ?? null;
}

export async function legacyTransitions(storage: KeyValueStorage): Promise<LegacyTransition[]> {
  return Object.values(await readTransitions(storage)).sort((a, b) => a.boardId.localeCompare(b.boardId));
}

/**
 * An explicit, user-authorized copy under a NEW board identity. Interrupted
 * copies are recoverable: the in-progress marker is written before any content
 * work, a crash restarts the copy cleanly (the source never changes), and the
 * completed entry records the copy's board id. No automatic authority
 * replacement occurs — the copy is unsigned and a separate board.
 */
export async function transitionLegacyBoard(storage: KeyValueStorage, rx: RxRepository, boardId: string): Promise<string> {
  const transitions = await readTransitions(storage), previous = transitions[boardId];
  if (!previous) throw new Error('Identify the legacy board before its transition; trust records are never inferred');
  if (previous.state === 'copied' && previous.copyBoardId) {
    // A completed copy survives; do not duplicate it.
    if (await rx.getProject(previous.copyBoardId)) return previous.copyBoardId;
  }
  await writeTransition(storage, { boardId, state: 'copy-in-progress', updatedAt: new Date().toISOString() });
  // Interrupted copies leave only the marker; the source board is unchanged and
  // a retry re-runs the full copy below.
  const copyId = await createVerifiedCopy(rx, boardId);
  await writeTransition(storage, { boardId, state: 'copied', copyBoardId: copyId, updatedAt: new Date().toISOString() });
  return copyId;
}

async function createVerifiedCopy(rx: RxRepository, boardId: string): Promise<string> {
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
  const sourceProject = snapshot.project as typeof snapshot.project & { _sec?: unknown };
  const { _sec: _authority, ...project } = sourceProject;
  void _authority;
  const items = snapshot.items.map(item => {
    const { _sec: _signature, ...fields } = item as typeof item & { _sec?: unknown };
    void _signature;
    return { ...fields, id: crypto.randomUUID(), projectId: id, createdAt: timestamp, updatedAt: timestamp };
  });
  await rx.importProject(
    { ...project, id, name: `${project.name} (collaboration copy)`, revision: 1, createdAt: timestamp, updatedAt: timestamp },
    items,
  );
  await rx.selectProject(id);
  return id;
}
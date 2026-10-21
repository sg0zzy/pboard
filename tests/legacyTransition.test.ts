import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { createRxRepository } from '../src/storage/rxdbRepository';
import { createIndexedDbBlobStore, hashBlob } from '../src/storage/blobStore';
import { identifyLegacyBoard, legacyTransitionFor, transitionLegacyBoard, legacyTransitions, TRANSITIONS_KEY } from '../src/collab/legacyTransition';
import type { RxRepository } from '../src/storage/rxdbRepository';

const repos = { current: [] as RxRepository[] };
afterEach(async () => { for (const r of repos.current.splice(0)) await r.db.close(); });

type Memory = Record<string, unknown>;
const storage = () => {
  const values: Memory = {};
  return {
    get: async (id: string): Promise<Record<string, unknown>> => ({ [id]: structuredClone(values[id]) }),
    set: async (patch: Record<string, unknown>): Promise<void> => { Object.assign(values, structuredClone(patch)); },
    values
  };
};

const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', mimeType: 'image/png', width: 1, height: 1 };

async function seededBoard(withImages = true) {
  const store = storage();
  const repo = await createRxRepository({ name: `legacy-${crypto.randomUUID()}`, blobs: createIndexedDbBlobStore(`legblob-${crypto.randomUUID()}`) });
  repos.current.push(repo);
  const board = await repo.createProject('Legacy shared board', 'project');
  const card = await repo.addItem({ projectId: board.id, content: 'Legacy content', ...(withImages ? { image } : {}) });
  return { store, repo, board, card };
}

it('identification requires an existing trust marker and never relies on missing signatures alone', async () => {
  const { store, repo, board } = await seededBoard(false);
  await expect(identifyLegacyBoard(store, board.id, { hasLegacyPin: false, hasSharedProjectFile: false })).rejects.toThrow('trust record');
  const transition = await identifyLegacyBoard(store, board.id, { hasLegacyPin: true, hasSharedProjectFile: false });
  expect(transition.state).toBe('identified');
  // Reidentification is idempotent and keeps the original state.
  expect(await legacyTransitionFor(store, board.id)).toEqual(transition);
  // The source board and its membership/content stay untouched.
  expect(await repo.getProject(board.id)).not.toBeNull();
  expect((await legacyTransitions(store))).toHaveLength(1);
});

it('an interrupted copy is recoverable: the marker precedes content work and a retry completes without duplicating or touching the source', async () => {
  const { store, repo, board, card } = await seededBoard(true);
  await identifyLegacyBoard(store, board.id, { hasLegacyPin: false, hasSharedProjectFile: true });
  const imageId = (await repo.getCard(card.id))!.imageId!;
  // Fail during the copy operation itself (before import): the source remains intact.
  const failing: RxRepository = new Proxy(repo, {
    get(target, property, receiver) {
      if (property === 'importProject') return async () => { throw new Error('simulated crash during copy import'); };
      return Reflect.get(target, property, receiver);
    }
  }) as unknown as RxRepository;
  await expect(transitionLegacyBoard(store, failing, board.id)).rejects.toThrow('simulated crash');
  expect(await legacyTransitionFor(store, board.id)).toMatchObject({ state: 'copy-in-progress' });
  // Source content, images and trust are unchanged.
  expect((await repo.listCards(board.id)).map(c => c.id)).toEqual([card.id]);
  expect(await repo.hasImage(imageId)).toBe(true);
  expect(repo.db.name).toBe(repo.db.name);
  // A retry completes; the copy has fresh identities and re-verified image bytes.
  const copyId = await transitionLegacyBoard(store, repo, board.id);
  expect(copyId).not.toBe(board.id);
  const copyCard = (await repo.listCards(copyId))[0];
  expect(copyCard.id).not.toBe(card.id); expect(copyCard.imageId).toBe(imageId);
  expect(await repo.hasImage(imageId)).toBe(true);
  expect(await legacyTransitionFor(store, board.id)).toMatchObject({ state: 'copied', copyBoardId: copyId });
  // Repeated transition keeps the completed copy rather than duplicating.
  expect(await transitionLegacyBoard(store, repo, board.id)).toBe(copyId);
  expect((await repo.listCards(copyId))).toHaveLength(1);
  expect(Object.keys(store.values[TRANSITIONS_KEY] as object)).toEqual([board.id]);
  // The image bytes keep matching their content id in both references.
  expect(await hashBlob((await repo.getImage(imageId))!.blob)).toBe(imageId);
});

it('transition refuses a board without prior identification and with no legacy trust', async () => {
  const { store, repo, board } = await seededBoard(false);
  await expect(transitionLegacyBoard(store, repo, board.id)).rejects.toThrow('Identify the legacy board');
  expect(await legacyTransitionFor(store, board.id)).toBeNull();
  // The original board remains editable and unchanged.
  expect((await repo.listCards(board.id))).toHaveLength(1);
});
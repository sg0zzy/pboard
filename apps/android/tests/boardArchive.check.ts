// @vitest-environment node
import 'fake-indexeddb/auto';
import { createRxRepository } from '../../../src/storage/rxdbRepository';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildBoardArchive } from '../../../src/sidebar/download';
import { buildBoardArchiveAsync } from '../src/platform/boardArchive';

import type { BoardItem, Project } from '../src/storage/repository';


const project: Project = { id: 'board', name: 'Photo board', template: 'project', revision: 1, createdAt: '', updatedAt: '' };
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

describe('Android board archive', () => {
  it('matches the shared archive contents and keeps image numbering in first-occurrence order', async () => {
    const repository = await createRxRepository({ name: `archive${Date.now()}` });
    try {
      const imageId = await repository.putImage({ dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`, mimeType: 'image/png', width: 10, height: 10 });
      const mk = (id: string, order: number, patch: Partial<BoardItem> = {}): BoardItem => ({
        id, projectId: 'board', type: 'task', content: `card ${id}`, status: 'candidate', order, createdAt: '', updatedAt: '', ...patch,
      });
      const items: BoardItem[] = [
        mk('a', 0, { imageId }),
        mk('b', 1, { imageId }),
        mk('c', 2, { status: 'trash', imageId }),
        mk('d', 3),
      ];
      const shared = await buildBoardArchive(project, items, repository.getImage);
      const asyncArchive = await buildBoardArchiveAsync(project, items, repository.getImage);
      expect(asyncArchive.filename).toBe(shared.filename);
      const left = unzipSync(shared.data), right = unzipSync(asyncArchive.data);
      expect(Object.keys(right).sort()).toEqual(Object.keys(left).sort());
      expect(strFromU8(right['board.txt'])).toBe(strFromU8(left['board.txt']));
      expect(strFromU8(right['board.json'])).toBe(strFromU8(left['board.json']));
      for (const name of Object.keys(left)) expect(right[name]).toEqual(left[name]);
      // Trash is excluded, and a's and b's shared image is stored exactly once.
      expect(Object.keys(right).filter(name => name.startsWith('images/'))).toEqual(['images/a-1.png']);
    } finally { await repository.db.close(); }
  });
});

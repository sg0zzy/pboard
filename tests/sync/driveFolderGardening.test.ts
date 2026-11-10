import { describe, expect, it, vi } from 'vitest';
import { createDriveFolderGardener } from '../../src/sync/driveFolderGardening';
import type { DriveBoardStore } from '../../src/sync/driveBoardStore';
import type { RxRepository } from '../../src/storage/rxdbRepository';

function setup() {
  const rows = [
    { rootId: 'root-a', folderId: 'one', name: 'active', children: [] },
    { rootId: 'root-a', folderId: 'two', name: 'old', children: [{ id: 'file', name: 'old.json.gz', mimeType: 'application/gzip', modifiedTime: 'a' }] },
    { rootId: 'root-a', folderId: 'three', name: 'shared', children: [] },
  ];
  const store = { inspectBoardFolders: vi.fn(async () => structuredClone(rows)),
    inspectBoardRoots: vi.fn(async () => ['root-a']),
    inspectFolderChildren: vi.fn(async (id: string) => structuredClone(rows.find(row => row.folderId === id)!.children)),
    folderState: vi.fn(async (id: string) => ({ id, name: id === 'root-a' ? 'pboard' : rows.find(row => row.folderId === id)!.name, parents: ['root-a'], trashed: false, ownedByMe: id !== 'three', role: 'owner' as const })),
    trashFile: vi.fn(async () => {}) };
  const rx = { listProjects: vi.fn(async () => [{ id: 'active' }]), journal: { boardTombstone: vi.fn(async () => ({ deleted: false })) } };
  let account = 'account-a';
  const gardener = createDriveFolderGardener({ store: store as unknown as DriveBoardStore, repository: async () => rx as unknown as RxRepository, account: async () => account });
  return { gardener, store, rx, rows, setAccount: (value: string) => { account = value; } };
}

describe('Drive folder gardening', () => {
  it('previews without writing and requires a reviewed owned folder', async () => {
    const h = setup();
    await expect(h.gardener.trash('two')).rejects.toThrow('Review');
    const rows = await h.gardener.preview();
    expect(rows.map(row => [row.classification, row.owned])).toEqual([['active', true], ['unidentified', true], ['unidentified', false]]);
    expect(h.store.trashFile).not.toHaveBeenCalled();
    await expect(h.gardener.trash('one')).rejects.toThrow('active');
    await expect(h.gardener.trash('three')).rejects.toThrow('not owned');
    await h.gardener.trash('two');
    expect(h.store.trashFile).toHaveBeenCalledWith('two');
    await expect(h.gardener.trash('two')).rejects.toThrow('Review');
  });
  it('refuses if contents, account, ownership or local board state change after review', async () => {
    const h = setup(); await h.gardener.preview();
    h.rows[1].children[0].modifiedTime = 'b';
    await expect(h.gardener.trash('two')).rejects.toThrow('contents changed');
    h.rows[1].children[0].modifiedTime = 'a';
    h.rx.listProjects.mockResolvedValueOnce([{ id: 'old' }]);
    await expect(h.gardener.trash('two')).rejects.toThrow('present locally');
    h.setAccount('account-b');
    await expect(h.gardener.trash('two')).rejects.toThrow('Review');
    expect(h.store.trashFile).not.toHaveBeenCalled();
  });
  it('does not offer unidentified folders with nested folders for removal', async () => {
    const h = setup();
    h.rows[1].children.push({ id: 'sub', name: 'attachments', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 'a' });
    await h.gardener.preview();
    await expect(h.gardener.trash('two')).rejects.toThrow('subfolders');
    expect(h.store.trashFile).not.toHaveBeenCalled();
  });
});

import type { DriveBoardStore } from './driveBoardStore';
import type { RxRepository } from '../storage/rxdbRepository';

export type GardenFolder = {
  folderId: string; name: string; rootId: string;
  children: { id: string; name: string; mimeType: string; modifiedTime?: string }[];
  classification: 'active' | 'deleted' | 'unidentified'; owned: boolean;
};

/** A manual review, never an automatic inference that a missing local board is dead. */
export function createDriveFolderGardener(options: {
  store: DriveBoardStore; repository: () => Promise<RxRepository | null>; account: () => Promise<string | null>;
}) {
  let reviewed = new Map<string, GardenFolder>();
  let reviewedAccount: string | null = null;
  const fingerprint = (files: GardenFolder['children']) => JSON.stringify([...files].sort((a, b) => a.id.localeCompare(b.id)));
  async function current() {
    const account = await options.account();
    const rx = await options.repository();
    if (!account || !rx) throw new Error('Connect Google Drive and open local storage before reviewing folders.');
    return { account, rx };
  }
  return {
    async preview(): Promise<GardenFolder[]> {
      reviewed = new Map(); reviewedAccount = null;
      const { account, rx } = await current();
      const visible = new Set((await rx.listProjects()).map(project => project.id));
      const folders = await options.store.inspectBoardFolders();
      const rows: GardenFolder[] = [];
      for (const folder of folders) {
        const state = await options.store.folderState(folder.folderId);
        const deleted = (await rx.journal.boardTombstone(folder.name, account)).deleted;
        rows.push({ ...folder, owned: state.ownedByMe && !state.trashed && state.parents.includes(folder.rootId),
          classification: visible.has(folder.name) ? 'active' : deleted ? 'deleted' : 'unidentified' });
      }
      if (await options.account() !== account) throw new Error('Google account changed during the review.');
      reviewedAccount = account; reviewed = new Map(rows.map(row => [row.folderId, row]));
      return rows;
    },
    async trash(folderId: string): Promise<void> {
      const row = reviewed.get(folderId), { account, rx } = await current();
      if (!row || !reviewedAccount || account !== reviewedAccount) throw new Error('Review the folders again before moving one to Trash.');
      if (!row.owned || row.classification === 'active') throw new Error('This folder is active or is not owned by this account.');
      // An unidentified folder may be a live board on another device. The UI
      // requires an explicit, per-folder confirmation after showing its files.
      if (row.classification === 'unidentified' && row.children.some(file => !file.mimeType || file.mimeType === 'application/vnd.google-apps.folder'))
        throw new Error('Unidentified folders containing subfolders cannot be moved here.');
      if (row.children.some(file => !file.modifiedTime)) throw new Error('Drive did not provide enough information to recheck these contents.');
      if ((await rx.listProjects()).some(project => project.id === row.name)) throw new Error('This board is now present locally; review again.');
      if (row.classification === 'deleted' && !(await rx.journal.boardTombstone(row.name, account)).deleted)
        throw new Error('The deletion record changed; review again.');
      const root = await options.store.folderState(row.rootId);
      if (!root.ownedByMe || root.trashed || root.name !== 'pboard' || !(await options.store.inspectBoardRoots()).includes(row.rootId))
        throw new Error('The pboard root changed; review again.');
      const state = await options.store.folderState(folderId);
      if (!state.ownedByMe || state.trashed || state.name !== row.name || !state.parents.includes(row.rootId))
        throw new Error('The folder ownership or location changed; review again.');
      if (fingerprint(await options.store.inspectFolderChildren(folderId)) !== fingerprint(row.children))
        throw new Error('The folder contents changed; review again.');
      if (await options.account() !== account) throw new Error('Google account changed; nothing was moved.');
      await options.store.trashFile(folderId);
      reviewed.delete(folderId);
    }
  };
}

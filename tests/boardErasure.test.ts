import { expect, it } from 'vitest';
import { eraseLegacyBoardCopies } from '../src/storage/boardErasure';
it('removes only the confirmed board from legacy and rollback copies', async () => {
  const data: Record<string, any> = {};
  for (const key of ['projectBoardState', 'pboardStateBeforeRxRollback']) data[key] = {
    version: 3, projects: [{ id: 'erase' }, { id: 'keep' }], boardItems: [{ id: 'one', projectId: 'erase', content: 'Removed secret' }, { id: 'two', projectId: 'keep', content: 'Kept content' }], currentProjectId: 'erase' };
  await eraseLegacyBoardCopies({ get: async key => ({ [key]: data[key] }), set: async patch => { Object.assign(data, patch); } }, 'erase');
  for (const state of Object.values(data)) {
    expect(state.projects).toEqual([{ id: 'keep' }]);
    expect(state.boardItems).toEqual([{ id: 'two', projectId: 'keep', content: 'Kept content' }]);
    expect(state.currentProjectId).toBe('keep');
  }
});

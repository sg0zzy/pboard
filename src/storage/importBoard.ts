import type { BoardItem, Project } from '../types';
import type { RxRepository } from './rxdbRepository';

export type ImportedCard = Pick<BoardItem, 'type' | 'status' | 'content' | 'title' | 'displayMode' | 'source' | 'image'>;

/** New local identities only: an exported board never restores collaboration
 * credentials, signatures, tombstones or a binding to someone else's board. */
export async function importLocalBoard(rx: Pick<RxRepository, 'importProject' | 'selectProject'>, name: string, template: Project['template'], cards: ImportedCard[]) {
  const id = crypto.randomUUID(), timestamp = new Date().toISOString();
  const project: Project = { id, name, template, revision: 1, createdAt: timestamp, updatedAt: timestamp };
  try {
    await rx.importProject(project, cards.map(({ type, status, content, title, displayMode, source, image }, order) => ({
      type, status, content, ...(title !== undefined ? { title } : {}), ...(displayMode ? { displayMode } : {}),
      ...(source ? { source } : {}), ...(image ? { image } : {}),
      id: crypto.randomUUID(), projectId: id, order, createdAt: timestamp, updatedAt: timestamp
    })));
    await rx.selectProject(id);
  } catch {
    throw new Error('Import stopped before completion. Any partially imported board was kept; existing boards are unchanged.');
  }
  return project;
}

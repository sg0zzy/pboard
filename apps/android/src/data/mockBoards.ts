import type { BoardOverview } from './boards';

// Deliberately in manual sidebar order, rather than recency order.
export const mockBoards: readonly BoardOverview[] = [
  { id: 'archive', name: 'Archive', category: 'Notes', firstCard: 'Older notes and references', color: 'rose', updatedAt: '2026-10-01T09:00:00Z' },
  { id: 'ai', name: 'AI experiments', category: 'Ideas', firstCard: 'Test new coding agents', color: 'lavender', updatedAt: '2026-10-02T09:00:00Z' },
  { id: 'website', name: 'Website', category: 'Project', firstCard: 'Publish personal landing page', color: 'peach', updatedAt: '2026-10-11T09:00:00Z' },
  { id: 'personal', name: 'Personal ideas', category: 'Ideas', firstCard: 'A lightweight notes system', color: 'mint', updatedAt: '2026-10-12T09:00:00Z' },
  { id: 'film', name: 'filmTidy', category: 'Project', firstCard: 'Photo metadata analysis', color: 'blue', updatedAt: '2026-10-13T09:00:00Z' },
  { id: 'phone', name: 'PhoneHaul', category: 'Project', firstCard: 'Improve Android transfer UX', color: 'yellow', updatedAt: '2026-10-14T09:00:00Z' },
];

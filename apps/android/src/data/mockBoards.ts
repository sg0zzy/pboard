import type { BoardOverview } from './boards';

// Deliberately in manual sidebar order, rather than recency order.
export const mockBoards: readonly BoardOverview[] = [
  { id: 'archive', name: 'Archive', category: 'Notes', firstCard: 'Older notes and references', updatedAt: '2026-10-01T09:00:00Z' },
  { id: 'ai', name: 'AI experiments', category: 'Ideas', firstCard: 'Test new coding agents', updatedAt: '2026-10-02T09:00:00Z' },
  { id: 'website', name: 'Website', category: 'Project', firstCard: 'Publish personal landing page', updatedAt: '2026-10-11T09:00:00Z' },
  { id: 'personal', name: 'Personal ideas', category: 'Ideas', firstCard: 'A lightweight notes system', updatedAt: '2026-10-12T09:00:00Z' },
  { id: 'film', name: 'filmTidy', category: 'Project', firstCard: 'Photo metadata analysis', updatedAt: '2026-10-13T09:00:00Z' },
  { id: 'phone', name: 'PhoneHaul', category: 'Project', firstCard: 'Improve Android transfer UX', updatedAt: '2026-10-14T09:00:00Z' },
];

import type { BoardItemStatus } from '../../../../src/types';

export const TERMINAL_CONTAINERS = [
  { status: 'done', label: 'Done' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'trash', label: 'Trash' },
] as const;
export type TerminalStatus = typeof TERMINAL_CONTAINERS[number]['status'];

/** Presentation only: status changes never assign a new order key. */
export function cardContainer(status: BoardItemStatus): 'active' | TerminalStatus {
  return status === 'done' || status === 'rejected' || status === 'trash' ? status : 'active';
}

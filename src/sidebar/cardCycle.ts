import { BOARD_ITEM_STATUS_CYCLE } from "../types";
import type { BoardItemType, BoardItemStatus, BoardTemplate } from "../types";
import { boardTemplates } from "../templates/boardTemplates";

const STATUS_CYCLE: readonly BoardItemStatus[] = BOARD_ITEM_STATUS_CYCLE;

export function stepStatus(status: BoardItemStatus, direction: -1 | 1): BoardItemStatus {
  const index = STATUS_CYCLE.indexOf(status);
  const base = index === -1 ? 0 : index;
  const next = (base + direction + STATUS_CYCLE.length) % STATUS_CYCLE.length;
  return STATUS_CYCLE[next];
}

export function stepCardType(template: BoardTemplate, type: BoardItemType, direction: -1 | 1): BoardItemType {
  const supported = boardTemplates[template].cardTypes;
  const current = supported.findIndex((candidate) => candidate.id === type);
  const next =
    current === -1
      ? (direction === 1 ? 0 : supported.length - 1)
      : (current + direction + supported.length) % supported.length;
  return supported[next].id;
}

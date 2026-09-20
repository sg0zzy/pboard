import { BOARD_ITEM_STATUSES } from "../types";
import type { BoardItemType, BoardItemStatus, BoardTemplate } from "../types";
import { boardTemplates } from "../templates/boardTemplates";

export function stepStatus(status: BoardItemStatus, direction: -1 | 1): BoardItemStatus {
  const index = BOARD_ITEM_STATUSES.indexOf(status);
  const next = (index + direction + BOARD_ITEM_STATUSES.length) % BOARD_ITEM_STATUSES.length;
  return BOARD_ITEM_STATUSES[next];
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

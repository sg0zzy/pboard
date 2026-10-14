import { cardColors } from '../data/cardColors';
import { BOARD_TEMPLATES, BOARD_ITEM_TYPES, type BoardTemplate, type BoardItemType } from '../../../../src/types';
import { displayText, type BoardOverview } from '../data/boards';

export function BoardTile({ board, onOpen, showPreview = true }: { board: BoardOverview; showPreview?: boolean; onOpen: (board: BoardOverview) => void }) {
  const title = displayText(board.name, 'Untitled board');
  const template = BOARD_TEMPLATES.includes(board.template as BoardTemplate) ? board.template as BoardTemplate : undefined;
  const type = BOARD_ITEM_TYPES.includes(board.firstCardType as BoardItemType) ? board.firstCardType as BoardItemType : undefined;
  return (
    <button className="board-tile" style={cardColors(template, type)} onClick={() => onOpen(board)} aria-label={`Open ${title}`}>
      <span className="board-title">{title}</span>
      <span className="board-category">{displayText(board.category, 'Notes')}</span>
      {showPreview && <span className="card-preview"><span>{displayText(board.firstCard, 'No cards yet')}</span></span>}
    </button>
  );
}

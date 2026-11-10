import { displayText, type BoardOverview } from '../data/boards';
import { categoryColors } from '../data/categories';

/**
 * Home tile. Its accent and chip come from the board's **category**, not from
 * the first card, so the grid reads by board kind: all Notes share one hue, all
 * Ideas another, and a board's colour never changes because a card was edited,
 * reordered or emptied. The accent is the colour `overviewBoards` already
 * resolved for `categoryColor`, so the chip's label and the tile's hue are
 * decided once, together.
 */
export function BoardTile({ board, onOpen, showPreview = true }: { board: BoardOverview; showPreview?: boolean; onOpen: (board: BoardOverview) => void }) {
  const title = displayText(board.name, 'Untitled board');
  return (
    <button className={`board-tile${showPreview ? '' : ' board-tile--compact'}`} style={categoryColors(board)} onClick={() => onOpen(board)} aria-label={`Open ${title}`}>
      <span className="board-title">{title}</span>
      <span className="board-category">{displayText(board.category, 'Notes')}</span>
      {showPreview && <span className="card-preview"><span>{displayText(board.firstCard, 'No cards yet')}</span></span>}
    </button>
  );
}

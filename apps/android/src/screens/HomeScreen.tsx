import { BoardTile } from '../components/BoardTile';
import { Icon } from '../components/Icon';
import { sortBoards, type BoardOverview } from '../data/boards';

type Props = {
  boards: readonly BoardOverview[];
  onOpen: (board: BoardOverview) => void;
  onSettings: () => void;
  onCreate: () => void;
  showPreviews?: boolean;
  onNotice: (message: string) => void;
};
export function HomeScreen({ boards, onOpen, onSettings, onNotice, onCreate, showPreviews = true }: Props) {
  return <>
    <header className="toolbar">
      <h1>pboard</h1>
      <button className="icon-button" aria-label="Google Drive integration" onClick={() => onNotice('Google Drive integration is not yet configured.')}><Icon name="cloud" /></button>
      <button className="icon-button" aria-label="Settings" onClick={onSettings}><Icon name="settings" /></button>
    </header>
    <main className="home-content" aria-label="Boards">
      {!boards.length && <p className="empty-state">No boards yet. Tap + to create your first board.</p>}
      <div className="board-grid">{sortBoards(boards).map(board => <BoardTile key={board.id} board={board} onOpen={onOpen} showPreview={showPreviews} />)}</div>
    </main>
    <button className="add-button" aria-label="Create board" onClick={onCreate}><Icon name="add" /></button>
  </>;
}

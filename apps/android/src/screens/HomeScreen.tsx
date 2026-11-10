import { BoardTile } from '../components/BoardTile';
import { Icon } from '../components/Icon';
import { sortBoards, type BoardOverview } from '../data/boards';

type Props = {
  boards: readonly BoardOverview[];
  onOpen: (board: BoardOverview) => void;
  onSettings: () => void;
  onCreate: () => void;
  showPreviews?: boolean;
  onPreviews?: (show: boolean) => void;
  onNotice: (message: string) => void;
  cloud?: { connected: boolean; error: string; lastSynced: string } | null;
};
export function HomeScreen({ boards, onOpen, onSettings, onCreate, showPreviews = true, onPreviews, onNotice, cloud }: Props) {
  const driveNotice = !cloud?.connected
    ? 'Google Drive is not connected. Open Settings to connect it.'
    : cloud.error ? `Google Drive: ${cloud.error}`
      : `Google Drive connected. Boards and photos sync while the app is open.${cloud.lastSynced ? ` Last synced: ${cloud.lastSynced}.` : ''}`;
  return <>
    <header className="toolbar">
      <h1>pboard</h1>
      {onPreviews && <button className="icon-button" aria-label="Board only layout" aria-pressed={!showPreviews} title={showPreviews ? 'Show boards only' : 'Show card previews on boards'} onClick={() => onPreviews(!showPreviews)}><Icon name={showPreviews ? 'cards' : 'rows'} /></button>}
      <button className="icon-button" aria-label="Google Drive integration" onClick={() => onNotice(driveNotice)}><Icon name="cloud" /></button>
      <button className="icon-button" aria-label="Settings" onClick={onSettings}><Icon name="settings" /></button>
    </header>
    <main className="home-content" aria-label="Boards">
      {!boards.length && <p className="empty-state">No boards yet. Tap + to create your first board.</p>}
      <div className="board-grid">{sortBoards(boards).map(board => <BoardTile key={board.id} board={board} onOpen={onOpen} showPreview={showPreviews} />)}</div>
    </main>
    <button className="add-button" aria-label="Create board" onClick={onCreate}><Icon name="add" /></button>
  </>;
}

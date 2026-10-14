import type { ToolbarPinContext, ToolbarPinKind } from "../../messaging/messages";
import { LinkIcon, PageIcon, PlusIcon, RegionCameraIcon, SelectionIcon } from "./icons";

export function CaptureToolbar({
  context,
  busy,
  onNewCard,
  onPin,
  onCaptureRegion
}: {
  context: ToolbarPinContext;
  busy: boolean;
  onNewCard(): void;
  onPin(kind: ToolbarPinKind): void;
  onCaptureRegion(): void;
}) {
  return (
    <div className="board-add-zone" role="toolbar" aria-label="Add to Pboard">
      <button className="board-add-button" aria-label="New card" title="New card" onClick={onNewCard}>
        <PlusIcon />
      </button>
      <span className="board-add-separator" role="separator" aria-orientation="vertical" />
      <button className="board-add-button" aria-label="Pin current page" title="Pin current page" disabled={!context.page || busy} onClick={() => onPin("page")}><PageIcon /></button>
      <button className="board-add-button" aria-label="Pin selected text" title="Pin selected text" disabled={!context.page || (context.accessible && !context.selection) || busy} onClick={() => onPin("selection")}><SelectionIcon /></button>
      <button className="board-add-button" aria-label="Pin link" title="Pin link" disabled={!context.page || (context.accessible && !context.link) || busy} onClick={() => onPin("link")}><LinkIcon /></button>
      <button className="board-add-button" aria-label="Capture region" title="Capture region" disabled={busy} onClick={onCaptureRegion}><RegionCameraIcon /></button>
    </div>
  );
}

import type { ToolbarPinContext, ToolbarPinKind } from "../../messaging/messages";

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
        <span aria-hidden="true">+</span>
      </button>
      <span className="board-add-separator" role="separator" aria-orientation="vertical" />
      <button className="board-add-button" aria-label="Pin current page" title="Pin current page" disabled={!context.page || busy} onClick={() => onPin("page")}><PageIcon /></button>
      <button className="board-add-button" aria-label="Pin selected text" title="Pin selected text" disabled={!context.page || (context.accessible && !context.selection) || busy} onClick={() => onPin("selection")}><SelectionIcon /></button>
      <button className="board-add-button" aria-label="Pin link" title="Pin link" disabled={!context.page || (context.accessible && !context.link) || busy} onClick={() => onPin("link")}><LinkIcon /></button>
      <button className="board-add-button" aria-label="Capture region" title="Capture region" disabled={busy} onClick={onCaptureRegion}><RegionCameraIcon /></button>
    </div>
  );
}

function PageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.75h8l4 4v14.5H6zM14 2.75v4h4M9 11h6M9 14.5h6M9 18h4" /></svg>;
}

function SelectionIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 9h10M5 17h14M5 21h9" /><path d="M4 12.5h16v3H4z" className="selection-highlight" /></svg>;
}

function LinkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.2 14.8 5.6-5.6M10 7.5l1.3-1.3a4 4 0 0 1 5.7 5.7l-2 2M14 16.5l-1.3 1.3A4 4 0 0 1 7 12.1l2-2" /></svg>;
}

function RegionCameraIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" /><path d="M6.5 10.5h3l1-1.5h3l1 1.5h3v7h-11z" /><circle cx="12" cy="14" r="2" /></svg>;
}

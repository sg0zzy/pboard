/** Local, bounded experiment diagnostics. Never accept arbitrary payload/error text. */
export type CollaborationDiagnostic = { time: string; event: string; room?: string; session?: string; peer?: string; count?: number; code?: number };
const history: CollaborationDiagnostic[] = [];
const listeners = new Set<() => void>();
export function collaborationDiagnostic(event: string, fields: Omit<CollaborationDiagnostic, "time" | "event"> = {}) {
  if (!import.meta.env.DEV || import.meta.env.VITE_PBOARD_SIGNALING_PROVIDER !== "websocket") return;
  // Explicit field projection avoids accidentally logging SDP, documents or credentials.
  const entry: CollaborationDiagnostic = { time: new Date().toISOString(), event,
    room: fields.room?.slice(0, 100), session: fields.session?.slice(0, 12), peer: fields.peer?.slice(0, 12), count: fields.count, code: fields.code };
  history.push(entry);
  if (history.length > 100) history.shift();
  console.info("[pboard collaboration]", entry);
  for (const listener of listeners) listener();
}
export const collaborationDiagnostics = {
  snapshot: () => history.slice(),
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  clear() { history.length = 0; for (const listener of listeners) listener(); }
};

import { useState } from "react";
import { healRelay } from "../../sync/browser";

/**
 * The owner's one control that forces recovery on this board's relay leg.
 * It runs the same conditional heal as the automatic triggers — replay
 * operations the relay never carried, re-open the live channel only if it is
 * not synced, fix the content-key hand-off only if the key looks wrong, pull a
 * visible gap, and consolidate the log last — but unconditionally asks for the
 * answer now instead of waiting for a backoff timer a throttled tab may never
 * run. Nothing here is destructive: it sends what the local board already
 * holds and reconnects; it never prunes, never downloads history to "reset",
 * and needs no page reload or re-sign-in. Pressing it twice is safe: a heal
 * already running for this board is the one that gets reported.
 */
export function BoardRelayHealControls({ projectId }: { projectId: string | null }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  async function heal() {
    if (!projectId || busy) return;
    setBusy(true);
    try { setOutcome(await healRelay(projectId, { force: true })); }
    catch (error) { setOutcome(`failed:${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }
  return <p className="board-relay-heal">
    <button type="button" disabled={!projectId || busy} onClick={() => void heal()}>{busy ? "Reconnecting…" : "Reconnect"}</button>{" "}
    Replays anything the relay never carried, restores the live channel, repairs the key hand-off and consolidates — in that order, nothing deleted.{" "}
    {outcome && <span role="status">Relay: {outcome}</span>}
  </p>;
}

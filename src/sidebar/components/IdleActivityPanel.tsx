import { useState } from "react";
import { collaborationCounters } from "../../collab/counters";

/**
 * Idle-work attribution for the periodic-CPU investigation: aggregated
 * counters (no per-event logging) rendered only while expanded, so keeping
 * the debugging section open costs nothing. Available only in a build made
 * with VITE_PBOARD_DIAGNOSTICS=1; read the same numbers from any context's
 * console via `pboardCounters.snapshot()`.
 */
export function IdleActivityPanel() {
  const [snapshot, setSnapshot] = useState(() => collaborationCounters.snapshot());
  if (!collaborationCounters.enabled) return null;
  return <details onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) setSnapshot(collaborationCounters.snapshot()); }}>
    <summary>Idle activity counters</summary>
    <p>Counted since load (or the last clear). Active timers or subscriptions that keep growing while the board is idle name the leak; timings name the expensive operation.</p>
    <button onClick={() => collaborationCounters.clear()}>Reset counters</button>
    <button onClick={() => setSnapshot(collaborationCounters.snapshot())}>Refresh</button>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(snapshot, null, 1)}</pre>
  </details>;
}

import { useState } from "react";
import { createContentKeyStore, type ContentKeyStore } from "../../storage/contentKeyStore";

/** Development-testing hand-off for a board's buffer content key.
 *
 * A content key normally reaches a second device over the authenticated
 * WebRTC data channel. While that channel is switched off for testing, the
 * operator copies the key by hand, which carries the same trust as pasting a
 * board grant by hand: the key is revealed only on an explicit click on the
 * device that already holds one (editors only — viewers are never given a
 * key), and it is never included in a board export or a grant bundle. */
export function BoardContentKeyControls({ projectId, onChanged, keys = createContentKeyStore() }: { projectId: string | null; onChanged: () => void; keys?: ContentKeyStore }) {
  const [material, setMaterial] = useState("");
  const [pasted, setPasted] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(work: () => Promise<string>) {
    setBusy(true); setMessage("");
    try { setMessage(await work()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Content key operation failed"); }
    finally { setBusy(false); }
  }
  function show() {
    void run(async () => {
      if (!projectId) return "Select a board first.";
      // Deliberately loadRaw and not ensure: a device without the key must
      // import it, never quietly start a second key for the same board.
      const stored = await keys.loadRaw(projectId);
      if (!stored) return "This device has no content key for this board, so there is nothing to copy here. Content keys exist only on devices that can edit the board. On the device that already holds the key, use Show board content key, then paste it into Use pasted content key below.";
      setMaterial(stored.material);
      return "The board content key is in the field below. It is not shown in any other panel and never leaves this device by itself.";
    });
  }
  function usePasted() {
    void run(async () => {
      if (!projectId) return "Select a board first.";
      const pastedKey = pasted.trim();
      if (!pastedKey) return "Paste the board content key copied on the other device first.";
      // The store validates and derives the key id, so unusable material is
      // rejected here rather than stored and discovered at decryption time.
      try { await keys.put(projectId, pastedKey); }
      catch { return "That paste was not a usable board content key. Nothing was saved; the pasted text is not repeated here."; }
      onChanged();
      return "Board content key saved. This device can now decrypt this board's operation log; reopen the board if it still shows encrypted history.";
    });
  }
  return <details className="board-content-keys">
    <summary>Development testing: board content key hand-off</summary>
    <p>A board content key is what lets another device decrypt this board's operation log. It exists only for editors; viewers are never given one. Paste it through a channel you already trust, exactly like the board grant. It is never included in board exports or grant bundles, so this manual copy is the only way it leaves the device that holds it.</p>
    <button disabled={busy} onClick={show}>Show board content key</button>
    {material && <label>Board content key — copy and send to the other device<textarea aria-label="Board content key output" readOnly rows={3} value={material} onFocus={e => e.target.select()} /></label>}
    <label>Paste the board content key copied on the other device<textarea aria-label="Board content key input" rows={3} value={pasted} onChange={e => setPasted(e.target.value)} /></label>
    <button disabled={busy} onClick={usePasted}>Use pasted content key</button>
    {message && <p role="status">{message}</p>}
  </details>;
}

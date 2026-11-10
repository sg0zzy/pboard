import { useEffect, useState } from 'react';
import { browser } from '../../platform/browser';
import { DEFAULT_RENDEZVOUS, rendezvousOrigin } from '../../collab/boardGrants';
import { boardCollaboration, collaborationManager } from '../../sync/browser';
import { BoardRelayHealControls } from './BoardRelayHealControls';
import { BoardRetentionControls } from './BoardRetentionControls';

function stopCollaboration(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The collaboration service is still processing an earlier command. Try again once it responds.')), 15_000);
    void collaborationManager.stop().then(
      () => { clearTimeout(timer); resolve(); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Live access is decided by Google Drive permissions. */
export function BoardCollaborationControls({ projectId, onChanged }: { projectId: string | null; onChanged: () => void }) {
  const [url, setUrl] = useState(DEFAULT_RENDEZVOUS);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void boardCollaboration.settings().then(value => {
      if (active) { setUrl(value.url); setEnabled(value.provider === 'websocket'); }
    }).catch(() => { if (active) setMessage('Collaboration configuration could not be read'); });
    return () => { active = false; };
  }, []);

  function enable() {
    // The browser permission request must start inside the click handler.
    try {
      const grant = browser.permissions.request({ origins: [rendezvousOrigin(url)] });
      setBusy(true); setMessage('');
      void (async () => {
        if (!await grant) throw new Error('Rendezvous permission was not granted');
        await stopCollaboration();
        await boardCollaboration.configure({ provider: 'websocket', url });
        setEnabled(true); onChanged();
      })().catch(error => setMessage(error instanceof Error ? error.message : 'Could not enable collaboration'))
        .finally(() => setBusy(false));
    } catch { setMessage('Use a WSS service URL ending in /ws'); }
  }

  async function disable() {
    setBusy(true); setMessage('');
    try {
      await stopCollaboration();
      await boardCollaboration.configure({ provider: 'drive', url });
      setEnabled(false); onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not disable collaboration'); }
    finally { setBusy(false); }
  }

  return <details className="board-collaboration">
    <summary>WebRTC collaboration</summary>
    <p>Signaling: {enabled ? 'WebSocket' : 'Drive (default)'}. Board access is managed through Google Drive sharing.</p>
    <label>Rendezvous service<input type="url" value={url} onChange={event => setUrl(event.target.value)} disabled={busy || enabled} /></label>
    {!enabled && <button disabled={busy} onClick={enable}>Enable WebSocket collaboration</button>}
    {enabled && <>
      <button disabled={busy} onClick={() => void disable()}>Use Drive signaling</button>
      {projectId && <BoardRelayHealControls key={projectId} projectId={projectId} />}
    </>}
    {projectId && <BoardRetentionControls key={projectId} projectId={projectId} />}
    {message && <p role="status">{message}</p>}
  </details>;
}

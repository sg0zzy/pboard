import { useEffect, useRef, useState } from 'react';
import { boardCollaboration, collaborationManager } from '../../sync/browser';
import { repository } from '../../storage/browser';

export function BoardPairingControls({ projectId, onChanged }: { projectId: string | null; onChanged: () => void }) {
  const [invitation, setInvitation] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [deviceCode, setDeviceCode] = useState('');
  const [approvalCode, setApprovalCode] = useState('');
  const [verification, setVerification] = useState('');
  const [preview, setPreview] = useState<{ boardId: string; verification: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [connection, setConnection] = useState('Checking live collaboration…');
  const polling = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void boardCollaboration.pairing.pending().then(value => { if (alive.current && value) { setDeviceCode(value.code); setVerification(value.verification); } }).catch(error => { if (alive.current) setMessage(error.message); });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { setPreview(null); setConfirmed(false); setCopyConfirmed(false); setInvitation(''); }, [projectId]);
  useEffect(() => {
    const update = () => {
      const state = collaborationManager.state();
      setConnection(state.error ? `Live collaboration: ${state.error}` : !state.ready ? 'Checking live collaboration…'
        : state.connectedPeers.length ? `Connected browsers: ${state.connectedPeers.length}`
        : state.role === 'private' ? 'This board is not shared through WebRTC yet.' : 'Waiting for the other browser with this board open.');
    };
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [projectId]);
  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : 'Connection failed'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function share(id: string) {
    const snapshot = await repository.exportProject(id);
    if (snapshot.items.some(item => item.image || item.imageId)) throw new Error('Standalone image transfer is not ready. Use a text-only board; existing data is unchanged.');
    await collaborationManager.stop();
    const code = await boardCollaboration.pairing.invite(id);
    await collaborationManager.start(id);
    setInvitation(code); onChanged();
    setMessage('Send this invitation code to the other browser through a trusted channel. Keep this board open.');
  }
  useEffect(() => {
    if (!deviceCode) return;
    let active = true;
    async function check() {
      if (!active || polling.current) return;
      polling.current = true;
      try {
        const board = await boardCollaboration.pairing.finish();
        if (!active || !board) return;
        setMessage('Device approved. Connecting to the board owner…');
        await collaborationManager.stop(); await collaborationManager.start(board);
        const end = Date.now()+30_000;
        while (active && Date.now()<end && !await repository.getProject(board)) await new Promise(resolve => setTimeout(resolve, 250));
        if (!active) return;
        if (!await repository.getProject(board)) throw new Error('Approved, but the owner is not connected. Keep the owner’s board open; connection will retry.');
        await repository.selectProject(board); await boardCollaboration.pairing.cancel();
        if (active) { setDeviceCode(''); setMessage('Connected. Board edits now replicate through WebRTC.'); onChanged(); }
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : 'Connection failed'); }
      finally { polling.current = false; }
    }
    void check(); const timer = setInterval(() => { void check(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [deviceCode]);
  return <section className="board-pairing" aria-label="Connect another browser">
    <h3>Connect another browser</h3>
    <p role="status">{connection}</p>
    <p>Use these codes between your browsers or send them through a trusted channel. Google login alone never grants board access. No JSON editing is needed.</p>
    <button disabled={!projectId || busy} onClick={() => void run(() => share(projectId!))}>Share selected board</button>
    {invitation && <label>Invitation code — send to Browser B<textarea aria-label="Invitation code" readOnly value={invitation} rows={3} onFocus={event => event.target.select()} /></label>}
    <fieldset disabled={busy}>
      <legend>Browser B: join a board</legend>
      <label>Invitation from Browser A<textarea aria-label="Invitation to join" value={joinCode} onChange={event => setJoinCode(event.target.value)} rows={3} /></label>
      <button disabled={!joinCode.trim()} onClick={() => void run(async () => {
        const value = await boardCollaboration.pairing.request(joinCode); setDeviceCode(value.code); setVerification(value.verification);
        setMessage('Send your device code back to Browser A. After approval this browser connects automatically.');
      })}>Request access</button>
      {deviceCode && <>
        <label>Device code — send back to Browser A<textarea aria-label="Your device code" value={deviceCode} readOnly rows={3} onFocus={event => event.target.select()} /></label>
        <p>Compare in both browsers: <strong>{verification}</strong>. Waiting for the owner’s approval…</p>
      </>}
      <button onClick={() => void run(async () => { await boardCollaboration.pairing.cancel(); setDeviceCode(''); setVerification(''); setMessage('Pending request cancelled.'); })}>Cancel pending request</button>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>Browser A: approve the joining device</legend>
      <label>Device code from Browser B<textarea aria-label="Device code to approve" value={approvalCode} rows={3} onChange={event => { setApprovalCode(event.target.value); setPreview(null); setConfirmed(false); }} /></label>
      <button disabled={!approvalCode.trim()} onClick={() => void run(async () => {
        const value = await boardCollaboration.pairing.preview(approvalCode);
        if (value.boardId !== projectId) throw new Error('Select the board named in this invitation before approving the device');
        setPreview(value);
      })}>Review device</button>
      {preview && <>
        <p>Compare with Browser B: <strong>{preview.verification}</strong></p>
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Both browsers show this verification code.</label>
        <label>Access<select value={role} onChange={event => setRole(event.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
        <button disabled={!confirmed || preview.boardId !== projectId} onClick={() => void run(async () => {
          await collaborationManager.stop();
          await boardCollaboration.pairing.approve(approvalCode, preview.verification, role);
          await collaborationManager.start(preview.boardId); setPreview(null); setConfirmed(false); onChanged();
          setMessage('Device approved. Browser B will connect automatically; keep this board open.');
        })}>Approve device</button>
      </>}
    </fieldset>
    <details>
      <summary>Existing board from an earlier collaboration setup?</summary>
      <p>Create a separate copy of its current text cards for this collaboration. The original board, history and signatures stay intact. This is a new board, not an authority migration. Boards containing images are currently refused because standalone image transfer is not ready.</p>
      <label><input type="checkbox" checked={copyConfirmed} onChange={event => setCopyConfirmed(event.target.checked)} />I authorize a new collaborative copy of the selected board’s current cards under this device’s authority.</label>
      <button disabled={!projectId || busy || !copyConfirmed} onClick={() => void run(async () => {
        await collaborationManager.stop(); const id = await boardCollaboration.createCopy(projectId!);
        onChanged(); await share(id);
      })}>Create collaborative copy</button>
    </details>
    {message && <p role="status">{message}</p>}
  </section>;
}

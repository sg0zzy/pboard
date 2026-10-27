import { IDENTITY_REFRESH_MS } from '../../collab/googleIdentitySharing';
import { useEffect, useRef, useState } from 'react';
import { BoardExistingSignedDataError } from "../../collab/authorityErrors";
import { boardCollaboration, collaborationManager } from '../../sync/browser';
import { repository } from '../../storage/browser';

/** Account-assisted enrollment; content still arrives only over WebRTC. */
export function GoogleBoardSharing({ projectId, onChanged }: { projectId: string | null; onChanged: () => void }) {
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [members, setMembers] = useState<{ email: string; role: string }[]>([]);
  const [boards, setBoards] = useState<{ boardId: string; ownerEmail: string; ready: boolean }[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncError, setSyncError] = useState('');
  const busyRef = useRef(false);
  const [hasAuthority, setHasAuthority] = useState(false);
  useEffect(() => {
    let active = true, running = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function sync() {
      if (running) return; running = true;
      try {
        const value = await boardCollaboration.identitySharing.sync(projectId ?? undefined);
        if (!active) return;
        const available = await Promise.all(value.boards.map(async e => ({
          boardId: e.publication.policy.boardId, ownerEmail: e.publication.policy.ownerEmail,
          ready: value.ready.includes(e.publication.policy.boardId), received: Boolean(await repository.getProject(e.publication.policy.boardId))
        })));
        if (!active) return;
        setEmail(value.email);
        const directoryFull = value.issues?.some(issue => issue.code === 'directory_capacity');
        const requestsFull = value.issues?.some(issue => issue.code === 'pending_capacity');
        setSyncError(directoryFull
          ? 'Live collaboration enrollment is limited: the rendezvous board directory is full. Existing boards and private Drive synchronization continue independently.'
          : requestsFull ? 'A board’s device request queue is full. Other boards and private Drive synchronization continue independently.' : '');
        setBoards(available.filter(board => !board.received));
        const list = projectId ? await boardCollaboration.identitySharing.collaborators(projectId) : [];
        const owns = projectId ? await boardCollaboration.ownsAuthority(projectId) : false;
        if (active) { setMembers(list); setHasAuthority(owns); }
      } catch (error) {
        if (active) {
          setBoards([]);
          setSyncError(error instanceof Error ? error.message : 'Account sharing unavailable');
          // A deterministic authority block does not clear by polling it; stop
          // the refresh loop and keep showing the diagnostic. Opening the
          // panel again, switching boards, or an explicit pairing retry
          // re-runs the effect.
          if (error instanceof BoardExistingSignedDataError) { clearInterval(timer); timer = undefined; window.removeEventListener('focus', refresh); }
        }
      }
      finally { running = false; }
    }
    const refresh = () => void sync();
    refresh(); timer = setInterval(refresh, IDENTITY_REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [projectId]);
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage('');
    try { await work(); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Account sharing failed'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const isOwner = hasAuthority && members.some(m => m.email === email && m.role === 'owner');
  async function openBoard(boardId: string) {
    const previous = await repository.getCurrentProject();
    try {
      await collaborationManager.start(boardId);
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        if (await repository.getProject(boardId)) { await repository.selectProject(boardId); return; }
        const state = collaborationManager.state();
        if (state.error) throw new Error(state.error);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('Device authorized, but board contents have not arrived. Ask the owner to open this board and keep it online, then retry Open shared board.');
    } catch (error) {
      // An unsuccessful navigation must not strand the previous board's live
      // session on the missing invitation. Never create an unsigned placeholder.
      const current = await repository.getCurrentProject();
      if (current?.id === previous?.id) {
        await collaborationManager.stop();
        if (current) await collaborationManager.start(current.id).catch(() => {});
      }
      throw error;
    }
  }
  const ownEmail = email.trim().toLowerCase();
  const mine = boards.filter(board => board.ownerEmail.toLowerCase() === ownEmail);
  const invited = boards.filter(board => board.ownerEmail.toLowerCase() !== ownEmail);
  return <section className="google-board-sharing">
    {mine.length > 0 && <aside className="own-board-inbox" aria-label="Your boards to restore">
      <strong>Your boards on this account</strong>
      <p>{mine.length} board{mine.length === 1 ? ' is' : 's are'} saved by this account. Connect Google Drive to restore {mine.length === 1 ? 'it' : 'them'} from the private Drive copy — no other browser needs to be open.</p>
      <ul>{mine.map(board => <li key={board.boardId}>
        <span title={board.boardId}>Your board · {board.boardId.slice(0, 8)}</span>
      </li>)}</ul>
    </aside>}
    {invited.length > 0 && <aside className="shared-board-inbox" aria-label="Shared board invitations">
      <strong>Shared boards available</strong>
      <p>{invited.length} shared board{invited.length === 1 ? '' : 's'}. Keep the owner’s Pboard open to connect.</p>
      <ul>{invited.map(board => <li key={board.boardId}>
        <span title={board.boardId}>From {board.ownerEmail} · {board.boardId.slice(0, 8)}</span>
        {board.ready
          ? <button disabled={busy} onClick={() => void run(() => openBoard(board.boardId))} aria-label={`Open shared board ${board.boardId}`}>Open board</button>
          : <span role="status">Waiting for owner…</span>}
      </li>)}</ul>
    </aside>}
    {message && <p role="status">{message}</p>}
    {syncError && <p role="status">{syncError}</p>}
    <details><summary>Google account sharing</summary>
    <fieldset disabled={busy}>
    <legend>Google account sharing</legend>
    <p>{email ? `Verified account: ${email}. Devices on this account request board grants automatically.` : 'Connect Google using the existing account button to discover your boards and invitations. Manual device pairing remains available below.'}</p>
    {isOwner && <>
      <label>Invite by email<input aria-label="WebRTC invite by email" type="email" value={invite} onChange={e => setInvite(e.target.value)} /></label>
      <label>Board access<select value={role} onChange={e => setRole(e.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
      <button disabled={!invite.trim()} onClick={() => void run(async () => { await boardCollaboration.identitySharing.invite(projectId!, invite, role); setInvite(''); setMembers(await boardCollaboration.identitySharing.collaborators(projectId!)); await collaborationManager.refreshRole(); })}>Share board with account</button>
      <ul>{members.map(m => <li key={m.email}>{m.email} — {m.role}{m.role !== 'owner' && <button onClick={() => void run(async () => { await boardCollaboration.identitySharing.remove(projectId!, m.email); setMembers(await boardCollaboration.identitySharing.collaborators(projectId!)); await collaborationManager.refreshRole(); })}>Remove {m.email}</button>}</li>)}</ul>
    </>}
    </fieldset></details>
  </section>;
}

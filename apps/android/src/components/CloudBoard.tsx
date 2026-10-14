import { useState } from 'react';
import type { AndroidSync } from '../sync/service';
export function CloudBoard({ service, state, projectId }: { service: AndroidSync | null; state?: ReturnType<AndroidSync['state']>; projectId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!service || !state?.connected) return null;
  return <section aria-label="Live collaboration" className="cloud-board">
    <p role="status">{state.resolving ? 'Connecting collaboration…' : `${state.role === 'private' ? 'Private board' : state.role + ' access'} · ${state.peers} live peers`}</p>
    {state.error && <p role="alert">{state.error}</p>}
    {(state.role === 'private' || state.role === 'owner') && !state.resolving && <details><summary>Share board</summary>
      <form onSubmit={event => {
        event.preventDefault(); setBusy(true); setMessage('');
        void service.invite(projectId, email.trim(), role).then(() => { setEmail(''); setMessage('Invitation sent.'); }, error => { setMessage(error instanceof Error ? error.message : String(error)); }).finally(() => setBusy(false));
      }}>
        <label>Email<input type="email" required value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
        <label>Access<select value={role} disabled={busy} onChange={event => setRole(event.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
        <button disabled={busy || state.busy}>Invite</button>
      </form>
      {message && <p role="status">{message}</p>}
    </details>}
  </section>;
}

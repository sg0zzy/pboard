import { useState } from 'react';
import type { AndroidSync } from '../sync/service';
import { MaterialIcon } from './MaterialIcon';

/**
 * Collaboration strip above the card list.
 *
 * The status line and the **Share board** control share one fixed row, and the
 * invitation form renders *below* that row rather than inside it: as a flex
 * child the open form used to squeeze the status text into a one-character
 * column. The button is present but disabled while the role is resolving, so
 * it never appears late and shifts the layout after connecting. Editors and
 * viewers cannot invite, so it is absent for them.
 */
export function CloudBoard({ service, state, projectId }: { service: AndroidSync | null; state?: ReturnType<AndroidSync['state']>; projectId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  if (!service || !state?.connected) return null;
  const canShare = state.role === 'private' || state.role === 'owner';
  const status = state.resolving
    ? 'Connecting collaboration…'
    : `${state.role === 'private' ? 'Private board' : `${state.role} access`} · ${state.peers} live ${state.peers === 1 ? 'peer' : 'peers'}`;
  return <section aria-label="Live collaboration" className="cloud-board">
    <div className="cloud-row">
      <p className="cloud-status" role="status">{status}</p>
      {(state.resolving || canShare) && <button type="button" className="cloud-share-button" aria-expanded={open}
        aria-disabled={state.resolving} disabled={state.resolving}
        onClick={() => { setOpen(value => !value); setMessage(''); }}>
        <MaterialIcon name="person-add" size={18} /><span>Share board</span>
      </button>}
    </div>
    {open && canShare && <form className="cloud-share-form" onSubmit={event => {
      event.preventDefault(); setBusy(true); setMessage('');
      void service.invite(projectId, email.trim(), role).then(() => { setEmail(''); setMessage('Invitation sent.'); }, error => { setMessage(error instanceof Error ? error.message : String(error)); }).finally(() => setBusy(false));
    }}>
      <label>Email<input type="email" required value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
      <label>Access<select value={role} disabled={busy} onChange={event => setRole(event.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
      <button disabled={busy || state.busy}><MaterialIcon name="share" size={18} />Invite</button>
    </form>}
    {message && <p role="status" className="cloud-message">{message}</p>}
    {state.error && <p role="alert">{state.error}</p>}
  </section>;
}

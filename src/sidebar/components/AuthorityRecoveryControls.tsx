import { useState } from 'react';
import { boardCollaboration, collaborationManager } from '../../sync/browser';
import { downloadBlob } from '../download';

type Preview = Awaited<ReturnType<typeof boardCollaboration.inspectRecovery>>;
/** Sensitive key material stays encrypted in a user-managed file, outside Drive. */
export function AuthorityRecoveryControls({ projectId, onChanged }: { projectId: string | null; onChanged: () => void }) {
  const [passphrase, setPassphrase] = useState(''), [raw, setRaw] = useState(''), [fingerprint, setFingerprint] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [devices, setDevices] = useState<string[]>([]), [emails, setEmails] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const reset = () => { setPreview(null); setConfirmed(false); setEmails([]); };
  const run = async (work: () => Promise<void>) => { setBusy(true); setMessage(''); try { await work(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Authority recovery failed. Original data is retained.'); } finally { setBusy(false); } };
  return <details><summary>Authority recovery file</summary>
    <p>The authority owner can save an encrypted recovery file before losing this device. Keep it offline and keep its passphrase separately. It contains the original signing authority; anyone with both can manage this board.</p>
    <label>Recovery passphrase<input type="password" autoComplete="new-password" value={passphrase} disabled={busy} onChange={e => { setPassphrase(e.target.value); reset(); }} /></label>
    <button disabled={busy || !projectId || passphrase.length < 16} onClick={() => void run(async () => {
      const encrypted = await boardCollaboration.exportAuthorityRecovery(projectId!, passphrase);
      downloadBlob(`pboard-authority-${projectId}.json`, new TextEncoder().encode(encrypted)); setPassphrase(''); setMessage('Encrypted recovery file saved. Keep its passphrase separately.');
    })}>Save encrypted authority recovery file</button>
    <label>Open a recovery file<input type="file" accept="application/json,.json" disabled={busy} onChange={e => {
      reset(); const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) { setMessage('Recovery file is too large'); return; }
      void file.text().then(text => setRaw(text)).catch(() => setMessage('Recovery file could not be read'));
    }} /></label>
    <label>Original authority fingerprint, verified independently<input value={fingerprint} disabled={busy} onChange={e => { setFingerprint(e.target.value); reset(); }} /></label>
    <button disabled={busy || !raw || passphrase.length < 16 || !fingerprint} onClick={() => void run(async () => {
      const value = await boardCollaboration.inspectRecovery(raw, passphrase, fingerprint.trim()); setPreview(value); setDevices(value.devices.map(d => d.deviceKeyId)); setConfirmed(false);
    })}>Decrypt and review recovery</button>
    {preview && <fieldset disabled={busy}>
      <legend>Review board {preview.boardId}</legend>
      <p>Recovery preserves the original authority and adds this device as an owner. Confirm every device below. A backup may omit later removals; reconstruct any missing permission changes before continuing. Email invitations are restored only when explicitly selected.</p>
      {preview.devices.map(device => <label key={device.deviceKeyId}><input type="checkbox" checked={devices.includes(device.deviceKeyId)} onChange={e => { setDevices(old => e.target.checked ? [...old, device.deviceKeyId] : old.filter(id => id !== device.deviceKeyId)); setConfirmed(false); }} />{device.deviceKeyId} ({device.role})</label>)}
      {preview.members.map((member: { email: string; role: string }) => <label key={member.email}><input type="checkbox" checked={emails.includes(member.email)} onChange={e => { setEmails(old => e.target.checked ? [...old, member.email] : old.filter(email => email !== member.email)); setConfirmed(false); }} />Restore invitation for {member.email} ({member.role})</label>)}
      <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I verified the original fingerprint and reviewed this membership as a new owner authorization.</label>
      <button disabled={!confirmed} onClick={() => void run(async () => {
        await collaborationManager.stop();
        const board = await boardCollaboration.restoreAuthority(raw, passphrase, fingerprint.trim(), preview.reviewedHash, devices, emails);
        setRaw(''); setPassphrase(''); reset(); setMessage('Original authority recovered. Board data restores independently from private Drive.'); onChanged();
        await collaborationManager.start(board);
      })}>Restore original authority with reviewed membership</button>
    </fieldset>}
    {message && <p role="status">{message}</p>}
  </details>;
}

import { AuthorityRecoveryControls } from "./AuthorityRecoveryControls";
import { GoogleBoardSharing } from "./GoogleBoardSharing";
import { BoardPairingControls } from "./BoardPairingControls";
import { useEffect, useState } from "react";
import { browser } from "../../platform/browser";
import { boardCollaboration, collaborationManager } from "../../sync/browser";
import { DEFAULT_RENDEZVOUS, rendezvousOrigin } from "../../collab/boardGrants";
import { repository } from "../../storage/browser";

/** Production opt-in; Drive persistence remains separately controlled. */
export function BoardCollaborationControls({ projectId, onChanged }: { projectId: string | null; onChanged: () => void }) {
  const [url, setUrl] = useState(DEFAULT_RENDEZVOUS);
  const [enabled, setEnabled] = useState(false);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [verified, setVerified] = useState(false);
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; void boardCollaboration.settings().then(value => { if (active) { setUrl(value.url); setEnabled(value.provider === "websocket"); } }).catch(() => { if (active) setMessage("Collaboration configuration could not be read"); }); return () => { active = false; }; }, []);
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setMessage("");
    try { const result = await work(); if (result && typeof result !== "string") setOutput(JSON.stringify(result, null, 2)); setMessage("Done. Output is below; it contains public authorization metadata only."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Collaboration operation failed"); }
    finally { setBusy(false); }
  }
  function enable() {
    // Native permission prompt must start synchronously in this click handler.
    try {
      const grant = browser.permissions.request({ origins: [rendezvousOrigin(url)] });
      void run(async () => {
        if (!await grant) throw new Error("Rendezvous permission was not granted");
        await collaborationManager.stop(); await boardCollaboration.configure({ provider: "websocket", url }); setEnabled(true); onChanged();
      });
    } catch { setMessage("Use a WSS service URL ending in /ws"); }
  }
  async function connect() {
    if (!verified) throw new Error("Verify the authority fingerprint first");
    await collaborationManager.stop();
    const board = await boardCollaboration.trust(input, fingerprint);
    await collaborationManager.start(board);
    // No unsigned placeholder is imported. The owner's signed project must
    // arrive over the authenticated DataChannel before it can be selected.
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (await repository.getProject(board)) { await repository.selectProject(board); onChanged(); return; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Grant saved. The board owner must open this board; then retry Connect approved board. No board contents are stored on the rendezvous server.");
  }
  return <>
    {enabled && <GoogleBoardSharing projectId={projectId} onChanged={onChanged} />}
    <details className="board-collaboration">
    <summary>WebRTC collaboration</summary>
    <p>Signaling: {enabled ? "WebSocket" : "Drive (default)"}. Drive persistence is controlled separately and can stay enabled.</p>
    <label>Rendezvous service<input type="url" value={url} onChange={event => setUrl(event.target.value)} disabled={busy || enabled} /></label>
    <p>With Google connected, this service verifies your account using a transient access token and automatically enrolls devices under owner-signed board invitations. It receives authorization metadata, never board contents.</p>
    <button disabled={busy || enabled} onClick={enable}>Enable WebSocket collaboration</button>
    {enabled && <>
      <p>Board access requires an owner-signed sharing policy and device grant. Google verifies identity only. Use Invite by email in Share project or Google account sharing for WebRTC invitations. Drive mode retains its existing sharing behavior. Enrollment and renewal require the original authority or an explicitly restored authority recovery file. Image transfer and account-order replication are not included in this standalone path yet.</p>
      <AuthorityRecoveryControls projectId={projectId} onChanged={onChanged} />
      <details><summary>Manual device pairing (Google service admission still required)</summary><BoardPairingControls projectId={projectId} onChanged={onChanged} /></details>
      <details><summary>Advanced: manual grants and device revocation</summary>
      <fieldset disabled={busy}>
        <legend>1. Board owner</legend>
        <label><input type="checkbox" checked={ownerConfirmed} onChange={e => setOwnerConfirmed(e.target.checked)} />I authorize this device to create a separate board authority for my local board. Existing collaboration trust will not be replaced.</label>
        <button disabled={!projectId || !ownerConfirmed} onClick={() => void run(async () => { await collaborationManager.stop(); const bundle = await boardCollaboration.initialize(projectId!); onChanged(); return bundle; })}>Create / renew board invitation</button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>2. Add another device</legend>
        <label>Paste an invitation, device request, or approved grant here<textarea aria-label="Board grant input" rows={5} value={input} onChange={e => { setInput(e.target.value); setVerified(false); }} /></label>
        <p>On the joining browser, paste the owner's invitation and create a device request. Send that request back to the owner.</p>
        <button onClick={() => void run(() => boardCollaboration.deviceRequest(input))}>Create my device request</button>
        <label>Fingerprint verified through a trusted channel<input value={fingerprint} onChange={e => { setFingerprint(e.target.value); setVerified(false); }} /></label>
        <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />I compared the deviceKeyId (owner approving) or authorityKeyId (joining device) with the other person/device through a trusted channel.</label>
        <label>Role to grant<select value={role} onChange={e => setRole(e.target.value as "editor" | "viewer")}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
        <button disabled={!verified} onClick={() => void run(async () => { await collaborationManager.stop(); const bundle = await boardCollaboration.approve(input, fingerprint, role); onChanged(); return bundle; })}>Owner: approve device request</button>
        <p>On the joining browser, paste the owner's approved grant, verify the authority fingerprint, then connect.</p>
        <button disabled={!verified} onClick={() => void run(connect)}>Connect approved board</button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Manage this board</legend>
        <button disabled={!projectId} onClick={() => void run(() => boardCollaboration.exportBundle(projectId!))}>Show current public grant</button>
        <label>Device fingerprint to revoke<input aria-label="Device to revoke" value={fingerprint} onChange={e => { setFingerprint(e.target.value); setVerified(false); }} /></label>
        <button disabled={!projectId || !verified} onClick={() => void run(async () => { await collaborationManager.stop(); const bundle = await boardCollaboration.revoke(projectId!, fingerprint); onChanged(); return bundle; })}>Owner: revoke verified device</button>
        <button onClick={() => void run(async () => { await collaborationManager.stop(); await boardCollaboration.configure({ provider: "drive", url }); setEnabled(false); onChanged(); })}>Use Drive signaling</button>
      </fieldset>
      </details>
    </>}
    {output && <label>Public output — copy and send to the other browser<textarea aria-label="Board grant output" readOnly rows={7} value={output} onFocus={e => e.target.select()} /></label>}
    {message && <p role="status">{message}</p>}
  </details></>;
}

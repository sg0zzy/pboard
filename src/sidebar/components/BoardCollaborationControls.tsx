import { AuthorityRecoveryControls } from "./AuthorityRecoveryControls";
import { GoogleBoardSharing } from "./GoogleBoardSharing";
import { BoardPairingControls } from "./BoardPairingControls";
import { BoardContentKeyControls } from "./BoardContentKeyControls";
import { BoardRetentionControls } from "./BoardRetentionControls";
import { BoardRelayHealControls } from "./BoardRelayHealControls";
import { webrtcDisabledForTesting } from "../../collab/liveTransport";
import { useEffect, useState } from "react";
import { browser } from "../../platform/browser";
import { accountChannel, boardCollaboration, collaborationManager } from "../../sync/browser";
import type { AccountRepinResult } from "../../sync/runtime";
import type { AccountChannelStatus } from "../../sync/operations/accountChannel";
import { DEFAULT_RENDEZVOUS, rendezvousOrigin } from "../../collab/boardGrants";
import { repository } from "../../storage/browser";

/** The collaboration manager serialises commands without a deadline, so a
 * command queued behind one waiting on a stalled WebRTC negotiation would
 * otherwise leave this panel disabled with no explanation. Waiting is bounded
 * here instead: the timeout does not cancel the outstanding command, it only
 * releases this panel and says what is still pending. */
const COMMAND_WINDOW_MS = 15_000;

function stopCollaboration(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The collaboration service has not answered an earlier command within ${Math.round(COMMAND_WINDOW_MS / 1000)}s. Nothing was sent to the rendezvous service; try again once it replies.`)), COMMAND_WINDOW_MS);
    void collaborationManager.stop().then(
      () => { clearTimeout(timer); resolve(); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * The account room's state, and the one explicit action that can leave a
 * `foreign` dead end.
 *
 * The automatic bootstrap is deliberately fail-closed: when the manifest in
 * Drive is signed by an authority other than the pinned one it reports
 * `failed` and moves nothing, because anyone who can write this account's
 * `appDataFolder` could otherwise become the account's authority. That leaves a
 * browser whose pin is simply stale with a channel that can never start. This
 * section is the only place that override exists, it only appears in the state
 * it is for, and it says what it costs before the click: the pin moves, the
 * move is one-way from this panel, and the account room still cannot open
 * unless this browser happens to hold the new authority's private key.
 */
function AccountChannelControls({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<AccountChannelStatus | null>(null);
  const [outcome, setOutcome] = useState<AccountRepinResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const read = () => { if (active) { try { setStatus(accountChannel.status()); } catch { /* a panel never breaks on a read */ } } };
    read();
    // Subscribed rather than polled: the channel announces on every status
    // change, including one another context of this profile caused.
    const unsubscribe = accountChannel.subscribe(read);
    return () => { active = false; unsubscribe(); };
  }, []);
  const stale = status?.state === "absent-pin" && /foreign|different authority|does not match|signed by/i
    .test(`${status.reason} ${status.authority?.reason ?? ""}`);
  // The outcome stays on screen after the pass even though the state it was
  // offered in has gone: the consequence (this browser can or cannot renew) is
  // the whole point of pressing the button, and hiding it the moment the channel
  // moved would hide the answer.
  if (!stale && !outcome) return null;
  async function repin() {
    setBusy(true); setMessage("");
    try {
      const result = await accountChannel.repinPublishedAuthority();
      setOutcome(result);
      setStatus(accountChannel.status());
      onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Account re-pin failed and nothing was changed"); }
    finally { setBusy(false); }
  }
  return <fieldset className="account-channel-foreign">
    <legend>{stale ? "Account room: the published authorization is not this browser's authority" : "Account room: re-pin result"}</legend>
    {stale && <>
      <p>The account authority pinned in this browser does not match the authorization published in your Google Drive. Until they agree the account room cannot open, so boards this browser creates are announced only through Drive. Nothing has been changed automatically.</p>
      <p>Re-pinning trusts the authorization <em>currently published in your Drive</em>. That file lives in this account's private app data, so whoever can write it would become the account’s authority; only do this if you know why the published authorization changed. It is one-way from this panel: the previous pin is replaced, not merged.</p>
      {status?.authority?.reason && <p role="note">{status.authority.reason}</p>}
      <p>{status.outbox} queued account record{status.outbox === 1 ? "" : "s"} {status.outbox === 1 ? "is" : "are"} waiting; re-pinning does not drop them, and they flush once the room opens.</p>
      <button disabled={busy} onClick={() => void repin()}>Trust the published account authorization</button>
    </>}
    {message && <p role="status">{message}</p>}
    {outcome && <div role="status">
      <p>Re-pinned. This browser now trusts the account authority beginning <code>{outcome.authorityKeyId.slice(0, 12)}</code>
        {outcome.previousAuthorityKeyId ? <> (was <code>{outcome.previousAuthorityKeyId.slice(0, 12)}</code>)</> : null}.
        {outcome.unchanged ? " It was already the pinned authority, so nothing was rewritten." : ""}</p>
      <p>Account room: {outcome.channelState}{outcome.channelReason ? ` — ${outcome.channelReason}` : ""}.</p>
      <p>{outcome.canRenew
        ? "This browser holds the new authority's private key, so it can renew the account authorization."
        : "This browser does not hold the new authority's private key, so it is reported as authority-not-local: it can never renew the account authorization, and it can read and write the account room only after the browser that holds that key grants it the room's content key. Renewal must come from that browser, or from another re-pin after a new authorization is published."}</p>
      <p>{outcome.queuedBefore} queued record{outcome.queuedBefore === 1 ? "" : "s"} were waiting; {outcome.outbox === 0
        ? "they have been flushed."
        : `${outcome.outbox} still queued — they flush when the room opens.`}</p>
    </div>}
  </fieldset>;
}

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
        await stopCollaboration(); await boardCollaboration.configure({ provider: "websocket", url }); setEnabled(true); onChanged();
      });
    } catch { setMessage("Use a WSS service URL ending in /ws"); }
  }
  async function connect() {
    if (!verified) throw new Error("Verify the authority fingerprint first");
    await stopCollaboration();
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
      <AccountChannelControls onChanged={onChanged} />
      <p>Board access requires an owner-signed sharing policy and device grant. Google verifies identity only. Use Invite by email in Share project or Google account sharing for WebRTC invitations. Drive mode retains its existing sharing behavior. Enrollment and renewal require the original authority or an explicitly restored authority recovery file. Image transfer and account-order replication are not included in this standalone path yet.</p>
      <AuthorityRecoveryControls projectId={projectId} onChanged={onChanged} />
      {projectId && <BoardRelayHealControls key={projectId} projectId={projectId} />}
      {enabled && webrtcDisabledForTesting() && projectId && <BoardContentKeyControls key={projectId} projectId={projectId} onChanged={onChanged} />}
      <details><summary>Manual device pairing (Google service admission still required)</summary><BoardPairingControls projectId={projectId} onChanged={onChanged} /></details>
      <details><summary>Advanced: manual grants and device revocation</summary>
      <fieldset disabled={busy}>
        <legend>1. Board owner</legend>
        <label><input type="checkbox" checked={ownerConfirmed} onChange={e => setOwnerConfirmed(e.target.checked)} />I authorize this device to create a separate board authority for my local board. Existing collaboration trust will not be replaced.</label>
        <button disabled={!projectId || !ownerConfirmed} onClick={() => void run(async () => { await stopCollaboration(); const bundle = await boardCollaboration.initialize(projectId!); onChanged(); return bundle; })}>Create / renew board invitation</button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>2. Add another device</legend>
        <label>Paste an invitation, device request, or approved grant here<textarea aria-label="Board grant input" rows={5} value={input} onChange={e => { setInput(e.target.value); setVerified(false); }} /></label>
        <p>On the joining browser, paste the owner's invitation and create a device request. Send that request back to the owner.</p>
        <button onClick={() => void run(() => boardCollaboration.deviceRequest(input))}>Create my device request</button>
        <label>Fingerprint verified through a trusted channel<input value={fingerprint} onChange={e => { setFingerprint(e.target.value); setVerified(false); }} /></label>
        <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />I compared the deviceKeyId (owner approving) or authorityKeyId (joining device) with the other person/device through a trusted channel.</label>
        <label>Role to grant<select value={role} onChange={e => setRole(e.target.value as "editor" | "viewer")}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
        <button disabled={!verified} onClick={() => void run(async () => { await stopCollaboration(); const bundle = await boardCollaboration.approve(input, fingerprint, role); onChanged(); return bundle; })}>Owner: approve device request</button>
        <p>On the joining browser, paste the owner's approved grant, verify the authority fingerprint, then connect.</p>
        <button disabled={!verified} onClick={() => void run(connect)}>Connect approved board</button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Manage this board</legend>
        <button disabled={!projectId} onClick={() => void run(() => boardCollaboration.exportBundle(projectId!))}>Show current public grant</button>
        <label>Device fingerprint to revoke<input aria-label="Device to revoke" value={fingerprint} onChange={e => { setFingerprint(e.target.value); setVerified(false); }} /></label>
        <button disabled={!projectId || !verified} onClick={() => void run(async () => { await stopCollaboration(); const bundle = await boardCollaboration.revoke(projectId!, fingerprint); onChanged(); return bundle; })}>Owner: revoke verified device</button>
        <button onClick={() => void run(async () => { await stopCollaboration(); await boardCollaboration.configure({ provider: "drive", url }); setEnabled(false); onChanged(); })}>Use Drive signaling</button>
      </fieldset>
      </details>
    </>}
    {projectId && <BoardRetentionControls key={projectId} projectId={projectId} />}
    {output && <label>Public output — copy and send to the other browser<textarea aria-label="Board grant output" readOnly rows={7} value={output} onFocus={e => e.target.select()} /></label>}
    {message && <p role="status">{message}</p>}
  </details></>;
}

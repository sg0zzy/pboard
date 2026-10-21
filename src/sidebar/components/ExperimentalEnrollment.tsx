import { useEffect, useState } from "react";
import { collaborationDiagnostics } from "../../collab/diagnostics";
import { googleBrokerEnabled, googleBrokerPermissionOrigin } from "../../collab/googleBrokerEnrollment";
import { browser } from "../../platform/browser";
import { experimentalEnrollment, collaborationManager } from "../../sync/browser";
import { downloadBlob } from "../download";

/** Only rendered in the explicit local experimental extension build. */
export function ExperimentalEnrollment({ projectId, onChanged }: { projectId: string | null; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(collaborationDiagnostics.snapshot);
  useEffect(() => collaborationDiagnostics.subscribe(() => setDiagnostics(collaborationDiagnostics.snapshot())), []);
  if (!experimentalEnrollment) return null;
  const enrollment = experimentalEnrollment;
  const broker = googleBrokerEnabled();
  function connectGoogle() {
    setBusy(true); setMessage("");
    try {
      // Invoke immediately in the click handler: Firefox requires a user gesture.
      const request = browser.permissions.request({ origins: [googleBrokerPermissionOrigin()] });
      void request.then((granted: boolean) => {
        if (granted) onChanged();
        else setMessage("Signaling service access was not granted. Allow access to this service to connect live collaboration.");
      }).catch(() => setMessage("Browser permission could not be requested. Enable signaling service access in the extension's Permissions settings, then reconnect."))
        .finally(() => setBusy(false));
    } catch { setBusy(false); setMessage("The experimental signaling endpoint is not configured correctly."); }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setMessage("");
    try {
      await collaborationManager.stop();
      const result = await action();
      if (result) setText(JSON.stringify(result, null, 2));
      setMessage("Enrollment updated. Start live collaboration: relay authorization is automatic, with no server grant upload. Authorizations last five minutes.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }
  async function save(name: string, value: unknown) { downloadBlob(name, new TextEncoder().encode(JSON.stringify(value, null, 2))); }
  return <details className="share-note">
    <summary>Experimental device enrollment</summary>
    {broker ? <>
      <p>Google-verified private experiment. Share the board through Drive, then connect the owner's browser first. Other authorized browsers connect automatically; no JSON exchange is needed.</p>
      <p>The experimental service temporarily receives your current Google access token to verify your account and board permissions. Tokens and board contents are not stored there.</p>
      <button disabled={!projectId || busy} onClick={connectGoogle}>Connect / reconnect with Google</button>
    </> : <p>Experimental collaboration. Share boards through Drive first. Verify device and authority fingerprints through a separate trusted channel. Existing board data is attested only by an approved owner. Enrolled devices authorize with the relay automatically; no SSH grant upload is needed.</p>}
    {!broker && <fieldset disabled={busy}>
      <button onClick={() => void run(() => enrollment.initialize("account"))}>Initialize / renew my account</button>
      <button disabled={!projectId} onClick={() => void run(() => enrollment.initialize("board", projectId!))}>Initialize / renew board authority</button>
      <button onClick={() => void run(() => enrollment.request("account"))}>My account device request</button>
      <button disabled={!projectId} onClick={() => void run(() => enrollment.request("board", projectId!))}>My board device request</button>
      <p>The request's deviceKeyId and the bundle's authorityKeyId are public fingerprints.</p>
      <label>Load public request / bundle JSON<input type="file" accept="application/json,.json" onChange={event => {
        const file = event.target.files?.[0];
        if (file) void file.text().then(value => { setText(value); setVerified(false); }).catch(error => setMessage(String(error)));
      }} /></label>
      <label>Public request or enrollment bundle<textarea aria-label="Public enrollment JSON" rows={8} value={text} onChange={e => { setText(e.target.value); setVerified(false); }} /></label>
      <input aria-label="Independently verified fingerprint" placeholder="Fingerprint verified with the other device" value={fingerprint} onChange={e => { setFingerprint(e.target.value); setVerified(false); }} />
      <input type="email" aria-label="Independently verified Google email" placeholder="Google email verified with requesting device" value={verifiedEmail} onChange={e => { setVerifiedEmail(e.target.value); setVerified(false); }} />
      <label><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />I verified the fingerprint and, for a device request, its Google email through a separate trusted channel.</label>
      <button disabled={!verified} onClick={() => void run(() => enrollment.approve(text, fingerprint, verifiedEmail))}>Owner: approve device request</button>
      <button disabled={!verified} onClick={() => void run(async () => { await enrollment.trust(text, fingerprint); })}>Trust authority bundle</button>
      <button onClick={() => {
        void (async () => {
          const value = JSON.parse(text);
          if ((!value.payload?.deviceKeyId && value.format !== "pboard-enrollment-v1") || /"d"\s*:/.test(text)) throw new Error("Only public enrollment requests/bundles can be exported");
          await save("pboard-public-enrollment.json", value);
        })().catch(error => setMessage(String(error)));
      }}>Download public JSON</button>
      <button disabled={!projectId} onClick={() => void run(async () => { await save("grants.local.json", await enrollment.grants(projectId!)); })}>Export legacy relay grants (optional)</button>
      <button disabled={!projectId} onClick={() => { onChanged(); }}>Start / restart live collaboration</button>
    </fieldset>}
    {message && <p role="status">{message}</p>}
    <details><summary>Live collaboration diagnostics ({diagnostics.length})</summary>
      <p>Local events only. Session prefixes match the server logs. No board contents, SDP, ICE addresses or Google credentials are logged.</p>
      <button onClick={() => collaborationDiagnostics.clear()}>Clear diagnostics</button>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{diagnostics.map(entry => JSON.stringify(entry)).join("\n") || "No connection events yet. Start live collaboration."}</pre>
    </details>
  </details>;
}

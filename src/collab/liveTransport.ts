/**
 * Development transport posture.
 *
 * Pboard has two live transports: ephemeral WebRTC peer pools signalled through
 * Drive, and the durable operation log over the authenticated WebSocket. While
 * the log is being evaluated the peer pools can be switched off, so a board
 * either attaches to the log or has no live channel at all and converges through
 * Drive synchronization.
 *
 * The default here is the supported production posture — WebRTC available — and
 * the application's composition root (`src/sync/browser.ts`) opts into the
 * testing posture. That direction is deliberate: a call site that forgets to
 * configure anything gets the behaviour that ships, and the automated suite,
 * which never loads the composition root, keeps testing real peer pools.
 *
 * Two consequences of the disabled posture are expected, not defects:
 *
 *  - A board with no grant or no content key gets no live transport. It stays
 *    correct — Drive is the durable path — but edits reach the other device at
 *    the next synchronization rather than immediately.
 *  - Buffer content keys used to reach a second device only through the
 *    authenticated peer channel. With the pools off, the key courier carries
 *    it instead: a writer's key is wrapped to the account's other devices
 *    over the authenticated relay, with no manual step. The board's content
 *    key control stays as the manual fallback — it is the only path that
 *    works against a relay that does not have the courier yet. Revoking a
 *    departed device's access to *future* keys is not solved by the courier,
 *    and content-key rotation remains a separate decision.
 */
let webrtcDisabled = false;

/** Whether this process must not open WebRTC peer pools. */
export function webrtcDisabledForTesting(): boolean {
  return webrtcDisabled;
}

/** Called once by the application entry point, and by tests that need either
 * posture. `true` means WebRTC peer pools are switched off in this process. */
export function setWebRtcDisabled(disabled: boolean): void {
  webrtcDisabled = disabled;
}

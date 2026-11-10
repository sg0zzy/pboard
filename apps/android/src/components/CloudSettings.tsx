import type { AndroidSync } from '../sync/service';
import { DriveFolderGardening } from '../../../../src/sidebar/components/DriveFolderGardening';
export function CloudSettings({ service, state }: { service: AndroidSync | null; state?: ReturnType<AndroidSync['state']> }) {
  if (!service || !state) return <p>Google Drive is available in the installed Android app.</p>;
  return <section aria-label="Google Drive">
    <h2>Google Drive</h2>
    <p>{state.connected ? 'Connected. Boards and photos sync while the app is open.' : 'Connect to back up existing local boards privately to the selected Google account and discover shared boards.'}</p>
    <div className="form-actions">
      <button disabled={state.busy} onClick={() => { void service.connect(); }}>{state.connected ? 'Reconnect' : 'Connect Google Drive'}</button>
      {state.connected && <><button disabled={state.busy} onClick={() => { void service.authorizePrivatePersistence().then(() => service.sync()).catch(console.error); }}>Sync now</button><button disabled={state.busy} onClick={() => { void service.disconnect().catch(console.error); }}>Disconnect</button></>}
    </div>
    {state.busy && <p role="status">Syncing…</p>}
    {state.lastSynced && <p>Last synced: {state.lastSynced}</p>}
    {state.connected && (() => {
      const channel = service.accountStatus();
      const cause = channel.reason || channel.error || '';
      const authority = channel.authority ? ` · authority ${channel.authority.state}${channel.authority.reason ? `: ${channel.authority.reason}` : ''}` : '';
      return <p>Account sync: {channel.state}{cause ? ` — ${cause}` : ''}{authority}</p>;
    })()}
    {state.connected && <DriveFolderGardening gardener={service.driveFolderGardener} />}
    {state.error && <p role="alert">{state.error}</p>}
  </section>;
}

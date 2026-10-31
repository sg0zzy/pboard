import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "../../platform/browser";
import { clearDriveSyncError, driveSyncState, googleAuth, googleDrive, authorizePrivatePersistence } from "../../sync/browser";
import { requestDriveErrorClear, requestDriveReconciliation, requestProjectSync } from "../../sync/client";
import {
  DRIVE_AUTH_STORAGE_KEY,
  projectSyncStorageKey,
  type DriveProjectSyncState
} from "../../sync/state";
import { ChevronDownIcon, ChevronUpIcon, CloudIcon, CloseIcon, SyncIcon } from "../components/icons";

type Props = { projectId: string | null; onConnectionChanged?: () => void };

export function DriveSyncControls({ projectId, onConnectionChanged }: Props) {
  const [connected, setConnected] = useState(false);
  const [syncState, setSyncState] = useState<DriveProjectSyncState | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [syncingProjects, setSyncingProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [syncFeedback, setSyncFeedback] = useState('');
  const syncing = useRef(new Set<string>()), selectedProject = useRef(projectId);
  const refreshGeneration = useRef(0);
  const syncBusy = projectId !== null && syncingProjects.has(projectId);
  selectedProject.current = projectId;
  useEffect(() => { setLocalError(''); setSyncFeedback(''); }, [projectId]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const isConnected = await googleDrive.getConnectionState() === "connected";
    const state = projectId ? await driveSyncState.get(projectId) : null;
    if (generation !== refreshGeneration.current || selectedProject.current !== projectId) return;
    setConnected(isConnected);
    setSyncState(state);
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const projectKey = projectId ? projectSyncStorageKey(projectId) : null;
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area !== "local") return;
      if (DRIVE_AUTH_STORAGE_KEY in changes || (projectKey && projectKey in changes)) void refresh();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [projectId, refresh]);

  async function connect() {
    setAuthBusy(true);
    setLocalError("");
    try {
      await googleAuth.connect();
      await authorizePrivatePersistence();
      onConnectionChanged?.();
      await refresh();
      void requestDriveReconciliation();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Google Drive connection failed");
    } finally {
      setAuthBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Google Drive? Local pboard data will remain available.")) return;
    setAuthBusy(true);
    setLocalError("");
    await googleAuth.disconnect();
    onConnectionChanged?.();
    await refresh();
    setAuthBusy(false);
  }

  async function syncNow() {
    if (!projectId || syncing.current.has(projectId)) return;
    syncing.current.add(projectId); setSyncingProjects(new Set(syncing.current));
    setLocalError(""); setSyncFeedback('');
    try {
      await authorizePrivatePersistence(projectId);
      const result = await requestProjectSync(projectId);
      // An explicit sync is the moment the user expects everything Drive has:
      // reconcile now, so boards other accounts shared surface immediately
      // instead of on the sidebar's next discovery tick. Fire-and-forget;
      // the reactive project list picks up any import.
      void requestDriveReconciliation();
      if (selectedProject.current !== projectId) return;
      if (!result.ok) setLocalError(result.reason ?? "Google Drive sync failed");
      else setSyncFeedback(result.pending ? 'Saved locally; Drive synchronization is still pending.' : 'Sync OK');
      await refresh();
    } catch (error) { if (selectedProject.current === projectId) setLocalError(error instanceof Error ? error.message : "Google Drive sync failed"); }
    finally { syncing.current.delete(projectId); setSyncingProjects(new Set(syncing.current)); }
  }

  /**
   * Dismiss the failure notice in both contexts that can hold one, without
   * spending a Drive request. The board stays pending, so the next attempt is a
   * real one and reports the failure again if Google still refuses — which is
   * how a one-off rate window is told apart from a limit that is really spent.
   */
  async function clearError() {
    if (!projectId) return;
    setLocalError("");
    setSyncFeedback("");
    await clearDriveSyncError(projectId);
    const result = await requestDriveErrorClear(projectId);
    if (selectedProject.current !== projectId) return;
    setSyncFeedback(result.ok
      ? "Error cleared. The next sync asks Drive again and reports the failure if it happens again."
      : result.reason || "The Drive error could not be cleared.");
    await refresh();
  }

  if (!connected) {
    const configured = googleAuth.isConfigured();
    return (
      <div className="drive-controls drive-controls--disconnected">
        <button
          type="button"
          className={`drive-connect-button${localError ? " error" : ""}`}
          disabled={authBusy || !configured}
          title={localError || (configured ? "Connect pboard to Google Drive" : "Set a Google Drive OAuth client ID to enable sync")}
          onClick={() => void connect()}
        >
          <CloudIcon />
          <span>{authBusy ? "Connecting…" : "Connect Drive"}</span>
        </button>
        <span className="drive-connect-disclosure">Connect to back up existing local boards privately to the selected Google account.</span>
        <span className="visually-hidden" role="status">{localError}</span>
      </div>
    );
  }

  const currentState = syncState?.projectId === projectId ? syncState : null;
  const status = currentState?.status ?? "synced";
  const statusText = syncBusy ? 'Syncing project to Google Drive' : localError || currentState?.error || (
    status === "syncing" ? "Syncing project to Google Drive" :
    status === "pending" ? "Local changes pending Google Drive sync" :
    status === "error" ? "Google Drive sync failed" :
    "Google Drive connected and synced"
  );

  return (
    <div className="drive-controls">
      <button
        type="button"
        className={`drive-icon-button drive-status drive-status--${localError ? "error" : status}`}
        aria-label={`${statusText}. Disconnect Google Drive`}
        title={`${statusText}. Click to disconnect.`}
        disabled={authBusy}
        onClick={() => void disconnect()}
      ><CloudIcon /></button>
      <button
        type="button"
        className={`drive-icon-button drive-sync-button${syncBusy || status === "syncing" ? " syncing" : ""}`}
        aria-label="Sync current project to Google Drive now"
        title={syncBusy ? 'Syncing project to Google Drive…' : "Sync current project to Google Drive now"}
        disabled={!projectId || syncBusy || authBusy}
        onClick={() => void syncNow()}
      ><SyncIcon /></button>
      {(currentState?.error || localError) && <button
        type="button"
        className="drive-icon-button"
        aria-label="Clear the Drive error message"
        title="Clear this Drive error and stop holding the local retry delay, so the next sync is a real request. The board stays pending, so the message returns if Drive refuses again."
        disabled={authBusy}
        onClick={() => void clearError()}
      ><CloseIcon /></button>}
      {(syncBusy || localError || syncFeedback) && <span className="drive-sync-feedback" role="status">{syncBusy ? 'Syncing…' : localError || syncFeedback}</span>}
      <span className="visually-hidden" role="status">{statusText}</span>
    </div>
  );
}

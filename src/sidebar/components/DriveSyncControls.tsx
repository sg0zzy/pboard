import { useCallback, useEffect, useState } from "react";
import { browser } from "../../platform/browser";
import { driveSyncState, googleAuth, googleDrive } from "../../sync/browser";
import { requestDriveReconciliation, requestProjectSync } from "../../sync/client";
import {
  DRIVE_AUTH_STORAGE_KEY,
  projectSyncStorageKey,
  type DriveProjectSyncState
} from "../../sync/state";
import { ChevronDownIcon, ChevronUpIcon, CloudIcon, SyncIcon } from "../components/icons";

type Props = { projectId: string | null; onConnectionChanged?: () => void };

export function DriveSyncControls({ projectId, onConnectionChanged }: Props) {
  const [connected, setConnected] = useState(false);
  const [syncState, setSyncState] = useState<DriveProjectSyncState | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  const refresh = useCallback(async () => {
    setConnected(await googleDrive.getConnectionState() === "connected");
    setSyncState(projectId ? await driveSyncState.get(projectId) : null);
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
    if (!projectId || !syncState?.dirty) return;
    setLocalError("");
    const result = await requestProjectSync(projectId);
    if (!result.ok) setLocalError(result.reason ?? "Google Drive sync failed");
  }

  if (!connected) {
    const configured = googleAuth.isConfigured();
    return (
      <div className="drive-controls">
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
        <span className="visually-hidden" role="status">{localError}</span>
      </div>
    );
  }

  const status = syncState?.status ?? "synced";
  const statusText = localError || syncState?.error || (
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
        className={`drive-icon-button drive-sync-button${status === "syncing" ? " syncing" : ""}`}
        aria-label="Sync current project to Google Drive now"
        title={syncState?.dirty ? "Sync current project to Google Drive now" : "Current project is already synced"}
        disabled={!projectId || !syncState?.dirty || status === "syncing"}
        onClick={() => void syncNow()}
      ><SyncIcon /></button>
      <span className="visually-hidden" role="status">{statusText}</span>
    </div>
  );
}

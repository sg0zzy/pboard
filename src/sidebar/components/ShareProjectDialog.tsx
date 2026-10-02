import { useCallback, useEffect, useState } from "react";
import { browser } from "../../platform/browser";
import { googleDrive, drivePermissions } from "../../sync/browser";
import { DRIVE_AUTH_STORAGE_KEY } from "../../sync/state";
import type { Collaborator, PboardCollaboratorRole } from "../../sync/drivePermissions";

type Props = {
  projectId: string;
  projectName: string;
  onClose: () => void;
};

export function ShareProjectDialog({ projectId, projectName, onClose }: Props) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [projectFileId, setProjectFileId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<PboardCollaboratorRole>("editor");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [list, fileId] = await Promise.all([
        drivePermissions.listCollaborators(projectId),
        drivePermissions.projectFileId(projectId),
      ]);
      setCollaborators(list);
      setProjectFileId(fileId);
    } catch {
      setError("Could not load collaborators.");
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const refreshConnection = async () => {
      const state = await googleDrive
        .getConnectionState()
        .catch(() => "disconnected" as const);
      setConnected(state === "connected");
    };
    void refreshConnection();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && DRIVE_AUTH_STORAGE_KEY in changes) {
        void refreshConnection();
        void refresh();
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function invite() {
    if (!connected || !projectId || !email.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await drivePermissions.invite(projectId, email, inviteRole);
      setEmail("");
      setInviteRole("editor");
      setNotice("Invited.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed.");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function updateCollabRole(email: string, role: PboardCollaboratorRole) {
    setCollaborators((prev) => prev.map((c) => (c.email === email ? { ...c, role } : c)));
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await drivePermissions.updateRole(projectId, email, role);
      setNotice("Role updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role update failed.");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function removeCollab(email: string) {
    if (!window.confirm(`Remove ${email} as a collaborator?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await drivePermissions.removeCollaborator(projectId, email);
      setNotice("Removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed.");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const isOwner = (collaborator: Collaborator) => collaborator.role === "owner";

  return (
    <div className="share-dialog" role="dialog" aria-label={`Share ${projectName}`}>
      <div className="share-dialog-head">
        <div>
          <h2>Share project</h2>
          <p className="share-sub">{projectName}</p>
        </div>
        <button className="share-close" type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <section className="share-section">
        <h3>Invite collaborators</h3>
        {!connected ? (
          <p className="share-hint">Connect Drive to share this project.</p>
        ) : (
          <form
            className="share-form"
            onSubmit={(event) => { event.preventDefault(); void invite(); }}
          >
            <div className="share-form-row">
              <input
                type="email"
                placeholder="collaborator@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              />
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as PboardCollaboratorRole)}
                disabled={busy}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            </div>
            <div className="share-form-row">
              <button
                type="submit"
                className="text-button"
                disabled={busy || !email.trim()}
              >
                {busy ? "Inviting…" : "Invite"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="share-section">
        <h3>Collaborators</h3>
        {projectFileId === null ? (
          <p className="share-hint">Not shared yet. Invite someone to make it a shared project.</p>
        ) : collaborators.length === 0 ? (
          <p className="share-hint">No collaborators yet.</p>
        ) : (
          <ul className="collab-list">
            {collaborators.map((collaborator) => (
              <li className="collab-row" key={collaborator.email}>
                <span className="collab-name">
                  {collaborator.name ? collaborator.name : collaborator.email}
                  <small>{collaborator.email}</small>
                </span>
                {isOwner(collaborator) ? (
                  <span className="collab-owner">Owner</span>
                ) : (
                  <select
                    value={collaborator.role}
                    disabled={busy}
                    onChange={(event) =>
                      void updateCollabRole(collaborator.email, event.target.value as PboardCollaboratorRole)
                    }
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                )}
                {!isOwner(collaborator) && (
                  <button
                    className="collab-remove"
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${collaborator.email}`}
                    onClick={() => void removeCollab(collaborator.email)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p
        className={`share-status ${error ? "error" : notice ? "ok" : "empty"}`}
        aria-live="polite"
      >
        {error || notice || ""}
      </p>
    </div>
  );
}

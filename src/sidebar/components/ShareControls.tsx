import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Collaborator, DrivePermissionService, PboardRole } from "../../sync/drivePermissions";
import { CloseIcon, PeopleIcon } from "./icons";

type Props = {
  projectId: string | null;
  /** The Drive permission service (injected so the component is independently testable). */
  permissions: DrivePermissionService;
  onAccessChanged?: () => void;
  liveStatus?: string;
};

/**
 * Share button + "Share Project" dialog. The button sits left of the Drive
 * cloud icon; the dialog has an Invite section and a Collaborators list that
 * drive the Google Drive permission service. The owner cannot be removed or
 * downgraded; a viewer (no write role) sees collaborators read-only.
 */
export function ShareControls({ projectId, permissions, onAccessChanged, liveStatus }: Props) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [myRole, setMyRole] = useState<PboardRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [privateProject, setPrivateProject] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [mine, list, fileId] = await Promise.all([
      permissions.myRole(projectId),
      permissions.listCollaborators(projectId),
      permissions.projectFileId(projectId)
    ]);
    setMyRole(mine);
    setCollaborators(list);
    setPrivateProject(fileId === null);
    setLoadedProjectId(projectId);
  }, [projectId, permissions]);

  useEffect(() => {
    if (!open || !projectId) return;
    let active = true;
    setLoadedProjectId(null);
    setMyRole(null);
    setCollaborators([]);
    setError("");
    void Promise.all([
      permissions.myRole(projectId), permissions.listCollaborators(projectId), permissions.projectFileId(projectId)
    ]).then(([mine, list, fileId]) => {
      if (!active) return;
      setMyRole(mine);
      setCollaborators(list);
      setPrivateProject(fileId === null);
      setLoadedProjectId(projectId);
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : "Could not check project access");
    });
    return () => { active = false; };
  }, [open, projectId, load]);

  const loaded = projectId !== null && loadedProjectId === projectId;
  const canManage = loaded && (myRole === "owner" || myRole === "editor" || (privateProject && myRole === null));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      onAccessChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !email.trim()) return;
    await run(async () => {
      await permissions.invite(projectId, email, role);
      setEmail("");
    });
  }

  if (!projectId) return null;

  return (
    <>
      <button
        type="button"
        className="drive-icon-button share-button"
        aria-label="Share this project"
        title="Share this project"
        onClick={() => setOpen(true)}
      >
        <PeopleIcon />
      </button>
      {open && (
        <div
          className="share-dialog"
          role="dialog"
          aria-label="Share project"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <div className="share-dialog-head">
            <strong>Share project</strong>
            <button type="button" className="text-button" aria-label="Close share dialog" onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>

          {liveStatus && <p className="share-note" role="status">{liveStatus}</p>}
          {loaded && privateProject && myRole === null && (
            <button type="button" className="text-button" disabled={busy} onClick={() => {
              void run(async () => { await permissions.ensureSharedProject(projectId); });
            }}>
              Enable live collaboration
            </button>
          )}

          {canManage ? (
            <form className="share-invite" onSubmit={(event) => void invite(event)}>
              <label>
                <span>Invite by email</span>
                <input
                  type="email"
                  value={email}
                  placeholder="name@example.com"
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                <span>Role</span>
                <select value={role} onChange={(event) => setRole(event.target.value as "viewer" | "editor")} disabled={busy}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
              </label>
              <button type="submit" className="share-invite-button" disabled={busy || !email.trim()}>
                Invite
              </button>
            </form>
          ) : (
            <p className="share-note">{error ? "Could not check project access. Check your Google Drive connection and reopen this dialog."
              : !loaded ? "Checking project access…"
              : myRole === "viewer" ? "You are a viewer and cannot change who can access this project."
              : "Your access to this shared project could not be verified."}</p>
          )}

          <ul className="share-collaborators">
            {collaborators.map((collaborator) => (
              <li key={collaborator.email} className="share-collaborator">
                <span className="share-collaborator-name" title={collaborator.email}>
                  {collaborator.name || collaborator.email}
                </span>
                {collaborator.role === "owner" ? (
                  <span className="share-collaborator-role">Owner</span>
                ) : (
                  <select
                    className="share-role-select"
                    value={collaborator.role}
                    disabled={busy || !canManage}
                    aria-label={`Role for ${collaborator.email}`}
                    onChange={(event) => {
                      if (!projectId) return;
                      void run(() => permissions.updateRole(projectId, collaborator.email, event.target.value as "viewer" | "editor"));
                    }}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                )}
                {collaborator.role !== "owner" && canManage && (
                  <button
                    type="button"
                    className="text-button share-remove-button"
                    aria-label={`Remove ${collaborator.email}`}
                    disabled={busy}
                    onClick={() => {
                      if (projectId) void run(() => permissions.removeCollaborator(projectId, collaborator.email));
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
            {loaded && collaborators.length === 0 && <li className="share-collaborator-empty">No collaborators yet.</li>}
          </ul>

          {error && <p className="share-error" role="alert">{error}</p>}
          <span className="visually-hidden" role="status">{error}</span>
        </div>
      )}
    </>
  );
}

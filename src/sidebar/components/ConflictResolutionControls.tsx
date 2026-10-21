import { useEffect, useRef, useState } from "react";
import type { ConflictDraft } from "../../storage/changeJournal";
import { scope } from "../../storage/changeJournal";
import type { ConflictRecord, ConflictTarget, ResolutionRequest } from "../../storage/conflictResolution";
import type { StoredBlob } from "../../storage/blobStore";

export type ConflictRecoveryApi = {
  listConflicts?(): Promise<ConflictRecord[]>;
  subscribeConflicts?(listener: (records: ConflictRecord[]) => void, onError: (error: unknown) => void): Promise<() => void>;
  saveConflictDraft?(target: ConflictTarget, draft: Omit<ConflictDraft, "id" | "target">): Promise<void>;
  resolveConflict?(request: ResolutionRequest): Promise<void>;
  getImage?(id: string): Promise<StoredBlob | null>;
  permanentlyDeleteBoard?(boardId: string): Promise<void>;
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const deleted = (value: Record<string, unknown>) => value._deleted === true || !!value.deletedAt;
const sameHeads = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function ConflictResolutionControls({ api, onRenewBoard }: { api: ConflictRecoveryApi; onRenewBoard?: (boardId: string) => Promise<{ role: string }> }) {
  const [records, setRecords] = useState<ConflictRecord[]>([]);
  const [error, setError] = useState("");
  const refreshRef = useRef(() => {});
  useEffect(() => {
    let active = true, stop: (() => void) | undefined;
    const failed = () => { if (active) setError("Conflict recovery is unavailable. Retained versions remain stored locally."); };
    const receive = (records: ConflictRecord[]) => { if (active) { setRecords(records); setError(""); } };
    refreshRef.current = () => { if (api.listConflicts) void api.listConflicts().then(receive).catch(failed); };
    if (api.subscribeConflicts) void api.subscribeConflicts(receive, failed).then(unsubscribe => { if (active) stop = unsubscribe; else unsubscribe(); }).catch(failed);
    else if (api.listConflicts) void api.listConflicts().then(receive).catch(failed);
    return () => { active = false; stop?.(); };
  }, [api]);
  if (!records.length && !error) return null;
  const actionable = records.filter(record => !record.boardMissing);
  const evidence = records.filter(record => record.boardMissing);
  return <section className="conflict-recovery" aria-label="Conflict recovery">
    {error && <p role="status">{error}</p>}
    {actionable.length > 0 && <details>
      <summary>Conflict requires resolution ({actionable.length})</summary>
      <p>Compare retained versions and save a reviewed resolution. Original versions stay in local history.</p>
      <p className="muted">Private history recovery depends on a completed Drive backup. Authorized peers exchange signed history; pending decisions remain private until admission.</p>
      {actionable.map(record => <ConflictEditor key={scope(record)} record={record} api={api}
        onRenewBoard={onRenewBoard && (async boardId => { const result = await onRenewBoard(boardId); refreshRef.current(); return result; })} />)}
      {api.permanentlyDeleteBoard && [...new Set(actionable.map(record => record.boardId))].map(boardId => <PermanentBoardDeletion key={boardId} boardId={boardId} name={actionable.find(record => record.boardId === boardId)!.boardName} api={api} onDeleted={() => refreshRef.current()} />)}
    </details>}
    {evidence.length > 0 && <details>
      <summary>Retained conflict evidence on removed boards ({evidence.length})</summary>
      <p>These boards are no longer in this account’s list. Restore a board to resolve its retained versions, or permanently delete the board and its private Drive backup.</p>
      {evidence.map(record => <EvidenceRow key={scope(record)} record={record} api={api} />)}
      {api.permanentlyDeleteBoard && [...new Set(evidence.map(record => record.boardId))].map(boardId => <PermanentBoardDeletion key={boardId} boardId={boardId} name={evidence.find(record => record.boardId === boardId)!.boardName} api={api} onDeleted={() => refreshRef.current()} />)}
    </details>}
  </section>;
}

function PermanentBoardDeletion({ boardId, name, api, onDeleted }: { boardId: string; name: string; api: ConflictRecoveryApi; onDeleted(): void }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="retained-work-delete">
    <strong>{name}</strong>
    <button className="danger" disabled={busy} onClick={() => setConfirming(true)}>Permanently delete board</button>
    {confirming && <div role="group" aria-label="Confirm permanent board deletion">
      <p>Delete this board, its cards and all retained versions from this device and its private Google Drive backup? This cannot be undone. Cloud cleanup retries when connected. Other users’ copies remain intact.</p>
      <button disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      <button className="danger" disabled={busy} onClick={() => {
        setBusy(true); setError('');
        void api.permanentlyDeleteBoard!(boardId).then(onDeleted).catch(() => setError('Board deletion could not finish. Retry to complete it.')).finally(() => setBusy(false));
      }}>Delete board permanently</button>
    </div>}
    {error && <p role="status">{error}</p>}
  </div>;
}

function EvidenceRow({ record, api }: { record: ConflictRecord; api: ConflictRecoveryApi & { unhideProject?(projectId: string): Promise<void> } }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [restored, setRestored] = useState(false);
  const restore = async () => {
    setBusy(true); setError("");
    try { await api.unhideProject?.(record.boardId); setRestored(true); } catch (e) { setError(e instanceof Error ? e.message : "Evidence remains retained locally."); } finally { setBusy(false); }
  };
  return <article className="conflict-evidence">
    <strong>{record.boardName}</strong>
    <p>{record.restriction ?? "Versions are retained; the board is not in this account’s list."}</p>
    {api.unhideProject && <button disabled={busy || restored} onClick={() => void restore()}>{restored ? "Board is restored" : "Restore board to the list"}</button>}
    {error && <p role="status">{error}</p>}
  </article>;
}

function VariantImage({ id, api }: { id: string; api: ConflictRecoveryApi }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true, objectUrl = "";
    if (api.getImage && typeof URL.createObjectURL === "function") void api.getImage(id).then(image => {
      if (active && image) { objectUrl = URL.createObjectURL(image.blob); setUrl(objectUrl); }
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, api]);
  return url ? <img className="conflict-image" src={url} alt="Image attached to this version" /> : <p>This image is not available for preview on this device.</p>;
}

function ConflictEditor({ record, api, onRenewBoard }: { record: ConflictRecord; api: ConflictRecoveryApi; onRenewBoard?: (boardId: string) => Promise<{ role: string }> }) {
  const [draft, setDraft] = useState<Omit<ConflictDraft, "id" | "target"> | null>(() => record.drafts.length === 1 ? { ...record.drafts[0], writerId: crypto.randomUUID() } : null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [renewed, setRenewed] = useState(false);
  const saves = useRef(Promise.resolve());
  const mounted = useRef(true), generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const persist = (next: NonNullable<typeof draft>) => {
    setDraft(next); setMessage("Saving local draft…");
    const current = ++generation.current;
    saves.current = saves.current.catch(() => {}).then(async () => {
      if (!api.saveConflictDraft) throw new Error("Draft recovery is unavailable");
      await api.saveConflictDraft(record, next);
    });
    void saves.current.then(() => { if (mounted.current && generation.current === current) setMessage("Draft saved locally."); })
      .catch(() => { if (mounted.current && generation.current === current) setMessage("Draft could not be saved. Keep this window open and copy your text before retrying."); });
  };
  const choose = (variantId: string) => {
    const variant = record.result.variants.find(v => v.id === variantId)!;
    const keepDraft = draft && !sameHeads(draft.heads, record.result.heads);
    persist({ writerId: crypto.randomUUID(), heads: record.result.heads, variantId,
      title: keepDraft ? draft.title : text(record.collection === "projects" ? variant.value.name : variant.value.title),
      content: keepDraft ? draft.content : text(variant.value.content) });
  };
  const selected = record.result.variants.find(v => v.id === draft?.variantId);
  const stale = draft && !sameHeads(draft.heads, record.result.heads);
  const disabled = busy || !!record.restriction;
  async function resolve() {
    if (!draft || !selected || stale || disabled || !api.resolveConflict) return;
    setBusy(true); setMessage("");
    try {
      await saves.current;
      await api.resolveConflict({ boardId: record.boardId, collection: record.collection, documentId: record.documentId, heads: draft.heads, variantId: draft.variantId,
        ...(!deleted(selected.value) ? { edits: record.collection === "cards" ? { title: draft.title, content: draft.content } : { name: draft.title } } : {}) });
      if (mounted.current) setMessage(record.pendingAuthorization ? "Resolution saved as private pending work. Current authorization is required for publication." : "Resolution saved locally. Other retained concurrent changes may still require review.");
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "Resolution could not be saved. All versions are retained."); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <details className="conflict-entry">
    <summary>{record.boardName} — {record.collection === "cards" ? "Card" : "Board"}: {record.result.variants.length} versions</summary>
    {record.restriction && !record.pendingAuthorization && <p role="status">{record.restriction}</p>}
    {onRenewBoard && record.restriction && !record.pendingAuthorization && !renewed &&
      <button type="button" onClick={() => void (async () => {
        setBusy(true); setMessage("");
        try { const { role } = await onRenewBoard(record.boardId);
          if (role === "none") setMessage("Board access was verified but this device has no editing grant; resolution remains blocked.");
          else { setRenewed(true); setMessage("Board access verified. This conflict's retained versions can now be reviewed and resolved."); }
        } catch (error) { setMessage(error instanceof Error ? error.message : "Board access could not be renewed; versions are retained."); }
        finally { setBusy(false); }
      })()}>Verify board access and retry</button>}
    {record.restriction && renewed && <p role="status" className="muted">The restriction shown above was computed before renewal; after choosing new versions it is rechecked when saving.</p>}
    {record.result.kind === "mergeable" && <p>These versions contain compatible changes. Review the text before saving.</p>}
    {record.drafts.length > 0 && <label>Saved drafts
      <select aria-label="Saved resolution drafts" defaultValue="" onChange={event => {
        const saved = record.drafts.find(d => d.id === event.target.value);
        if (saved) persist({ ...saved, writerId: crypto.randomUUID() });
      }} disabled={disabled}>
        <option value="">Choose a saved draft</option>
        {record.drafts.map((saved, index) => <option key={saved.id} value={saved.id}>Draft {index + 1}: {saved.title || saved.content.slice(0, 40) || "Deleted version"}</option>)}
      </select>
    </label>}
    <fieldset disabled={disabled}>
      <legend>Choose a version to keep or use as a starting point</legend>
      {record.result.variants.map((variant, index) => <label className="conflict-version" key={variant.id}>
        <span><input type="radio" name={`version-${scope(record)}`} checked={draft?.variantId === variant.id} onChange={() => choose(variant.id)} /> Version {index + 1}{deleted(variant.value) ? " — Deleted" : ""}</span>
        <strong>{text(record.collection === "projects" ? variant.value.name : variant.value.title)}</strong>
        {record.collection === "cards" ? <>
          <span>{text(variant.value.type)} · {text(variant.value.status)}</span>
          <pre>{text(variant.value.content)}</pre>
          {typeof variant.value.imageId === "string" && <VariantImage id={variant.value.imageId} api={api} />}
        </> : <span>Template: {text(variant.value.template)}</span>}
      </label>)}
      {draft && <>
        {stale && <>
          <p role="status">New changes arrived. Your draft is retained. Review the current versions before saving a resolution. Choosing a current starting version keeps your draft text.</p>
          {selected && <button type="button" onClick={() => persist({ ...draft, writerId: crypto.randomUUID(), heads: record.result.heads })}>I reviewed the new versions; keep my draft</button>}
        </>}
        {(!selected || !deleted(selected.value)) && <>
          <label>{record.collection === "cards" ? "Resolution title" : "Resolved board name"}
            <input value={draft.title} onChange={event => persist({ ...draft, title: event.target.value })} />
          </label>
          {record.collection === "cards" && <label>Resolution text
            <textarea rows={5} value={draft.content} onChange={event => persist({ ...draft, content: event.target.value })} />
          </label>}
          {record.collection === "cards" && record.result.kind === "mergeable" && record.result.preview && <button type="button" onClick={() => persist({ ...draft,
            title: text(record.result.preview?.title), content: text(record.result.preview?.content) })}>Use combined text</button>}
        </>}
        <button type="button" disabled={!selected || !!stale || !api.resolveConflict} onClick={() => void resolve()}>{busy ? "Saving resolution…" : record.pendingAuthorization ? "Save pending resolution" : selected && deleted(selected.value) ? "Confirm deletion resolution" : "Save resolution"}</button>
      </>}
    </fieldset>
    {message && <p role="status">{message}</p>}
  </details>;
}

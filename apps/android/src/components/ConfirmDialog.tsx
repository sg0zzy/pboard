import { useEffect, useRef } from 'react';
export type Confirmation = { title: string; message: string; actionLabel: string; onConfirm: () => void };
export function ConfirmDialog({ confirmation, onCancel }: { confirmation: Confirmation; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby="confirmation-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="confirmation-title">{confirmation.title}</h2><p>{confirmation.message}</p>
    <div className="form-actions">
      <button autoFocus onClick={onCancel}>Cancel</button>
      <button className="danger" onClick={confirmation.onConfirm}>{confirmation.actionLabel}</button>
    </div>
  </dialog>;
}

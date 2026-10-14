import { useEffect, useRef } from 'react';
import { boardTemplates } from '../../../../src/templates/boardTemplates';
import { BOARD_ITEM_STATUSES } from '../../../../src/types';
import { cardColors } from '../data/cardColors';
import type { BoardItem, Project } from '../storage/repository';

export type CardPickerField = 'type' | 'status';
export function CardFieldPicker({ project, card, field, onChoose, onCancel }: {
  project: Project; card: BoardItem; field: CardPickerField;
  onChoose: (patch: Partial<Pick<BoardItem, CardPickerField>>) => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const category = field === 'type';
  const options = category ? boardTemplates[project.template].cardTypes.map(type => ({ value: type.id, label: type.label, style: cardColors(project.template, type.id) })) : BOARD_ITEM_STATUSES.map(status => ({ value: status, label: status, style: undefined }));
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, []);
  return <dialog ref={dialog} className="card-field-picker" aria-labelledby="card-picker-title" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h2 id="card-picker-title">Choose {category ? 'category' : 'status'}</h2>
    <div className="card-picker-options" role="group" aria-labelledby="card-picker-title">
      {options.map(option => <button key={option.value} type="button" className="card-picker-option" aria-label={option.label} aria-pressed={card[field] === option.value} onClick={() => onChoose(category ? { type: option.value as BoardItem['type'] } : { status: option.value as BoardItem['status'] })}>
        <span className={category ? 'card-type-label' : `card-status status-${option.value.replaceAll(' ', '-')}`} style={option.style}>
          {!category && <span className="status-color-dot" aria-hidden="true" />}{option.label}
        </span>
        <span className="card-picker-check" aria-hidden="true">{card[field] === option.value ? '✓' : ''}</span>
      </button>)}
    </div>
    <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button></div>
  </dialog>;
}

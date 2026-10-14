import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Project } from "../../types";
import { reorderAtTarget, type DropPosition } from "../reorder";
import { CheckIcon, ChevronDownIcon, DragHandleIcon } from "./icons";

type Props = {
  projects: Project[];
  currentProjectId: string;
  onSelect: (projectId: string) => Promise<void>;
  onReorder: (orderedIds: string[]) => Promise<void>;
};

export function ProjectPicker({ projects, currentProjectId, onSelect, onReorder }: Props) {
  const [open, setOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? projects[0];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function openAndFocus(projectId = currentProjectId) {
    setOpen(true);
    window.requestAnimationFrame(() => optionRefs.current.get(projectId)?.focus());
  }

  function closeAndFocusTrigger() {
    setOpen(false);
    setDraggedId(null);
    setDropTarget(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function focusRelative(projectId: string, direction: -1 | 1) {
    const index = projects.findIndex((project) => project.id === projectId);
    const target = projects[index + direction];
    if (target) optionRefs.current.get(target.id)?.focus();
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, projectId: string) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocusTrigger();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      focusRelative(projectId, event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? projects[0] : projects.at(-1);
      if (target) optionRefs.current.get(target.id)?.focus();
    }
  }

  function previewDrop(event: React.DragEvent<HTMLButtonElement>, targetId: string) {
    event.preventDefault();
    if (!draggedId || draggedId === targetId) {
      setDropTarget(null);
      return;
    }
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDropTarget({ id: targetId, position });
  }

  async function dropProject(event: React.DragEvent<HTMLButtonElement>, targetId: string) {
    event.preventDefault();
    if (!draggedId || !dropTarget || draggedId === targetId) return;
    const orderedIds = reorderAtTarget(projects.map((project) => project.id), draggedId, targetId, dropTarget.position);
    setDraggedId(null);
    setDropTarget(null);
    await onReorder(orderedIds);
  }

  return (
    <div className="project-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="project-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => open ? setOpen(false) : openAndFocus()}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openAndFocus(event.key === "ArrowUp" ? projects.at(-1)?.id : currentProjectId);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            closeAndFocusTrigger();
          }
        }}
      >
        <span>{currentProject?.name}</span><span className="project-picker-chevron" aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      {open && (
        <div className="project-picker-menu" role="listbox" aria-label="Projects">
          {projects.map((project) => {
            const position = dropTarget?.id === project.id ? dropTarget.position : null;
            return (
              <button
                key={project.id}
                ref={(element) => {
                  if (element) optionRefs.current.set(project.id, element);
                  else optionRefs.current.delete(project.id);
                }}
                type="button"
                role="option"
                aria-selected={project.id === currentProjectId}
                className={`project-picker-option${project.id === currentProjectId ? " current" : ""}${draggedId === project.id ? " dragging" : ""}${position ? ` drop-${position}` : ""}`}
                draggable
                onClick={async () => {
                  await onSelect(project.id);
                  closeAndFocusTrigger();
                }}
                onKeyDown={(event) => handleOptionKeyDown(event, project.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", project.id);
                  setDraggedId(project.id);
                  setDropTarget(null);
                }}
                onDragOver={(event) => previewDrop(event, project.id)}
                onDrop={(event) => void dropProject(event, project.id)}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDropTarget(null);
                }}
              >
                <span className="project-picker-handle" aria-hidden="true"><DragHandleIcon /></span>
                <span>{project.name}</span>
                {project.id === currentProjectId && <span className="project-picker-check" aria-hidden="true"><CheckIcon /></span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

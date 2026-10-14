import type { ReactNode } from "react";

/**
 * Shared UI icon set. Material-Symbols-outlined style: 24px viewBox,
 * stroke-based (fill: none, stroke: currentColor), 2px stroke width,
 * round caps, sized in `em` by container CSS so icons scale with uiScale.
 * Existing recognizable path geometry is deliberately reused.
 */

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <path d="M8.25 8.25h10.5v10.5H8.25zM5.25 15.75h-1v-10.5h10.5v1" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="m5.5 12.5 4 4 9-9" />
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M4.75 7.25h14.5M9 7.25V4.75h6v2.5m-8.5 0 .75 12h9.5l.75-12M10 10v6.5m4-6.5v6.5" />
    </Icon>
  );
}

export function DownloadIcon() {
  return (
    <Icon>
      <path d="M12 4.5v10.5M7.75 10.75 12 15l4.25-4.25M4.75 19.25h14.5" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}

export function DragHandleIcon() {
  return (
    <Icon>
      <path d="M8.5 7h7M8.5 12h7M8.5 17h7" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
    </Icon>
  );
}

export function ChevronUpIcon() {
  return (
    <Icon>
      <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />
    </Icon>
  );
}

export function ZoomInIcon() {
  return (
    <Icon>
      <path d="M10.5 4.25a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM15.25 15.25 20.75 20.75M10.5 7.75v5M8 10.25h5" />
    </Icon>
  );
}

export function ZoomOutIcon() {
  return (
    <Icon>
      <path d="M10.5 4.25a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5ZM15.25 15.25 20.75 20.75M8 10.25h5" />
    </Icon>
  );
}

export function PageIcon() {
  return (
    <Icon>
      <path d="M6 2.75h8l4 4v14.5H6zM14 2.75v4h4M9 11h6M9 14.5h6M9 18h4" />
    </Icon>
  );
}

export function SelectionIcon() {
  return (
    <Icon>
      <path d="M5 5h14M5 9h10M5 17h14M5 21h9" />
      <path d="M4 12.5h16v3H4z" className="selection-highlight" />
    </Icon>
  );
}

export function LinkIcon() {
  return (
    <Icon>
      <path d="m9.2 14.8 5.6-5.6M10 7.5l1.3-1.3a4 4 0 0 1 5.7 5.7l-2 2M14 16.5l-1.3 1.3A4 4 0 0 1 7 12.1l2-2" />
    </Icon>
  );
}

export function RegionCameraIcon() {
  return (
    <Icon>
      <path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" />
      <path d="M6.5 10.5h3l1-1.5h3l1 1.5h3v7h-11z" />
      <circle cx="12" cy="14" r="2" />
    </Icon>
  );
}

export function CloudIcon() {
  return (
    <Icon>
      <path d="M7 18h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 7 8.5 4.75 4.75 0 0 0 7 18Z" />
    </Icon>
  );
}

export function SyncIcon() {
  return (
    <Icon>
      <path d="M19 7v5h-5M5 17v-5h5M7.1 8.3A6 6 0 0 1 17.7 10M16.9 15.7A6 6 0 0 1 6.3 14" />
    </Icon>
  );
}

export function PeopleIcon() {
  return (
    <Icon>
      <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-3.3 0-6 1.8-6 4v1h12v-1c0-2.2-2.7-4-6-4Zm7.5-2.2A2.5 2.5 0 1 0 15 7a2.5 2.5 0 0 0 1.5 2.8ZM16 13c-.7 0-1.4.1-2 .3 1.2.8 2 1.9 2 3.2v1h5v-1c0-1.8-2-2.5-5-2.5Z" />
    </Icon>
  );
}

export function NewProjectIcon() {
  return (
    <Icon>
      <path d="M3.75 6.25h6l1.5 2h9v10h-17zM12.5 13.25h5m-2.5-2.5v5" />
    </Icon>
  );
}

export function EditIcon() {
  return (
    <Icon>
      <path d="m5 16.75-.5 3 3-.5L18.25 8.5l-2.5-2.5L5 16.75Zm8.75-8.75 2.5 2.5" />
    </Icon>
  );
}

/** Card display-mode icons: one card outline, growing line count. */
export function CompactViewIcon() {
  return (
    <Icon>
      <path d="M4.5 9.5h15v5h-15zM8 12h8" />
    </Icon>
  );
}

export function StandardViewIcon() {
  return (
    <Icon>
      <path d="M4.5 7h15v10h-15zM8 10.25h9M8 12.75h9M8 15.25h6" />
    </Icon>
  );
}

export function ExpandedViewIcon() {
  return (
    <Icon>
      <path d="M4.5 5h15v14h-15zM8 8.5h9M8 11h9M8 13.5h9M8 16h6" />
    </Icon>
  );
}
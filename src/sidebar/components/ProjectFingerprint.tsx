import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { statusClassName, WORKFLOW_STATUS_ROWS } from "../../statuses";
import type { BoardItem, BoardItemStatus } from "../../types";

const CELL_SIZE = 7;
const CELL_STEP = 10;
const GRID_X = 4;
const ROW_Y = [3, 16, 29] as const;
const SVG_HEIGHT = 39;
const COMPACT_GROUP_GAP = 6;
const CLOSED_STATUSES = new Set<BoardItemStatus>(WORKFLOW_STATUS_ROWS[2].map((definition) => definition.id));

type FingerprintStatus = Exclude<BoardItemStatus, "trash">;

export type FingerprintTransition = {
  itemId: string;
  fromStatus: BoardItemStatus;
  status: BoardItemStatus;
  revision: number;
};

type Props = {
  projectId: string;
  items: BoardItem[];
  transition: FingerprintTransition | null;
};

type CompactGroup = {
  status: FingerprintStatus;
  count: number;
};

export function expandedFingerprintRowWidth(itemCount: number): number {
  return itemCount === 0 ? 0 : GRID_X * 2 + (itemCount - 1) * CELL_STEP + CELL_SIZE;
}

export function compactFingerprintRows(statusRows: BoardItem[][], availableWidth: number | null): boolean[] {
  return statusRows.map((row) => availableWidth !== null && expandedFingerprintRowWidth(row.length) > availableWidth);
}

function compactGroups(row: BoardItem[]): CompactGroup[] {
  return row.reduce<CompactGroup[]>((groups, item) => {
    const status = item.status as FingerprintStatus;
    const last = groups.at(-1);
    if (last?.status === status) last.count += 1;
    else groups.push({ status, count: 1 });
    return groups;
  }, []);
}

function compactCountWidth(count: number): number {
  return String(count).length * 6 + 8;
}

function compactRowWidth(row: BoardItem[]): number {
  const groups = compactGroups(row);
  if (groups.length === 0) return 0;
  return GRID_X * 2 + groups.reduce((width, group) => width + compactCountWidth(group.count) + CELL_SIZE, 0)
    + (groups.length - 1) * COMPACT_GROUP_GAP;
}

function useAvailableFingerprintWidth() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const width = root.clientWidth;
      const fontSize = Number.parseFloat(window.getComputedStyle(root).fontSize);
      if (width > 0 && fontSize > 0) setAvailableWidth(width * 16 / fontSize);
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return { rootRef, availableWidth };
}

export function fingerprintHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: number, step: number): number {
  let value = seed + Math.imul(step + 1, 0x6d2b79f5);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

export function pencilCellPath(x: number, y: number, size: number, seed: number): string {
  const wobble = (step: number) => (seededUnit(seed, step) - .5) * .7;
  const left = x + wobble(0);
  const top = y + wobble(1);
  const right = x + size + wobble(2);
  const bottom = y + size + wobble(3);
  const radius = 1;
  return [
    `M ${left + radius} ${top}`,
    `Q ${x + size / 2} ${top + wobble(4)} ${right - radius} ${top}`,
    `Q ${right} ${top} ${right} ${top + radius}`,
    `Q ${right + wobble(5)} ${y + size / 2} ${right} ${bottom - radius}`,
    `Q ${right} ${bottom} ${right - radius} ${bottom}`,
    `Q ${x + size / 2} ${bottom + wobble(6)} ${left + radius} ${bottom}`,
    `Q ${left} ${bottom} ${left} ${bottom - radius}`,
    `Q ${left + wobble(7)} ${y + size / 2} ${left} ${top + radius}`,
    `Q ${left} ${top} ${left + radius} ${top} Z`
  ].join(" ");
}

export function splitFingerprintItems(items: BoardItem[]): {
  statusRows: BoardItem[][];
  active: BoardItem[];
  closed: BoardItem[];
} {
  const statusRows = WORKFLOW_STATUS_ROWS.map((definitions) => definitions.flatMap((definition) =>
    items.filter((item) => item.status === definition.id)
  ));
  return {
    statusRows,
    active: [...statusRows[0], ...statusRows[1]],
    closed: statusRows[2]
  };
}

function StateSymbol({ status, x, y }: { status: FingerprintStatus; x: number; y: number }) {
  if (status === "candidate") {
    return <circle className="fingerprint-state-symbol fingerprint-state-symbol--candidate" cx={x + 3.5} cy={y + 3.5} r="1.15" />;
  }
  if (status === "confirmed") {
    return <circle className="fingerprint-state-symbol fingerprint-state-symbol--confirmed" cx={x + 3.5} cy={y + 3.5} r="1.35" />;
  }
  if (status === "started") {
    return <path className="fingerprint-state-symbol fingerprint-state-symbol--started" d={`M${x + 2.5} ${y + 1.8}l3 1.7-3 1.8Z`} />;
  }
  if (status === "to validate") {
    return <path className="fingerprint-state-symbol fingerprint-state-symbol--to-validate" d={`M${x + 3.5} ${y + 1.5}a2 2 0 1 1-2 2h2Z`} />;
  }
  if (status === "done") {
    return <path className="fingerprint-state-symbol fingerprint-state-symbol--done" d={`M${x + 1.4} ${y + 3.7}l1.7 1.7 3-3.2`} />;
  }
  return <path className="fingerprint-state-symbol fingerprint-state-symbol--rejected" d={`M${x + 1.8} ${y + 1.8}l3.5 3.5m0-3.5-3.5 3.5`} />;
}

function FingerprintCell({ projectId, item, x, y, className = "", style }: {
  projectId: string;
  item: BoardItem;
  x: number;
  y: number;
  className?: string;
  style?: CSSProperties;
}) {
  const status = item.status as FingerprintStatus;
  const seedBase = `${projectId}:${item.id}`;
  return (
    <g className={`fingerprint-cell fingerprint-cell--${statusClassName(status)}${className ? ` ${className}` : ""}`} style={style}>
      <title>{status}</title>
      <path className="fingerprint-cell-shape" d={pencilCellPath(x, y, CELL_SIZE, fingerprintHash(`${seedBase}:main`))} />
      <path className="fingerprint-cell-echo" d={pencilCellPath(x, y, CELL_SIZE, fingerprintHash(`${seedBase}:echo`))} />
      <StateSymbol status={status} x={x} y={y} />
    </g>
  );
}

function CompactFingerprintRow({ row, y }: { row: BoardItem[]; y: number }) {
  let x = GRID_X;
  return compactGroups(row).map((group) => {
    const countWidth = compactCountWidth(group.count);
    const groupX = x;
    const symbolX = groupX + countWidth;
    x += countWidth + CELL_SIZE + COMPACT_GROUP_GAP;
    return (
      <g key={group.status} className={`fingerprint-compact-group fingerprint-cell--${statusClassName(group.status)}`}>
        <title>{group.count} {group.status}</title>
        <text
          className="fingerprint-compact-count"
          x={groupX}
          y={y + 5.8}
        >{group.count}×</text>
        <StateSymbol status={group.status} x={symbolX} y={y} />
      </g>
    );
  });
}

export function ProjectFingerprint({ projectId, items, transition }: Props) {
  const { rootRef, availableWidth } = useAvailableFingerprintWidth();
  const split = splitFingerprintItems(items);
  if (split.statusRows.every((row) => row.length === 0)) return null;

  const transitioningItem = transition ? items.find((item) => item.id === transition.itemId) : undefined;
  const isClosing = Boolean(
    transition &&
    transitioningItem &&
    !CLOSED_STATUSES.has(transition.fromStatus) &&
    transition.fromStatus !== "trash" &&
    CLOSED_STATUSES.has(transition.status)
  );
  const previousItems = isClosing && transitioningItem
    ? items.map((item) => item.id === transitioningItem.id ? { ...item, status: transition!.fromStatus } : item)
    : items;
  const previousRows = splitFingerprintItems(previousItems).statusRows;
  const compactRows = compactFingerprintRows(split.statusRows, availableWidth);
  const previousCompactRows = compactFingerprintRows(previousRows, availableWidth);
  const sourceRowIndex = transitioningItem
    ? previousRows.findIndex((row) => row.some((item) => item.id === transitioningItem.id))
    : -1;
  const destinationRowIndex = transitioningItem
    ? split.statusRows.findIndex((row) => row.some((item) => item.id === transitioningItem.id))
    : -1;
  const sourceIndex = sourceRowIndex >= 0 && transitioningItem
    ? previousRows[sourceRowIndex].findIndex((item) => item.id === transitioningItem.id)
    : -1;
  const destinationIndex = destinationRowIndex >= 0 && transitioningItem
    ? split.statusRows[destinationRowIndex].findIndex((item) => item.id === transitioningItem.id)
    : -1;
  const animateTransition = Boolean(
    isClosing &&
    sourceRowIndex >= 0 &&
    destinationRowIndex >= 0 &&
    !previousCompactRows[sourceRowIndex] &&
    !compactRows[destinationRowIndex]
  );
  const renderedRowWidths = split.statusRows.map((row, index) => compactRows[index]
    ? compactRowWidth(row)
    : expandedFingerprintRowWidth(row.length));
  const transitionRowWidths = animateTransition
    ? [expandedFingerprintRowWidth(previousRows[sourceRowIndex].length)]
    : [];
  const gridWidth = Math.max(...renderedRowWidths, ...transitionRowWidths, expandedFingerprintRowWidth(2));
  const svgWidth = gridWidth;
  const destinationX = GRID_X + destinationIndex * CELL_STEP;
  const sourceX = GRID_X + sourceIndex * CELL_STEP;
  const destinationY = destinationRowIndex >= 0 ? ROW_Y[destinationRowIndex] : 0;
  const sourceY = sourceRowIndex >= 0 ? ROW_Y[sourceRowIndex] : 0;

  return (
    <div ref={rootRef} className="project-fingerprint" aria-label={`Project status, ${split.active.length} active and ${split.closed.length} closed cards`}>
      <svg viewBox={`0 0 ${svgWidth} ${SVG_HEIGHT}`} style={{ width: `${svgWidth / 16}em` }} role="img">
        <title>Project status: candidate and confirmed; started and to validate; done and rejected</title>
        <path className="fingerprint-row-guide" d={`M1 13h${gridWidth - 2}M1 26h${gridWidth - 2}`} aria-hidden="true" />
        {split.statusRows.flatMap((row, rowIndex) => compactRows[rowIndex]
          ? <CompactFingerprintRow key={`compact-${rowIndex}`} row={row} y={ROW_Y[rowIndex]} />
          : row.map((item, index) => (
            <FingerprintCell
              key={item.id}
              projectId={projectId}
              item={item}
              x={GRID_X + index * CELL_STEP}
              y={ROW_Y[rowIndex]}
              className={animateTransition && item.id === transitioningItem?.id ? "fingerprint-cell--landing" : ""}
            />
          )))}
        {animateTransition && transitioningItem && sourceIndex >= 0 && destinationIndex >= 0 && sourceRowIndex >= 0 && destinationRowIndex >= 0 && (
          <FingerprintCell
            key={`moving-${transition!.revision}`}
            projectId={projectId}
            item={transitioningItem}
            x={destinationX}
            y={destinationY}
            className={`fingerprint-cell--moving fingerprint-cell--moving-${statusClassName(transition!.status)}`}
            style={{
              "--fingerprint-move-x": `${sourceX - destinationX}px`,
              "--fingerprint-move-y": `${sourceY - destinationY}px`
            } as CSSProperties}
          />
        )}
      </svg>
    </div>
  );
}

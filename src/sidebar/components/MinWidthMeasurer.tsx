import { useEffect, useMemo, useRef } from "react";
import type { BoardTemplate } from "../../types";
import { boardTemplates } from "../../templates/boardTemplates";
import {
  DISPLAY_MODE_BUTTON_COUNT,
  MIN_WIDTH_FLOOR_PX,
  STATIC_CATEGORY_LABEL,
  computeActionsRow,
  computeMinContentWidth,
  computeMinPageWidth,
  computeTopLine,
  sourceBadgeLabels,
  statusTriggerLabels,
  triggerCategoryLabels,
} from "../minWidth";

interface MinWidthMeasurerProps {
  template: BoardTemplate;
  uiScale: number;
  legacyTypeLabels: readonly string[];
  sourceProviders: readonly string[];
}

/**
 * Off-screen layout probe that renders the worst-case card elements using the
 * real card classes and measures them at the current `uiScale`:
 *
 *   --min-page-width = max(floor, ceil(worst topline | worst actions row) + chrome)
 *
 * where chrome is the horizontal padding + borders of `.app`, `.board` and
 * `.card`, read at runtime via `getComputedStyle`. It is consumed by
 * `body { min-width: max(260px, var(--min-page-width, 260px)); }`, which both
 * Chrome and Firefox respect through plain CSS.
 *
 * The probe mirrors Card.tsx exactly: a static `card-type-label` NOTE plus the
 * category triggers (only when the template shows a type selector), all seven
 * statuses (StatusPicker is unconditional), the three display-mode buttons and
 * the badge + copy + trash action row. The worst badge case is any raw
 * "From <provider>" string, clamped to 110px by `.source-badge`, so the probe
 * renders one deliberately long provider label to capture that clamp.
 */
export function MinWidthMeasurer({
  template,
  uiScale,
  legacyTypeLabels,
  sourceProviders,
}: MinWidthMeasurerProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const showTypeSelector = boardTemplates[template]?.showTypeSelector ?? false;

  const categoryLabels = useMemo(
    () => triggerCategoryLabels(template, legacyTypeLabels),
    [template, legacyTypeLabels]
  );
  const statusLabels = useMemo(() => statusTriggerLabels(), []);
  const badgeLabels = useMemo(
    () => sourceBadgeLabels([...sourceProviders, "very-long-provider-name"]),
    [sourceProviders]
  );

  useEffect(
    () => {
      const root = rootRef.current;
      if (!root) return;

      const measureProbe = (): void => {
        // Flush layout so em-based sizes are resolved for this uiScale.
        void root.getBoundingClientRect();

        const elementsWidth = (selector: string): number => {
          const elements = root.querySelectorAll<HTMLElement>(selector);
          if (elements.length === 0) return 0;
          return Math.max(
            ...[...elements].map((element) => element.getBoundingClientRect().width)
          );
        };
        const horizontalBox = (element: HTMLElement | null): number => {
          if (!element) return 0;
          const style = getComputedStyle(element);
          return (
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderRightWidth)
          );
        };

        const dragHandle = elementsWidth(".drag-handle");
        const category = elementsWidth(".type-picker-trigger");
        const status = elementsWidth(".card-status");
        const controls = elementsWidth(".display-mode-controls");
        const badge = elementsWidth(".source-badge");
        const icon = elementsWidth(".card-icon-button");

        const topLine = computeTopLine(dragHandle, category, status, controls);
        const actionsRow = computeActionsRow(badge, icon);
        const content = computeMinContentWidth(topLine, actionsRow);

        const app = root.closest<HTMLElement>(".app");
        const board = root.querySelector<HTMLElement>(".board");
        const card = root.querySelector<HTMLElement>(".card");
        const chrome = horizontalBox(app) + horizontalBox(board) + horizontalBox(card);

        const pageWidth = Math.ceil(computeMinPageWidth(content, chrome));
        const value = Math.max(MIN_WIDTH_FLOOR_PX, pageWidth);
        document.documentElement.style.setProperty("--min-page-width", `${value}px`);
      };

      void measureProbe();

      // Second measurement after the first paint so em-based sizes have settled.
      let rafId: number;
      rafId = window.requestAnimationFrame(() => void measureProbe());
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    },
    [uiScale, categoryLabels.join(","), badgeLabels.join(",")]
  );

  return (
    <div className="min-width-measurer" aria-hidden="true" ref={rootRef}>
      <div className="board">
        <div className="card">
          <div className="card-topline">
            <span className="drag-handle" aria-hidden="true">
              ≡
            </span>
            <span className="card-type-label">
              {STATIC_CATEGORY_LABEL}
            </span>
            {showTypeSelector &&
              categoryLabels.map((label, index) => (
                <button
                  key={`category-${index}`}
                  type="button"
                  className="type-picker-trigger"
                  aria-label="Select category"
                >
                  <span>{label}</span>
                  <span className="type-picker-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </button>
              ))}
            {statusLabels.map((label, index) => (
              <button
                key={`status-${index}`}
                type="button"
                className="card-status status-picker-trigger"
                aria-label="Select status"
              >
                <span>{label}</span>
                <span className="status-picker-chevron" aria-hidden="true">
                  ⌄
                </span>
              </button>
            ))}
            <div className="display-mode-controls">
              {Array.from({ length: DISPLAY_MODE_BUTTON_COUNT }).map((_, index) => (
                <button
                  key={`display-mode-${index}`}
                  type="button"
                  className="display-mode-button"
                  aria-label="Display mode"
                >
                  <span aria-hidden="true">▢</span>
                </button>
              ))}
            </div>
          </div>
          <div className="card-actions">
            {badgeLabels.map((badge, index) => (
              <span className="source-badge" key={`badge-${index}`}>
                {badge}
              </span>
            ))}
            <button
              type="button"
              className="card-icon-button"
              aria-label="Copy card content"
              title="Copy card content"
            >
              <span aria-hidden="true">▢</span>
            </button>
            <button
              type="button"
              className="card-icon-button danger"
              aria-label="Trash card"
              title="Trash card"
            >
              <span aria-hidden="true">▢</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

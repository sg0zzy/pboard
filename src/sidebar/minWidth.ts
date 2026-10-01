import { STATUS_DEFINITIONS } from "../statuses";
import { boardTemplates } from "../templates/boardTemplates";
import type { BoardTemplate } from "../types";

/**
 * The page-wide minimum width is computed at runtime by
 * `MinWidthMeasurer` (an off-screen layout probe) and exposed as
 * `--min-page-width` on `html`. This module holds the formula and the
 * probe's label sets, so the probe always measures the worst case the
 * active template can display: widest category, largest status, the
 * three display-mode buttons, and the source-badge + copy + trash row.
 */

export const MIN_WIDTH_FLOOR_PX = 260;
export const TOPLINE_GAP_PX = 5;
export const ACTIONS_GAP_PX = 5;
export const DISPLAY_MODE_BUTTON_COUNT = 3;

/** Label shown when a card's type has no template card type. */
export const STATIC_CATEGORY_LABEL = "NOTE";

export function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Every category trigger label the active template can display, plus any
 * legacy (unknown) types currently used on the board.
 */
export function triggerCategoryLabels(template: BoardTemplate, legacyTypeLabels: readonly string[]): string[] {
  const cardTypes = boardTemplates[template]?.cardTypes ?? [];
  const knownLabels = cardTypes.map((type) => type.label);
  const legacyLabels = legacyTypeLabels.map((type) => `LEGACY: ${type.replaceAll("_", " ").toUpperCase()}`);
  return dedupe([...knownLabels, ...legacyLabels]);
}

export function statusTriggerLabels(): string[] {
  return STATUS_DEFINITIONS.map((status) => `${status.symbol} ${status.label}`);
}

/** Base source badges plus any provider seen on current board items. */
export function sourceBadgeLabels(extraProviders: readonly string[]): string[] {
  const providers = ["chat", "web", "chatgpt", ...extraProviders];
  return dedupe(providers.filter((provider) => Boolean(provider)).map((provider) => `From ${provider}`));
}

/** Worst top-line row: drag handle + widest category + widest status + display-mode controls. */
export function computeTopLine(dragHandle: number, category: number, status: number, controls: number): number {
  return dragHandle + TOPLINE_GAP_PX + category + TOPLINE_GAP_PX + status + TOPLINE_GAP_PX + controls;
}

/** Worst card-actions row: widest source badge + copy + trash icons. */
export function computeActionsRow(badge: number, icon: number): number {
  return badge + ACTIONS_GAP_PX + icon + ACTIONS_GAP_PX + icon;
}

export function computeMinContentWidth(topLine: number, actionsRow: number): number {
  return Math.max(topLine, actionsRow);
}

/** Content width plus the horizontal chrome of app/board/card boxes. */
export function computeMinPageWidth(contentWidth: number, chromeWidth: number): number {
  return contentWidth + chromeWidth;
}

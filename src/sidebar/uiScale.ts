export const UI_SCALE_STORAGE_KEY = "projectBoardUiScale";
export const UI_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3] as const;
export const DEFAULT_UI_SCALE = 1;

export function normalizeUiScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_UI_SCALE;
  return UI_SCALE_STEPS.reduce((closest, step) =>
    Math.abs(step - value) < Math.abs(closest - value) ? step : closest
  , DEFAULT_UI_SCALE as number);
}

export function adjustUiScale(current: number, direction: -1 | 1): number {
  const normalized = normalizeUiScale(current);
  const index = UI_SCALE_STEPS.indexOf(normalized as (typeof UI_SCALE_STEPS)[number]);
  const nextIndex = Math.max(0, Math.min(UI_SCALE_STEPS.length - 1, index + direction));
  return UI_SCALE_STEPS[nextIndex];
}

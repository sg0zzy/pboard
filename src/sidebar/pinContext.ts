import type { ToolbarPinContext } from "../messaging/messages";

/**
 * The toolbar pin context is polled every 1.5 seconds and every answer is a
 * fresh object. Two answers that describe the same page state are equal, so
 * the poll does not re-render the board for nothing.
 */
export function samePinContext(left: ToolbarPinContext, right: ToolbarPinContext): boolean {
  return left.page === right.page &&
    left.selection === right.selection &&
    left.link === right.link &&
    left.accessible === right.accessible;
}

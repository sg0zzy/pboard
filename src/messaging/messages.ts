import type { CapturedSelection } from "../providers/provider";

export type CaptureSelectionMessage = { type: "CAPTURE_SELECTION" };
export type CaptureSelectionResponse = { ok: true; selection: CapturedSelection } | { ok: false; reason: string };
export type RuntimeMessage = CaptureSelectionMessage;

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "CAPTURE_SELECTION");
}

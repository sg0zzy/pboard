import type { CapturedSelection } from "../providers/provider";
import type { BoardImage } from "../types";

export type CaptureSelectionMessage = { type: "CAPTURE_SELECTION" };
export type CaptureSelectionResponse = { ok: true; selection: CapturedSelection } | { ok: false; reason: string };
export type RuntimeMessage = CaptureSelectionMessage;

export type CaptureRegionMessage = { type: "CAPTURE_PAGE_REGION" };
export type CaptureRegionResponse =
  | { ok: true; image: BoardImage; pageUrl?: string; pageTitle?: string }
  | { ok: false; reason: string; cancelled?: boolean };

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "CAPTURE_SELECTION");
}

export function isCaptureRegionMessage(value: unknown): value is CaptureRegionMessage {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "CAPTURE_PAGE_REGION");
}

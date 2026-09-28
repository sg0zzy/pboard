import type { CapturedSelection } from "../providers/provider";
import type { BoardImage } from "../types";

export type CaptureSelectionMessage = { type: "CAPTURE_SELECTION" };
export type CaptureSelectionResponse = { ok: true; selection: CapturedSelection } | { ok: false; reason: string };
export type RuntimeMessage = CaptureSelectionMessage;

export type CaptureRegionMessage = { type: "CAPTURE_PAGE_REGION" };
export type ToolbarPinKind = "page" | "selection" | "link";
export type ToolbarPinContext = { page: boolean; selection: boolean; link: boolean; accessible: boolean };
export type ToolbarPinResponse = { ok: boolean; reason?: string };
export type CaptureRegionResponse =
  | { ok: true; image: BoardImage; pageUrl?: string; pageTitle?: string }
  | { ok: false; reason: string; cancelled?: boolean };

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "CAPTURE_SELECTION");
}

export function isCaptureRegionMessage(value: unknown): value is CaptureRegionMessage {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "CAPTURE_PAGE_REGION");
}

export function isToolbarPinMessage(value: unknown): value is { type: "GET_TOOLBAR_PIN_CONTEXT" } | { type: "PIN_FROM_TOOLBAR"; kind: ToolbarPinKind } {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "GET_TOOLBAR_PIN_CONTEXT") return true;
  return value.type === "PIN_FROM_TOOLBAR" && "kind" in value &&
    (value.kind === "page" || value.kind === "selection" || value.kind === "link");
}

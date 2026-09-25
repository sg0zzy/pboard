import { cropCapturedImage } from "../images/processing";
import type { CaptureRegion } from "../images/processing";
import type { CaptureRegionResponse } from "../messaging/messages";
import type { BoardImage } from "../types";
import { isWebUrl } from "./handlers";
import { firstCaptureRegion, selectPageRegion } from "./regionCapture";

type CaptureTab = {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
};

export type PageCaptureApi = {
  tabs: {
    query(details: { active: boolean; currentWindow: boolean }): Promise<CaptureTab[]>;
    captureVisibleTab(windowId: number, details: { format: "png" }): Promise<string>;
  };
  scripting: {
    executeScript(details: {
      target: { tabId: number };
      func: () => void;
    }): Promise<Array<{ result?: unknown }>>;
  };
};

type PageCaptureDependencies = {
  selectRegion: typeof selectPageRegion;
  cropImage: (dataUrl: string, region: CaptureRegion) => Promise<BoardImage>;
};

const defaultDependencies: PageCaptureDependencies = {
  selectRegion: selectPageRegion,
  cropImage: cropCapturedImage
};

export async function capturePageRegion(
  api: PageCaptureApi,
  dependencies: PageCaptureDependencies = defaultDependencies
): Promise<CaptureRegionResponse> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.windowId === undefined) {
    return { ok: false, reason: "No active web page is available." };
  }

  let results;
  try {
    results = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: dependencies.selectRegion as unknown as () => void
    });
  } catch {
    return {
      ok: false,
      reason: isWebUrl(tab.url)
        ? "The page could not be captured. Try again."
        : "This page type cannot be captured."
    };
  }

  const region = firstCaptureRegion(results);
  if (!region) return { ok: false, reason: "Capture cancelled.", cancelled: true };

  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  if (!active?.id || active.windowId === undefined) {
    return { ok: false, reason: "No active web page is available." };
  }
  if (active.id !== tab.id || (region.href && active.url && active.url !== region.href)) {
    return { ok: false, reason: "The page changed while capturing. Try again." };
  }

  let screenshot: string;
  try {
    screenshot = await api.tabs.captureVisibleTab(active.windowId, { format: "png" });
  } catch {
    return { ok: false, reason: "The page could not be captured. Try again." };
  }

  let image: BoardImage;
  try {
    image = await dependencies.cropImage(screenshot, region);
  } catch {
    return { ok: false, reason: "The captured image could not be processed." };
  }
  return { ok: true, image, pageUrl: active.url, pageTitle: active.title };
}

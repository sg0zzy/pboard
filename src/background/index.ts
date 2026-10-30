import type { CaptureSelectionResponse } from "../messaging/messages";
import { isCaptureRegionMessage, isToolbarPinMessage } from "../messaging/messages";
import { cropCapturedImage } from "../images/processing";
import { repository } from "../storage/browser";
import type { BoardImage } from "../types";
import { PINNED_CARD_FOCUS_KEY } from "../types";
import { pinImage, pinSelection, pinWebResource } from "./handlers";
import {
  firstSelectedText,
  PIN_PAGE_COMMAND,
  PIN_PAGE_SHORTCUT,
  PIN_SELECTION_COMMAND,
  PIN_SELECTION_SHORTCUT
} from "./shortcuts";
import { firstCaptureImageRegion, findContextImage } from "./regionCapture";
import { capturePageRegion, type PageCaptureApi } from "./pageCapture";
import { getToolbarPinContext, pinFromToolbar, type PinApi } from "./toolbarPins";
import { togglePboardSidebar } from "./sidebar";
import { browser } from "../platform/browser";
import { handleDriveSyncMessage, registerDriveBackgroundSync } from "../sync/background";
import { registerDriveAccountPolling } from '../sync/drivePolling';
import { collaborationCounters } from "../collab/counters";

const SELECTION_MENU_ID = "pin-selection-to-pboard";
const LINK_MENU_ID = "pin-link-to-pboard";
const PAGE_MENU_ID = "pin-page-to-pboard";
const IMAGE_MENU_ID = "pin-image-to-pboard";
const WEB_PAGES = ["http://*/*", "https://*/*"];

browser.runtime.onInstalled.addListener(() => { void registerMenus(); });
void registerMenus();
registerDriveBackgroundSync();
registerDriveAccountPolling();

/**
 * The recurring work counters, for a development build. A developer can read
 * them from the background page's console with
 * `pboardCounters.snapshot()` to attribute a sustained CPU load to a
 * component without a profiler. A production build does not collect them.
 */
if (collaborationCounters.enabled) {
  globalThis.pboardCounters = collaborationCounters;
}

if (browser.sidePanel?.setPanelBehavior) {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

if (browser.sidebarAction && browser.action?.onClicked) {
  browser.action.onClicked.addListener(() => {
    void togglePboardSidebar(browser);
  });
}

async function registerMenus() {
  await browser.menus.removeAll();
  browser.menus.create({
      id: SELECTION_MENU_ID,
      title: `Pin selection to Pboard (${PIN_SELECTION_SHORTCUT})`,
      contexts: ["selection"],
      documentUrlPatterns: WEB_PAGES
  });
  browser.menus.create({
      id: LINK_MENU_ID,
      title: "Pin link to Pboard",
      contexts: ["link"],
      documentUrlPatterns: WEB_PAGES,
      targetUrlPatterns: WEB_PAGES
  });
  browser.menus.create({
      id: PAGE_MENU_ID,
      title: `Pin current page to Pboard (${PIN_PAGE_SHORTCUT})`,
      contexts: ["page", "selection", "link"],
      documentUrlPatterns: WEB_PAGES
  });
  browser.menus.create({
      id: IMAGE_MENU_ID,
      title: "Pin image to Pboard",
      contexts: ["image"],
      documentUrlPatterns: WEB_PAGES
  });
}

browser.menus.onClicked.addListener(async (info: any, tab: any) => {
  if (info.menuItemId === SELECTION_MENU_ID) {
    let response: CaptureSelectionResponse | undefined;
    if (tab?.id && isChatGptUrl(info.pageUrl ?? tab.url)) {
      try {
        response = await browser.tabs.sendMessage(tab.id, { type: "CAPTURE_SELECTION" });
      } catch {
        // Generic pages use Firefox's selectionText. ChatGPT can additionally
        // answer through its provider adapter when its content script is present.
      }
    }

    const result = await pinSelection(repository, response, {
      text: info.selectionText,
      url: info.pageUrl ?? tab?.url,
      provider: isChatGptUrl(info.pageUrl ?? tab?.url) ? "chatgpt" : "web"
    });
    warnOnFailure(result);
    setPinnedCardFocus(result.cardId);
    return;
  }

  if (info.menuItemId === LINK_MENU_ID) {
    warnOnFailure(await pinWebResource(repository, {
      url: info.linkUrl,
      pageUrl: info.pageUrl,
      title: info.linkText
    }));
    return;
  }

  if (info.menuItemId === PAGE_MENU_ID) {
    warnOnFailure(await pinWebResource(repository, {
      url: info.pageUrl ?? tab?.url,
      pageUrl: info.pageUrl ?? tab?.url,
      title: tab?.title
    }));
    return;
  }

  if (info.menuItemId === IMAGE_MENU_ID) {
    const result = await captureContextImage(tab, info.srcUrl, info.frameId, info.targetElementId);
    if (!result.ok) {
      warnOnFailure(result);
      return;
    }
    const pinned = await pinImage(repository, {
      image: result.image,
      url: result.imageUrl,
      pageUrl: info.pageUrl ?? tab?.url,
      alt: result.alt
    });
    warnOnFailure(pinned);
    setPinnedCardFocus(pinned.cardId);
  }
});

if (browser.pageAction?.onClicked) {
  browser.pageAction.onClicked.addListener(async (tab: { url?: string; title?: string }) => {
    warnOnFailure(await pinWebResource(repository, {
      url: tab.url,
      pageUrl: tab.url,
      title: tab.title
    }));
  });
}

browser.commands.onCommand.addListener(async (command: string, tab: any) => {
  if (command === PIN_PAGE_COMMAND) {
    warnOnFailure(await pinWebResource(repository, {
      url: tab.url,
      pageUrl: tab.url,
      title: tab.title
    }));
    return;
  }

  if (command !== PIN_SELECTION_COMMAND || tab.id === undefined) return;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      // Firefox returns this value in InjectionResult.result. The installed
      // WebExtension types currently narrow injected functions to void.
      func: (() => window.getSelection()?.toString() ?? "") as unknown as () => void
    });
    const result = await pinSelection(repository, undefined, {
      text: firstSelectedText(results),
      url: tab.url,
      provider: isChatGptUrl(tab.url) ? "chatgpt" : "web"
    });
    warnOnFailure(result);
    setPinnedCardFocus(result.cardId);
  } catch {
    warnOnFailure({ ok: false, reason: "The selected text cannot be read on this page." });
  }
});

browser.runtime.onMessage.addListener((message: unknown) => {
  if (isCaptureRegionMessage(message)) return capturePageRegion(browser as unknown as PageCaptureApi);
  if (isToolbarPinMessage(message)) {
    if (message.type === "GET_TOOLBAR_PIN_CONTEXT") return getToolbarPinContext(browser as unknown as PinApi);
    return pinFromToolbar(browser as unknown as PinApi, repository, message.kind).then((result) => {
      setPinnedCardFocus(result.cardId);
      return result;
    });
  }
  return handleDriveSyncMessage(message);
});

async function captureContextImage(
  tab: { id?: number; windowId?: number; url?: string; title?: string } | undefined,
  imageUrl?: string,
  frameId?: number,
  targetElementId?: number
): Promise<{ ok: true; image: BoardImage; imageUrl?: string; alt?: string } | { ok: false; reason: string }> {
  if (!tab?.id || tab.windowId === undefined) return { ok: false, reason: "No active web page is available." };
  let results;
  try {
    results = await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId ?? 0] },
      args: [imageUrl ?? null, targetElementId ?? null],
      func: findContextImage as unknown as (url?: string | null, elementId?: number | null) => void
    });
  } catch {
    return { ok: false, reason: "The image could not be captured on this page." };
  }
  const region = firstCaptureImageRegion(results);
  if (!region) return { ok: false, reason: "The selected image is no longer visible." };
  let screenshot: string;
  try {
    screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    return { ok: false, reason: "The image could not be captured. Try again." };
  }
  try {
    const image = await cropCapturedImage(screenshot, region);
    return { ok: true, image, imageUrl: region.sourceUrl, alt: region.alt };
  } catch {
    return { ok: false, reason: "The image could not be processed." };
  }
}

function isChatGptUrl(value?: string): boolean {
  if (!value) return false;
  try {
    return new Set(["chatgpt.com", "chat.openai.com"]).has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function warnOnFailure(result: { ok: boolean; reason?: string }) {
  if (!result.ok) console.warn(`Pboard: ${result.reason}`);
}

function setPinnedCardFocus(cardId: string | undefined) {
  if (!cardId) return;
  void browser.storage.local.set({ [PINNED_CARD_FOCUS_KEY]: cardId });
}

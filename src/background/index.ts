import type { CaptureSelectionResponse } from "../messaging/messages";
import { repository } from "../storage/browser";
import { pinSelection, pinWebResource } from "./handlers";
import {
  firstSelectedText,
  PIN_PAGE_COMMAND,
  PIN_PAGE_SHORTCUT,
  PIN_SELECTION_COMMAND,
  PIN_SELECTION_SHORTCUT
} from "./shortcuts";

const SELECTION_MENU_ID = "pin-selection-to-pboard";
const LINK_MENU_ID = "pin-link-to-pboard";
const PAGE_MENU_ID = "pin-page-to-pboard";
const WEB_PAGES = ["http://*/*", "https://*/*"];

browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll().then(() => {
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
  });
});

browser.menus.onClicked.addListener(async (info, tab) => {
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
  }
});

browser.pageAction.onClicked.addListener(async (tab) => {
  warnOnFailure(await pinWebResource(repository, {
    url: tab.url,
    pageUrl: tab.url,
    title: tab.title
  }));
});

browser.commands.onCommand.addListener(async (command, tab) => {
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
    warnOnFailure(await pinSelection(repository, undefined, {
      text: firstSelectedText(results),
      url: tab.url,
      provider: isChatGptUrl(tab.url) ? "chatgpt" : "web"
    }));
  } catch {
    warnOnFailure({ ok: false, reason: "The selected text cannot be read on this page." });
  }
});

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

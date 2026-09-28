import { pinSelection, pinWebResource, isWebUrl } from "./handlers";
import { firstSelectedText } from "./shortcuts";
import type { ToolbarPinContext, ToolbarPinKind, ToolbarPinResponse } from "../messaging/messages";

export type PagePinTarget = { selectionText?: string; linkUrl?: string; linkText?: string };

// This function is injected into the page, so it must remain self-contained.
export function readPagePinTarget(): PagePinTarget {
  const selection = window.getSelection();
  let selectionText = selection?.toString().trim() || "";
  const active = document.activeElement;
  if (!selectionText && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start !== null && end !== null && end > start) selectionText = active.value.slice(start, end).trim();
  }
  const selectedNode = selection?.anchorNode;
  const selectedElement = selectedNode instanceof Element ? selectedNode : selectedNode?.parentElement;
  const link = (selectedElement?.closest("a[href]") ||
    (active instanceof Element ? active.closest("a[href]") : null)) as HTMLAnchorElement | null;
  return {
    selectionText: selectionText || undefined,
    linkUrl: link?.href,
    linkText: link?.textContent?.trim() || undefined
  };
}

type Tab = { id?: number; url?: string; title?: string };
export type PinApi = {
  tabs: { query(details: { active: boolean; currentWindow: boolean }): Promise<Tab[]> };
  scripting: { executeScript(details: { target: { tabId: number; allFrames: boolean }; func: () => PagePinTarget }): Promise<Array<{ result?: PagePinTarget }>> };
};
type PinRepository = Parameters<typeof pinSelection>[0];

async function activePage(api: PinApi) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function pageTargets(api: PinApi, tab: Tab): Promise<PagePinTarget[] | null> {
  if (tab.id === undefined) return null;
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: readPagePinTarget
    });
    return results.map(({ result }) => result ?? {});
  } catch {
    return null;
  }
}

export async function getToolbarPinContext(api: PinApi): Promise<ToolbarPinContext> {
  const tab = await activePage(api);
  const page = isWebUrl(tab?.url);
  if (!page || !tab) return { page: false, selection: false, link: false, accessible: true };
  const targets = await pageTargets(api, tab);
  return {
    page,
    selection: Boolean(targets?.some((target) => target.selectionText?.trim())),
    link: Boolean(targets?.some((target) => isWebUrl(target.linkUrl))),
    accessible: targets !== null
  };
}

export async function pinFromToolbar(api: PinApi, repository: PinRepository, kind: ToolbarPinKind): Promise<ToolbarPinResponse & { cardId?: string }> {
  const tab = await activePage(api);
  if (!isWebUrl(tab?.url) || !tab) return { ok: false, reason: "No active web page is available." };
  const pageUrl = tab.url!;
  if (kind === "page") return pinWebResource(repository, { url: tab.url, pageUrl: tab.url, title: tab.title });
  const targets = await pageTargets(api, tab);
  if (!targets) return { ok: false, reason: "Page access is required to read the selection or link." };
  if (kind === "selection") {
    const text = firstSelectedText(targets.map((target) => ({ result: target.selectionText })));
    return pinSelection(repository, undefined, {
      text,
      url: tab.url,
      provider: new Set(["chatgpt.com", "chat.openai.com"]).has(new URL(pageUrl).hostname) ? "chatgpt" : "web"
    });
  }
  const link = targets.find((target) => isWebUrl(target.linkUrl));
  if (!link) return { ok: false, reason: "No link is selected or focused on the page." };
  return pinWebResource(repository, { url: link.linkUrl, pageUrl: tab.url, title: link.linkText });
}

import type { CaptureSelectionResponse } from "../messaging/messages";
import type { BoardImage, BoardItem } from "../types";

type Repository = {
  load(): Promise<{ currentProjectId: string | null }>;
  addItem(input: {
    projectId: string;
    content: string;
    title?: string;
    type?: BoardItem["type"];
    status?: BoardItem["status"];
    source?: BoardItem["source"];
    image?: BoardImage;
  }): Promise<BoardItem>;
};

export async function pinSelection(
  repository: Repository,
  response: CaptureSelectionResponse | undefined,
  fallback: { text?: string; url?: string; provider?: string } = {}
): Promise<{ ok: boolean; reason?: string; cardId?: string }> {
  const state = await repository.load();
  if (!state.currentProjectId) return { ok: false, reason: "Create or select a project in the sidebar first." };

  const text = response?.ok ? response.selection.sourceText : fallback.text?.trim();
  if (!text) return { ok: false, reason: response && !response.ok ? response.reason : "No text is selected." };
  const provider = response?.ok ? response.selection.provider : fallback.provider ?? "web";
  const conversationUrl = response?.ok ? response.selection.conversationUrl : fallback.url;

  const created = await repository.addItem({
    projectId: state.currentProjectId,
    content: text,
    type: "note",
    status: "candidate",
    source: { provider, conversationUrl, sourceText: text }
  });
  return { ok: true, cardId: created.id };
}

export async function pinWebResource(
  repository: Repository,
  input: { url?: string; pageUrl?: string; title?: string }
): Promise<{ ok: boolean; reason?: string }> {
  const state = await repository.load();
  if (!state.currentProjectId) return { ok: false, reason: "Create or select a project in the sidebar first." };
  if (!input.url || !isWebUrl(input.url)) return { ok: false, reason: "Only HTTP and HTTPS links can be pinned." };

  const title = input.title?.trim();
  await repository.addItem({
    projectId: state.currentProjectId,
    content: input.url,
    ...(title && title !== input.url ? { title } : {}),
    type: "reference",
    status: "candidate",
    source: {
      provider: "web",
      conversationUrl: input.pageUrl && isWebUrl(input.pageUrl) ? input.pageUrl : input.url,
      sourceText: input.url
    }
  });
  return { ok: true };
}

export async function pinImage(
  repository: Repository,
  input: { image: BoardImage; url?: string; pageUrl?: string; alt?: string }
): Promise<{ ok: boolean; reason?: string; cardId?: string }> {
  const state = await repository.load();
  if (!state.currentProjectId) return { ok: false, reason: "Create or select a project in the sidebar first." };
  if (!input.image?.dataUrl) return { ok: false, reason: "The image could not be captured." };

  const url = input.url?.trim();
  const alt = input.alt?.trim();
  const content = alt || url || "Pinned image";
  const created = await repository.addItem({
    projectId: state.currentProjectId,
    content,
    ...(alt ? { title: alt } : {}),
    type: "reference",
    status: "candidate",
    image: input.image,
    source: {
      provider: "web",
      conversationUrl: input.pageUrl && isWebUrl(input.pageUrl) ? input.pageUrl : url,
      sourceText: url || content
    }
  });
  return { ok: true, cardId: created.id };
}

export function isWebUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

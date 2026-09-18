import type { CaptureSelectionResponse } from "../messaging/messages";
import type { ChatProviderAdapter } from "../providers/provider";

export function captureSelection(adapter: ChatProviderAdapter | null): CaptureSelectionResponse {
  if (!adapter || !adapter.isSupportedPage()) return { ok: false, reason: "Unsupported page" };
  const sourceText = adapter.getSelectedText();
  if (!sourceText) return { ok: false, reason: "No text is selected" };
  return {
    ok: true,
    selection: {
      provider: "chatgpt",
      sourceText,
      conversationUrl: adapter.getConversationUrl()
    }
  };
}

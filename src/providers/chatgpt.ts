import type { ChatProviderAdapter } from "./provider";

const SUPPORTED_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

export class ChatGptAdapter implements ChatProviderAdapter {
  constructor(
    private readonly pageWindow: Window = window,
    private readonly pageDocument: Document = document
  ) {}

  isSupportedPage(): boolean {
    return this.pageWindow.location.protocol === "https:" && SUPPORTED_HOSTS.has(this.pageWindow.location.hostname);
  }

  getConversationUrl(): string {
    return this.pageWindow.location.href;
  }

  getSelectedText(): string | null {
    if (!this.isSupportedPage()) return null;
    const text = this.pageWindow.getSelection?.()?.toString().trim();
    if (text) return text;

    const active = this.pageDocument.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start !== null && end !== null && end > start) return active.value.slice(start, end).trim() || null;
    }
    return null;
  }
}

export type CapturedSelection = {
  provider: string;
  sourceText: string;
  conversationUrl: string;
};

export interface ChatProviderAdapter {
  isSupportedPage(): boolean;
  getConversationUrl(): string;
  getSelectedText(): string | null;
}

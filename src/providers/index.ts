import { ChatGptAdapter } from "./chatgpt";
import type { ChatProviderAdapter } from "./provider";

export function getProviderAdapter(): ChatProviderAdapter | null {
  const adapter = new ChatGptAdapter();
  return adapter.isSupportedPage() ? adapter : null;
}

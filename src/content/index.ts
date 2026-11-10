import { isRuntimeMessage } from "../messaging/messages";
import { respondWith } from "../messaging/respond";
import { getProviderAdapter } from "../providers";
import { captureSelection } from "./selection";
import { browser } from "../platform/browser";

browser.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
  return respondWith(sendResponse, () => isRuntimeMessage(message) ? captureSelection(getProviderAdapter()) : undefined);
});

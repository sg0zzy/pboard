import { isRuntimeMessage } from "../messaging/messages";
import { getProviderAdapter } from "../providers";
import { captureSelection } from "./selection";

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isRuntimeMessage(message)) return undefined;
  return Promise.resolve(captureSelection(getProviderAdapter()));
});

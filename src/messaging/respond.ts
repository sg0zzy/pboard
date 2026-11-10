export type ResponseSender = (response?: unknown) => void;

/**
 * `onMessage` listeners must keep Chrome's message port open until they
 * answer, so a promise return alone is not reliable across browsers. The
 * listener returns `true` only for messages this Pboard context owns.
 */
export function respondWith(sendResponse: ResponseSender, handler: () => unknown): boolean {
  try {
    const result = handler();
    if (result === undefined) return false;
    Promise.resolve(result).then(sendResponse).catch((error) =>
      sendResponse({ ok: false, reason: error instanceof Error ? error.message : String(error) })
    );
    return true;
  } catch (error) {
    sendResponse({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

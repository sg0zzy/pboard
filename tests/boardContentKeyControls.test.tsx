// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BoardContentKey } from "../src/sync/bufferCrypto";
import type { ContentKeyStore } from "../src/storage/contentKeyStore";
import { BoardContentKeyControls } from "../src/sidebar/components/BoardContentKeyControls";
let node: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...node.querySelectorAll("button")].find(button => button.textContent === label)!;
const field = (label: string) => node.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;
const status = () => node.querySelector('[role="status"]')?.textContent ?? "";
async function paste(label: string, value: string) {
  await act(async () => {
    const el = field(label);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const imported: BoardContentKey = { keyId: "key-1", key: {} as unknown as CryptoKey };
function fakeKeys(loadRaw: ContentKeyStore["loadRaw"], put: ContentKeyStore["put"]): ContentKeyStore {
  return { get: vi.fn(async () => undefined), loadRaw, ensure: vi.fn(async () => { throw new Error("the hand-off panel must not provision a key"); }), put, remove: vi.fn(async () => {}) };
}
it("reports a missing key instead of provisioning one, and copies nothing", async () => {
  const loadRaw = vi.fn(async () => undefined);
  const put = vi.fn(async (): Promise<BoardContentKey> => imported);
  await act(async () => { root.render(<BoardContentKeyControls projectId="board" onChanged={() => {}} keys={fakeKeys(loadRaw, put)} />); });
  await act(async () => { button("Show board content key").click(); });
  expect(loadRaw).toHaveBeenCalledWith("board");
  expect(node.textContent).toContain("This device has no content key for this board");
  expect(node.textContent).toContain("Use pasted content key");
  expect(field("Board content key output")).toBeNull();
  expect(put).not.toHaveBeenCalled();
  expect(button("Show board content key").disabled).toBe(false);
});
it("reveals a stored key only in the read-only copy field, never in the status message", async () => {
  const material = "s7Kd0mV2pX9tLb4Qw1eRjN6yHa8cU3fZg5iO0kTnBqM";
  const loadRaw = vi.fn(async () => ({ material, keyId: "key-1" }));
  const put = vi.fn(async (): Promise<BoardContentKey> => imported);
  await act(async () => { root.render(<BoardContentKeyControls projectId="board" onChanged={() => {}} keys={fakeKeys(loadRaw, put)} />); });
  expect(field("Board content key output")).toBeNull();
  await act(async () => { button("Show board content key").click(); });
  expect(loadRaw).toHaveBeenCalledWith("board");
  expect(field("Board content key output").value).toBe(material);
  expect(field("Board content key output").readOnly).toBe(true);
  expect(status()).not.toContain(material);
  expect(node.textContent).toContain("never included in board exports or grant bundles");
  expect(put).not.toHaveBeenCalled();
});
it("imports a pasted key with the board id and notifies the board", async () => {
  const material = "Y3VzdG9tLW1hdGVyaWFsLWZyb20tdGhlLW90aGVyLWRldmljZQ";
  const loadRaw = vi.fn(async () => undefined);
  const put = vi.fn(async (): Promise<BoardContentKey> => imported);
  const changed = vi.fn();
  await act(async () => { root.render(<BoardContentKeyControls projectId="board" onChanged={changed} keys={fakeKeys(loadRaw, put)} />); });
  await paste("Board content key input", material);
  await act(async () => { button("Use pasted content key").click(); });
  expect(put).toHaveBeenCalledWith("board", material);
  expect(changed).toHaveBeenCalledOnce();
  expect(loadRaw).not.toHaveBeenCalled();
  expect(status()).not.toContain(material);
  expect(button("Use pasted content key").disabled).toBe(false);
});
it("keeps a rejected paste out of the store, out of the status message, and away from onChanged", async () => {
  const material = "not-a-board-content-key-material";
  const loadRaw = vi.fn(async () => undefined);
  const put = vi.fn(async (): Promise<BoardContentKey> => { throw new Error("AES-GCM key import failed"); });
  const changed = vi.fn();
  await act(async () => { root.render(<BoardContentKeyControls projectId="board" onChanged={changed} keys={fakeKeys(loadRaw, put)} />); });
  await paste("Board content key input", material);
  await act(async () => { button("Use pasted content key").click(); });
  expect(put).toHaveBeenCalledWith("board", material);
  expect(changed).not.toHaveBeenCalled();
  expect(node.textContent).toContain("not a usable board content key");
  expect(status()).not.toContain(material);
  expect(field("Board content key output")).toBeNull();
});

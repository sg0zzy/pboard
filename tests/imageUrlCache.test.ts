// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let created: string[]; let revoked: string[]; let counter = 0;
beforeEach(() => {
  created = []; revoked = []; counter = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => { const url = `blob:mock/${(counter += 1)}`; created.push(url); return url; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

async function fresh() { return import("../src/sidebar/imageUrlCache"); }

it("hands every holder of an image id the same URL and never revokes it while held", async () => {
  const { acquireImageUrl, peekImageUrl, releaseImageUrl } = await fresh();
  const blob = new Blob(["x"], { type: "image/png" });
  const first = acquireImageUrl("img-1", blob);
  const second = acquireImageUrl("img-1", blob);
  expect(second).toBe(first);
  expect(created).toHaveLength(1);
  expect(peekImageUrl("img-1")).toBe(first);
  releaseImageUrl("img-1");
  expect(peekImageUrl("img-1")).toBe(first);
  expect(revoked).toEqual([]);
  releaseImageUrl("img-1");
  expect(revoked).toEqual([]); // Idle, but still cached; only the idle cap revokes.
  expect(peekImageUrl("img-1")).toBe(first);
});

it("evicts idle entries beyond the cap without touching active holders", async () => {
  const { acquireImageUrl, peekImageUrl, releaseImageUrl } = await fresh();
  const blob = new Blob(["x"]);
  const held = acquireImageUrl("held", blob);
  const firstIdle = acquireImageUrl("img-0", blob);
  releaseImageUrl("img-0");
  for (let i = 1; i <= 513; i++) { acquireImageUrl(`img-${i}`, blob); releaseImageUrl(`img-${i}`); }
  expect(peekImageUrl("img-0")).toBeNull(); // The oldest idle entries made way for newer ones.
  expect(revoked).toContain(firstIdle);
  expect(peekImageUrl("held")).toBe(held); // An entry with an active holder is never revoked.
  expect(revoked).not.toContain(held);
});

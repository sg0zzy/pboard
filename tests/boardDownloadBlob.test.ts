// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { downloadBlob } from "../src/sidebar/download";

describe("downloadBlob", () => {
  let capturedBlob: Blob | undefined;
  let createObjectURL: Mock<(blob: Blob) => string>;
  let revokeObjectURL: Mock<() => void>;
  let click: MockInstance;

  beforeEach(() => {
    capturedBlob = undefined;
    createObjectURL = vi.fn((blob: Blob) => { capturedBlob = blob; return "blob:board-zip"; });
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL: createObjectURL, revokeObjectURL });
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    click.mockRestore();
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
  });

  it("starts the download with the zip bytes only after the archive is complete", () => {
    const data = new Uint8Array([80, 75, 3, 4]);
    downloadBlob("My Board.zip", data);
    expect(capturedBlob?.type).toBe("application/zip");
    void capturedBlob?.arrayBuffer().then((buffer) => expect(new Uint8Array(buffer)).toEqual(data));
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("My Board.zip");
    expect(anchor.href).toBe("blob:board-zip");
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:board-zip");
  });
});

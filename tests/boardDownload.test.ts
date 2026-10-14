import { describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import { buildBoardArchive } from "../src/sidebar/download";
import { serializeBoard } from "../src/sidebar/serialize";
import type { StoredBlob } from "../src/storage/blobStore";
import type { BoardItem, Project } from "../src/types";

const project: Project = { id: "p1", name: "New SaaS", template: "project", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const base: Omit<BoardItem, "id" | "type" | "content" | "order" | "status"> = {
  projectId: "p1", createdAt: "2026-01-01", updatedAt: "2026-01-01"
};

function storedBlob(imageId: string, mimeType: string, bytes: number[]): StoredBlob {
  return { imageId, blob: new Blob([new Uint8Array(bytes)], { type: mimeType }), mimeType, width: 10, height: 10, size: bytes.length };
}

describe("buildBoardArchive", () => {
  it("zips the exact copy-board prompt under board.txt", async () => {
    const items: BoardItem[] = [
      { ...base, id: "1", type: "goal", status: "candidate", order: 0, content: "Keep what matters." }
    ];
    const archive = await buildBoardArchive(project, items, async () => null);
    expect(archive.filename).toBe("New SaaS.zip");
    const files = unzipSync(archive.data);
    expect(Object.keys(files)).toEqual(["board.txt"]);
    expect(new TextDecoder().decode(files["board.txt"])).toBe(serializeBoard(project, items));
  });

  it("includes card images with an extension per mime type", async () => {
    const items: BoardItem[] = [
      { ...base, id: "shot", type: "reference", status: "confirmed", order: 0, content: "Screenshot", imageId: "abc" }
    ];
    const archive = await buildBoardArchive(project, items, async () => storedBlob("abc", "image/webp", [1, 2, 3]));
    const files = unzipSync(archive.data);
    expect(Object.keys(files).sort()).toEqual(["board.txt", "images/shot-1.webp"]);
    expect(Array.from(files["images/shot-1.webp"]!)).toEqual([1, 2, 3]);
  });

  it("stores a shared image once and skips missing image data", async () => {
    const items: BoardItem[] = [
      { ...base, id: "a", type: "reference", status: "candidate", order: 0, content: "A", imageId: "shared" },
      { ...base, id: "b", type: "reference", status: "candidate", order: 1, content: "B", imageId: "shared" },
      { ...base, id: "c", type: "reference", status: "candidate", order: 2, content: "C", imageId: "gone" }
    ];
    const getImage = vi.fn(async (imageId: string) => imageId === "shared" ? storedBlob("shared", "image/png", [9]) : null);
    const files = unzipSync((await buildBoardArchive(project, items, getImage)).data);
    expect(Object.keys(files).sort()).toEqual(["board.txt", "images/a-1.png"]);
    expect(getImage).toHaveBeenCalledTimes(2);
  });

  it("excludes trash cards and embeds legacy inline image data", async () => {
    const pngDataUrl = `data:image/png;base64,${btoa("inline-png")}`;
    const items: BoardItem[] = [
      { ...base, id: "kept", type: "reference", status: "candidate", order: 0, content: "Kept",
        image: { dataUrl: pngDataUrl, mimeType: "image/png", width: 4, height: 4 } },
      { ...base, id: "gone", type: "reference", status: "trash", order: 1, content: "Trash", imageId: "x" }
    ];
    const files = unzipSync((await buildBoardArchive(project, items, async () => storedBlob("x", "image/png", [1]))).data);
    expect(Object.keys(files).sort()).toEqual(["board.txt", "images/kept-1.png"]);
    expect(new TextDecoder().decode(files["board.txt"])).not.toContain("Trash");
    expect(new TextDecoder().decode(files["images/kept-1.png"])).toBe("inline-png");
  });

  it("slugs the project name for the zip filename", async () => {
    const archive = await buildBoardArchive({ ...project, name: "AI/Board: v2 " }, [], async () => null);
    expect(archive.filename).toBe("AI-Board- v2.zip");
    expect((await buildBoardArchive({ ...project, name: "///" }, [], async () => null)).filename).toBe("board.zip");
  });
});

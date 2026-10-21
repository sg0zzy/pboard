import { strToU8, zipSync } from "fflate";
import type { StoredBlob } from "../storage/blobStore";
import type { BoardItem, Project } from "../types";
import { serializeBoard } from "./serialize";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg"
};

export type BoardArchive = { filename: string; data: Uint8Array<ArrayBuffer> };

export function boardArchiveFileName(project: Project): string {
  const slug = project.name.trim().replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(/^[-]+|[- .]+$/g, "");
  return `${slug || "board"}.zip`;
}

/**
 * Zips the exact "Copy board" prompt (`board.txt`) plus every card image the
 * board displays under `images/`. Trash cards are excluded, a shared image is
 * stored once, and missing image data is skipped so the text export never fails.
 */
export async function buildBoardArchive(
  project: Project,
  items: BoardItem[],
  getImage: (imageId: string) => Promise<StoredBlob | null>
): Promise<BoardArchive> {
  const files: Record<string, Uint8Array> = { "board.txt": strToU8(serializeBoard(project, items)) };
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.status === "trash") continue;
    const key = item.imageId ?? (item.image ? `data:${item.image.dataUrl}` : null);
    if (key === null || seen.has(key)) continue;
    const entry = item.imageId
      ? await getImage(item.imageId)
      : item.image
        ? { blob: await (await fetch(item.image.dataUrl)).blob(), mimeType: item.image.mimeType }
        : null;
    if (!entry) continue;
    const extension = IMAGE_EXTENSIONS[entry.mimeType] ?? entry.mimeType.split("/")[1]?.split("+")[0] ?? "img";
    const name = `images/${item.id}-${seen.size + 1}.${extension}`;
    seen.set(key, name);
    files[name] = new Uint8Array(await entry.blob.arrayBuffer());
  }
  files["board.json"] = strToU8(JSON.stringify({
    format: "pboard-download", version: 1, name: project.name, template: project.template,
    cards: [...items].filter(item => item.status !== "trash").sort((a, b) => a.order - b.order).map(item => ({
      type: item.type, status: item.status, title: item.title, content: item.content,
      displayMode: item.displayMode, source: item.source,
      imagePath: seen.get(item.imageId ?? (item.image ? `data:${item.image.dataUrl}` : "")),
      imageWidth: item.image?.width ?? item.imageWidth,
      imageHeight: item.image?.height ?? item.imageHeight
    }))
  }));
  return { filename: boardArchiveFileName(project), data: zipSync(files) };
}

/** Starts the browser download only once the whole zip is in memory. */
export function downloadBlob(filename: string, data: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

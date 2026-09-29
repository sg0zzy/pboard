import { createRxRepository } from "../../src/storage/rxdbRepository";
import { createIndexedDbBlobStore } from "../../src/storage/blobStore";
import { initialOrderKeys } from "../../src/storage/orderKey";

type Sample = Record<string, number | string | null>;
const output = document.getElementById("results")!;
const runId = Date.now().toString(36);
const clock = async <T>(run: () => Promise<T>): Promise<{ ms: number; result: T }> => {
  const start = performance.now();
  const result = await run();
  return { ms: Math.round((performance.now() - start) * 100) / 100, result };
};
const memory = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
const rows: Sample[] = [];
try {
  for (const count of [100, 1000, 5000]) {
    const usageBefore = (await navigator.storage.estimate()).usage ?? 0;
    const name = `pboardbrowserbench${runId}${count}`;
    const blobs = createIndexedDbBlobStore(`${name}images`);
    const opened = await clock(() => createRxRepository({ name, blobs }));
    let rx = opened.result;
    const project = await rx.createProject("Benchmark");
    const other = await rx.createProject("Other");
    const keys = initialOrderKeys(count);
    const cards = Array.from({ length: count }, (_, index) => ({
      id: `card-${String(index).padStart(6, "0")}`, projectId: project.id, type: "note" as const,
      content: `Card ${index}: ${"text ".repeat(16)}`, status: "candidate" as const,
      orderKey: keys[index], displayMode: "standard" as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    const inserted = await clock(() => rx.db.cards.bulkInsert(cards));
    if (inserted.result.error.length) throw inserted.result.error[0];
    await (await rx.db.projects.findOne(project.id).exec())?.incrementalPatch({ tailOrderKey: keys.at(-1) });
    const bytes = new Uint8Array(128 * 1024);
    crypto.getRandomValues(bytes.subarray(0, 65536));
    crypto.getRandomValues(bytes.subarray(65536));
    const image = { dataUrl: `data:image/webp;base64,${btoa(String.fromCharCode(...bytes.subarray(0, 65536)) + String.fromCharCode(...bytes.subarray(65536)))}`,
      mimeType: "image/webp", width: 500, height: 300 };
    const imageCount = count === 100 ? 10 : 100;
    const images = await clock(async () => {
      for (let index = 0; index < imageCount; index++) {
        // Different content IDs so this measures actual image count, not only deduplication.
        const variant = { ...image, dataUrl: image.dataUrl.slice(0, -4) + btoa(String.fromCharCode(index, 0, 0)) };
        await rx.putImage(variant);
      }
    });
    const current = await clock(() => rx.getCurrentProject());
    const switched = await clock(async () => { await rx.selectProject(other.id); await rx.getCurrentProject(); await rx.selectProject(project.id); });
    const added = await clock(() => rx.addItem({ projectId: project.id, content: "Added" }));
    const edited = await clock(() => rx.updateItem(added.result.id, { content: "Edited" }));
    const status = await clock(() => rx.updateItem(added.result.id, { status: "done" }));
    const ordered = await rx.listCards(project.id);
    const target = ordered[ordered.length - 1].id;
    const moved = await clock(() => rx.moveItem(project.id, target, [target, ...ordered.filter((card) => card.id !== target).map((card) => card.id)]));
    const imageCard = await rx.addItem({ projectId: project.id, content: "Image", image });
    const duplicated = await clock(() => rx.duplicateItem(imageCard.id));
    const imageLoaded = await clock(() => rx.getImage(imageCard.imageId!));
    const projectQuery = await clock(() => rx.listCards(project.id));
    const heapBeforeClose = memory();
    await rx.db.close();
    const reopened = await clock(() => createRxRepository({ name, blobs }));
    rx = reopened.result;
    const reloaded = await clock(() => rx.listCards(project.id));
    const quota = await navigator.storage.estimate();
    rows.push({ cards: count, images: imageCount, openMs: opened.ms, insertMs: inserted.ms,
      imagesMs: images.ms, currentProjectMs: current.ms, switchMs: switched.ms,
      addMs: added.ms, textMs: edited.ms, statusMs: status.ms, moveMs: moved.ms,
      duplicateImageMs: duplicated.ms, imageLoadMs: imageLoaded.ms,
      projectQueryMs: projectQuery.ms, reopenMs: reopened.ms, reloadMs: reloaded.ms,
      reloadCount: reloaded.result.length, storageDeltaBytes: quota.usage === undefined ? null : quota.usage - usageBefore,
      heapBytes: heapBeforeClose });
    output.textContent = JSON.stringify(rows, null, 2);
    await rx.db.close();
  }
  output.dataset.done = "true";
} catch (error) {
  output.dataset.done = "error";
  output.textContent = `${error instanceof Error ? error.stack : String(error)}\n\n${JSON.stringify(rows, null, 2)}`;
}

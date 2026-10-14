import type { RxReplicationHandler } from "rxdb";

/** Fill a project batch before reporting that the remote change log is exhausted. */
export function scopeMasterChanges<T, Checkpoint>(
  handler: Pick<RxReplicationHandler<T, Checkpoint>, "masterChangesSince">,
  includes: (doc: unknown) => boolean
): void {
  const read = handler.masterChangesSince.bind(handler);
  handler.masterChangesSince = async (checkpoint, batchSize) => {
    const documents: Awaited<ReturnType<typeof read>>["documents"] = [];
    let next = checkpoint;
    while (true) {
      const remaining = batchSize - documents.length;
      const result = await read(next, remaining);
      documents.push(...result.documents.filter(includes));
      // RxDB treats a short batch as the end of the log. Only the unfiltered
      // length can establish that; unrelated documents must not end catch-up.
      if (documents.length === batchSize || result.documents.length < remaining) {
        return { ...result, documents };
      }
      next = result.checkpoint;
    }
  };
}

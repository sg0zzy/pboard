import type { RxReplicationHandler, RxReplicationPullStreamItem } from "rxdb";
import { Observable, type OperatorFunction } from "rxjs";

/**
 * Fill a project batch before reporting that the remote change log is exhausted,
 * and filter the *live* master change stream the same way: private documents
 * must never be serialized to a peer just because the stream bypasses catch-up
 * reads. Both directions wrap the same `includes` predicate.
 */
export function scopeMasterChanges<T, Checkpoint>(
  handler: Pick<RxReplicationHandler<T, Checkpoint>, "masterChangesSince"> & {
    /** Present on the master handler; streams every master change event. */
    masterChangeStream$?: Observable<RxReplicationPullStreamItem<T, Checkpoint>>;
  },
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
  // Live outgoing stream: private documents must never leave the device. The
  // unfiltered stream would serialize every project's changes to the peer.
  const stream = handler.masterChangeStream$;
  if (stream) {
    const tapScoped: OperatorFunction<RxReplicationPullStreamItem<T, Checkpoint>, RxReplicationPullStreamItem<T, Checkpoint>> = (source) =>
      new Observable<RxReplicationPullStreamItem<T, Checkpoint>>((subscriber) => {
        return source.subscribe({
          next: (event) => {
            if (event === "RESYNC") { subscriber.next(event); return; }
            const documents = Array.isArray(event.documents) ? event.documents : [];
            const scoped = (documents as unknown[]).filter(includes);
            if (scoped.length === 0) return; // Never emit an all-private bulk.
            subscriber.next({ ...event, documents: scoped as typeof event.documents });
          },
          error: (error: unknown) => subscriber.error(error),
          complete: () => subscriber.complete()
        });
      });
    // Replace the upstream subscription path: RxDB subscribes the field itself.
    Object.defineProperty(handler, "masterChangeStream$", { value: stream.pipe(tapScoped), configurable: true });
  }
}

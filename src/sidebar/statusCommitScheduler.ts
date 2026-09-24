import type { BoardItemStatus } from "../types";

type Commit = (itemId: string, status: BoardItemStatus) => void | Promise<void>;

type PendingCommit = {
  status: BoardItemStatus;
  timer: ReturnType<typeof setTimeout>;
};

export class StatusCommitScheduler {
  private readonly pending = new Map<string, PendingCommit>();

  constructor(private readonly delayMs: number) {}

  schedule(itemId: string, status: BoardItemStatus, commit: Commit) {
    this.cancel(itemId);
    const timer = setTimeout(() => {
      const current = this.pending.get(itemId);
      if (!current || current.timer !== timer || current.status !== status) return;
      this.pending.delete(itemId);
      void commit(itemId, status);
    }, this.delayMs);
    this.pending.set(itemId, { status, timer });
  }

  cancel(itemId: string) {
    const current = this.pending.get(itemId);
    if (current) clearTimeout(current.timer);
    this.pending.delete(itemId);
  }

  cancelAll() {
    this.pending.forEach(({ timer }) => clearTimeout(timer));
    this.pending.clear();
  }
}

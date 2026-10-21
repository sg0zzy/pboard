/**
 * UI responsiveness probe.
 *
 * Measures the sidebar's hot paths in a real browser: the cost of a local
 * card edit, how many repository re-reads that edit triggers, and how many
 * journal writes it produces. Every journal write notifies every
 * subscription, so the write count is the driver of the re-read count.
 */
import { createRxRepository } from "../../src/storage/rxdbRepository";

const rx = await createRxRepository({ name: "uiperfprobe" });
const project = await rx.createProject("Perf board", "project");

export type Counts = { listCards: number; listPendingWork: number; listProjects: number; listConflicts: number };
export type ProbeResult = {
  addMs: number;
  editMs: number;
  journalWrites: number;
  cardListRefreshes: number;
  pendingWorkRefreshes: number;
  counts: Counts;
};

const counts: Counts = { listCards: 0, listPendingWork: 0, listProjects: 0, listConflicts: 0 };

// Count the journal reads and writes. The subscriptions capture internal
// closures, so the journal is the only common seam: every subscription
// re-reads the journal on every notification.
type InstrumentedJournal = {
  write: (name: string, operation: (store: IDBObjectStore) => void) => Promise<void>;
  read: <T>(name: string, operation: (store: IDBObjectStore) => IDBRequest<T>) => Promise<T>;
};
let journalWrites = 0;
const journalReads: Record<string, number> = {};
const journal = rx.journal as unknown as InstrumentedJournal;
const originalWrite = journal.write.bind(journal);
const originalRead = journal.read.bind(journal);
journal.write = async (name, operation) => { journalWrites++; return originalWrite(name, operation); };
journal.read = async (name, operation) => { journalReads[name] = (journalReads[name] ?? 0) + 1; return originalRead(name, operation); };

let cardListRefreshes = 0;
let pendingWorkRefreshes = 0;
let projectListRefreshes = 0;

// The subscriptions the sidebar always mounts.
const stopCards = await rx.subscribeCards(project.id, () => { cardListRefreshes++; });
const stopPending = await rx.subscribePendingWork(() => { pendingWorkRefreshes++; });
const stopProjects = await rx.subscribeProjects(() => { projectListRefreshes++; });
await new Promise(resolve => setTimeout(resolve, 200));

const settle = () => new Promise(resolve => setTimeout(resolve, 400));

// --- one card add -------------------------------------------------------
const writesBeforeAdd = journalWrites;
const readsBeforeAdd = { ...journalReads };
const refreshesBeforeAdd = { cards: cardListRefreshes, pending: pendingWorkRefreshes, projects: projectListRefreshes };
const addBegan = performance.now();
await rx.addItem({ projectId: project.id, content: "First card" });
const addMs = performance.now() - addBegan;
await settle();
const addWrites = journalWrites - writesBeforeAdd;
const addReads = Object.fromEntries(Object.entries(journalReads).map(([name, value]) => [name, value - (readsBeforeAdd[name] ?? 0)]));
const addRefreshes = { cards: cardListRefreshes - refreshesBeforeAdd.cards, pending: pendingWorkRefreshes - refreshesBeforeAdd.pending, projects: projectListRefreshes - refreshesBeforeAdd.projects };

// --- one card edit ------------------------------------------------------
const card = await rx.addItem({ projectId: project.id, content: "Second card" });
await settle();
const writesBeforeEdit = journalWrites;
const readsBeforeEdit = { ...journalReads };
const refreshesBeforeEdit = { cards: cardListRefreshes, pending: pendingWorkRefreshes, projects: projectListRefreshes };
const editBegan = performance.now();
await rx.updateItem(card.id, { content: "Edited content" });
const editMs = performance.now() - editBegan;
await settle();
const editWrites = journalWrites - writesBeforeEdit;
const editReads = Object.fromEntries(Object.entries(journalReads).map(([name, value]) => [name, value - (readsBeforeEdit[name] ?? 0)]));
const editRefreshes = { cards: cardListRefreshes - refreshesBeforeEdit.cards, pending: pendingWorkRefreshes - refreshesBeforeEdit.pending, projects: projectListRefreshes - refreshesBeforeEdit.projects };

// --- a board with history ------------------------------------------------
// The cost of the conflict panel and the pending-work panel grows with the
// number of journal rows, so the same edit is measured again on a board that
// already holds a history.
const historyProject = await rx.createProject("History board", "project");
for (let index = 0; index < 40; index++) {
  const historic = await rx.addItem({ projectId: historyProject.id, content: `Card ${index}` });
  await rx.updateItem(historic.id, { content: `Card ${index} edited` });
}
await settle();
const writesBeforeHistory = journalWrites;
const readsBeforeHistory = { ...journalReads };
const historyBegan = performance.now();
const historyCard = await rx.addItem({ projectId: historyProject.id, content: "After history" });
const historyMs = performance.now() - historyBegan;
await settle();
const historyWrites = journalWrites - writesBeforeHistory;
const historyReads = Object.fromEntries(Object.entries(journalReads).map(([name, value]) => [name, value - (readsBeforeHistory[name] ?? 0)]));

stopCards();
stopPending();

const testWindow = window as typeof window & { probe: { done: boolean; result: unknown } };
testWindow.probe = {
  done: true,
  result: {
    addMs, editMs, journalWrites, cardListRefreshes, pendingWorkRefreshes, counts,
    addReads, editReads, addWrites, editWrites, addRefreshes, editRefreshes,
    historyMs, historyReads, historyWrites,
    totalReads: Object.values(journalReads).reduce((sum, value) => sum + value, 0)
  }
};

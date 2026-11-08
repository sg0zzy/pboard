/**
 * Cold load, measured in `/ws` upgrades: one browser context, five boards, no
 * more key-courier dials than there are rooms that need one.
 *
 * The field report this pins: a 40-minute window showed **80** `101` upgrades
 * through the proxy, **zero** of them refused, while only ~123 auth/session
 * events landed — and the identity-enrolment diagnostics fired at :53, :57,
 * :58.2, :58.9, :59.7, 00:06:24. Connections created and destroyed every few
 * seconds with no user action is *churn*, and the key courier was its largest
 * source: `keyCourierTransport.ts` opened one short-lived socket per pass, and
 * `runtime.ts` runs a pass from six places — including a 2-second debounced
 * foreign-row trigger.
 *
 * Measured before the queue (`tests/operations/keyCourierQueue.test.ts` carries
 * the unit half of the same claim; this is the end-to-end half), with a stack
 * captured at the socket constructor:
 *
 * | phase                   | courier dials before         | after                        |
 * |-------------------------|------------------------------|------------------------------|
 * | first board open        | 4 (`account` ×3, `attach` ×1)| 2 (`account` ×1, `attach` ×1)|
 * | each further board open | 2 (`account` ×1, `attach` ×1)| 1 (`attach` ×1)              |
 * | one reconcile round     | 1 (`account` ×1)             | 0                            |
 *
 * Five boards: **13 → 6**. The 6 are the five board rooms' own necessary attach
 * passes plus **one** account-room pass for the whole context, against the eight
 * the account room used to make. Nothing here asserts a duration: every wait
 * polls an observable this test owns, and the count is read from the relay's own
 * sockets, not from the client's bookkeeping.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowser, createCloud, logStatusOf, type BrowserHandle, type Cloud } from './fixtures/browser';

const OWNER = 'owner@example.com';
const BOARDS = 5;

/** Zero-delay task-queue polling of an observable this test owns. */
async function untilQuiet(predicate: () => boolean, turns = 40_000): Promise<boolean> {
  for (let turn = 0; turn < turns; turn++) {
    if (predicate()) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return predicate();
}

/**
 * Every socket the relay has ever constructed, by the courier actions it
 * carried.
 *
 * The relay is the independent answer. A courier exchange is recognisable on
 * the wire — it issues `publishDeviceKey`, which nothing else does — so a socket
 * that carried one *is* a courier dial, whatever the client believes. Sockets
 * are removed from `signaling.sockets` when they close, so the record is taken
 * from a subclass that keeps its own list rather than from the live set.
 */
type Dial = { actions: string[]; room: string };
const dials: Dial[] = [];

const COURIER_ACTIONS = new Set(['publishDeviceKey', 'listDeviceKeys', 'publishKeyGrants', 'fetchKeyGrants']);

describe('the key courier on a cold load', { timeout: 240_000 }, () => {
  let cloud: Cloud;
  let a: BrowserHandle;
  const boards: string[] = [];

  beforeAll(async () => {
    vi.stubGlobal('__PBOARD_DIAGNOSTICS__', true);
    cloud = createCloud();
    // The relay's own socket class, wrapped so every frame is visible here: the
    // count of courier dials must not depend on the client's instrumentation.
    const Base = cloud.signaling.WebSocket;
    const Instrumented = class extends Base {
      readonly record: Dial = { actions: [], room: '' };
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        dials.push(this.record);
      }
      async send(raw: string) {
        const message = JSON.parse(raw) as { type?: string; room?: string; request?: { action?: string; board?: string } };
        if (message.type === 'authenticate' || message.type === 'attach') this.record.room = String(message.room ?? '');
        if (message.type === 'sync') {
          const action = String(message.request?.action ?? '');
          this.record.actions.push(action);
          if (action === 'publishKeyGrants') this.record.room = String(message.request?.board ?? this.record.room);
        } else this.record.actions.push(String(message.type ?? ''));
        return await super.send(raw);
      }
    };
    Object.defineProperty(cloud.signaling, 'WebSocket', { value: Instrumented, configurable: true });
    a = await createBrowser({ label: 'A', email: OWNER, cloud });
    for (let index = 0; index < BOARDS; index++) {
      const board = await a.rx.createProject(`Cold load board ${index}`, 'project');
      await a.rx.addItem({ projectId: board.id, content: `card on board ${index}` });
      await a.runtime.googleDrive.syncProject(board.id, { force: true });
      boards.push(board.id);
    }
    // The seeding above runs no courier pass at all: creating a board writes
    // Drive and marks it dirty, and the relay is not touched until a board is
    // opened or a round runs.
    expect(courierDials()).toHaveLength(0);
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    vi.unstubAllGlobals();
  });

  /** Every dial that carried a courier action: one short-lived exchange each. */
  function courierDials(): Dial[] {
    return dials.filter(dial => dial.actions.some(action => COURIER_ACTIONS.has(action)));
  }

  it('opens one courier exchange per room, not one per trigger, across five boards', async () => {
    // One board's first open: the account room's pass and the board's own. Both
    // are necessary — the account room's content key and the board's are two
    // different keys — and neither is repeated by the other triggers that fire
    // in the same turn (three of them open the account channel).
    await a.runtime.collaborationManager.start(boards[0]);
    expect(await untilQuiet(() => logStatusOf(a, boards[0])?.phase === 'synced'),
      `board never synced: ${JSON.stringify(logStatusOf(a, boards[0]))}`).toBe(true);
    expect(courierDials().length, `first board: ${JSON.stringify(courierDials().map(d => d.actions))}`).toBe(2);

    // Each further board open: its own pass, and nothing for the account room —
    // a pass that resolved a key already answered the room, and the queue is what
    // makes the three account triggers one answer.
    for (const boardId of boards.slice(1)) {
      await a.runtime.collaborationManager.start(boardId);
      expect(await untilQuiet(() => logStatusOf(a, boardId)?.phase === 'synced'),
        `board never synced: ${JSON.stringify(logStatusOf(a, boardId))}`).toBe(true);
    }
    const afterOpens = courierDials().length;
    expect(afterOpens, `five boards opened: ${JSON.stringify(courierDials().map(d => d.actions))}`).toBe(BOARDS + 1);

    // A reconcile round is maintenance with nothing new to say: a pass that
    // already resolved every room's key answers it, so it dials nothing.
    const before = courierDials().length;
    await a.runtime.googleDrive.reconcileAll({ force: true });
    expect(courierDials().length - before, 'a round inside the quiet window dials nothing').toBe(0);
  });
});

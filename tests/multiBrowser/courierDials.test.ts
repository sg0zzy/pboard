/**
 * Cold load, measured in `/ws` upgrades: one browser context, five boards, and
 * not one key-courier dial.
 *
 * The field report this suite came from: a 40-minute window showed **80** `101`
 * upgrades through the proxy, **zero** of them refused, while only ~123
 * auth/session events landed. Connections created and destroyed every few
 * seconds with no user action is *churn*, and the key courier was its largest
 * source: `keyCourierTransport.ts` opened one short-lived socket per pass, and
 * `runtime.ts` runs a pass from six places.
 *
 * The queue coalesced those passes, and that is what this file used to assert
 * (five boards: 13 dials → 6). The Drive-authorized architecture then removed
 * the reason for the exchange entirely: every room is a plaintext plane
 * (`createPlaintextOperationCodec`), so no wrap key is published and no
 * content-key grant is fetched. The claim is now absolute — **zero** — and it
 * is still counted at the relay, from the frames the sockets carried
 * (`publishDeviceKey` and friends are actions nothing else sends), never from
 * the client's own bookkeeping. The unit half of the old claim remains in
 * `tests/operations/keyCourierQueue.test.ts` for the signed path it still
 * serves.
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

  it('dials no courier exchange at all: the Drive-authorized room is a plaintext plane', async () => {
    // The cold-load churn this suite was written for came from the key courier:
    // one self-closing socket per trigger, per room, to publish wrap keys and
    // fetch a board's content-key grant. That machinery belongs to the retired
    // signed-authority path. Every room a Drive-authorized browser opens —
    // boards and the account room alike — seals with
    // `createPlaintextOperationCodec`, so there is no key to courier and the
    // whole class of dials is gone rather than merely coalesced.
    await a.runtime.collaborationManager.start(boards[0]);
    expect(await untilQuiet(() => logStatusOf(a, boards[0])?.phase === 'synced'),
      `board never synced: ${JSON.stringify(logStatusOf(a, boards[0]))}`).toBe(true);
    for (const boardId of boards.slice(1)) {
      await a.runtime.collaborationManager.start(boardId);
      expect(await untilQuiet(() => logStatusOf(a, boardId)?.phase === 'synced'),
        `board never synced: ${JSON.stringify(logStatusOf(a, boardId))}`).toBe(true);
    }
    await a.runtime.googleDrive.reconcileAll({ force: true });
    expect(courierDials(), `no courier exchange may be dialled on the Drive path: ${JSON.stringify(courierDials().map(d => d.actions))}`)
      .toHaveLength(0);
    // The instrumented sockets are still the ones the rooms used, so the count
    // above is a real absence and not a broken wrapper.
    expect(dials.some(dial => dial.actions.includes('attach') || dial.actions.includes('authenticate')),
      'the relay still saw the rooms dial').toBe(true);
  });
});

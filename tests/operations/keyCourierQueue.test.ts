import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instantAuthBudget } from '../helpers/authBudget';
import {
  KEY_COURIER_QUIET_MS, clearKeyCourierQueue, keyCourierQueueSnapshot,
  requestKeyCourier, requestKeyCourierBounded, type KeyCourierRequest
} from '../../src/sync/operations/keyCourierQueue';
import { generateBoardContentKey, type BoardContentKey } from '../../src/sync/bufferCrypto';
import type { KeyCourierOutcome } from '../../src/sync/operations/keyCourierTransport';

/**
 * The courier's per-room queue, measured in dials.
 *
 * The property under test is the one the field evidence named: a cold load of
 * five boards cost **13** short-lived `/ws` upgrades — one per pass per trigger,
 * sequential, never concurrent — because six call sites each ran their own
 * exchange. What is asserted here is the queue's contract in *dials made*:
 *
 *  - one pass at a time per room, and at most one waiting behind it, however
 *    many requests arrive while it runs;
 *  - a request joins a pass only when that pass answers its question at least as
 *    well — a joiner's four-attempt ladder never rides an authority's one-attempt
 *    pass, and a reader never rides a writer's;
 *  - a pass that resolved a key answers another maintenance request inside the
 *    quiet window; a pass that resolved *nothing* never does, because that caller
 *    is a device waiting for a grant and must keep asking;
 *  - a `fresh` request never rides a pass that has begun reading;
 *  - the debounced trigger drops rather than queues, so a burst cannot become a
 *    stream of passes;
 *  - a pass that throws becomes an outcome with an `error`, never a rejection,
 *    so a courier failure cannot reach a board open or a sync round.
 *
 * Every wait here is a microtask drain, never a timer: the fake transport hands
 * each pass to the test, which settles it explicitly.
 */
const topic = 'pboard-collab-board-1-cards';
const url = 'wss://relay.example.test/ws';

type Dial = { options: KeyCourierRequest; settle: (outcome: KeyCourierOutcome) => void; reject: (cause: Error) => void };
const dials: Dial[] = [];

vi.mock('../../src/sync/operations/keyCourierTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/sync/operations/keyCourierTransport')>();
  return {
    ...actual,
    runKeyCourier: (options: KeyCourierRequest) => new Promise<KeyCourierOutcome>((settle, reject) => {
      dials.push({ options, settle, reject });
    })
  };
});

const outcome = (overrides: Partial<KeyCourierOutcome> = {}): KeyCourierOutcome =>
  ({ source: 'none', peers: 0, published: 0, peerIds: [], error: null, ...overrides });

let content: BoardContentKey;

function request(overrides: Partial<KeyCourierRequest> = {}): KeyCourierRequest {
  return {
    topic, url,
    authBudget: instantAuthBudget(),
    getKey: async () => { throw new Error('the queue test never signs'); },
    getAuthorization: async () => { throw new Error('the queue test never authorizes'); },
    isWriter: true,
    isAuthority: true,
    heldKey: async () => content,
    ensureKey: async () => content,
    storeKey: async () => content,
    ...overrides
  };
}

/** Lets every pending continuation run; no timer, no sleep. */
async function drain() {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}

/** Settles the pass at `index` and lets the queue start whatever waited. */
async function settle(index: number, result: KeyCourierOutcome) {
  dials[index].settle(result);
  await drain();
}

afterEach(() => {
  clearKeyCourierQueue();
  dials.length = 0;
});

describe('the key courier queue', () => {
  it('coalesces a burst of identical requests for one room into a single dial', async () => {
    content = await generateBoardContentKey();
    const requests = Array.from({ length: 5 }, () => requestKeyCourier(request()));
    await drain();
    expect(dials.length, 'identical requests share one dial').toBe(1);
    await settle(0, outcome({ source: 'local', key: content }));
    for (const result of await Promise.all(requests)) expect(result.key?.keyId).toBe(content.keyId);
    expect(dials.length).toBe(1);
  });

  it('collapses concurrent requests for one room to one pass plus one follow-up', async () => {
    content = await generateBoardContentKey();
    const riding = requestKeyCourier(request());
    await drain();
    expect(dials.length).toBe(1);
    // Six fresh requests — a device approved, a foreign row, a repair, all in one
    // turn. None may ride a pass that has begun reading, so they take the single
    // waiting slot together.
    const fresh = Array.from({ length: 6 }, () => requestKeyCourier(request({ fresh: true })));
    await drain();
    expect(dials.length, 'one follow-up behind the running pass, never a chain').toBe(1);
    expect(keyCourierQueueSnapshot()[0]).toMatchObject({ running: true, queued: true });
    await settle(0, outcome({ source: 'local', key: content }));
    expect(dials.length, 'the follow-up begins as soon as the running pass ends').toBe(2);
    expect(dials[1].options.fresh, 'the follow-up is a fresh read').toBe(true);
    await settle(1, outcome({ source: 'local', key: content }));
    expect((await Promise.all([riding, ...fresh])).length).toBe(7);
    expect(dials.length, 'seven requests, two dials').toBe(2);
  });

  it('never makes a joiner’s four-attempt ladder ride an authority’s one-attempt pass', async () => {
    content = await generateBoardContentKey();
    const authority = requestKeyCourier(request({ isWriter: true, isAuthority: true }));
    await drain();
    expect(dials.length).toBe(1);
    // A joined writer keeps its own ladder: it must not inherit a pass that gave
    // up after one attempt and found nothing.
    const joiner = requestKeyCourier(request({ isWriter: true, isAuthority: false, attempts: 4 }));
    await drain();
    expect(dials.length, 'the joiner waits rather than sharing the wrong pass').toBe(1);
    expect(keyCourierQueueSnapshot()[0]).toMatchObject({ running: true, queued: true });
    await settle(0, outcome({ source: 'generated', key: content }));
    expect(dials.length).toBe(2);
    expect(dials[1].options.attempts, 'the joiner’s own ladder is what runs').toBe(4);
    await settle(1, outcome({ source: 'local', key: content }));
    expect((await Promise.all([authority, joiner])).every(result => result.key)).toBe(true);
  });

  it('answers a maintenance request from a pass that resolved a key, inside the quiet window', async () => {
    content = await generateBoardContentKey();
    const first = requestKeyCourier(request());
    await drain();
    await settle(0, outcome({ source: 'local', key: content }));
    expect((await first).key?.keyId).toBe(content.keyId);
    const second = await requestKeyCourier(request());
    expect(second.key?.keyId).toBe(content.keyId);
    expect(dials.length, 'a provisioned room is not re-dialled inside the window').toBe(1);
    // Outside the window it dials again: the window is a bound, not a cache.
    const later = requestKeyCourier(request({ quietMs: 0 }));
    await drain();
    expect(dials.length).toBe(2);
    await settle(1, outcome({ source: 'local', key: content }));
    await later;
  });

  it('never reuses a pass that resolved no key — a device waiting for a grant keeps asking', async () => {
    content = await generateBoardContentKey();
    const waiting = requestKeyCourier(request({ heldKey: async () => undefined }));
    await drain();
    await settle(0, outcome({ source: 'none' }));
    expect((await waiting).key).toBeUndefined();
    // The next poll is the joiner's next attempt: it must reach the relay,
    // because the grant it waits for can only be there by then.
    const next = requestKeyCourier(request({ heldKey: async () => undefined }));
    await drain();
    expect(dials.length, 'a pass that found nothing answers nobody').toBe(2);
    await settle(1, outcome({ source: 'granted', key: content }));
    expect((await next).key?.keyId).toBe(content.keyId);
  });

  it('a fresh request never rides a pass that has already begun reading', async () => {
    content = await generateBoardContentKey();
    const running = requestKeyCourier(request());
    await drain();
    // The pass is now executing `runKeyCourier`, so it may already have listed
    // the devices the fresh request exists to re-read.
    const fresh = requestKeyCourier(request({ fresh: true }));
    await drain();
    expect(dials.length, 'the fresh request waits for a read that begins after it').toBe(1);
    await settle(0, outcome({ source: 'local', key: content }));
    expect(dials.length).toBe(2);
    expect(dials[1].options.fresh).toBe(true);
    await settle(1, outcome({ source: 'local', key: content }));
    await Promise.all([running, fresh]);
  });

  it('bounds the debounced trigger by rate: a burst is dropped, not queued', async () => {
    content = await generateBoardContentKey();
    const minGapMs = KEY_COURIER_QUIET_MS;
    // Fired in one turn, exactly as a burst of foreign rows arrives. Nothing is
    // awaited until all eight have been handed in.
    const results = Array.from({ length: 8 }, () => requestKeyCourierBounded({ ...request(), minGapMs }));
    await drain();
    // The first passes the gate; every request in the window behind it is
    // dropped outright — no queue, no timer, no pass.
    expect(dials.length).toBe(1);
    const dropped = await Promise.all(results.slice(1));
    expect(dropped.every(result => result === undefined), 'the burst was dropped').toBe(true);
    await settle(0, outcome({ source: 'local', key: content }));
    expect(await results[0]).toMatchObject({ key: { keyId: content.keyId } });
    expect(keyCourierQueueSnapshot()[0], 'nothing left running or queued').toMatchObject({ running: false, queued: false });
  });

  it('a pass that throws is an outcome with an error, never a rejection', async () => {
    content = await generateBoardContentKey();
    const result = requestKeyCourier(request());
    await drain();
    dials[0].reject(new Error('Key courier connection failed'));
    const settled = await result;
    expect(settled.error).toBe('Key courier connection failed');
    expect(settled.key).toBeUndefined();
  });

  it('keeps rooms apart: one room’s pass never answers another room’s request', async () => {
    content = await generateBoardContentKey();
    const board = requestKeyCourier(request());
    const account = requestKeyCourier(request({ topic: 'pboard-account-abc-order' }));
    await drain();
    expect(dials.length, 'two rooms, two dials').toBe(2);
    expect(new Set(dials.map(dial => dial.options.topic)).size).toBe(2);
    await settle(0, outcome({ source: 'local', key: content }));
    await settle(1, outcome({ source: 'local', key: content }));
    await Promise.all([board, account]);
  });
});

describe('the queue never carries a courier failure into the caller', () => {
  it('hands every joined caller the same failure outcome, so a board open still proceeds', async () => {
    content = await generateBoardContentKey();
    // Three callers in one turn, all sharing one pass that fails. Each receives
    // the outcome (with `error`) rather than a rejection: a board open awaits
    // this and must continue into its Drive-first path, and a sync round
    // (`healRelay`) records `courier:<error>` and keeps going. `runKeyCourier`'s
    // own contract is "never rejects"; the queue must not add a rejection path.
    const callers = [
      requestKeyCourier(request({ topic: 'pboard-collab-board-1-cards' })),
      requestKeyCourier(request({ topic: 'pboard-collab-board-1-cards' })),
      requestKeyCourier(request({ topic: 'pboard-collab-board-1-cards', fresh: true }))
    ];
    await drain();
    expect(dials.length).toBe(1);
    dials[0].reject(new Error('Key courier refused: board_mismatch'));
    // The fresh caller is the one queued behind; settling it must not throw.
    await drain();
    if (dials.length === 2) dials[1].settle(outcome({ source: 'none', error: 'Key courier refused: board_mismatch' }));
    const results = await Promise.all(callers);
    expect(results).toHaveLength(3);
    expect(results[0].error).toBe('Key courier refused: board_mismatch');
    expect(results[0].key).toBeUndefined();
  });

  it('releases the room after a failure, so the next pass is not blocked by it', async () => {
    content = await generateBoardContentKey();
    const failed = requestKeyCourier(request({ heldKey: async () => undefined }));
    await drain();
    dials[0].settle(outcome({ source: 'none', error: 'Key courier connection failed' }));
    expect((await failed).error).toBe('Key courier connection failed');
    // The next attempt dials: a failed pass must leave no slot, no lock, no
    // reused outcome behind it.
    const retry = requestKeyCourier(request({ heldKey: async () => undefined }));
    await drain();
    expect(dials.length, 'the failure left the room free').toBe(2);
    await settle(1, outcome({ source: 'granted', key: content }));
    expect((await retry).key?.keyId).toBe(content.keyId);
  });
});

describe('key delivery to a device that was absent during a pass', () => {
  it('is still delivered on the next pass, because a pass that resolved nothing is never reused', async () => {
    content = await generateBoardContentKey();
    // The writer's first pass: the second device has not published a wrap key
    // yet, so `knownPeers` is empty and nothing is sealed for it. This is the
    // normal first-run shape, and the pass still resolves the board key.
    const first = requestKeyCourier(request({ sealedPeers: [] }));
    await drain();
    await settle(0, outcome({ source: 'generated', key: content, peers: 0, published: 0 }));
    expect((await first).key?.keyId).toBe(content.keyId);

    // The device joins (it publishes its wrap key) and the writer is asked
    // again. `fresh` is what a join causes — the enrol path and the handoff
    // beacon both ask for one — so the pass must read the room again and seal.
    const delivery = requestKeyCourier(request({ fresh: true, sealedPeers: [] }));
    await drain();
    expect(dials.length, 'the join caused a new pass').toBe(2);
    await settle(1, outcome({ source: 'local', key: content, peers: 1, published: 1, peerIds: ['peer-b'] }));
    const delivered = await delivery;
    expect(delivered.published, 'the absent device received its envelope on the next pass').toBe(1);
    expect(delivered.peerIds).toEqual(['peer-b']);
  });

  it('is not starved by the quiet window when the joiner is the one asking', async () => {
    content = await generateBoardContentKey();
    // The authority resolved its key (so a maintenance request would be
    // answered from cache) but the joiner holds nothing: its own request must
    // reach the relay, because the grant can only be there now.
    const authority = requestKeyCourier(request());
    await drain();
    await settle(0, outcome({ source: 'generated', key: content }));
    await authority;
    const joiner = requestKeyCourier(request({ heldKey: async () => undefined, isWriter: false, isAuthority: false }));
    await drain();
    expect(dials.length, 'the joiner’s request is never answered from the authority’s pass').toBe(2);
    await settle(1, outcome({ source: 'granted', key: content }));
    expect((await joiner).source).toBe('granted');
  });
});

describe('never two sockets on one room', () => {
  it('a different exchange arriving during a pass takes its turn, it does not overlap', async () => {
    content = await generateBoardContentKey();
    const writer = requestKeyCourier(request({ isWriter: true, isAuthority: true }));
    await drain();
    expect(dials.length).toBe(1);
    // A second, different exchange (a reader) and a third (a joiner with its own
    // ladder) arrive while the writer's pass runs. The waiting slot can only
    // hold one, so the third waits for the slot to drain and then runs — the
    // room never has two sockets, and the dial count still only advances as
    // passes complete.
    const reader = requestKeyCourier(request({ isWriter: false, isAuthority: false }));
    const joiner = requestKeyCourier(request({ isWriter: true, isAuthority: false, attempts: 4 }));
    await drain();
    expect(dials.length, 'still one pass on the wire').toBe(1);
    await settle(0, outcome({ source: 'generated', key: content }));
    // The waiting slot began; the third is queued behind it in turn.
    expect(dials.length).toBe(2);
    await settle(1, outcome({ source: 'local', key: content }));
    await drain();
    expect(dials.length, 'the third exchange runs after the second, not beside it').toBe(3);
    await settle(2, outcome({ source: 'local', key: content }));
    const results = await Promise.all([writer, reader, joiner]);
    expect(results.every(result => result.key?.keyId === content.keyId)).toBe(true);
    expect(dials.length, 'three exchanges, three dials, never four').toBe(3);
  });
});

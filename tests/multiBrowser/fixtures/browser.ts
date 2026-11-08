/**
 * Browser factory for the two-browser suite.
 *
 * Each `createBrowser` call is one browser context *in this process*:
 *  - its own extension storage fake (`browser.storage.local` shape),
 *  - its own IndexedDB namespace for device/wrap keys,
 *  - its own RxDB repository and blob store (unique database names),
 *  - its own Google account session and Drive identity (bearer token),
 *  - its own peer id (generated inside the runtime per composition root).
 *
 * Device keys are the hard part: `src/collab/security/keys.ts` captures the
 * ambient `indexedDB` at module evaluation and stores every purpose key under
 * fixed slots in a fixed database, and `src/storage/contentKeyStore.ts` opens
 * one fixed database lazily. Two browsers in one process therefore need two
 * module graphs: `vi.resetModules()` plus dynamic imports give each browser a
 * private copy of the whole source graph — static imports cannot do this, the
 * whole point is that the specifier is evaluated per browser at run time —
 * `vi.doMock` pins the key store to a private `IDBFactory` at that graph's
 * evaluation, and the content-key store — a pure persistence adapter whose
 * cryptographic semantics live in the real `bufferCrypto` the double reuses —
 * is replaced by an in-memory table per browser, which is the only way two
 * fixed-name instantiations coexist here. Every other seam (runtime, service,
 * session, log, courier, grants, journal, RxDB, Drive providers) is the
 * untouched product code.
 */
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import type { AuthBudget } from '../../../src/collab/authBudget';
import { instantAuthBudget } from '../../helpers/authBudget';
import type { CollaborationManager, CollaborationSecurityOptions } from '../../../src/collab/manager';
import type { AccountLifecycleChannel } from '../../../src/sync/operations/accountChannel';
import type { GoogleDriveProvider } from '../../../src/sync/googleDriveProvider';
import { PENDING_BOARD_LEAVES_KEY, type DrivePermissionService } from '../../../src/sync/drivePermissions';
import type { DriveSyncStateStore, DriveTombstoneStore } from '../../../src/sync/state';
import type { RoomSnapshot } from '../../../src/sync/realtimeDiagnostics';
import type { CollaborationCounters } from '../../../src/collab/counters';
import type { RxRepository } from '../../../src/storage/rxdbRepository';
import { FakeDrive } from './fakeDrive';
import { FakeSignaling } from './fakeSignaling';

export const RELAY_URL = 'wss://relay.invalid/ws';
export const COLLABORATION_SETTINGS_KEY = 'pboardCollaborationSettings';
export const RELAY_SETTINGS = { provider: 'websocket' as const, url: RELAY_URL };

/** The one fetch both browsers share: Drive calls resolve their account from
 * the bearer the product attaches, signaling calls from their Google token. */
export type Cloud = {
  drive: FakeDrive;
  signaling: FakeSignaling;
  /** Google bearer token → verified account email; the identity exchange's oracle. */
  accounts: Map<string, string>;
  fetch: typeof fetch;
  /** Bring the relay down and back up over the same durable data (T11): every
   * live socket dies with an abnormal close (1006), the volatile halves (grant
   * cache, directory, receipts, armed replay faults) come back empty, and the
   * operation log, checkpoints, and courier rows persist. The returned
   * instance is `cloud.signaling` from now on, and `cloud.fetch` reaches it;
   * the `WebSocket` class browsers captured resolves the live service per
   * connection, so reconnecting browsers land on the new process unwired. */
  restartSignaling(): FakeSignaling;
};

export function createCloud(): Cloud {
  const drive = new FakeDrive();
  const accounts = new Map<string, string>();
  const signaling = new FakeSignaling(accounts);
  const cloud: Cloud = {
    drive,
    signaling,
    accounts,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://www.googleapis.com/')) return await drive.fetch(url, init);
      const response = await cloud.signaling.handleHttp(url, init ?? {});
      if (response) return response;
      throw new Error(`multi-browser harness: unexpected fetch ${url}`);
    }) as typeof fetch,
    restartSignaling: () => {
      cloud.signaling = cloud.signaling.restart();
      return cloud.signaling;
    },
  };
  return cloud;
}

/** One shared IndexedDB realm (installed by `fake-indexeddb/auto`, which also
 * provides `IDBKeyRange` for Dexie/RxDB) for everything keyed by unique
 * database names (RxDB, journals, blob stores); device keys bypass it via
 * their private factory, per the header. */
let sharedIndexedDbInstalled = false;
function ensureSharedIndexedDb() {
  if (sharedIndexedDbInstalled) return;
  sharedIndexedDbInstalled = true;
  if (!(globalThis.indexedDB instanceof IDBFactory)) vi.stubGlobal('indexedDB', new IDBFactory());
}

/** KeyValueStorage over a plain object: the extension-storage fake. Deep
 * copies on both edges like `chrome.storage.local` so a caller can never
 * mutate what another read returned. */
export function createMemoryStorage(seed: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...structuredClone(seed) };
  return {
    data,
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (patch: Record<string, unknown>) => { Object.assign(data, structuredClone(patch)); },
  };
}

export type MemoryStorage = ReturnType<typeof createMemoryStorage>;

/** The runtime surface the suite drives, declared structurally because the
 * browsers are separate module graphs and the composition root publishes no
 * named type of its own. The shapes used are the product's own exported ones
 * wherever one exists. */
export type BrowserRuntime = {
  googleDrive: GoogleDriveProvider;
  /** The three stores behind the composition root's deletion events; the
   * fixture wires those events itself, exactly as `src/storage/browser.ts` does. */
  driveSyncState: DriveSyncStateStore;
  driveTombstones: DriveTombstoneStore;
  drivePermissions: DrivePermissionService;
  collaborationManager: CollaborationManager;
  operationService: { close(boardId: string): Promise<void>; role(boardId: string): Promise<string>; previewGardening(boardId: string): Promise<unknown> };
  boardCollaboration: {
    initialize(board: string): Promise<unknown>;
    adoptAuthority(board: string): Promise<{ outcome: string; reason?: string; mode?: string; benign?: boolean }>;
    ownsAuthority(board: string): Promise<boolean>;
    localBundle(board: string): Promise<unknown>;
    security(board: string, refresh?: boolean): Promise<CollaborationSecurityOptions | null>;
    settings(): Promise<{ provider: 'drive' | 'websocket'; url: string }>;
    identitySharing: {
      sync(selected?: string, force?: boolean): Promise<unknown>;
      invite(board: string, email: string, role: 'editor' | 'viewer'): Promise<unknown>;
      collaborators(board: string): Promise<{ email: string; role: string }[]>;
    };
  };
  reestablishAuthorityFromDrive(board: string): Promise<unknown>;
  /** The owner's relay-heal leg, one board at a time (the Reconnect button's
   * function and the forced-reconcile leg alike call exactly this). */
  healRelay(boardId: string, options?: { force?: boolean }): Promise<string>;
  /** The account-level discovery channel, typed by the product's own contract.
   * One exists per composition root, so `close()` must take it down with the
   * board sessions — a torn-down browser may not leave a socket, a retry loop
   * and a reader of the account room behind it. */
  accountChannel: AccountLifecycleChannel;
};

export type BrowserHandle = {
  readonly label: string;
  readonly email: string;
  readonly storage: MemoryStorage;
  readonly drive: FakeDrive;
  readonly runtime: BrowserRuntime;
  readonly rx: RxRepository;
  /** Observable room state as *this browser* reports it (per-graph diagnostics). */
  rooms(): (Omit<RoomSnapshot, 'seenAt'> & { secondsAgo: number })[];
  /** This browser's own counters, from its private module graph — the gauges
   * live per graph (the counters instance is evaluated once per browser), so a
   * suite that shares one process cannot read them from a static import. */
  counters(): CollaborationCounters;
  /** Whether this browser's key store holds a board content key (the store a
   * viewer must never populate, and the device key store is not). */
  holdsContentKey(boardId: string): boolean;
  /** The browser's own live-transport posture switch (per module graph). */
  setWebRtcDisabled(disabled: boolean): void;
  close(): Promise<void>;
};

let browserCounter = 0;

/** What one browser profile actually shares between its runtime contexts:
 * the extension storage, the device-key IndexedDB, and the content-key store
 * — the MV3 worker and the sidebar each build a runtime, and everything the
 * first one persists the second one reads. A scenario that needs the two
 * contexts of one profile (the account channel's real deployment, where both
 * start a channel over the same durable state) builds one of these and hands
 * it to two `createBrowser` calls; every other scenario keeps the default of
 * a private profile per handle. The RxDB store stays per handle: the account
 * channel's shared state lives in the profile above, and modelling two
 * databases per profile loses nothing there. */
export type SharedProfile = {
  storage: MemoryStorage;
  keyFactory: IDBFactory;
  contentKeys: Map<string, { boardId: string; material: string; keyId: string; createdAt: string }>;
};

export function createSharedProfile(seed: Record<string, unknown> = {}): SharedProfile {
  return {
    storage: createMemoryStorage({ [COLLABORATION_SETTINGS_KEY]: RELAY_SETTINGS, ...seed }),
    keyFactory: new IDBFactory(),
    contentKeys: new Map()
  };
}

export async function createBrowser(options: {
  label: string;
  email: string;
  cloud: Cloud;
  /** Pre-seeded extension storage; the collaboration setting selects the relay. */
  seed?: Record<string, unknown>;
  /** Share a profile with another handle: storage, device keys and content
   * keys become one — two runtime contexts, one browser. */
  profile?: SharedProfile;
  /** Budget override. The default is a budget that paces nothing: these are
   * protocol-coverage suites, and the real per-context token bucket would
   * spend their (legitimately dense but sub-second) automatic-auth bursts
   * waiting — enough to blow a `beforeAll` hook budget on pacing alone. The
   * bucket's own bounds are pinned by `tests/collab/authBudget.test.ts`; pass
   * `automaticAuthBudget` here to exercise the pacing end-to-end. */
  authBudget?: AuthBudget;
}): Promise<BrowserHandle> {
  ensureSharedIndexedDb();
  const { label, email, cloud } = options;
  const token = cloud.drive.addAccount(email);
  cloud.accounts.set(token, email);

  // Register this browser's module graph. Order matters: reset first, then
  // register the per-browser mocks, then evaluate the graph exactly once.
  vi.resetModules();
  // A profile shared with another handle makes the storage, the device-key
  // IndexedDB and the content-key table one — see `createSharedProfile`.
  const profile = options.profile ?? createSharedProfile(options.seed ?? {});
  const keyFactory = profile.keyFactory;
  const contentKeyTable = profile.contentKeys;
  const keysPath = new URL('../../../src/collab/security/keys', import.meta.url).pathname;
  const contentKeysPath = new URL('../../../src/storage/contentKeyStore', import.meta.url).pathname;
  vi.doMock(keysPath, async importOriginal => {
    // The real key module, evaluated while `indexedDB` resolves to *this*
    // browser's factory — the module captures that reference at import.
    const previous = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', keyFactory);
    try {
      return { ...(await importOriginal()) };
    } finally {
      vi.stubGlobal('indexedDB', previous);
    }
  });
  vi.doMock(contentKeysPath, async () => {
    // In-memory stand-in for the fixed-name content-key IndexedDB store; the
    // key material handling is the real `bufferCrypto`, only the persistence
    // table is local. Two graphs cannot both own `pboard-content-keys`.
    const bufferCrypto = await import('../../../src/sync/bufferCrypto');
    const table = contentKeyTable;
    const load = async (boardId: string) => {
      const row = table.get(boardId);
      if (!row) return undefined;
      return { imported: await bufferCrypto.importBoardContentKey(row.material), row };
    };
    return {
      createContentKeyStore: () => ({
        async get(boardId: string) { return (await load(boardId))?.imported; },
        async loadRaw(boardId: string) { const found = await load(boardId); return found ? { material: found.row.material, keyId: found.row.keyId } : undefined; },
        async ensure(boardId: string) {
          const found = await load(boardId);
          if (found) return found.imported;
          const created = await bufferCrypto.generateBoardContentKey();
          table.set(boardId, { boardId, material: await bufferCrypto.exportBoardContentKey(created.key), keyId: created.keyId, createdAt: new Date().toISOString() });
          return created;
        },
        async put(boardId: string, material: string) {
          const imported = await bufferCrypto.importBoardContentKey(material);
          table.set(boardId, { boardId, material, keyId: imported.keyId, createdAt: new Date().toISOString() });
          return imported;
        },
        async remove(boardId: string) { table.delete(boardId); },
      }),
    };
  });

  // Module loading is the mechanism under test for isolation, so the graph is
  // imported per browser (static import would share one graph across both).
  const [{ createDriveRuntime }, { createRxRepository }, { createIndexedDbBlobStore }, liveTransport, realtimeDiagnostics, { collaborationCounters }] = await Promise.all([
    import('../../../src/sync/runtime'),
    import('../../../src/storage/rxdbRepository'),
    import('../../../src/storage/blobStore'),
    import('../../../src/collab/liveTransport'),
    import('../../../src/sync/realtimeDiagnostics'),
    import('../../../src/collab/counters'),
  ]);

  // The relay posture: peer pools off for this browser's graph, restored on
  // teardown of the same copy.
  liveTransport.setWebRtcDisabled(true);

  // Every socket this browser opens is the shared fake relay. (Assigned to the
  // global because the transports fall back to `globalThis.WebSocket`.)
  vi.stubGlobal('WebSocket', cloud.signaling.WebSocket);

  const storage = profile.storage;
  const databaseName = `mb${++browserCounter}${crypto.randomUUID().replaceAll('-', '')}`;
  /**
   * The repository events the product composition root attaches
   * (`src/storage/browser.ts`): the Drive-side removal intent on
   * `projectDeleting`, its publication on `projectDeleted`, the leave on
   * `projectHidden`, the dirty mark on `projectChanged`. A fixture that leaves
   * them out cannot observe what a real browser does with a deletion it made
   * while the board was not the open one — nothing publishes it. They resolve
   * the runtime lazily because the product wires the same indirection through
   * its module singletons: the repository exists before the runtime does.
   */
  let runtimeRef: BrowserRuntime | null = null;
  const rx = await createRxRepository({
    name: databaseName, blobs: createIndexedDbBlobStore(`${databaseName}images`),
    // The composition root this suite models is an operation-protocol build
    // (`src/storage/browser.ts`): commands run for real and the operation
    // service takes their delivery, because nothing here ever installs the live
    // board role that draft admission demands. Leaving it out puts a browser in
    // the drafts-enabled posture, where an existing card's edit lands as
    // retained work instead of as an operation — a state no product build of
    // this relay posture can reach.
    offlineDrafts: false,
    events: {
      projectChanged: projectId => { void runtimeRef?.driveSyncState.markDirty(projectId); },
      // The composition root's order publication (`src/storage/browser.ts`):
      // one `board.order` record per settling reorder, on the account room.
      projectOrderChanged: order => { void runtimeRef?.accountChannel.publishLocalOrder(order); },
      projectDeleting: async project => {
        const state = await runtimeRef?.driveSyncState.get(project.id);
        await runtimeRef?.driveTombstones.add({ projectId: project.id,
          ...(state?.remoteFileId ? { remoteFileId: state.remoteFileId } : {}),
          deletedAt: new Date().toISOString(), projectUpdatedAt: project.updatedAt, revision: project.revision });
      },
      projectDeleted: async projectId => { await runtimeRef?.googleDrive.deleteProject(projectId); },
      // The composition root's account-room announcement of the deletion *fact*
      // (`src/storage/browser.ts:projectTombstoned`): the peer receives the
      // causal evidence, not a hint. Fire-and-forget, exactly as the product
      // wires it.
      projectTombstoned: (boardId, fact) => {
        if (fact.accountId === null) return;
        void runtimeRef?.accountChannel.publishTombstone(boardId, {
          kind: fact.kind, opId: fact.opId, actorId: fact.actorId, seq: fact.seq,
          clock: fact.clock, context: fact.context, role: fact.role
        }).catch(() => undefined);
      },
      projectHidden: async projectId => {
        const pending = storage.data[PENDING_BOARD_LEAVES_KEY] as Record<string, true> | undefined;
        storage.data[PENDING_BOARD_LEAVES_KEY] = { ...(pending ?? {}), [projectId]: true };
        await runtimeRef?.drivePermissions.removeSelfFromProject(projectId).catch(() => undefined);
      }
    }
  });
  const auth = {
    getAccessToken: async () => token,
    getConnectionState: async () => 'connected' as const,
    isConfigured: () => true,
    connect: async () => {},
    disconnect: async () => {},
  };
  const runtime = createDriveRuntime({ auth, storage, getRepository: async () => rx, fetcher: cloud.fetch, authBudget: options.authBudget ?? instantAuthBudget() }) as unknown as BrowserRuntime;
  runtimeRef = runtime;

  let closed = false;
  return {
    label,
    email,
    storage,
    drive: cloud.drive,
    runtime,
    rx: rx as unknown as RxRepository,
    rooms: () => realtimeDiagnostics.roomSnapshots(),
    counters: () => collaborationCounters.snapshot(),
    holdsContentKey: boardId => contentKeyTable.has(boardId),
    setWebRtcDisabled: disabled => liveTransport.setWebRtcDisabled(disabled),
    async close() {
      if (closed) return;
      closed = true;
      await runtime.collaborationManager.stop();
      // The account channel outlives the page it started from unless it is
      // closed: a torn-down browser would otherwise keep a socket, a retry
      // loop and a reader of the account room behind it (a scenario's fault
      // injection and subscription counts would then race an invisible
      // fourth reader). `accountChannel.close` is the product's own sign-out
      // gesture, and `close()` here is what a browser teardown does to it.
      await runtime.accountChannel.close();
      for (const boardId of [...rx.operationSource.bindings.keys()]) await runtime.operationService.close(boardId);
      await rx.db.close();
      liveTransport.setWebRtcDisabled(false);
    },
  };
}

/** The room diagnostics record one browser holds for one board, or undefined. */
export function roomFor(browser: BrowserHandle, boardId: string) {
  return browser.rooms().find(room => room.boardId === boardId || room.topic.includes(boardId));
}

/** `log` only exists on the room record once the durable operation log was
 * created for this board; its absence means the board never reached the relay. */
export function logStatusOf(browser: BrowserHandle, boardId: string) {
  return roomFor(browser, boardId)?.log;
}

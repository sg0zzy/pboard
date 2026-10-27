/** Controlled component harness. Real RxDB/storage/provider; synthetic Drive/auth.
 * Never imports the browser runtime or connects to Google/public rendezvous. */
import { createRxRepository, type RxRepository } from '../../src/storage/rxdbRepository';
import { createIndexedDbBlobStore } from '../../src/storage/blobStore';
import { createBackendProjectSnapshotStore, deserializeProjectSnapshot } from '../../src/sync/snapshot';
import { createDriveSyncStateStore, createDriveTombstoneStore } from '../../src/sync/state';
import { createGoogleDriveProvider } from '../../src/sync/googleDriveProvider';
import { createPrivateDriveHistory } from '../../src/sync/privateDriveHistory';
import type { DriveTransport } from '../../src/sync/driveTransport';
import type { GoogleAuthProvider } from '../../src/sync/googleAuth';
import type { KeyValueStorage } from '../../src/storage/repository';
import { createBoardGrantService } from '../../src/collab/boardGrants';
import { generateDeviceKey, type StoredDeviceKey } from '../../src/collab/security/keys';

export class MemoryStorage implements KeyValueStorage {
  readonly data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: structuredClone(this.data[key]) }; }
  async set(patch: Record<string, unknown>) { Object.assign(this.data, structuredClone(patch)); }
}
type Operation = 'list' | 'find' | 'download' | 'upload' | 'delete';
type File = { id: string; account: string; project: string; contents: string; prefix: string };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** Supports deterministic failure before processing, commit-with-lost-ack, and
 * requests held while the repository receives another edit. No sleep polling. */
export class DriveFixture {
  available = true;
  readonly calls: { account: string; operation: Operation }[] = [];
  private sequence = 0;
  private files = new Map<string, File>();
  private faults: { operation: Operation; kind: 'before' | 'after' | 'pause'; started: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> }[] = [];
  failNext(operation: Operation, afterCommit = false) { this.fault(operation, afterCommit ? 'after' : 'before'); }
  pauseNext(operation: Operation) {
    const value = this.fault(operation, 'pause');
    return { started: value.started.promise, release: value.resume.resolve };
  }
  private fault(operation: Operation, kind: 'before' | 'after' | 'pause') {
    const value = { operation, kind, started: deferred(), resume: deferred() };
    this.faults.push(value); return value;
  }
  snapshots(account: string) { return [...this.files.values()].filter(f => f.account === account && f.prefix === 'project-').map(f => deserializeProjectSnapshot(f.contents)); }
  histories(account: string) { return [...this.files.values()].filter(f => f.account === account && f.prefix === 'history-').map(f => JSON.parse(f.contents)); }
  async request<T>(account: string, operation: Operation, run: () => T): Promise<T> {
    this.calls.push({ account, operation });
    if (!this.available) throw new Error('Fixture network unavailable');
    const index = this.faults.findIndex(f => f.operation === operation);
    const fault = index < 0 ? undefined : this.faults.splice(index, 1)[0];
    fault?.started.resolve();
    if (fault?.kind === 'pause') await fault.resume.promise;
    if (fault?.kind === 'before') throw new Error('Fixture request interrupted');
    const result = run();
    if (fault?.kind === 'after') throw new Error('Fixture acknowledgement lost');
    return result;
  }
  transport(account: string, prefix = 'project-'): DriveTransport {
    const ref = (file: File) => ({ id: file.id, name: `${file.prefix}${file.project}.pboard` });
    const own = (id: string) => {
      const file = this.files.get(id);
      if (!file || file.account !== account) throw new Error('Fixture private file inaccessible');
      return file;
    };
    return {
      listProjectFiles: () => this.request(account, 'list', () => [...this.files.values()].filter(f => f.account === account && f.prefix === prefix).map(ref)),
      findProjectFile: project => this.request(account, 'find', () => { const file = [...this.files.values()].find(f => f.account === account && f.prefix === prefix && f.project === project); return file ? ref(file) : null; }),
      download: id => this.request(account, 'download', () => own(id).contents),
      upload: (project, contents, id) => this.request(account, 'upload', () => {
        if (id) own(id);
        const file = { id: id ?? `fixture-${++this.sequence}`, account, project, contents, prefix };
        this.files.set(file.id, file); return ref(file);
      }),
      delete: id => this.request(account, 'delete', () => { own(id); this.files.delete(id); })
    };
  }
}
export async function openDevice(cloud: DriveFixture, account = 'account-a') {
  const storage = new MemoryStorage();
  const name = `pboardrecovery${crypto.randomUUID().replaceAll('-', '')}`;
  const state = createDriveSyncStateStore(storage);
  const keys = new Map<string, StoredDeviceKey>();
  let repo: RxRepository;
  let connected = true, destroyed = false;
  const auth: GoogleAuthProvider = {
    getConnectionState: async () => connected ? 'connected' : 'disconnected',
    getAccessToken: async () => { if (!connected) throw new Error('Fixture account disconnected'); return 'synthetic-component-token'; },
    connect: async () => { connected = true; }, disconnect: async () => { connected = false; }, isConfigured: () => true
  };
  const open = () => createRxRepository({ name, blobs: createIndexedDbBlobStore(`${name}images`), events: { projectChanged: id => state.markDirty(id) } });
  repo = await open();
  const getRepo = async () => { if (destroyed) throw new Error('Original device permanently unavailable'); return repo; };
  const snapshots = createBackendProjectSnapshotStore(storage, getRepo);
  const providerFor = (identity: string) => createGoogleDriveProvider({ auth, transport: cloud.transport(identity), snapshots, syncState: state, tombstones: createDriveTombstoneStore(storage),
    history: createPrivateDriveHistory({ transport: cloud.transport(identity, 'history-'), snapshots, getRepository: getRepo,
      getAccountId: async () => connected ? identity : null, snapshotTransport: cloud.transport(identity),
      erasureTransport: cloud.transport(identity, 'erased-'), imageTransport: cloud.transport(identity, 'image-') }) });
  let publishedGrant: unknown;
  const grants = createBoardGrantService({ storage,
    getKey: async scope => { if (destroyed) throw new Error('Original keys unavailable'); if (!keys.has(scope)) keys.set(scope, await generateDeviceKey()); return keys.get(scope)!; },
    peekKey: async purpose => keys.get(purpose) ?? null,
    publicGrantHistory: async board => (await (await getRepo()).journal.publicGrants.where('boardId').equals(board).toArray()).map(g => g.manifest),
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/grants/challenge') return new Response(JSON.stringify({ version: 2, challenge: 'a'.repeat(43) }));
      if (path === '/grants/publish') { publishedGrant = JSON.parse(String(init?.body)).bundle; return new Response(null, { status: 204 }); }
      if (path.startsWith('/grants/')) return new Response(JSON.stringify(publishedGrant ?? {}), { status: publishedGrant ? 200 : 404 });
      throw new Error('Component harness does not provide a rendezvous');
    }
  });
  return {
    storage, state, auth, snapshots, grants, provider: providerFor(account), providerFor,
    setPublished: (bundle: unknown) => { publishedGrant = bundle ? structuredClone(bundle) : undefined; },
    get repo() { if (destroyed) throw new Error('Original device permanently unavailable'); return repo; },
    async restart() { await repo.db.close(); repo = await open(); },
    async destroy() { if (destroyed) return; await repo.db.remove(); keys.clear(); destroyed = true; connected = false; }
  };
}
export type RecoveryDevice = Awaited<ReturnType<typeof openDevice>>;
export const sampleImage = { dataUrl: 'data:image/png;base64,AAECAwQ=', mimeType: 'image/png', width: 1, height: 1 };

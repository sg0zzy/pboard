import { createDriveRuntime } from '../../../../src/sync/runtime';
import { createProjectDeletionRoleResolver } from '../../../../src/sync/projectDeletion';
import { createAndroidGoogleAuth } from './auth';
import { createSyncStorage } from './storage';
import type { RepositoryEvents } from '../../../../src/storage/repository';
import type { RxRepository } from '../storage/repository';

export function createAndroidSync(getRepository: () => Promise<RxRepository>, auth = createAndroidGoogleAuth(createSyncStorage()), storage = createSyncStorage()) {
  const runtime = createDriveRuntime({ auth, storage, getRepository });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let foreground = false;
  let selected: string | null = null;
  let liveProject: string | null = null;
  let running: Promise<void> | undefined;
  let disposed = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  let lastLiveError = '';
  let state = { connected: false, busy: false, resolving: false, error: '', role: 'private', peers: 0, lastSynced: '', projectId: null as string | null };
  const emit = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  function schedule(delay = 25_000) {
    clearTimeout(timer);
    if (foreground && state.connected && !disposed) timer = setTimeout(() => { void sync(); }, delay);
  }
  let liveQueue: Promise<void> = Promise.resolve();
  function restartLive(): Promise<void> {
    const current = generation;
    const projectId = selected;
    if (projectId && state.connected && foreground) emit({ resolving: true });
    const operation = liveQueue.then(async () => {
      if (current !== generation) return;
      const shouldStart = foreground && state.connected && !disposed;
      if (shouldStart && liveProject === projectId && projectId) {
        await runtime.collaborationManager.refreshRole();
      } else {
        // Retain viewer protection after leaving a room or disconnecting.
        const previousId = liveProject;
        const previousRole = runtime.collaborationManager.state().role;
        await runtime.collaborationManager.stop();
        liveProject = null;
        if (previousId && previousRole === 'viewer') (await getRepository()).setMutatorRole(previousId, 'viewer');
        if (current !== generation) return;
        if (shouldStart && projectId) {
          await runtime.collaborationManager.start(projectId);
          liveProject = projectId;
        }
      }
      if (current !== generation) return;
      const live = runtime.collaborationManager.state();
      if (projectId && shouldStart) {
        (await getRepository()).setMutatorRole(projectId, live.role);
        await storage.set({ [`role:${projectId}`]: live.role });
      }
      emit({ role: !shouldStart && state.role === 'viewer' ? 'viewer' : live.role, resolving: false, peers: live.connectedPeers.length });
    }).catch(error => {
      if (current === generation) emit({ role: projectId ? 'viewer' : 'private', resolving: false,
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    liveQueue = operation.catch(() => undefined);
    return operation;
  }
  async function sync() {
    if (running) return running;
    if (!foreground || !state.connected || disposed) return;
    const current = generation;
    running = (async () => {
      emit({ busy: true, error: '' });
      try {
        await runtime.googleDrive.reconcileAll();
        if (current !== generation || disposed || !state.connected || !foreground) return;
        // Refresh role/permission changes while the app remains open.
        await restartLive();
        emit({ lastSynced: new Date().toLocaleTimeString() });
      } catch (error) { emit({ error: error instanceof Error ? error.message : String(error), resolving: false }); }
      finally { emit({ busy: false }); running = undefined; schedule(); }
    })();
    return running;
  }
  const events: RepositoryEvents = {
    async projectChanged(id) { await runtime.driveSyncState.markDirty(id); schedule(2_000); },
    async projectDeleting(project) {
      const saved = await runtime.driveSyncState.get(project.id);
      await runtime.driveTombstones.add({ projectId: project.id, remoteFileId: saved.remoteFileId,
        deletedAt: new Date().toISOString(), projectUpdatedAt: project.updatedAt, revision: project.revision });
    },
    projectHidden() { schedule(2_000); },
    projectDeleted() { schedule(2_000); },
  };
  return {
    ...runtime, auth, events,
    resolveDeletionRole: createProjectDeletionRoleResolver({ sharedProjects: runtime.sharedProjects, permissions: runtime.drivePermissions,
      connected: async () => await auth.getConnectionState() === 'connected' }),
    state: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async initialize() { emit({ connected: await auth.getConnectionState() === 'connected' }); },
    async connect() {
      emit({ busy: true, error: '' });
      try { await auth.connect(); emit({ connected: true }); await sync(); }
      catch (error) { emit({ error: error instanceof Error ? error.message : String(error) }); }
      finally { emit({ busy: false }); }
    },
    async disconnect() {
      ++generation; clearTimeout(timer);
      const previousRole = state.role;
      emit({ connected: false, resolving: false, peers: 0, error: '' });
      // Finish any current backup before disconnect returns.
      await running;
      await restartLive();
      await auth.disconnect();
      emit({ role: previousRole === 'viewer' ? 'viewer' : 'private' });
    },
    sync,
    async selectProject(id: string | null) {
      if (selected === id) return;
      selected = id; ++generation;
      emit({ projectId: id, role: 'private', resolving: Boolean(id && state.connected) });
      if (id) {
        const role = (await storage.get(`role:${id}`))[`role:${id}`];
        if (id !== selected) return;
        if (role === 'viewer') { (await getRepository()).setMutatorRole(id, 'viewer'); emit({ role: 'viewer' }); }
      }
      try { await restartLive(); }
      catch (error) { emit({ error: error instanceof Error ? error.message : String(error), resolving: false }); }
    },
    async setForeground(active: boolean) {
      foreground = active; ++generation;
      if (active) { try { await restartLive(); } catch { /* sync retries with a visible error */ } await sync(); }
      else { clearTimeout(timer); await restartLive(); }
    },
    pollLive() {
      const live = runtime.collaborationManager.state();
      const error = live.error ?? '';
      emit({ peers: live.connectedPeers.length,
        ...(error || (lastLiveError && state.error === lastLiveError) ? { error } : {}) });
      lastLiveError = error;
    },
    async invite(projectId: string, email: string, role: 'editor' | 'viewer') {
      await runtime.drivePermissions.invite(projectId, email, role);
      await runtime.driveSyncState.markDirty(projectId);
      await restartLive();
      schedule(2_000);
    },
    async dispose() { disposed = true; ++generation; foreground = false; clearTimeout(timer); await running; await restartLive(); listeners.clear(); },
  };
}
export type AndroidSync = ReturnType<typeof createAndroidSync>;
let instance: AndroidSync | undefined;
export function getAndroidSync(getRepository?: () => Promise<RxRepository>): AndroidSync {
  if (!instance) {
    if (!getRepository) throw new Error('Android storage is not ready.');
    instance = createAndroidSync(getRepository);
  }
  return instance;
}

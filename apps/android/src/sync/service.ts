import { createDriveRuntime } from '../../../../src/sync/runtime';
import { createProjectDeletionRoleResolver } from '../../../../src/sync/projectDeletion';
import { createAndroidGoogleAuth } from './auth';
import { createSyncStorage } from './storage';
import type { RepositoryEvents } from '../../../../src/storage/repository';
import type { RxRepository } from '../storage/repository';
import { dirtyFlushAt, drivePollDelay } from '../../../../src/sync/syncPolicy';

export function createAndroidSync(getRepository: () => Promise<RxRepository>, auth = createAndroidGoogleAuth(createSyncStorage()), storage = createSyncStorage()) {
  const runtime = createDriveRuntime({ auth, storage, getRepository });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let foreground = false;
  let selected: string | null = null;
  let liveProject: string | null = null;
  let running: Promise<void> | undefined;
  let disposed = false;
  let generation = 0;
  let pollAttempt = 0;
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let lastLiveError = '';
  let state = { connected: false, busy: false, resolving: false, error: '', role: 'private', peers: 0, lastSynced: '', projectId: null as string | null };
  const emit = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  function schedule(delay = drivePollDelay(pollAttempt)) {
    clearTimeout(timer);
    if (foreground && state.connected && !disposed) timer = setTimeout(() => { void sync(); }, delay);
  }
  function clearFlushTimers() { for (const timer of flushTimers.values()) clearTimeout(timer); flushTimers.clear(); }
  async function scheduleBoard(id: string, afterAttempt = false) {
    const saved = await runtime.driveSyncState.get(id);
    clearTimeout(flushTimers.get(id)); flushTimers.delete(id);
    if (!foreground || !state.connected || disposed || !saved.dirty) return;
    const remaining = dirtyFlushAt(saved) - Date.now();
    const delay = afterAttempt && remaining <= 0 ? drivePollDelay(pollAttempt) : Math.max(0, remaining);
    flushTimers.set(id, setTimeout(() => { flushTimers.delete(id); void sync(); }, delay));
  }
  async function restoreFlushTimers(afterAttempt = false) {
    for (const project of await (await getRepository()).listProjects()) await scheduleBoard(project.id, afterAttempt);
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
  async function sync(force = false) {
    if (running) return running;
    if (!foreground || !state.connected || disposed) return;
    const current = generation;
    running = (async () => {
      emit({ busy: true, error: '' });
      try {
        if (force && selected) await runtime.googleDrive.syncProject(selected, { force: true });
        await runtime.googleDrive.reconcileAll({ force: true });
        pollAttempt = 0;
        if (current !== generation || disposed || !state.connected || !foreground) return;
        // Refresh role/permission changes while the app remains open.
        await restartLive();
        emit({ lastSynced: new Date().toLocaleTimeString() });
      } catch (error) { pollAttempt = Math.min(pollAttempt + 1, 6); emit({ error: error instanceof Error ? error.message : String(error), resolving: false }); }
      finally { emit({ busy: false }); running = undefined; schedule(); await restoreFlushTimers(true); }
    })();
    return running;
  }
  const events: RepositoryEvents = {
    async projectChanged(id) { await runtime.driveSyncState.markDirty(id); await scheduleBoard(id); },
    async projectDeleting(project) {
      const saved = await runtime.driveSyncState.get(project.id);
      await runtime.driveTombstones.add({ projectId: project.id, remoteFileId: saved.remoteFileId,
        deletedAt: new Date().toISOString(), projectUpdatedAt: project.updatedAt, revision: project.revision });
    },
    projectHidden() { schedule(); },
    projectDeleted() { schedule(); },
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
      try { await auth.connect(); await runtime.authorizePrivatePersistence(); emit({ connected: true }); await sync(); }
      catch (error) { emit({ error: error instanceof Error ? error.message : String(error) }); }
      finally { emit({ busy: false }); }
    },
    async disconnect() {
      ++generation; clearTimeout(timer); clearFlushTimers();
      const previousRole = state.role;
      emit({ connected: false, resolving: false, peers: 0, error: '' });
      // Finish any current backup before disconnect returns.
      await running;
      await restartLive();
      await auth.disconnect();
      emit({ role: previousRole === 'viewer' ? 'viewer' : 'private' });
    },
    sync: () => sync(true),
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
      else { clearTimeout(timer); clearFlushTimers(); await restartLive(); }
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
      await scheduleBoard(projectId);
    },
    async dispose() { disposed = true; ++generation; foreground = false; clearTimeout(timer); clearFlushTimers(); await running; await restartLive(); listeners.clear(); },
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

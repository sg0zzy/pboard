import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowser, createCloud, logStatusOf, type BrowserHandle } from './fixtures/browser';

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 5000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out: ${label}`);
}

describe('Firefox Drive-authorized board runtime', { timeout: 120_000 }, () => {
  const cloud = createCloud();
  const browsers: BrowserHandle[] = [];
  afterEach(async () => { for (const browser of browsers.splice(0)) await browser.close(); });
  it('starts and reconnects with Drive admission without contacting legacy identity or grant endpoints', async () => {
    const ownCloud = createCloud(), originalFetch = ownCloud.fetch;
    const legacyPaths: string[] = [];
    ownCloud.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/identity/') || path.startsWith('/grants/')) legacyPaths.push(path);
      return await originalFetch(input, init);
    }) as typeof fetch;
    const a = await createBrowser({ label: 'drive-only-authority', email: 'drive-only@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(a);
    const board = await a.rx.createProject('Drive authorized', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await a.runtime.collaborationManager.start(board.id);
    await waitFor(() => logStatusOf(a, board.id)?.phase === 'synced', 'Drive room connected');
    await a.runtime.healRelay(board.id, { force: true });
    const socket = ownCloud.signaling.sockets.find(entry => entry.readyState === 1);
    socket?.kill();
    await waitFor(() => logStatusOf(a, board.id)?.phase === 'synced', 'Drive room recovered');
    expect(ownCloud.signaling.admitted.length).toBeGreaterThan(0);
    expect(legacyPaths).toEqual([]);
  });
  it('does not fall back to a signed authority when Google identity credentials are unavailable', async () => {
    const ownCloud = createCloud(), originalFetch = ownCloud.fetch;
    const legacyPaths: string[] = [];
    ownCloud.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/identity/') || path.startsWith('/grants/')) legacyPaths.push(path);
      return await originalFetch(input, init);
    }) as typeof fetch;
    const a = await createBrowser({ label: 'missing-drive-identity', email: 'missing@example.com', cloud: ownCloud }); browsers.push(a);
    const board = await a.rx.createProject('No identity credentials', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await a.runtime.accountChannel.start();
    await a.runtime.collaborationManager.start(board.id);
    expect(ownCloud.signaling.sockets).toHaveLength(0);
    expect(legacyPaths).toEqual([]);
  });
  it('discovers new boards in both directions without a manual Drive sync', async () => {
    const ownCloud = createCloud();
    const a = await createBrowser({ label: 'new-board-a', email: 'same@example.com', cloud: ownCloud, driveAuthority: true, publishCreated: true }); browsers.push(a);
    const b = await createBrowser({ label: 'new-board-b', email: 'same@example.com', cloud: ownCloud, driveAuthority: true, publishCreated: true }); browsers.push(b);
    await Promise.all([a.runtime.accountChannel.start(), b.runtime.accountChannel.start()]);
    await waitFor(() => [a, b].every(client => client.runtime.accountChannel.status().state === 'connected'), 'account rooms connected');
    const first = await a.rx.createProject('Created by A', 'project');
    await waitFor(async () => !!await b.rx.getProject(first.id), 'B discovers A board');
    const second = await b.rx.createProject('Created by B', 'project');
    await waitFor(async () => !!await a.rx.getProject(second.id), 'A discovers B board');
  });
  it('keeps account discovery connected when the selected board closes', async () => {
    const ownCloud = createCloud();
    const a = await createBrowser({ label: 'account-stays-open', email: 'same@example.com', cloud: ownCloud, driveAuthority: true, publishCreated: true }); browsers.push(a);
    const board = await a.rx.createProject('Board', 'project');
    await waitFor(() => a.rx.operationSource.bindings.has(board.id), 'board published');
    await a.runtime.collaborationManager.start(board.id);
    await waitFor(() => a.runtime.accountChannel.status().state === 'connected' && logStatusOf(a, board.id)?.phase === 'synced', 'account and board connected');
    const socket = ownCloud.signaling.sockets[0];
    await a.runtime.collaborationManager.stop();
    expect(a.runtime.accountChannel.status().state).toBe('connected');
    expect(ownCloud.signaling.sockets[0]).toBe(socket);
    expect(socket.readyState).toBe(1);
  });
  it('delivers live edits to the same account and a Drive editor without manifests', async () => {
    const owner = await createBrowser({ label: 'owner', email: 'owner@example.com', cloud, driveAuthority: true }); browsers.push(owner);
    const same = await createBrowser({ label: 'same', email: 'owner@example.com', cloud, driveAuthority: true }); browsers.push(same);
    const editor = await createBrowser({ label: 'editor', email: 'editor@example.com', cloud, driveAuthority: true }); browsers.push(editor);
    const board = await owner.rx.createProject('Drive authority board', 'project');
    await owner.runtime.googleDrive.syncProject(board.id, { force: true });
    cloud.drive.grant(board.id, editor.email, 'writer');
    await same.runtime.googleDrive.reconcileAll({ force: true });
    await editor.runtime.googleDrive.reconcileAll({ force: true });
    const renewalCallbacks: Array<() => void> = [];
    const originalTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback === 'function' && typeof delay === 'number' && delay >= 85_000 && delay <= 90_000) renewalCallbacks.push(() => callback(...args));
      return originalTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    for (const browser of [owner, same, editor]) {
      await browser.runtime.collaborationManager.start(board.id);
      await waitFor(() => logStatusOf(browser, board.id)?.phase === 'synced', `${browser.label} sync`);
    }
    expect([...cloud.signaling.rooms.values()].filter(room => room.board === board.id)).toHaveLength(1);
    expect(cloud.signaling.sockets).toHaveLength(3);
    expect(cloud.signaling.directory.size).toBe(0);
    await owner.rx.addItem({ projectId: board.id, content: 'from owner over relay' });
    for (const browser of [same, editor]) {
      await waitFor(async () => (await browser.rx.listCards(board.id)).some(card => card.content === 'from owner over relay'), `${browser.label} receives owner edit`);
    }
    await editor.rx.addItem({ projectId: board.id, content: 'from editor over relay' });
    await waitFor(async () => (await owner.rx.listCards(board.id)).some(card => card.content === 'from editor over relay'), 'owner receives editor edit');
    const strangerToken = cloud.drive.addAccount('stranger@example.com');
    cloud.accounts.set(strangerToken, 'stranger@example.com');
    const denied = await cloud.fetch('https://relay.invalid/drive/admit', { method: 'POST', body: JSON.stringify({ idToken: `id:${strangerToken}`, accessToken: strangerToken, boardId: board.id, folderId: cloud.drive.mustFind(board.id).id, challenge: 'c'.repeat(43), session: 's'.repeat(43) }) });
    expect(denied.status).toBe(403);
    const sameAdmission = cloud.signaling.admitted.filter(entry => entry.email === same.email && entry.kind === 'authenticate')[1];
    const sameSocket = cloud.signaling.sockets.find(socket => socket.deviceKeyId === sameAdmission.deviceKeyId)!;
    sameSocket.kill();
    await owner.rx.addItem({ projectId: board.id, content: 'replayed after disconnect' });
    await waitFor(async () => (await same.rx.listCards(board.id)).some(card => card.content === 'replayed after disconnect'), 'disconnected session replays missed edit');
    await owner.runtime.collaborationManager.stop();
    const editorAdmission = cloud.signaling.admitted.find(entry => entry.email === editor.email)!;
    cloud.signaling.sockets.find(socket => socket.deviceKeyId === editorAdmission.deviceKeyId)!.kill();
    await editor.rx.addItem({ projectId: board.id, content: 'editor while owner offline' });
    await waitFor(async () => (await same.rx.listCards(board.id)).some(card => card.content === 'editor while owner offline'), 'offline editor outbox with owner offline');
    const editorRenewal = renewalCallbacks.at(-1)!;
    await owner.runtime.collaborationManager.start(board.id);
    await waitFor(() => logStatusOf(owner, board.id)?.phase === 'synced', 'owner reopens');
    expect(renewalCallbacks.length).toBeGreaterThanOrEqual(3);
    cloud.drive.mustFind(board.id).permissions.delete(editor.email);
    editorRenewal();
    await waitFor(() => logStatusOf(editor, board.id)?.phase === 'error', 'revoked editor detached');
    const liveRoom = [...cloud.signaling.rooms.values()].find(room => room.board === board.id)!;
    expect(cloud.signaling.sockets.filter(socket => socket.rooms.has(liveRoom.room))).toHaveLength(2);
    timerSpy.mockRestore();
    const second = await owner.rx.createProject('Second board', 'project');
    await owner.runtime.googleDrive.syncProject(second.id, { force: true });
    await owner.runtime.collaborationManager.start(second.id);
    await waitFor(() => logStatusOf(owner, second.id)?.phase === 'synced', 'second board sync');
    expect(cloud.signaling.sockets).toHaveLength(3);
  });
  it('replicates the sidebar board order over the same Google account room', async () => {
    const ownCloud = createCloud();
    const a = await createBrowser({ label: 'sort-a', email: 'sort@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(a);
    const b = await createBrowser({ label: 'sort-b', email: 'sort@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(b);
    const first = await a.rx.createProject('First', 'project');
    const second = await a.rx.createProject('Second', 'project');
    await a.runtime.googleDrive.syncProject(first.id, { force: true });
    await a.runtime.googleDrive.syncProject(second.id, { force: true });
    await b.runtime.googleDrive.reconcileAll({ force: true });
    await a.runtime.collaborationManager.start(first.id);
    await b.runtime.collaborationManager.start(first.id);
    await waitFor(() => a.runtime.accountChannel.status().state === 'connected' && b.runtime.accountChannel.status().state === 'connected', 'account rooms connected');
    await waitFor(async () => (await b.rx.listProjects()).length === 2, 'both boards discovered');
    const desired = (await a.rx.listProjects()).map(project => project.id).reverse();
    await a.rx.reorderProjects(desired);
    await waitFor(async () => JSON.stringify((await b.rx.listProjects()).map(project => project.id)) === JSON.stringify(desired), 'board order reached the other session');
    expect(ownCloud.signaling.sockets).toHaveLength(2);
    expect(ownCloud.signaling.directory.size).toBe(0);
  });

  it('announces creation and deletion only to the same account, without opening the board on the receiver', async () => {
    const ownCloud = createCloud();
    const a = await createBrowser({ label: 'lifecycle-a', email: 'lifecycle@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(a);
    const b = await createBrowser({ label: 'lifecycle-b', email: 'lifecycle@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(b);
    const stranger = await createBrowser({ label: 'lifecycle-stranger', email: 'stranger@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(stranger);
    await Promise.all([a.runtime.accountChannel.start(), b.runtime.accountChannel.start(), stranger.runtime.accountChannel.start()]);
    await waitFor(() => [a, b, stranger].every(client => client.runtime.accountChannel.status().state === 'connected'), 'lifecycle account rooms connected');
    const board = await a.rx.createProject('Lifecycle board', 'project');
    await a.runtime.googleDrive.syncProject(board.id, { force: true });
    await waitFor(async () => !!await b.rx.getProject(board.id), 'same account receives creation');
    expect(await stranger.rx.getProject(board.id)).toBeNull();
    expect(ownCloud.signaling.sockets.every(socket => ![...socket.rooms.values()].some(room => room.board === board.id))).toBe(true);
    await a.rx.deleteProject(board.id);
    await waitFor(async () => !await b.rx.getProject(board.id), 'same account receives deletion');
    expect(await stranger.rx.isDeletedProject(board.id)).toBe(false);
    const ghost = 'never-subscribed-board';
    const beforeGhost = b.runtime.accountChannel.status().appliedSeq;
    expect(await a.runtime.accountChannel.publishTombstone(ghost, { kind: 'deleted', opId: 'ghost-actor:1', actorId: 'ghost-actor', seq: 1, clock: 1, context: {}, role: 'editor' })).toBe(true);
    await waitFor(() => b.runtime.accountChannel.status().lastKind === 'board.tombstone' && b.runtime.accountChannel.status().appliedSeq > beforeGhost, 'unknown tombstone delivered');
    expect(await b.rx.isDeletedProject(ghost)).toBe(false);
  });

  it('synchronizes an editor leaving to that account while keeping the owner board', async () => {
    const ownCloud = createCloud();
    const owner = await createBrowser({ label: 'leave-owner', email: 'leave-owner@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(owner);
    const a = await createBrowser({ label: 'leave-a', email: 'leave-editor@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(a);
    const b = await createBrowser({ label: 'leave-b', email: 'leave-editor@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(b);
    await Promise.all([owner.runtime.accountChannel.start(), a.runtime.accountChannel.start(), b.runtime.accountChannel.start()]);
    await waitFor(() => [owner, a, b].every(client => client.runtime.accountChannel.status().state === 'connected'), 'leave account rooms connected');
    const board = await owner.rx.createProject('Shared board', 'project');
    await owner.runtime.googleDrive.syncProject(board.id, { force: true });
    ownCloud.drive.grant(board.id, a.email, 'writer');
    await a.runtime.googleDrive.reconcileAll({ force: true });
    await b.runtime.googleDrive.reconcileAll({ force: true });
    expect(await a.rx.getProject(board.id)).not.toBeNull();
    expect(await b.rx.getProject(board.id)).not.toBeNull();
    await a.rx.deleteProject(board.id);
    await waitFor(async () => !await b.rx.getProject(board.id), 'leave reaches editor account');
    expect(await owner.rx.getProject(board.id)).not.toBeNull();
    expect(await owner.rx.isDeletedProject(board.id)).toBe(false);
  });

  it('delivers an owner deletion to an editor subscribed to that board', async () => {
    const ownCloud = createCloud();
    const owner = await createBrowser({ label: 'delete-owner', email: 'delete-owner@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(owner);
    const editor = await createBrowser({ label: 'delete-editor', email: 'delete-editor@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(editor);
    const board = await owner.rx.createProject('Deleted shared board', 'project');
    await owner.runtime.googleDrive.syncProject(board.id, { force: true });
    ownCloud.drive.grant(board.id, editor.email, 'writer');
    await editor.runtime.googleDrive.reconcileAll({ force: true });
    await owner.runtime.collaborationManager.start(board.id);
    await editor.runtime.collaborationManager.start(board.id);
    await waitFor(() => logStatusOf(editor, board.id)?.phase === 'synced', 'editor subscribed');
    await owner.rx.deleteProject(board.id);
    await waitFor(async () => !await editor.rx.getProject(board.id), 'editor observes owner deletion');
  });

  it('announces a newly discovered Drive subscription to another session of that account', async () => {
    const ownCloud = createCloud();
    const owner = await createBrowser({ label: 'share-owner', email: 'share-owner@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(owner);
    const a = await createBrowser({ label: 'share-a', email: 'share-editor@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(a);
    const b = await createBrowser({ label: 'share-b', email: 'share-editor@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(b);
    await Promise.all([a.runtime.accountChannel.start(), b.runtime.accountChannel.start()]);
    await waitFor(() => [a, b].every(client => client.runtime.accountChannel.status().state === 'connected'), 'subscription account rooms connected');
    const board = await owner.rx.createProject('New shared subscription', 'project');
    await owner.runtime.googleDrive.syncProject(board.id, { force: true });
    ownCloud.drive.grant(board.id, a.email, 'writer');
    expect(await b.rx.getProject(board.id)).toBeNull();
    await a.runtime.googleDrive.reconcileAll({ force: true });
    await waitFor(async () => !!await b.rx.getProject(board.id), 'subscription discovered by second session');
    // The owner's synchronization opens its own account socket as well.
    expect(ownCloud.signaling.sockets).toHaveLength(3);
  });

  it('notifies an already-connected invitee over WebSocket and verifies the Drive share', async () => {
    const ownCloud = createCloud();
    const owner = await createBrowser({ label: 'invite-owner', email: 'invite-owner@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(owner);
    const guest = await createBrowser({ label: 'invite-guest', email: 'invite-guest@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(guest);
    const outsider = await createBrowser({ label: 'invite-outsider', email: 'invite-outsider@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(outsider);
    await Promise.all([guest.runtime.accountChannel.start(), outsider.runtime.accountChannel.start()]);
    await waitFor(() => [guest, outsider].every(client => client.runtime.accountChannel.status().state === 'connected'), 'recipient inbox connected');
    const board = await owner.rx.createProject('A live invitation', 'project');
    await owner.runtime.googleDrive.syncProject(board.id, { force: true });
    await owner.runtime.collaborationManager.start(board.id);
    await waitFor(() => logStatusOf(owner, board.id)?.phase === 'synced', 'owner board connected');
    expect(await guest.rx.getProject(board.id)).toBeNull();
    await owner.runtime.sharePermissions.invite(board.id, guest.email, 'editor');
    await waitFor(async () => !!await guest.rx.getProject(board.id), 'invitee sees board without polling');
    expect(await outsider.rx.getProject(board.id)).toBeNull();
    expect(ownCloud.signaling.sockets).toHaveLength(3);
  });

  it('replays an invitation after the recipient reconnects', async () => {
    const ownCloud = createCloud();
    const owner = await createBrowser({ label: 'replay-owner', email: 'replay-owner@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(owner);
    const guest = await createBrowser({ label: 'replay-guest', email: 'replay-guest@example.com', cloud: ownCloud, driveAuthority: true }); browsers.push(guest);
    await guest.runtime.accountChannel.start();
    await waitFor(() => guest.runtime.accountChannel.status().state === 'connected', 'recipient account connected');
    const board = await owner.rx.createProject('Invitation during outage', 'project');
    await owner.runtime.googleDrive.syncProject(board.id, { force: true });
    await owner.runtime.collaborationManager.start(board.id);
    await waitFor(() => logStatusOf(owner, board.id)?.phase === 'synced', 'owner board connected');
    const admission = ownCloud.signaling.admitted.find(entry => entry.email === guest.email)!;
    ownCloud.signaling.unreachable = true;
    ownCloud.signaling.sockets.find(socket => socket.deviceKeyId === admission.deviceKeyId)!.kill();
    await owner.runtime.sharePermissions.invite(board.id, guest.email, 'editor');
    expect(await guest.rx.getProject(board.id)).toBeNull();
    ownCloud.signaling.unreachable = false;
    await waitFor(async () => !!await guest.rx.getProject(board.id), 'invitation replayed after reconnect');
  });

});

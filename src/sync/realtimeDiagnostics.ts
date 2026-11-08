/**
 * What a board's realtime room actually saw, for the browser console.
 *
 * The room's own state is not visible anywhere a user can read: the sidebar has
 * one status sentence, and every failure of presence, permission or peer
 * connection collapses into "waiting for another browser". This keeps the last
 * answer per board — which presence files the listing named, which of them
 * resolved to a role, which peers are connected and what the room last
 * complained about — so the difference between "nobody is here", "they are here
 * but I cannot verify them" and "we cannot connect" can be read instead of
 * inferred from a network log.
 *
 * Only identifiers and outcomes are stored, never board content, tokens or ICE
 * credentials: the snapshot is meant to be pasted into a bug report.
 */
import { automaticAuthBudget } from '../collab/authBudget';
import { collaborationCounters } from '../collab/counters';
import { transportSnapshot } from './transportDiagnostics';
import { keyCourierQueueSnapshot } from './operations/keyCourierQueue';
import { grantAbsenceSnapshot } from '../collab/grantAbsence';

export type RoomSnapshot = {
  boardId: string;
  /** Presence topic: presence files are named `sig-<topic>-<session>.json`. */
  topic: string;
  folderId: string;
  /** This browser's presence session id — its own file in the same folder. */
  self: string;
  /** Peer ids named by the room's presence listing on its last pass. */
  listed: string[];
  /** Peer id to resolved role, or `unresolved` when no role could be read:
   * that peer is listed but excluded from the room. */
  roles: Record<string, string>;
  /** Peer id to seconds since that peer last rewrote its presence file. */
  ages: Record<string, number>;
  /** Whether this browser's own session appears in `listed`: a room whose only
   * entry is `self` is a room nobody else has joined. */
  selfListed: boolean;
  connected: string[];
  error: string | null;
  /** How many rooms this context has started for the board. A number that climbs
   * while the board is merely open is the room flapping — and every start of a
   * room whose identity is not stable is another presence file for the folder. */
  starts: number;
  /** Data-channel counters: did edits leave, were they refused, did they land. */
  channel: Record<string, number> | null;
  /** Durable operation log state, for a board that collaborates through the log
   * instead of a peer-to-peer room: how far it applied, and why not, when that is
   * the answer. `null` while the board uses the peer transport. */
  log: { phase: string; appliedSeq: number; checkpointSeq: number; pending: number; error: string | null; reconnectReason: string | null; throttled: boolean } | null;
  /** Newest first: why the last reconnects happened (`closed`, `network`,
   * `timeout:subscribe`, `refused:lease_busy`, …) and how long the backoff
   * waited. The proxy ages a background tab's tunnel out and closes it without
   * a client-side cause; without this list the difference between "the service
   * refused me" and "nobody pinged me for a minute" only exists in the proxy's
   * log, which is precisely where the person debugging propagation cannot read
   * it from. */
  reconnects: { reason: string; delayMs: number }[];
  /** Last consolidation cycle for this board's durable log, as `status` or
   * `status:reason` — `idle:not-owner`, `idle:no-watermark`, `gap`, `published/7`.
   * Publishing a snapshot is what makes a board cheap to catch up on and what
   * lets the log prune, so an idle cycle is a reportable condition rather than a
   * clean one, and it used to be discarded without being recorded anywhere. */
  consolidation: string | null;
  /** Session counters, when the board's operation session exists. */
  session: Record<string, number | string> | null;
  seenAt: number;
};

/** A browser may open many boards; only the most recent rooms are retained. */
const MAX_ROOMS = 8;
const rooms = new Map<string, RoomSnapshot>();

/** Returns the live snapshot for a board: writers mutate it in place, so a pass
 * that never completes still leaves the previous answer readable. */
export function trackRoom(boardId: string, identity: { self: string; topic: string; folderId: string }): RoomSnapshot {
  let room = rooms.get(boardId);
  if (!room) {
    room = { boardId, topic: identity.topic, folderId: identity.folderId, self: identity.self, listed: [], roles: {}, ages: {}, selfListed: false, connected: [], error: null, starts: 0, channel: null, log: null, reconnects: [], consolidation: null, session: null, seenAt: 0 };
    rooms.set(boardId, room);
  } else {
    Object.assign(room, { topic: identity.topic, folderId: identity.folderId, self: identity.self, selfListed: false });
    room.starts++;
  }
  while (rooms.size > MAX_ROOMS) rooms.delete(rooms.keys().next().value as string);
  return room;
}

/** The live record for a board, when one has ever been opened in this
 * context — the object the room itself writes to, so a heal pass reads the
 * same truth the console prints. Readers must not mutate it. */
export function roomSnapshot(boardId: string): RoomSnapshot | undefined { return rooms.get(boardId); }

export function roomSnapshots(): Array<Omit<RoomSnapshot, 'seenAt'> & { secondsAgo: number }> {
  const now = Date.now();
  return [...rooms.values()].map(room => ({
    ...structuredClone(room),
    seenAt: undefined as never,
    // A role check that could not run no longer closes the room, so why it failed is
    // folded into the same field a broken room reports in.
    error: [room.error, room.session?.roleCheckFailures
      ? `${room.session.roleCheckFailures} Drive role check(s) failed: ${room.session.roleCheckError}`
      : ''].filter(Boolean).join('; ') || null,
    secondsAgo: room.seenAt ? Math.round((now - room.seenAt) / 1000) : -1,
  }) as Omit<RoomSnapshot, 'seenAt'> & { secondsAgo: number });
}

/** Test seam: snapshots are module memory, shared by every board in the process. */
export function clearRoomDiagnostics(): void { rooms.clear(); }

/**
 * The account-level discovery channel's own record: one connection per browser
 * context (`pboard-account-<hash>-order`), carrying the board lifecycle hints
 * that tell a second browser of the same Google account a board exists.
 *
 * It is deliberately not a `RoomSnapshot`: it has no presence files, no peers
 * and no board id, and a failure here is invisible to every board's status —
 * which is exactly the blindness that made the grant-404 loop undiagnosable.
 * `reason` is the field a human reads: `no account pin` says this browser was
 * never enrolled in the account room, and silence would have said nothing.
 */
export type AccountChannelSnapshot = {
  /** Account scope this channel is attached to, or null when it never got one. */
  account: string | null;
  /** `disabled` | `starting` | `connected` | `failed` | `absent-pin` | `gap` | `closed`. */
  state: string;
  /** Why the channel is not working, or `ready`. */
  reason: string;
  /** Why the account authority is or is not available — the cause a bare
   * `absent-pin` cannot carry (`idle`, `created`, `awaiting-admission`, …). */
  authority?: { state: string; reason: string; authorization?: string };
  appliedSeq: number;
  /** `kind` of the last record applied (`board.created`, `board.deleted`, …). */
  lastKind: string | null;
  /** Lifecycle records waiting to go out: non-zero while the relay or Drive is broken. */
  outbox: number;
  /** Records held because Drive did not have their board yet — the normal first
   * answer for a creation-time announcement. */
  deferred: number;
  /** The boards those records name. */
  deferredBoards: string[];
  /** Records received that this build could not use, by reason. */
  skipped: Record<string, number>;
  /** Records handed to verification, by kind. */
  appliedByKind: Record<string, number>;
  error: string | null;
  reconnectReason: string | null;
  throttled: boolean;
  seenAt: number;
};

let accountChannel: AccountChannelSnapshot | undefined;

/** Records the channel's latest answer. Called on every status change, so the
 * console always shows the state the transport last reported. */
export function reportAccountChannel(status: Omit<AccountChannelSnapshot, 'seenAt'>): void {
  accountChannel = { ...status, skipped: { ...status.skipped }, seenAt: Date.now() };
}

/** The account channel as this context saw it, or undefined when none started. */
export function accountChannelDiagnostics(): AccountChannelSnapshot | undefined {
  return accountChannel ? { ...accountChannel, skipped: { ...accountChannel.skipped } } : undefined;
}

/** Test seam, alongside `clearRoomDiagnostics`. */
export function clearAccountChannelDiagnostics(): void { accountChannel = undefined; }

/**
 * Installs `pboardCollaboration()` in a JS context, labelling which one answered
 * — the realtime room lives in whichever context opened the board, so an empty
 * `rooms` means "not here", not "no room". Same reason the Drive ledger is
 * readable from the worker and the sidebar consoles and differs between them.
 */
export function exposeCollaborationDiagnostics(context: string, read: () => unknown): void {
  // Declared on the global type by the installer's own contract: the console
  // handle only exists in a context that called this, and a test asserting the
  // payload needs the call signature rather than a cast at every read.
  (globalThis as Record<string, unknown>).pboardCollaboration = async () => {
    let payload: Record<string, unknown>;
    try {
      // The automatic-auth posture belongs in the same read as the rooms it
      // protects: which endpoints this browser has spent its shared budget on,
      // whether a 429 cooldown is active, and which boards the client stopped
      // polling because the service answered 404. The next occurrence is then
      // readable from the console instead of only from the proxy's log.
      // `authBudget` carries both ceilings the next lockout has to distinguish:
      // `relayDials` is what actually reached the socket (`failed` is the ones
      // the proxy refused), `relayAttempts` is what the log's dial path tried,
      // including attempts that died before a socket existed. A lockout whose
      // cause is the client's own pacing reads `usedInWindow === limit` with
      // `deferred > 0`; one that is something else reads `failed` climbing.
      payload = { context, authBudget: automaticAuthBudget.snapshot(),
        grantAbsences: grantAbsenceSnapshot(),
        // The counters belong in this one read: `transport.open` is the
        // connection count the single-socket requirement is about, the
        // `timer.*` gauges are the recurring work that must not scale with the
        // board count, and `rx.subscriptions`/`journal.listeners` are the
        // handles a board switch has to release. Read them next to the rooms
        // they explain instead of asking a developer to run a second command.
        counters: collaborationCounters.snapshot(),
        // Every relay socket this context dialled, in order, with what caused
        // it and how it ended. The network panel shows the `/ws` requests; this
        // is what attributes them — read `transport.history` to answer "were
        // these sequential or concurrent, and what opened each one", and
        // `transport.byTrigger` to see which subsystem is dialling at all.
        transport: transportSnapshot(),
        // The courier's per-room queue: which rooms have an exchange running or
        // waiting behind it right now. It answers the question `transport` cannot
        // — "was this dial made because nothing had answered this room yet, or
        // because a request insisted on reading it again" — and it is the state
        // that replaced the one-pass-per-trigger churn. Empty means no exchange is
        // in flight anywhere in this context.
        keyCourier: keyCourierQueueSnapshot(),
        // The account-level discovery channel reads as itself, because a board
        // that never appears in the list has no room to complain in: the answer
        // lives on the account room, and an absent pin has to be a stated cause
        // rather than an empty list.
        ...(((await read()) as object) ?? {}),
        account: accountChannelDiagnostics() ?? { state: 'absent', reason: 'no account channel started in this context' } };
    } catch (error) {
      // A console handle that dies on the thing you are debugging is useless: the
      // failure is the answer, so report it instead of rejecting.
      payload = { context, error: error instanceof Error ? `${error.message} ${error.stack ?? ''}`.trim() : String(error) };
    }
    // Printed as well as returned: an object the console prints collapsed and a
    // command that did nothing look identical from where the reader is standing.
    const rooms = (payload.rooms as ReturnType<typeof roomSnapshots> | undefined) ?? [];
    console.info(`pboardCollaboration[${context}]`, payload);
    console.table(rooms.map(entry => ({
      board: entry.boardId.slice(0, 8),
      folder: entry.folderId.slice(0, 8),
      onlyMe: entry.selfListed && entry.listed.length === 1,
      // Which peers are in the room, and how stale each one's presence is; `me`
      // is this browser, so `me:2s` alone answers "nobody else is here".
      peers: entry.listed.map(id => `${id === entry.self ? 'me' : id.slice(0, 6)}:${entry.ages[id] ?? -1}s`).join(' '),
      // `unresolved` is a peer this browser could not verify; `stale` is one whose
      // presence record had expired, i.e. a browser that closed. Without the split
      // a room of ghosts prints exactly like a busy one.
      stale: Object.values(entry.roles).filter(value => value === 'stale').length,
      unresolved: Object.values(entry.roles).filter(value => value === 'unresolved').length,
      connected: entry.connected.length,
      // The durable log's own progress, when the board uses it: how far this
      // browser applied (`phase#sequence`), how many of its edits are still waiting
      // (`+n`), and how often it asked for history that had been consolidated away.
      // Blank on the peer path, where those questions do not exist.
      log: entry.log ? `${entry.log.phase}#${entry.log.appliedSeq}${entry.log.pending ? ` +${entry.log.pending}` : ''}` : '',
      // Why the log last fell over and reconnected (`closed` is the proxy
      // aging out a throttled background tab — expected, and the visibility
      // handler reconnects on the first visible frame). Newest first.
      reconn: [entry.log?.throttled ? 'THROTTLED(Reconnect to retry)' : '', entry.reconnects.map(reconnect => `${reconnect.reason}(${reconnect.delayMs}ms)`).join(' > ') || entry.log?.reconnectReason || ''].filter(Boolean).join(' '),
      acked: entry.channel?.acked ?? 0,
      gaps: entry.channel?.gaps ?? 0,
      starts: entry.starts,
      // `iceFail` counts negotiations that failed outright: with the room staying up,
      // that is the difference between "no candidate pair worked" (a missing relay)
      // and "the peer never got as far as negotiating".
      iceFail: entry.channel?.iceFailed ?? 0,
      roleFail: entry.session?.roleCheckFailures ?? 0,
      // Where an edit stops: `edits`/`sent` on the browser that made it, `recv` on
      // the one that should show it. `blocked` is a channel that would not take the
      // frame, `refused` is the peer's own Drive role check saying no.
      edits: entry.session?.realtimeMessages ?? 0,
      // `refreshes`/`local`: did the local edit even reach the operation session;
      // `bc`: did it reach the room; `skip`: why not, if it did not.
      tries: entry.session?.broadcasts ?? 0,
      local: entry.session?.localOps ?? 0,
      skip: entry.session?.skipped ?? '',
      recv: entry.channel?.receivedOps ?? 0,
      blocked: entry.channel?.blocked ?? 0,
      refused: (entry.channel?.refusedReads ?? 0) + (entry.channel?.refusedWrites ?? 0),
      roomError: entry.error ?? '',
      secondsAgo: entry.secondsAgo,
    })));
    if (!rooms.length) console.info(`no realtime room opened in the ${context} context; run this in the console of the document showing the board`);
    // The connection record prints separately because its unit is the socket,
    // not the room: one socket can carry every room, and the question a network
    // panel raises — "what are all these /ws upgrades?" — is answered here and
    // nowhere in the room table.
    const transport = payload.transport as ReturnType<typeof transportSnapshot> | undefined;
    if (transport && !transport.enabled) {
      // An empty ledger is otherwise indistinguishable from "no connections",
      // which is the wrong conclusion when a network panel is full of upgrades:
      // the counters are compiled out unless the bundle was built with the flag.
      console.info('transport: diagnostics off in this build — rebuild with VITE_PBOARD_DIAGNOSTICS=1 (see BUILD.md) to record dials, closes and reconnect delays');
    }
    if (transport?.dials) {
      console.info(`transport: ${transport.dials} dial(s), ${transport.open} open, ${transport.closed} closed`
        + ` — by trigger ${Object.entries(transport.byTrigger).map(([name, count]) => `${name}:${count}`).join(' ')}`
        + `; by close ${Object.entries(transport.byCloseReason).map(([name, count]) => `${name}:${count}`).join(' ') || 'none'}`);
      console.table(transport.history.map(entry => ({
        id: entry.id,
        trigger: entry.trigger,
        // Named the way the reader thinks about it: a board id, or the account
        // hash abbreviated — the full topic is already in `transport.history`.
        room: entry.room
          ? entry.room.replace(/^pboard-collab-/, '').replace(/-cards$/, '')
            .replace(/^pboard-account-(.{8}).*-order$/, 'account:$1')
          : '',
        device: entry.device ?? '',
        ms: entry.lifetimeMs ?? '',
        open: entry.open,
        close: entry.close ? `${entry.close.by}:${entry.close.code}${entry.close.reason ? ` ${entry.close.reason}` : ''}` : '',
        redial: entry.reconnect.scheduled ? `${entry.reconnect.delayMs}ms` : ''
      })));
    }
    // The account channel prints on its own line because it has no board to be a
    // row of: `account channel: no account pin` is the whole answer to "why did
    // my other browser never hear about this board", and it used to be nothing.
    const account = (payload.account ?? {}) as Partial<AccountChannelSnapshot>;
    console.info(`account channel: ${account.reason ?? 'not started'}`
      + `${account.state && account.state !== 'connected' ? ` [${account.state}]` : ''}`
      + `${account.authority ? ` authority:${account.authority.state} (${account.authority.reason})` : ''}`
      + `${account.appliedSeq ? ` applied#${account.appliedSeq}` : ''}${account.lastKind ? ` last:${account.lastKind}` : ''}`
      + `${account.outbox ? ` outbox:${account.outbox}` : ''}`);
    return payload;
  };
}

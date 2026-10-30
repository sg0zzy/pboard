/**
 * Lightweight counters for the extension's recurring work.
 *
 * The counters exist so a sustained CPU problem can be attributed to a
 * component without a profiler. They are only incremented, never logged from
 * a hot path, and the collection itself is disabled outside a development
 * build, so the production cost is a single boolean check per call site.
 */
import { driveCostResource, driveRequestCost, type DriveCostResource } from "../sync/driveQuota";

/** The counters a development build exposes. */
export type CollaborationCounters = {
  /** Drive requests issued, by purpose. */
  driveRequests: { sync: number; reconcile: number; discovery: number; identity: number; other: number };
  /** Drive request cost, by resource. `byResource` holds the authoritative number:
   *  Google's reported `X-Drive-Request-Cost` when the response carried it, otherwise
   *  the projection, which is the local model (`projected`) and not a measurement.
   */
  driveCost: {
    requests: number;
    projected: number;
    reported: number;
    reportedRequests: number;
    byResource: Partial<Record<DriveCostResource, number>>;
  };
  /** Background sync attempts, and how they ended. */
  backgroundSync: { attempts: number; settled: number; unsettled: number; failed: number; scheduled: number };
  /** The boards the background worker is currently retrying. */
  retryingBoards: number;
  /** The shared-project discovery listings, and how many were served from the cache. */
  sharedDiscovery: { listings: number; cached: number };
  /** The account identity lookups, and how many were served from the cache. */
  accountIdentity: { lookups: number; cached: number };
  /** The collaboration manager's live rooms and peers. */
  rooms: number;
  peers: number;
  /** React renders, by component. */
  renders: Record<string, number>;
  /** Effect executions, by name. */
  effects: Record<string, number>;
  /** Repository subscription emissions, by subscription. */
  emissions: Record<string, number>;
  /** Replication and room initialisations. */
  initialisations: Record<string, number>;
  /** Wall-clock durations of the recurring operations, by name. */
  timings: Record<string, { runs: number; lastMs: number; totalMs: number }>;
  /** Aggregated subsystem activity, by event name (idle-work attribution). */
  events: Record<string, number>;
  /** Live gauges: subscriptions, sockets, sessions that are currently open. */
  active: Record<string, number>;
};

const counters: CollaborationCounters = {
  driveRequests: { sync: 0, reconcile: 0, discovery: 0, identity: 0, other: 0 },
  driveCost: { requests: 0, projected: 0, reported: 0, reportedRequests: 0, byResource: {} },
  backgroundSync: { attempts: 0, settled: 0, unsettled: 0, failed: 0, scheduled: 0 },
  retryingBoards: 0,
  sharedDiscovery: { listings: 0, cached: 0 },
  accountIdentity: { lookups: 0, cached: 0 },
  rooms: 0,
  peers: 0,
  renders: {},
  effects: {},
  emissions: {},
  initialisations: {},
  timings: {},
  events: {},
  active: {}
};

/**
 * Whether the counters are collected.
 *
 * A production build does not collect them, so the cost of the call sites is a
 * single boolean test. A build can turn them on with
 * `VITE_PBOARD_DIAGNOSTICS=1`, which is how a sustained CPU problem is
 * attributed to a component without a profiler.
 */
declare const __PBOARD_DIAGNOSTICS__: boolean;
const DIAGNOSTICS: boolean = typeof __PBOARD_DIAGNOSTICS__ === "undefined" ? false : __PBOARD_DIAGNOSTICS__;
const enabled = (): boolean => DIAGNOSTICS;

export const collaborationCounters = {
  /** Whether the counters are collected in this build. */
  enabled: DIAGNOSTICS,
  /** The current counters. Always readable, so a report can be produced. */
  snapshot(): CollaborationCounters {
    return {
      driveRequests: { ...counters.driveRequests },
      driveCost: { ...counters.driveCost, byResource: { ...counters.driveCost.byResource } },
      backgroundSync: { ...counters.backgroundSync },
      retryingBoards: counters.retryingBoards,
      sharedDiscovery: { ...counters.sharedDiscovery },
      accountIdentity: { ...counters.accountIdentity },
      rooms: counters.rooms,
      peers: counters.peers,
      renders: { ...counters.renders },
      effects: { ...counters.effects },
      emissions: { ...counters.emissions },
      initialisations: { ...counters.initialisations },
      timings: Object.fromEntries(Object.entries(counters.timings).map(([name, entry]) => [name, { ...entry }])),
      events: { ...counters.events },
      active: { ...counters.active }
    };
  },
  /** Reset every counter. */
  clear(): void {
    counters.driveRequests = { sync: 0, reconcile: 0, discovery: 0, identity: 0, other: 0 };
    counters.driveCost = { requests: 0, projected: 0, reported: 0, reportedRequests: 0, byResource: {} };
    counters.backgroundSync = { attempts: 0, settled: 0, unsettled: 0, failed: 0, scheduled: 0 };
    counters.retryingBoards = 0;
    counters.sharedDiscovery = { listings: 0, cached: 0 };
    counters.accountIdentity = { lookups: 0, cached: 0 };
    counters.rooms = 0;
    counters.peers = 0;
    counters.renders = {};
    counters.effects = {};
    counters.emissions = {};
    counters.initialisations = {};
    counters.timings = {};
    counters.events = {};
    counters.active = {};
  },
  countDriveRequest(purpose: keyof CollaborationCounters["driveRequests"]): void {
    if (!enabled()) return;
    counters.driveRequests[purpose] += 1;
  },
  /** Price one Drive request; Google's reported cost outranks the local projection. */
  countDriveCost(resource: DriveCostResource, projected: number, reported?: number): void {
    if (!enabled()) return;
    const cost = counters.driveCost;
    cost.requests += 1;
    cost.projected += projected;
    if (reported === undefined || !Number.isFinite(reported)) {
      cost.byResource[resource] = (cost.byResource[resource] ?? 0) + projected;
      return;
    }
    cost.reported += reported;
    cost.reportedRequests += 1;
    cost.byResource[resource] = (cost.byResource[resource] ?? 0) + reported;
  },
  countEvent(name: string, by = 1): void {
    if (!enabled()) return;
    counters.events[name] = (counters.events[name] ?? 0) + by;
  },
  /** Set a live gauge (open subscriptions, sockets, sessions) to `value`. */
  setActive(name: string, value: number): void {
    if (!enabled()) return;
    counters.active[name] = value;
  },
  countBackgroundSync(outcome: "attempts" | "settled" | "unsettled" | "failed" | "scheduled"): void {
    if (!enabled()) return;
    counters.backgroundSync[outcome] += 1;
  },
  setRetryingBoards(count: number): void {
    if (!enabled()) return;
    counters.retryingBoards = count;
  },
  countSharedDiscovery(cached: boolean): void {
    if (!enabled()) return;
    counters.sharedDiscovery.listings += 1;
    if (cached) counters.sharedDiscovery.cached += 1;
  },
  countAccountIdentity(cached: boolean): void {
    if (!enabled()) return;
    counters.accountIdentity.lookups += 1;
    if (cached) counters.accountIdentity.cached += 1;
  },
  setRooms(rooms: number, peers: number): void {
    if (!enabled()) return;
    counters.rooms = rooms;
    counters.peers = peers;
  },
  countRender(component: string): void {
    if (!enabled()) return;
    counters.renders[component] = (counters.renders[component] ?? 0) + 1;
  },
  countEffect(effect: string): void {
    if (!enabled()) return;
    counters.effects[effect] = (counters.effects[effect] ?? 0) + 1;
  },
  countEmission(subscription: string): void {
    if (!enabled()) return;
    counters.emissions[subscription] = (counters.emissions[subscription] ?? 0) + 1;
  },
  countInitialisation(what: string): void {
    if (!enabled()) return;
    counters.initialisations[what] = (counters.initialisations[what] ?? 0) + 1;
  },
  /** Record one measured execution of a named operation. */
  time(name: string, ms: number): void {
    if (!enabled()) return;
    const entry = counters.timings[name] ?? { runs: 0, lastMs: 0, totalMs: 0 };
    entry.runs += 1;
    entry.lastMs = Math.round(ms);
    entry.totalMs = Math.round(entry.totalMs + ms);
    counters.timings[name] = entry;
  },
  /** Measure one execution of `run` under `name`. A passthrough when disabled. */
  async timed<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    if (!enabled()) return await run();
    const started = Date.now();
    try { return await run(); } finally { this.time(name, Date.now() - started); }
  },
  /**
   * Label the Drive requests issued while `run` is awaited so `driveRequests`
   * attributes traffic to the operation that caused it. Operations interleave
   * on one thread and share the innermost label — good enough to attribute
   * idle traffic, not a per-request audit. A passthrough when disabled.
   */
  async withDrivePurpose<T>(purpose: DrivePurpose, run: () => Promise<T>): Promise<T> {
    if (!enabled()) return await run();
    const previous = drivePurpose;
    drivePurpose = purpose;
    try { return await run(); } finally { drivePurpose = previous; }
  },
  /**
   * Wrap the fetcher every Drive provider uses, counting requests by the
   * active purpose (identity endpoints always by URL). Returns the same
   * fetcher in a production build.
   */
  instrumentFetcher(fetcher: typeof fetch): typeof fetch {
    if (!DIAGNOSTICS) return fetcher;
    return async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
      const purpose: DrivePurpose = /drive\/v3\/about|\/oauth2\/v1\/userinfo|oauth2\.googleapis.com\/(token|revoke)/.test(url)
        ? "identity"
        : drivePurpose ?? "other";
      counters.driveRequests[purpose] += 1;
      const response = await fetcher(input, init);
      // Only Drive endpoints are priced, and the header number outranks the model.
      if (url.includes("/drive/v3/")) {
        const header = response.headers?.get("X-Drive-Request-Cost");
        const reported = header ? Number(header) : undefined;
        collaborationCounters.countDriveCost(driveCostResource(url), driveRequestCost(url), reported);
      }
      return response;
    };
  }
};

/** The counters API this module publishes: the shape consumers and the background
 *  global see. Named here so callers import a contract instead of projecting the
 *  implementation value's type. */
export type CollaborationCountersApi = typeof collaborationCounters;

type DrivePurpose = keyof CollaborationCounters["driveRequests"];
let drivePurpose: DrivePurpose | null = null;

declare global {
  /**
   * The recurring work counters, exposed on the background page's global in a
   * development build so a developer can read them from the console.
   */
  var pboardCounters: CollaborationCountersApi | undefined;
  /** Set by the build when the counters are collected. */
  var __PBOARD_DIAGNOSTICS__: boolean;
}

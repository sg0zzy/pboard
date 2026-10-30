import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from "vitest";
import {
  DRIVE_COST_WINDOW_MS,
  DRIVE_DEFAULT_COST_PER_MINUTE,
  DriveQuotaExceededError,
  createDriveQuotaThrottle,
  defaultDriveQuotaThrottle,
  driveQuotaError,
  driveRequestCost,
  isDriveQuotaFailure,
  parseQuotaFailure,
  type DriveQuotaEvent,
  type DriveQuotaThrottle
} from "../src/sync/driveQuota";
import { driveBoundedRetryDelayMs, driveRetryAfterMs, driveSecondDelayMs } from "../src/sync/driveRetry";
import { createDrivePermissionTransport } from "../src/sync/drivePermissions";
import { createDriveTransport } from "../src/sync/driveTransport";
import { createOperationDriveStore } from "../src/sync/operations/driveStore";
import { createDriveBoardStore } from "../src/sync/driveBoardStore";
import type { GoogleAuthProvider } from "../src/sync/googleAuth";

const WINDOW = DRIVE_COST_WINDOW_MS;

type ErrorBody = { error: { code: number; message: string; status: string; errors?: { reason: string }[] } };

/** The funnels' `errorDetail`: first reason, then status, then message, joined. */
const detailOf = (body: ErrorBody): string =>
  [body.error.errors?.[0]?.reason, body.error.status, body.error.message].filter(Boolean).join(": ");

/** Permission-shaped envelope that reports an API quota reason; the classification must follow the reason. */
const QUOTA_BODY: ErrorBody = {
  error: {
    code: 403,
    message: "Quota exceeded for quota metric 'Total Query Cost' and usage limit 'query cost per minute' for consumer 'project:pboard'. Try again later. second delays (1-10 seconds).",
    status: "PERMISSION_DENIED",
    errors: [{ reason: "rateLimitExceeded" }]
  }
};
const USER_RATE_LIMIT_BODY: ErrorBody = {
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Total Query Cost' and usage limit 'query cost per minute' for consumer 'project:pboard'. second delays (1-10 seconds).",
    status: "RESOURCE_EXHAUSTED",
    errors: [{ reason: "userRateLimitExceeded" }]
  }
};
const PERMISSION_BODIES: Record<string, ErrorBody> = {
  insufficientPermissions: { error: { code: 403, message: "Access permission for this request is insufficient.", status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } },
  accessTokenPolicyInsufficient: { error: { code: 403, message: "The access token policy does not permit access to this resource.", status: "PERMISSION_DENIED", errors: [{ reason: "accessTokenPolicyInsufficient" }] } },
  insufficientScopes: { error: { code: 403, message: "The granted scopes do not include the required Drive scope.", status: "PERMISSION_DENIED", errors: [{ reason: "insufficientScopes" }] } }
};
/** Storage quota: same word "quota", but not an API-quota meter, so it must not classify as API quota. */
const STORAGE_QUOTA_BODY: ErrorBody = {
  error: { code: 403, message: "Cannot create more files, folders, or items by using Google Drive storage quota.", status: "capacityExceeded", errors: [{ reason: "capacityExceeded" }] }
};

const deny = (body: ErrorBody, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: body.error.code, headers: { "Content-Type": "application/json", ...headers } });

function fakeAuth(): GoogleAuthProvider {
  return {
    connect: async () => {},
    disconnect: async () => {},
    getConnectionState: async (): Promise<"connected"> => "connected",
    isConfigured: () => true,
    getAccessToken: vi.fn(async () => "drive-token")
  };
}

/** Fully controlled clock: every wait is recorded and advances the fake clock. No wall-clock sleeps. */
function makeThrottle(maxCostPerMinute = DRIVE_DEFAULT_COST_PER_MINUTE) {
  let nowMs = 1_700_000_000_000;
  const waits: number[] = [];
  const events: DriveQuotaEvent[] = [];
  const throttle = createDriveQuotaThrottle({
    maxCostPerMinute,
    now: () => nowMs,
    sleep: async (ms) => { waits.push(ms); nowMs += ms; },
    log: (event) => events.push(event)
  });
  return { throttle, waits, events, clock: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

// 1. Classification.
describe("driveQuota classification", () => {
  it("classifies a permission-shaped 403 envelope reporting a quota reason as API quota", async () => {
    const failure = parseQuotaFailure(detailOf(QUOTA_BODY));
    expect(failure).not.toBeNull();
    expect(failure!.reason).toBe("rateLimitExceeded");
    expect(failure!.metric).toBe("Total Query Cost");
    expect(failure!.limit).toBe("query cost per minute");
    expect(failure!.consumer).toBe("project:pboard");
    expect(failure!.secondDelayRange).toEqual([1, 10]);
    expect(isDriveQuotaFailure(detailOf(QUOTA_BODY))).toBe(true);
    // userRateLimitExceeded is the same API-quota class; parseQuotaFailure normalizes the reason.
    const userFailure = parseQuotaFailure(detailOf(USER_RATE_LIMIT_BODY));
    expect(userFailure).not.toBeNull();
    expect(detailOf(USER_RATE_LIMIT_BODY)).toContain("userRateLimitExceeded");
    expect(userFailure!.reason).toBe("rateLimitExceeded");
    expect(userFailure!.secondDelayRange).toEqual([1, 10]);
  });

  it("never classifies permission failures as quota", async () => {
    for (const [reason, body] of Object.entries(PERMISSION_BODIES)) {
      const detail = detailOf(body);
      expect(parseQuotaFailure(detail), reason).toBeNull();
      expect(isDriveQuotaFailure(detail), reason).toBe(false);
    }
  });

  it("keeps capacityExceeded as storage quota, not API quota", async () => {
    const detail = detailOf(STORAGE_QUOTA_BODY);
    expect(detail).toContain("capacityExceeded");
    expect(parseQuotaFailure(detail)).toBeNull();
    expect(isDriveQuotaFailure(detail)).toBe(false);
    expect(driveSecondDelayMs(detail)).toBeNull();
    // The API-quota meter wording is what the gate keys on, so the same status with
    // that wording does classify, and the two are distinguishable.
    const apiQuota = "capacityExceeded: capacityExceeded: Quota exceeded for quota metric 'Storage quota' and limit 'Storage quota per user' for consumer 'project:pboard'.";
    expect(parseQuotaFailure(apiQuota)?.reason).toBe("quotaExceeded");
  });
});

// 2. Precedence: the quota check runs before the role/permission mapping in every funnel.
describe("quota precedence through each funnel", () => {
  it("drivePermissions surfaces the quota-shaped 403 as quota, not as a permission error", async () => {
    const { throttle, waits } = makeThrottle();
    const transport = createDrivePermissionTransport(fakeAuth(), vi.fn<typeof fetch>(async () => deny(QUOTA_BODY)), throttle);
    const error = await rejection(transport.listPermissions("folder-1"));
    expect(error).toBeInstanceOf(DriveQuotaExceededError);
    expect((error as DriveQuotaExceededError).failure?.reason).toBe("rateLimitExceeded");
    expect((error as DriveQuotaExceededError).message).toContain("(403)");
    expect(waits).toEqual([]);

    // The same permission-shaped envelope with a genuine permission reason still maps to the permission path.
    const permissionTransport = createDrivePermissionTransport(fakeAuth(), vi.fn<typeof fetch>(async () => deny(PERMISSION_BODIES.insufficientScopes)), makeThrottle().throttle);
    const permissionError = await rejection(permissionTransport.listPermissions("folder-1"));
    expect(permissionError).not.toBeInstanceOf(DriveQuotaExceededError);
    expect((permissionError as Error).message).toContain("reconnect Google Drive and allow project sharing access");
  });

  it("driveTransport surfaces the quota-shaped 403 as quota and does not hide it", async () => {
    const { throttle } = makeThrottle();
    const transport = createDriveTransport(fakeAuth(), vi.fn<typeof fetch>(async () => deny(QUOTA_BODY)), "project-", undefined, throttle);
    const error = await rejection(transport.listProjectFiles());
    expect(error).toBeInstanceOf(DriveQuotaExceededError);
    expect((error as Error).message).toContain("(403)");
    // deleteFile swallows a 404; a 403 quota denial must survive it.
    const deleteError = await rejection(transport.delete("file-1"));
    expect(deleteError).toBeInstanceOf(DriveQuotaExceededError);
    const storageError = await rejection(createDriveTransport(fakeAuth(), vi.fn<typeof fetch>(async () => deny(STORAGE_QUOTA_BODY)), "project-", undefined, makeThrottle().throttle).listProjectFiles());
    expect(storageError).not.toBeInstanceOf(DriveQuotaExceededError);
    expect((storageError as Error).message).toContain("(403)");
  });

  it("driveStore keeps a quota denial distinguishable from a revoked role", async () => {
    const { throttle } = makeThrottle();
    const role = async () => "owner" as const;
    const quotaStore = createOperationDriveStore({ auth: fakeAuth(), folderId: "folder-1", boardId: "board-1", role, fetcher: vi.fn<typeof fetch>(async () => deny(QUOTA_BODY)), quota: throttle });
    const error = await rejection(quotaStore.folderRole());
    expect(error).toBeInstanceOf(DriveQuotaExceededError);
    expect((error as Error).message).toContain("(403)");
    const inventoryError = await rejection(quotaStore.inventory());
    expect(inventoryError).toBeInstanceOf(DriveQuotaExceededError);

    // A real permission denial still resolves to the role mapping, so the quota branch does not swallow it.
    const revokedStore = createOperationDriveStore({ auth: fakeAuth(), folderId: "folder-1", boardId: "board-1", role, fetcher: vi.fn<typeof fetch>(async () => deny(PERMISSION_BODIES.insufficientPermissions)), quota: makeThrottle().throttle });
    expect(await revokedStore.folderRole()).toBe("revoked");
  });

  // `failure` checks the quota class before the 403 scope hint, and `call` books the
  // request to the shared ledger, so a quota denial is neither a permission error nor
  // an unpriced request. Driven through the real funnel with an injected fetcher.
  it("driveBoardStore must surface a quota denial as quota and must consult the ledger", async () => {
    const throttle = defaultDriveQuotaThrottle();
    const before = throttle.snapshot().requests;
    const boards = createDriveBoardStore({ auth: fakeAuth(), fetcher: vi.fn<typeof fetch>(async () => deny(QUOTA_BODY)) });
    const error = await rejection(boards.listBoards());
    expect(error).toBeInstanceOf(DriveQuotaExceededError);
    expect((error as Error).message).toContain("(403)");
    expect(throttle.snapshot().requests).toBe(before + 1);
  });
});

// 3. Defers only: a full window delays a request, it never refuses or adds one.
describe("defers only", () => {
  it("delays past the window instead of refusing, and issues exactly one request per call", async () => {
    const { throttle, waits, events } = makeThrottle(10);
    const urls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return new Response("ok", { headers: { "Content-Type": "text/plain", "X-Drive-Request-Cost": String(driveRequestCost(String(input))) } });
    });
    const transport = createDriveTransport(fakeAuth(), fetcher, "project-", undefined, throttle);
    const cost = driveRequestCost("https://www.googleapis.com/drive/v3/files/file-1?alt=media");
    expect(cost).toBe(1);

    const calls = 13;
    for (let i = 0; i < calls; i++) expect(await transport.download("file-1")).toBe("ok");

    // Ten single-cost calls fit the window; the eleventh waits for the window to roll, then goes out.
    expect(waits).toEqual([WINDOW]);
    expect(events.filter((event) => event.type === "defer")).toEqual([{ type: "defer", projected: cost, cost, waitMs: WINDOW }]);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(throttle.snapshot().requests).toBe(calls);
    expect(throttle.snapshot().deferrals).toBe(1);
    expect(throttle.snapshot().charged).toBe(3);
    expect(throttle.snapshot().limit).toBe(10);
  });

  it("a cost larger than the whole window is still issued, never refused", async () => {
    const { throttle, waits } = makeThrottle(10);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ files: [] })));
    const transport = createDriveTransport(fakeAuth(), fetcher, "project-", undefined, throttle);
    const pageTokenCost = driveRequestCost("https://www.googleapis.com/drive/v3/files?pageSize=100&pageToken=t");
    expect(pageTokenCost).toBe(111);
    for (let i = 0; i < 3; i++) expect(await transport.listProjectFiles()).toEqual([]);
    expect(waits.length).toBe(3);
    expect(waits.every((ms) => Number.isFinite(ms) && ms > 0)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(throttle.snapshot().requests).toBe(3);
  });

  it("tops up the projection that acquire charged, and books nothing without an acquire", async () => {
    const { throttle } = makeThrottle(100);
    expect(throttle.reserve(2).waitMs).toBe(0); // reserve projects; it never charges or refuses
    expect(throttle.snapshot().charged).toBe(0);
    // `observe` only corrects a charge that is already in the window; on its own it
    // reports the cost and books nothing.
    expect(throttle.observe(3, new Headers({ "X-Drive-Request-Cost": "7" }))).toBe(7);
    expect(throttle.snapshot().charged).toBe(0);
    await throttle.acquire(2);
    expect(throttle.snapshot().charged).toBe(2);
    expect(throttle.observe(2, new Headers({ "X-Drive-Request-Cost": "7" }))).toBe(7);
    expect(throttle.snapshot().charged).toBe(7);
    // The projection is the fallback for a header that is not a number.
    await throttle.acquire(5);
    expect(throttle.observe(5, new Headers({ "X-Drive-Request-Cost": "not-a-number" }))).toBe(5);
    expect(throttle.snapshot().charged).toBe(12);
    // A missing header is not a measured zero: the ledger keeps the projection.
    await throttle.acquire(4);
    expect(throttle.observe(4, new Headers())).toBe(4);
    expect(throttle.snapshot().charged).toBe(16);
    expect(throttle.snapshot().requests).toBe(3);
  });
  // The stall observed in the operations suite was 50 inventory requests inside one
  // minute; the unverified 10,000 default made that defere a whole window even though
  // Google would have served it. The documented per-user budget is asserted as
  // behaviour: the burst goes out, and the same ledger still defers once the budget is
  // genuinely spent.
  it("serves an inventory burst under the documented per-user budget and defers only when that budget is spent", async () => {
    const { throttle, waits, events, clock } = makeThrottle();
    expect(throttle.snapshot().limit).toBe(DRIVE_DEFAULT_COST_PER_MINUTE);
    const page = "https://www.googleapis.com/drive/v3/files?pageSize=200&fields=files(id,name,mimeType,modifiedTime,parents)";
    const pageCost = driveRequestCost(page);
    for (let i = 0; i < 50; i++) await throttle.acquire(pageCost);
    expect(waits).toEqual([]);
    expect(throttle.snapshot().deferrals).toBe(0);
    expect(throttle.snapshot().charged).toBe(50 * pageCost);
    expect(throttle.snapshot().requests).toBe(50);
    // Exactly filling the budget is not an overshoot; the next request is.
    await throttle.acquire(DRIVE_DEFAULT_COST_PER_MINUTE - 50 * pageCost);
    expect(throttle.snapshot().charged).toBe(DRIVE_DEFAULT_COST_PER_MINUTE);
    await throttle.acquire(1);
    expect(waits).toEqual([WINDOW]);
    expect(throttle.snapshot().deferrals).toBe(1);
    expect(events.filter((event) => event.type === "defer")).toEqual([{ type: "defer", projected: 1, cost: 1, waitMs: WINDOW }]);
    // The deferral moved the request into the next window, so that request is the only
    // charge left in it: the roll cleared the previous window, it did not carry the burst over.
    expect(throttle.snapshot().windowStart).toBe(clock());
    expect(throttle.snapshot().charged).toBe(1);
  });

  it("re-books a corrected charge into the window a deferral pushed it into", async () => {
    const { throttle, waits, clock } = makeThrottle(10);
    await throttle.acquire(6);
    await throttle.acquire(6); // overshoot: sleep to the boundary, then book in the new window
    expect(waits).toEqual([WINDOW]);
    expect(throttle.snapshot().windowStart).toBe(clock());
    expect(throttle.snapshot().charged).toBe(6);
    // The top-up corrects the amount booked after the roll, so the reported cost lands in
    // the new window instead of topping up a charge that belonged to the old one.
    expect(throttle.observe(6, new Headers({ "X-Drive-Request-Cost": "8" }))).toBe(8);
    expect(throttle.snapshot().charged).toBe(8);
  });

});

// 4. Never waits on Infinity.
describe("never waits on Infinity", () => {
  it("an unparseable or Infinity Retry-After never causes an infinite wait", async () => {
    expect(driveRetryAfterMs("Infinity", 0)).toBeNull();
    expect(driveRetryAfterMs("not-a-date", 0)).toBeNull();
    const pastDate = Date.parse("Sun, 01 Jan 2000 00:00:00 GMT");
    expect(driveRetryAfterMs("Sun, 01 Jan 2000 00:00:00 GMT", pastDate + 60_000)).toBe(0); // a past date, never Infinity
    // Ceiling already spent: nothing left to wait, whatever Retry-After claims.
    expect(driveBoundedRetryDelayMs(1, "Infinity", 8000, "RESOURCE_EXHAUSTED: Too Many Requests, retried for 8000ms")).toBe(0);

    const { throttle, waits, events } = makeThrottle(10);
    const detail = "rateLimitExceeded: RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Total Query Cost' and usage limit 'query cost per minute' for consumer 'project:pboard'. Try again later. (Retry-After: Infinity)";
    expect(driveSecondDelayMs(detail)).toBeNull();
    const error = driveQuotaError(429, detail, throttle, 1) as DriveQuotaExceededError;
    expect(error).toBeInstanceOf(DriveQuotaExceededError);
    expect(error.waitMs).toBe(WINDOW); // Google denial starts a finite cooldown even without a hint
    expect(throttle.reserve(1).waitMs).toBe(0);
    expect(throttle.observe(1, new Headers({ "X-Drive-Request-Cost": "Infinity" }))).toBe(1); // finite fallback
    expect(Number.isFinite(throttle.snapshot().charged)).toBe(true);

    // A second real denial increases the finite cooldown, never to Infinity.
    const over = driveQuotaError(429, detail, throttle, 11) as DriveQuotaExceededError;
    expect(over.waitMs).toBe(2 * WINDOW);
    expect(Number.isFinite(over.waitMs)).toBe(true);
    // A 429 without the quota-meter wording is not the quota class at all, so it carries no quota wait.
    expect(driveQuotaError(429, "RESOURCE_EXHAUSTED: Too Many Requests", throttle)).not.toBeInstanceOf(DriveQuotaExceededError);
    expect(waits).toEqual([]);
    expect(events.every((event) => Number.isFinite(event.cost) && Number.isFinite(event.waitMs))).toBe(true);
  });
});

// 5. secondDelay.
describe("secondDelay", () => {
  it("reads the advertised delay and applies at least one quota window of cooldown", async () => {
    const detail = detailOf(QUOTA_BODY);
    expect(driveSecondDelayMs(detail)).toBe(10000);
    const { throttle } = makeThrottle(10);
    const error = driveQuotaError(403, detail, throttle, 1) as DriveQuotaExceededError;
    expect(error.name).toBe("DriveQuotaExceededError");
    expect(error.failure?.secondDelayRange).toEqual([1, 10]);
    expect(error.waitMs).toBe(WINDOW);
    expect(error.cost).toBe(1); // projection only; reserve charged nothing to the window
    // A longer advertised range still clamps to the transient ceiling, and the window projection wins when larger.
    expect(driveSecondDelayMs("second delays (1-30 seconds)")).toBe(30000);
    const exhausted = makeThrottle(10);
    exhausted.throttle.acquire(10);
    const windowWait = driveQuotaError(403, detail, exhausted.throttle, 1) as DriveQuotaExceededError; // only the quota class carries waitMs
    expect(windowWait.waitMs).toBe(WINDOW);
  });
});

// 6. What the reported error claims about the budget.
describe("quota error accounting", () => {
  it("reports the accounting it holds instead of an overshoot the projection never reached", async () => {
    const detail = detailOf(QUOTA_BODY);
    const inside = makeThrottle(1000);
    const insideError = driveQuotaError(403, detail, inside.throttle, 1) as DriveQuotaExceededError;
    expect(insideError.cost).toBe(1);
    expect(insideError.message).toContain("charged 1 of limit 1000");
    expect(insideError.message).not.toContain("projected cost 1 > limit 1000");
    // A denial that does cross the window still reports the crossing.
    const crossed = makeThrottle(10);
    await crossed.throttle.acquire(10);
    const crossedError = driveQuotaError(403, detail, crossed.throttle, 1) as DriveQuotaExceededError;
    expect(crossedError.cost).toBe(11);
    expect(crossedError.message).toContain("projected cost 11 > limit 10");
    expect(crossedError.message).not.toContain("charged 11 of limit 10");
  });
});

describe("Google quota cooldown", () => {
  it("bounds repeated quota denials and resets after a quiet period", async () => {
    const { throttle, advance } = makeThrottle();
    for (const expected of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      const error = driveQuotaError(403, detailOf(QUOTA_BODY), throttle) as DriveQuotaExceededError;
      expect(error.waitMs).toBe(expected);
      advance(expected);
    }
    advance(1);
    const reset = driveQuotaError(403, detailOf(QUOTA_BODY), throttle) as DriveQuotaExceededError;
    expect(reset.waitMs).toBe(WINDOW);
  });
  it("stops other Drive paths after a real denial, then resumes and backs off repeated denials", async () => {
    const { throttle, advance } = makeThrottle();
    const fetcher = vi.fn<typeof fetch>(async () => deny(QUOTA_BODY));
    const permissions = createDrivePermissionTransport(fakeAuth(), fetcher, throttle);
    const transport = createDriveTransport(fakeAuth(), fetcher, 'project-', undefined, throttle);
    const error = await rejection(permissions.listPermissions('folder')) as DriveQuotaExceededError;
    expect(error.waitMs).toBe(WINDOW);
    expect(error.cost).toBeLessThan(throttle.snapshot().limit); // Google's denial wins over the local estimate.
    advance(10_000);
    const blocked = await rejection(transport.download('file')) as DriveQuotaExceededError;
    expect(blocked.waitMs).toBe(50_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(50_000);
    const second = await rejection(transport.download('file')) as DriveQuotaExceededError;
    expect(second.waitMs).toBe(2 * WINDOW);
    expect(fetcher).toHaveBeenCalledTimes(2);
    advance(second.waitMs);
    fetcher.mockResolvedValueOnce(new Response('recovered'));
    expect(await transport.download('file')).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['permissions', 'transport'])("does not replay a quota-shaped 429 through %s", async path => {
    const { throttle } = makeThrottle();
    const fetcher = vi.fn<typeof fetch>(async () => deny(USER_RATE_LIMIT_BODY));
    const request = path === 'permissions'
      ? createDrivePermissionTransport(fakeAuth(), fetcher, throttle).listPermissions('folder')
      : createDriveTransport(fakeAuth(), fetcher, 'project-', undefined, throttle).download('file');
    expect(await rejection(request)).toBeInstanceOf(DriveQuotaExceededError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies immutable upload denials and stops subsequent metadata requests", async () => {
    const { throttle } = makeThrottle();
    const fetcher = vi.fn<typeof fetch>(async () => deny(QUOTA_BODY));
    const store = createOperationDriveStore({ auth: fakeAuth(), folderId: 'folder', boardId: 'board', role: async () => 'owner', fetcher, quota: throttle });
    expect(await rejection(store.publishMigration('id', { protocol: 'pboard-operations-v1', boardId: 'board', legacyFileIds: [] }))).toBeInstanceOf(DriveQuotaExceededError);
    expect(await rejection(store.metadata('id'))).toBeInstanceOf(DriveQuotaExceededError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

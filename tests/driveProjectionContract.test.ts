// The share dialog's permission projections, checked against Google's published
// Permission representation and the documented fields-parameter rule: "If the fields
// parameter has an error or is otherwise invalid, the server returns an HTTP 400 Bad
// Request status code, along with an error message stating what's wrong with your fields
// selection." The fake Drive below enforces that rule instead of restating the projection
// string `src/sync/drivePermissions.ts` emits, so the contract is read off the recorded
// requests. The 400 is then followed at the layer the share dialog consumes
// (`src/sidebar/components/ShareControls.tsx`, which renders `err.message`).
//
// Sources (pinned, verified 2026-10-29):
//   https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions
//     The Permission representation: id, displayName, type, kind, permissionDetails,
//     photoLink, emailAddress, role, allowFileDiscovery, domain, expirationTime,
//     teamDrivePermissionDetails (deprecated), deleted, view, pendingOwner,
//     inheritedPermissionsDisabled — last updated 2026-04-21. No `createdTime`.
//   https://developers.google.com/workspace/drive/api/guides/fields-parameter
//     Invalid selection => HTTP 400 Bad Request.
//   https://developers.google.com/workspace/drive/api/reference/rest/v3/errors
//     `badRequest` => HTTP 400. `createdTime` exists only on the File resource, so a
//     permission projection asking for it is one of those invalid selections.

import { describe, expect, it, vi } from "vitest";
import {
  createDrivePermissionService,
  createDrivePermissionTransport,
  type DriveFileRef,
  type DriveSharedProjectRecord,
  type DriveSharedProjectStore,
} from "../src/sync/drivePermissions";
import {
  createDriveQuotaThrottle,
  DriveQuotaExceededError,
  parseQuotaFailure,
  type DriveQuotaThrottle,
} from "../src/sync/driveQuota";
import type { GoogleAuthProvider } from "../src/sync/googleAuth";

const BOARD = "board-1";

/** Names a permission projection may legally ask for: the representation's fields plus the
    top-level selector names (`nextPageToken`, `permissions`, `*`), which are structure
    rather than fields. */
const DOCUMENTED_PERMISSION_NAMES: Record<string, true> = {
  id: true, displayName: true, type: true, kind: true, permissionDetails: true, photoLink: true, emailAddress: true,
  role: true, allowFileDiscovery: true, domain: true, expirationTime: true, teamDrivePermissionDetails: true,
  deleted: true, view: true, pendingOwner: true, inheritedPermissionsDisabled: true,
  nextPageToken: true, permissions: true, "*": true,
};

/** The names a projection selects: top-level names (including the `permissions` group
    selector, which is structure rather than a field) and the names inside its parentheses. */
function parseProjection(fields: string): { top: string[]; group: string[] } {
  const top: string[] = [];
  const group: string[] = [];
  let current = "";
  let inside = false;
  for (const char of fields) {
    if (char === "(" || char === ")" || char === ",") {
      const name = current.trim();
      if (name) (inside ? group : top).push(name);
      current = "";
      if (char === "(") inside = true;
      if (char === ")") inside = false;
      continue;
    }
    current += char;
  }
  const last = current.trim();
  if (last) (inside ? group : top).push(last);
  return { top, group };
}

/** Every projected name the published representation does not have — the selection that
    triggers the documented field-selection 400. */
function undocumentedNames(fields: string): string[] {
  const projection = parseProjection(fields);
  return [...projection.top, ...projection.group].filter((name) => !DOCUMENTED_PERMISSION_NAMES[name]);
}

// ---------------------------------------------------------------------------
// Fake Drive
// ---------------------------------------------------------------------------
type ErrorBody = { error: { code: number; message: string; status: string; errors?: { reason: string }[] } };

function errorResponse(status: number, message: string, reason: string): Response {
  const body: ErrorBody = { error: { code: status, message, status: reason, errors: [{ reason }] } };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** One canned grantee, valued for every field the representation has, so the fake can
    answer exactly the projection it was asked for. `nextPageToken` is deliberately absent:
    the fake serves a single page. */
const CANNED_PERMISSION: Record<string, unknown> = {
  id: "perm-1",
  kind: "drive#permission",
  type: "user",
  role: "writer",
  emailAddress: "collab@x.com",
  displayName: "Collab",
  domain: "x.com",
  view: "published",
  deleted: false,
  pendingOwner: false,
  allowFileDiscovery: false,
  expirationTime: "2026-11-01T00:00:00Z",
  photoLink: "https://example.invalid/photo",
  permissionDetails: [{ permissionType: "file", role: "writer", inherited: false }],
  inheritedPermissionsDisabled: false,
};

const SHARED_ROOT: DriveFileRef = { id: "root", name: "Pboard", mimeType: "application/vnd.google-apps.folder", parents: [] };
const BOARD_FOLDER: DriveFileRef = { id: BOARD, name: "board", mimeType: "application/vnd.google-apps.folder", parents: ["root"] };

/** `permissionAnswer` lets a test force a documented error on a permission request;
    returning null lets the fake answer the projection it was asked for. */
function fakeDrive(options: { permissionAnswer?: (url: URL, call: number) => Response | null } = {}) {
  const requests: { url: string; method: string; fields: string; status: number }[] = [];
  let permissionCalls = 0;

  const echo = (fields: string): Response => {
    const projection = parseProjection(fields);
    const body: Record<string, unknown> = Object.fromEntries(projection.top.map((name) => [name, CANNED_PERMISSION[name]]));
    if (projection.group.length) body.permissions = [Object.fromEntries(projection.group.map((name) => [name, CANNED_PERMISSION[name]]))];
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const fields = url.searchParams.get("fields") ?? "";
    let response: Response;

    // The permissions resource, with or without a permission id after it.
    if (url.pathname.includes("/permissions")) {
      permissionCalls += 1;
      const offenders = undocumentedNames(fields);
      // The documented rule, enforced here rather than asserted as a string.
      response = offenders.length
        ? errorResponse(400, `Invalid field selection ${offenders[0]}`, "badRequest")
        : options.permissionAnswer?.(url, permissionCalls) ?? echo(fields);
    } else if (url.pathname.endsWith("/about")) {
      response = new Response(JSON.stringify({ user: { emailAddress: "me@example.com", displayName: "Me" } }), { headers: { "Content-Type": "application/json" } });
    } else if (url.searchParams.has("q")) {
      response = new Response(JSON.stringify({ files: [SHARED_ROOT] }), { headers: { "Content-Type": "application/json" } });
    } else {
      response = new Response(JSON.stringify(BOARD_FOLDER), { headers: { "Content-Type": "application/json" } });
    }

    requests.push({ url: String(input), method, fields, status: response.status });
    return response;
  });

  return {
    fetcher,
    requests,
    permissionRequests: () => requests.filter((request) => new URL(request.url).pathname.includes("/permissions")),
  };
}

function fakeAuth(): GoogleAuthProvider {
  return {
    connect: async () => {},
    disconnect: async () => {},
    getConnectionState: async (): Promise<"connected"> => "connected",
    isConfigured: () => true,
    getAccessToken: vi.fn(async () => "drive-token"),
  };
}

/** Controlled clock (tests/driveQuota.test.ts `makeThrottle`): every deferral wait is
    recorded and advances the fake clock; no wall-clock sleeps. */
function makeThrottle() {
  let nowMs = 1_700_000_000_000;
  const waits: number[] = [];
  const throttle = createDriveQuotaThrottle({
    now: () => nowMs,
    sleep: async (ms) => { waits.push(ms); nowMs += ms; },
  });
  return { throttle, waits };
}

/** Service wired to the fake Drive, with the shared layout pre-seeded so the share
    dialog's paths stay on permission requests. */
function makeShareService(fetcher: typeof fetch, throttle: DriveQuotaThrottle) {
  const layout: DriveSharedProjectRecord = { folderId: BOARD, projectFileId: "project-file", realtimeFolderId: "realtime" };
  const sharedProjects: DriveSharedProjectStore = {
    get: vi.fn(async () => layout),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const service = createDrivePermissionService({
    transport: createDrivePermissionTransport(fakeAuth(), fetcher, throttle),
    sharedProjects,
    readSnapshot: async (projectId: string) => JSON.stringify({ id: projectId }),
    // An operations board: no multipart snapshot POST on invite.
    isOperationBoard: async () => true,
  });
  return { service, throttle };
}

// ---------------------------------------------------------------------------
// 1. The projection contract, read off the recorded requests
// ---------------------------------------------------------------------------
describe("permission projection contract", () => {
  it("projects only fields the published Permission representation has", async () => {
    const h = fakeDrive();
    const transport = createDrivePermissionTransport(fakeAuth(), h.fetcher, makeThrottle().throttle);

    await transport.listPermissions(BOARD);
    await transport.createPermission(BOARD, "editor", "collab@x.com");
    await transport.updatePermission(BOARD, "perm-1", "viewer");

    const recorded = h.permissionRequests();
    expect(recorded).toHaveLength(3);
    // The fake answers 400 for any name outside the representation, so these responses are
    // the contract: the three permission entry points — permissions.list, permissions.create,
    // permissions.update — each projected only documented names.
    expect(recorded.map((request) => `${request.method} ${request.status}`)).toEqual(["GET 200", "POST 200", "PATCH 200"]);

    // The contract, read off the requests the funnel recorded: nothing it asks for sits
    // outside the documented field set.
    expect(recorded.flatMap((request) => undocumentedNames(request.fields))).toEqual([]);

    // The defect: HEAD's permission projection added `createdTime` (verified against
    // `git show HEAD:src/sync/drivePermissions.ts`), which the representation has never
    // had — `createdTime` belongs to the File resource. Re-running the recorded projection
    // with that name added inside the group gets the documented field-selection 400 from the
    // same fake, so the 400 is the rule being enforced, not a string restated from the diff.
    const listUrl = new URL(recorded[0].url);
    listUrl.searchParams.set("fields", (listUrl.searchParams.get("fields") ?? "").replace(/\)$/, ",createdTime)"));
    expect(undocumentedNames(listUrl.searchParams.get("fields") ?? "")).toEqual(["createdTime"]);
    const rejected = await h.fetcher(listUrl);
    const body: ErrorBody = await rejected.json();
    expect(rejected.status).toBe(400);
    expect(body.error.errors?.[0]?.reason).toBe("badRequest");
  });
});

// ---------------------------------------------------------------------------
// 2. How that 400 reaches the share dialog
// ---------------------------------------------------------------------------
describe("the field-selection 400 at the share-dialog layer", () => {
  // The canned 400 carries no message text, so anything the share dialog renders comes
  // from the documented reason.
  const BAD_REQUEST: ErrorBody = { error: { code: 400, message: "", status: "badRequest", errors: [{ reason: "badRequest" }] } };

  it("surfaces as the documented error class with one attempt and no throttle deferral", async () => {
    const h = fakeDrive({ permissionAnswer: () => errorResponse(400, BAD_REQUEST.error.message, "badRequest") });
    const clock = makeThrottle();
    const { service, throttle } = makeShareService(h.fetcher, clock.throttle);

    // permissions.list — the collaborator list the dialog renders.
    const listError = await service.listCollaborators("p1").catch((error: unknown) => error);
    // permissions.create — the dialog's only create entry point.
    const createError = await service.invite("p1", "collab@x.com", "editor").catch((error: unknown) => error);

    expect(listError).toBeInstanceOf(Error);
    expect(listError).not.toBeInstanceOf(DriveQuotaExceededError);
    expect(createError).toBeInstanceOf(Error);
    expect(createError).not.toBeInstanceOf(DriveQuotaExceededError);

    // The reason, not a message string, is what ShareControls shows through err.message.
    const shown = listError instanceof Error ? listError.message : "";
    expect(shown).toContain("badRequest");
    expect(shown).toContain("(400)");
    expect(parseQuotaFailure("badRequest")).toBeNull();

    // One attempt each; the 400 is not replayed. The throttle still accounted both
    // requests (it defers, never refuses) but never deferred or slept, so the deferral path
    // is not involved in this error class.
    const permissionCalls = h.permissionRequests();
    expect(permissionCalls.map((request) => `${request.method} ${request.status}`)).toEqual(["GET 400", "POST 400"]);
    // Every fetch the funnel made is accounted by the throttle — the two permission calls
    // plus the shared-root lookup `ensureSharedProject` does before the create (line 515).
    // It defers, never refuses, so a 403/400 still surfaces unchanged, and here it never
    // deferred or slept: the deferral path is not involved in this error class.
    expect(throttle.snapshot().requests).toBe(h.requests.length);
    expect(clock.waits).toEqual([]);
    expect(throttle.snapshot().deferrals).toBe(0);
  });

  it("stops at one attempt even though a later permission call on the same path would succeed", async () => {
    const h = fakeDrive({ permissionAnswer: (_url, call) => (call === 1 ? errorResponse(400, "", "badRequest") : null) });
    const { service, throttle } = makeShareService(h.fetcher, makeThrottle().throttle);

    await expect(service.listCollaborators("p1")).rejects.toThrow();
    expect(h.permissionRequests()).toHaveLength(1);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(throttle.snapshot().requests).toBe(1);
  });
});

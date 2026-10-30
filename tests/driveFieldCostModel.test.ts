// The Drive request-cost model, pinned at the exact projections the collaboration
// funnel sends. Every number below is produced by `src/sync/driveQuota`; the pins
// are the accepted table, so a projection change shows up as a diff rather than a
// silent re-tune. `experiments/collaboration/driveFieldCostModel.mjs` mirrors the
// same model in plain JS and prints this table.

import { describe, expect, it, vi } from "vitest";
import {
  DRIVE_COST_BASE,
  DRIVE_COST_FIELD,
  DRIVE_COST_FIELD_GROUP,
  DRIVE_COST_PAGETOKEN,
  DRIVE_COST_WINDOW_MS,
  DRIVE_DEFAULT_COST_PER_MINUTE,
  driveCostResource,
  driveFieldCost,
  driveRequestCost,
  fieldEntries,
} from "../src/sync/driveQuota";
import { createDrivePermissionTransport } from "../src/sync/drivePermissions";
import { createOperationDriveStore } from "../src/sync/operations/driveStore";
import type { GoogleAuthProvider } from "../src/sync/googleAuth";

const API = "https://www.googleapis.com/drive/v3";
const FILE = "1Y8QV4wR4zFqK0kQ0kQ0kQ0kQ0kQ0kQ0k";

/** A request exactly as the funnel builds it (query values URL-encoded). */
function request(path: string, query: Record<string, string> = {}): string {
  return `${API}/${path}?${new URLSearchParams(query)}`;
}

/** One pinned row of the table: label, the URL actually sent, the cost. */
type Row = { label: string; url: string; expected: number };

function pin(row: Row): void {
  expect({ label: row.label, cost: driveRequestCost(row.url) }).toEqual({ label: row.label, cost: row.expected });
}

describe("pinned cost model constants", () => {
  it("keeps the model's unit prices and window fixed", () => {
    expect(DRIVE_COST_BASE).toBe(1);
    expect(DRIVE_COST_FIELD).toBe(1);
    expect(DRIVE_COST_FIELD_GROUP).toBe(2);
    expect(DRIVE_COST_PAGETOKEN).toBe(10);
    expect(DRIVE_COST_WINDOW_MS).toBe(60000);
    // Documented per-user-per-project quota at the cited revision; the projection is a pre-flight estimate.
    expect(DRIVE_DEFAULT_COST_PER_MINUTE).toBe(325_000);
  });
});

describe("the accepted request-cost table", () => {
  const table: Row[] = [
    { label: "share dialog identity read", url: request("about", { fields: "user(emailAddress,displayName)" }), expected: 3 },
    { label: "single-resource get, parents only", url: request(`files/${FILE}`, { fields: "parents" }), expected: 2 },
    {
      label: "single-resource get, full metadata projection",
      url: request(`files/${FILE}`, {
        fields: "id,name,parents,ownedByMe,owners(emailAddress),capabilities(canAddChildren),contentRestrictions",
      }),
      expected: 10,
    },
    { label: "single-resource get, location/size probe", url: request(`files/${FILE}`, { fields: "id,parents,trashed,size" }), expected: 5 },
    {
      label: "single-resource get, folder role probe",
      url: request(`files/${FILE}`, { fields: "trashed,ownedByMe,capabilities(canAddChildren)" }),
      expected: 5,
    },
    { label: "single-resource get, board reference", url: request(`files/${FILE}`, { fields: "id,name,mimeType,modifiedTime" }), expected: 5 },
    {
      label: "list, page size 100 with continuation token",
      url: request("files", { fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "100" }),
      expected: 104,
    },
    {
      label: "list, same projection at page size 20",
      url: request("files", { fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "20" }),
      expected: 24,
    },
    {
      label: "list, projection without nextPageToken, page size 100",
      url: request("files", { fields: "files(id,name,mimeType,modifiedTime)", pageSize: "100" }),
      expected: 103,
    },
    {
      label: "list, projection without nextPageToken, page size 20",
      url: request("files", { fields: "files(id,name,mimeType,modifiedTime)", pageSize: "20" }),
      expected: 23,
    },
    {
      label: "search, name probe page",
      url: request("files", {
        q: `name contains 'board' and trashed = false`,
        fields: "files(id,name,mimeType,modifiedTime)",
        pageSize: "2",
      }),
      expected: 5,
    },
    {
      label: "inventory list, page size 1000",
      url: request("files", { fields: "nextPageToken,files(id,name,size,createdTime)", pageSize: "1000" }),
      expected: 1004,
    },
    {
      label: "inventory list, page size 200",
      url: request("files", { fields: "nextPageToken,files(id,name,size,createdTime)", pageSize: "200" }),
      expected: 204,
    },
    {
      label: "inventory list, page size 200 continued by a pageToken",
      url: request("files", {
        fields: "nextPageToken,files(id,name,size,createdTime)",
        pageSize: "200",
        pageToken: "CAIHEAE",
      }),
      expected: 214,
    },
    {
      label: "permission list, page size 100",
      url: request(`files/${FILE}/permissions`, { fields: "permissions(id,type,role,emailAddress,displayName)", pageSize: "100" }),
      expected: 103,
    },
    {
      label: "permission list, page size 20",
      url: request(`files/${FILE}/permissions`, { fields: "permissions(id,type,role,emailAddress,displayName)", pageSize: "20" }),
      expected: 23,
    },
    { label: "content download", url: request(`files/${FILE}`, { alt: "media" }), expected: 1 },
    { label: "pre-generated file id", url: request("files/generateIds", { count: "1", space: "drive", type: "files" }), expected: 1 },
  ];

  it("prices every projection the funnel actually sends", () => {
    for (const row of table) pin(row);
  });

  it("does not add page size to a single-resource get", () => {
    const fields = { fields: "parents", pageSize: "1000" };
    expect(driveCostResource(request(`files/${FILE}`, { fields: "parents" }))).toBe("get");
    expect(driveRequestCost(request(`files/${FILE}`, fields))).toBe(driveRequestCost(request(`files/${FILE}`, { fields: "parents" })));
    expect(driveRequestCost(request(`files/${FILE}`, fields))).toBe(2);
    // Only a pageToken surcharge survives on a single-resource get.
    expect(driveRequestCost(request(`files/${FILE}`, { fields: "parents", pageSize: "1000", pageToken: "CAIHEAE" }))).toBe(12);
    // A create POST on the list resource still prices its four bare fields with no page size asked for.
    expect(driveCostResource(request("files", { fields: "id,name,mimeType,modifiedTime" }))).toBe("list");
    expect(driveRequestCost(request("files", { fields: "id,name,mimeType,modifiedTime" }))).toBe(DRIVE_COST_BASE + 4 * DRIVE_COST_FIELD);
  });

  it("prices the page-size term only for the resources dominated by it", () => {
    for (const resource of ["list", "search", "permlist"]) {
      const base = request(resource === "permlist" ? `files/${FILE}/permissions` : "files", { fields: "files(id)" });
      const q: Record<string, string> = resource === "search" ? { q: "trashed = false" } : {};
      expect(driveCostResource(`${base}&${new URLSearchParams({ ...q, pageSize: "100" })}`)).toBe(resource);
      expect(driveRequestCost(`${base}&${new URLSearchParams({ ...q, pageSize: "100" })}`)).toBe(DRIVE_COST_BASE + DRIVE_COST_FIELD_GROUP + 100);
    }
  });

  it("keeps resource precedence and base-only routes", () => {
    // alt=media outranks both the projection and the page size.
    expect(driveCostResource(request("files", { fields: "nextPageToken,files(id)", pageSize: "1000", alt: "media" }))).toBe("flat");
    expect(driveRequestCost(request("files", { fields: "nextPageToken,files(id)", pageSize: "1000", alt: "media" }))).toBe(1);
    // A permission list outranks a query, and a query turns a bare files call into search.
    expect(driveCostResource(request(`files/${FILE}/permissions`, { q: "x", fields: "permissions(id)", pageSize: "20" }))).toBe("permlist");
    expect(driveCostResource(request("files", { q: "trashed = false", fields: "files(id)", pageSize: "2" }))).toBe("search");
    expect(driveCostResource(request("files", { fields: "files(id)", pageSize: "2" }))).toBe("list");
    expect(driveCostResource(request("about", { fields: "user(emailAddress)" }))).toBe("about");
    // generateIds is base-only no matter what it projects.
    expect(driveCostResource(request("files/generateIds", { count: "1", fields: "ids", pageSize: "100" }))).toBe("flat");
    expect(driveRequestCost(request("files/generateIds", { count: "1", fields: "ids", pageSize: "100" }))).toBe(1);
  });

  it("holds the boundaries: no projection, no page size, unusable page size", () => {
    expect(driveFieldCost("")).toBe(0);
    expect(driveRequestCost(request(`files/${FILE}`))).toBe(1);
    expect(driveRequestCost(request("files", { fields: "files(id)" }))).toBe(3);
    expect(driveRequestCost(request("files", { fields: "files(id)", pageSize: "0" }))).toBe(3);
    expect(driveRequestCost(request("files", { fields: "files(id)", pageSize: "abc" }))).toBe(3);
  });

  it("counts a nested selection as one entry, not a comma-split field list", () => {
    const nested = "user(emailAddress,displayName)";
    expect(fieldEntries(nested)).toEqual([nested]); // the entry keeps its parentheses
    expect(driveFieldCost(nested)).toBe(DRIVE_COST_FIELD_GROUP);
    // A naive top-level comma split would mis-price the very same projection as 3.
    const naive = nested.split(",").reduce((sum, entry) => sum + (entry.includes("(") ? DRIVE_COST_FIELD_GROUP : DRIVE_COST_FIELD), 0);
    expect(naive).toBe(3);
    expect(driveFieldCost(nested)).not.toBe(naive);

    // The list projections the funnel sends are guarded the same way.
    const list = "nextPageToken,files(id,name,size,createdTime)";
    expect(fieldEntries(list)).toEqual(["nextPageToken", "files(id,name,size,createdTime)"]);
    expect(driveFieldCost(list)).toBe(DRIVE_COST_FIELD + DRIVE_COST_FIELD_GROUP);
    expect(driveFieldCost("owners(emailAddress),capabilities(canAddChildren)")).toBe(4);
    expect(driveFieldCost("id,name,mimeType,modifiedTime")).toBe(4);
  });
});

describe("funnel URLs as the funnel actually sends them", () => {
  const auth: GoogleAuthProvider = {
    connect: async () => {},
    disconnect: async () => {},
    getConnectionState: async () => "connected",
    isConfigured: () => true,
    getAccessToken: async () => "drive-token",
  };

  /** Recording fake Drive: captures every URL the funnel sends and answers with a
   * continuation token once, so a real pageToken request appears in the recording. */
  function harness(continuationToken: string | null = "CAIHEAE") {
    const urls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      urls.push(url);
      const body: Record<string, unknown> = new URL(url).pathname.endsWith("/permissions")
        ? { permissions: [] }
        : { files: [] };
      if (continuationToken && !new URL(url).searchParams.get("pageToken")) body.nextPageToken = continuationToken;
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    });
    return { urls, fetcher, query: (url: string) => new URL(url).searchParams };
  }

  it("prices the recorded permission-list URL at 24, its continuation at 34", async () => {
    const h = harness();
    await createDrivePermissionTransport(auth, h.fetcher).listPermissions(FILE);
    expect(h.urls.map((url) => driveRequestCost(url))).toEqual([24, 34]);
    expect(h.query(h.urls[0]).get("fields")).toBe("nextPageToken,permissions(id,type,role,emailAddress,displayName)");
    expect(h.query(h.urls[0]).get("pageSize")).toBe("20");
    expect(h.query(h.urls[1]).get("pageToken")).toBe("CAIHEAE");
    // The accepted table prices the same projection at 23 because it carries no
    // continuation token; the funnel asks for one, so its recorded URL prices 24.
    expect(driveRequestCost(request(`files/${FILE}/permissions`, { fields: "permissions(id,type,role,emailAddress,displayName)", pageSize: "20" }))).toBe(23);
  });

  it("prices each collaboration listing at 24, continued by 34", async () => {
    const h = harness();
    const transport = createDrivePermissionTransport(auth, h.fetcher);
    await transport.listFiles("board-1");
    await transport.listFilesByName("board-a", "application/json");
    await transport.listSharedWithMe();
    expect(h.urls).toHaveLength(6);
    const firstPage = h.urls.filter((url) => !h.query(url).get("pageToken"));
    expect(firstPage.map((url) => driveRequestCost(url))).toEqual([24, 24, 24]);
    expect(h.urls.filter((url) => h.query(url).get("pageToken")).map((url) => driveRequestCost(url))).toEqual([34, 34, 34]);
    for (const url of firstPage) {
      expect(h.query(url).get("fields")).toBe("nextPageToken,files(id,name,mimeType,modifiedTime,parents)");
      expect(h.query(url).get("pageSize")).toBe("20");
    }
  });

  it("reads parents from the listing projection, never as a per-file lookup", async () => {
    const h = harness(null);
    const transport = createDrivePermissionTransport(auth, h.fetcher);
    await transport.listFiles("board-1");
    expect(h.query(h.urls[0]).get("fields")).toContain("parents");
    expect(h.urls.filter((url) => h.query(url).get("fields") === "parents")).toEqual([]);
  });

  it("keeps the name probe a single page of two, priced 5", async () => {
    const h = harness(null);
    await createDrivePermissionTransport(auth, h.fetcher).findSharedRoot();
    expect(h.urls).toHaveLength(1);
    expect(h.query(h.urls[0]).get("pageSize")).toBe("2");
    expect(h.query(h.urls[0]).get("fields")).toBe("files(id,name,mimeType,modifiedTime,parents)");
    expect(driveRequestCost(h.urls[0])).toBe(5);
  });

  it("prices the recorded inventory page at 204 and its continuation at 214", async () => {
    const h = harness();
    const store = createOperationDriveStore({
      auth,
      folderId: "board-1",
      boardId: "board-1",
      role: async () => "owner",
      fetcher: h.fetcher,
    });
    await store.inventory();
    expect(h.urls).toHaveLength(2);
    expect(h.query(h.urls[0]).get("pageSize")).toBe("200");
    expect(driveRequestCost(h.urls[0])).toBe(204);
    expect(driveRequestCost(h.urls[1])).toBe(214);
  });

  it("keeps createdTime out of every permission projection", async () => {
    const h = harness(null);
    const transport = createDrivePermissionTransport(auth, h.fetcher);
    await transport.listPermissions(FILE);
    await transport.createPermission(FILE, "editor", "reader@example.com");
    await transport.updatePermission(FILE, "perm-1", "viewer");
    // Scoped to permission URLs: Google's v3 Permission representation has no
    // createdTime, so a permission projection asking for it is rejected as an
    // invalid field selection. File projections legitimately carry it.
    const projections = h.urls.map((url) => h.query(url).get("fields")).filter(Boolean) as string[];
    expect(projections).toHaveLength(3);
    for (const fields of projections) {
      expect(fields).not.toContain("createdTime");
    }
    expect(projections[0]).toBe("nextPageToken,permissions(id,type,role,emailAddress,displayName)");
  });
});

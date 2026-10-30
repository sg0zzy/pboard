/**
 * Plain-JS mirror of the Drive request-cost model in src/sync/driveQuota (no
 * import from src/, no network): it prints the table the funnel's real
 * projection strings cost.
 *
 * The table is a DERIVED LOCAL MODEL — base 1 per Drive metadata request, +1 per
 * top-level projected field, 2 for a projected field carrying a nested selection,
 * +pageSize for list/search/permission-list requests, +10 when a pageToken
 * continues a page, base-only for `alt=media` and `generateIds`. Google's reported
 * `X-Drive-Request-Cost` header is authoritative and MAY DIFFER from these
 * numbers; when that header is present the throttle charges the reported value,
 * so real usage always wins over this model. The model only DEFERS; it never adds
 * a request and never suppresses a 403.
 */

const DRIVE_COST_BASE = 1;
const DRIVE_COST_FIELD = 1;
const DRIVE_COST_FIELD_GROUP = 2;
const DRIVE_COST_PAGETOKEN = 10;
const DRIVE_COST_WINDOW_MS = 60_000;
const DRIVE_DEFAULT_COST_PER_MINUTE = 325_000;

const COSTED_BY_PAGE_SIZE = { list: true, search: true, permlist: true };

/** Top-level projection entries; commas inside a nested selection do not split. */
function fieldEntries(fields) {
  const entries = [];
  let depth = 0;
  let current = "";
  for (const char of fields) {
    if (char === "," && depth === 0) { entries.push(current); current = ""; continue; }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    current += char;
  }
  if (current) entries.push(current);
  return entries;
}

/** A nested selection is priced as one group (2), a bare field as 1. */
function driveFieldCost(fields) {
  return fieldEntries(fields).reduce((sum, entry) => sum + (entry.includes("(") ? DRIVE_COST_FIELD_GROUP : DRIVE_COST_FIELD), 0);
}

function driveCostResource(input) {
  const url = new URL(input, "https://www.googleapis.com/drive/v3");
  if (url.searchParams.get("alt") === "media") return "flat";
  if (url.pathname.includes("/generateIds")) return "flat";
  if (url.pathname.includes("/about")) return "about";
  if (url.pathname.endsWith("/permissions")) return "permlist";
  if (url.pathname.endsWith("/files")) return url.searchParams.get("q") ? "search" : "list";
  return "get";
}

/** Prices the request the funnel actually sends, from its URL. */
function driveRequestCost(input) {
  const url = new URL(input, "https://www.googleapis.com/drive/v3");
  const resource = driveCostResource(input);
  if (resource === "flat") return DRIVE_COST_BASE;
  let cost = DRIVE_COST_BASE + driveFieldCost(url.searchParams.get("fields") ?? "");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "0");
  if (COSTED_BY_PAGE_SIZE[resource] && Number.isFinite(pageSize)) cost += pageSize;
  if (url.searchParams.get("pageToken")) cost += DRIVE_COST_PAGETOKEN;
  return cost;
}

const API = "https://www.googleapis.com/drive/v3";
const FILE = "1Y8QV4wR4zFqK0kQ0kQ0kQ0kQ0kQ0kQ0k";

/** A request exactly as the funnel builds it (query values URL-encoded). */
function request(path, query = {}) {
  return `${API}/${path}?${new URLSearchParams(query)}`;
}

const rows = [
  ["share dialog identity read", request("about", { fields: "user(emailAddress,displayName)" })],
  ["single-resource get, parents only", request(`files/${FILE}`, { fields: "parents" })],
  ["single-resource get, full metadata projection", request(`files/${FILE}`, { fields: "id,name,parents,ownedByMe,owners(emailAddress),capabilities(canAddChildren),contentRestrictions" })],
  ["single-resource get, location/size probe", request(`files/${FILE}`, { fields: "id,parents,trashed,size" })],
  ["single-resource get, folder role probe", request(`files/${FILE}`, { fields: "trashed,ownedByMe,capabilities(canAddChildren)" })],
  ["single-resource get, board reference", request(`files/${FILE}`, { fields: "id,name,mimeType,modifiedTime" })],
  ["list, page size 100 with continuation token", request("files", { fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "100" })],
  ["list, same projection at page size 20", request("files", { fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "20" })],
  ["list, projection without nextPageToken, page size 100", request("files", { fields: "files(id,name,mimeType,modifiedTime)", pageSize: "100" })],
  ["list, projection without nextPageToken, page size 20", request("files", { fields: "files(id,name,mimeType,modifiedTime)", pageSize: "20" })],
  ["search, name probe page", request("files", { q: "name contains 'board' and trashed = false", fields: "files(id,name,mimeType,modifiedTime)", pageSize: "2" })],
  ["inventory list, page size 1000", request("files", { fields: "nextPageToken,files(id,name,size,createdTime)", pageSize: "1000" })],
  ["inventory list, page size 200", request("files", { fields: "nextPageToken,files(id,name,size,createdTime)", pageSize: "200" })],
  ["inventory list, page size 200 continued by a pageToken", request("files", { fields: "nextPageToken,files(id,name,size,createdTime)", pageSize: "200", pageToken: "CAIHEAE" })],
  ["permission list, page size 100", request(`files/${FILE}/permissions`, { fields: "permissions(id,type,role,emailAddress,displayName)", pageSize: "100" })],
  ["permission list, page size 20", request(`files/${FILE}/permissions`, { fields: "permissions(id,type,role,emailAddress,displayName)", pageSize: "20" })],
  ["content download", request(`files/${FILE}`, { alt: "media" })],
  ["pre-generated file id", request("files/generateIds", { count: "1", space: "drive", type: "files" })],
  ["single-resource get, page size never counted", request(`files/${FILE}`, { fields: "parents", pageSize: "1000" })],
];

const labelWidth = Math.max(...rows.map((row) => row[0].length));
const projectionWidth = Math.max(...rows.map((row) => new URL(row[1], API).searchParams.get("fields")?.length ?? 0));

console.log(`Drive request cost — derived local model (Google's reported X-Drive-Request-Cost may differ)`);
console.log(`constants: base ${DRIVE_COST_BASE}, field ${DRIVE_COST_FIELD}, nested field group ${DRIVE_COST_FIELD_GROUP}, pageToken ${DRIVE_COST_PAGETOKEN}, window ${DRIVE_COST_WINDOW_MS} ms, budget ${DRIVE_DEFAULT_COST_PER_MINUTE} cost/minute`);
console.log();
console.log(`${"cost".padStart(5)}  ${"resource".padEnd(8)}  ${"projection".padEnd(projectionWidth)}  request`);
for (const [label, url] of rows) {
  const parsed = new URL(url, API);
  const fields = parsed.searchParams.get("fields") ?? "";
  const query = [...parsed.searchParams.entries()].filter(([key]) => key !== "fields").map(([key, value]) => `${key}=${value}`).join("&");
  console.log(`${String(driveRequestCost(url)).padStart(5)}  ${driveCostResource(url).padEnd(8)}  ${fields.padEnd(projectionWidth)}  ${label} (${query || "no query"})`);
}

console.log();
const nested = "user(emailAddress,displayName)";
const naive = nested.split(",").reduce((sum, entry) => sum + (entry.includes("(") ? DRIVE_COST_FIELD_GROUP : DRIVE_COST_FIELD), 0);
console.log(`nested-selection guard: ${nested} -> ${fieldEntries(nested).length} entry (${fieldEntries(nested)[0]}), cost ${driveFieldCost(nested)}; a naive comma split would mis-count it as ${naive}`);

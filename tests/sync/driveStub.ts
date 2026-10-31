/**
 * In-memory Google Drive fixture for the unified board store: understands
 * exactly the API surface `createDriveBoardStore`/`drivePublish`/legacy
 * transports use and counts any AppData-shaped request so tests can prove
 * v2 operation never touches `appDataFolder`. Mirrors two live-API quirks
 * that changed real behavior: media downloads only exist on the v3 host
 * (the upload host answers 405), and the `"root"` alias resolves — parents
 * listings return the account's real root id, never the literal "root".
 */
type StubFile = {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array;
  version: number;
  trashed: boolean;
  createdTime: string;
  modifiedTime: string;
  contentRestrictions?: { readOnly: boolean; ownerRestricted: boolean; reason?: string }[];
};

export type StubPermission = { id: string; type: "user"; role: string; emailAddress: string };

/** The live API resolves the `"root"` alias in queries/writes but returns
 * the account's real root id in `parents` listings; the stub mirrors this. */
export const REAL_ROOT_ID = "0pboardstubrootalias000000000000";
const alias = (parent: string) => (parent === "root" ? REAL_ROOT_ID : parent);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Deterministic sortable clock; ordering (createdTime/modifiedTime) follows
 * mutation order, matching Drive closely enough for merge arbitration. */
let clock = 0;
const stamp = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

export class DriveStub {
  files: StubFile[] = [];
  permissions = new Map<string, StubPermission[]>();
  defaultPermissions: StubPermission[] = [];
  appDataCalls = 0;
  requests: string[] = [];
  /** Hook invoked before every request; may mutate `files` to race the code. */
  onFetch: ((url: string) => void | Promise<void>) | null = null;
  private next = 1;

  addFolder(name: string, parent: string): StubFile {
    const folder: StubFile = { id: `folder-${this.next++}`, name, parents: [alias(parent)], mimeType: "application/vnd.google-apps.folder", bytes: new Uint8Array(), version: 1, trashed: false, createdTime: stamp(), modifiedTime: stamp() };
    this.files.push(folder);
    return folder;
  }
  addFile(name: string, parent: string | "appDataFolder", contents: string): StubFile {
    const file: StubFile = { id: `file-${this.next++}`, name, parents: [parent === "appDataFolder" ? parent : alias(parent)], mimeType: "", bytes: new TextEncoder().encode(contents), version: 1, trashed: false, createdTime: stamp(), modifiedTime: stamp() };
    this.files.push(file);
    return file;
  }
  find(name: string, parent?: string): StubFile | undefined {
    return this.files.find(f => f.name === name && f.trashed === false && (parent === undefined || f.parents.includes(parent)));
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    this.requests.push(url);
    if (url.includes("appDataFolder")) this.appDataCalls += 1;
    await this.onFetch?.(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const upload = url.startsWith("https://www.googleapis.com/upload/drive/v3/files");
    const api = url.startsWith("https://www.googleapis.com/drive/v3/files");
    const params = new URL(url).searchParams;
    const pathParts = new URL(url).pathname.split("/");
    if (method === 'GET' && url.includes('/drive/v3/about')) return json({ user: { emailAddress: 'owner@example.com', displayName: 'Owner' } });
    if (method === 'GET' && url.includes('/files/generateIds')) return json({ ids: [`reserved-${this.next++}`] });
    if (upload && method === "GET") return json({ error: { status: "METHOD_NOT_ALLOWED", message: "Media downloads must use the v3 host" } }, 405);
    if (upload && method === "POST") {
      const text = typeof init.body === "string" ? init.body : "";
      const meta = /\{[\s\S]*?\}(?=\r\n--)/.exec(text)?.[0];
      if (!meta) return json({ error: { message: "multipart metadata missing" } }, 400);
      const parsed = JSON.parse(meta) as { id?: string; name?: string; parents?: string[] | string; mimeType?: string };
      const parents = (typeof parsed.parents === "string" ? JSON.parse(parsed.parents) as string[] : parsed.parents ?? []).map(alias);
      const parts = [...text.matchAll(/Content-Type: [^\r\n]+\r\n\r\n([\s\S]*?)(?=\r\n--)/g)].map(m => m[1]);
      const payload = parts.length > 1 ? parts[1] : "";
      if (parsed.id && this.byId(parsed.id)) return json({ error: { message: 'exists' } }, 409);
      const file: StubFile = {
        id: parsed.id ?? `file-${this.next++}`, name: parsed.name ?? "", parents,
        mimeType: parsed.mimeType ?? "", bytes: new TextEncoder().encode(payload), version: 1, trashed: false, createdTime: stamp(), modifiedTime: stamp()
      };
      this.files.push(file);
      return json({ id: file.id, version: String(file.version) });
    }
    if (method === "GET" && url.includes("alt=media")) {
      const file = this.byId(decodeURIComponent(pathParts.at(-1)!));
      if (!file || file.trashed) return json({ error: { message: "missing" } }, 404);
      return new Response(file.bytes.slice().buffer as ArrayBuffer);
    }
    if (upload && method === "PATCH") {
      const file = this.byId(decodeURIComponent(pathParts.at(-1)!));
      if (!file || file.trashed) return json({ error: { message: "missing" } }, 404);
      if (file.contentRestrictions?.some(restriction => restriction.readOnly)) return json({ error: { message: 'read-only legacy file' } }, 403);
      const expected = headers.get("If-Match");
      if (expected !== null && expected !== String(file.version)) return json({ error: { message: "precondition failed" } }, 412);
      file.bytes = init.body instanceof Uint8Array ? init.body
        : init.body instanceof ArrayBuffer ? new Uint8Array(init.body)
          : typeof init.body === "string" ? new TextEncoder().encode(init.body)
            : new Uint8Array();
      file.version += 1;
      file.modifiedTime = stamp();
      return json({ ...file, size: String(file.bytes.length), ownedByMe: true, owners: [{ emailAddress: 'owner@example.com' }], capabilities: { canAddChildren: true }, version: String(file.version), md5Checksum: "md5" });
    }
    if (api && new URL(url).pathname.endsWith("/permissions") && method === "GET") {
      const target = decodeURIComponent(pathParts.at(-2)!);
      return json({ permissions: this.permissions.get(target) ?? this.defaultPermissions });
    }
    if (api && new URL(url).pathname.endsWith("/permissions") && method === "POST") {
      const target = decodeURIComponent(pathParts.at(-2)!);
      const body = JSON.parse(String(init.body)) as { role: string; emailAddress: string };
      const permission: StubPermission = { id: `perm-${this.next++}`, type: "user", role: body.role, emailAddress: body.emailAddress };
      this.permissions.set(target, [...(this.permissions.get(target) ?? []), permission]);
      return json(permission);
    }
    if (api && method === "GET") {
      const id = decodeURIComponent(pathParts.at(-1)!);
      if (id !== "files") {
        const file = this.byId(id);
        if (!file || file.trashed) return json({ error: { message: "missing" } }, 404);
        return json({ ...file, size: String(file.bytes.length), ownedByMe: true, owners: [{ emailAddress: 'owner@example.com' }], capabilities: { canAddChildren: true }, version: String(file.version), md5Checksum: "md5" });
      }
      const query = params.get("q") ?? "";
      const appData = params.get("spaces") === "appDataFolder";
      const nameEq = /name = '([^']*)'/.exec(query)?.[1];
      const nameIn = /'([^']*)' in name/.exec(query)?.[1] ?? /name contains '([^']*)'/.exec(query)?.[1];
      const parentIn = /'([^']*)' in parents/.exec(query)?.[1];
      const mimeType = /mimeType\s*=\s*'([^']*)'/.exec(query)?.[1];
      const listed = this.files.filter(f => !f.trashed
        && (appData ? f.parents.includes("appDataFolder") : !f.parents.includes("appDataFolder"))
        && (parentIn === undefined || f.parents.includes(alias(parentIn)))
        && (nameEq === undefined || f.name === nameEq)
        && (nameIn === undefined || f.name.includes(nameIn))
        && (mimeType === undefined || f.mimeType === mimeType));
      return json({ files: listed.map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType, createdTime: f.createdTime, modifiedTime: f.modifiedTime, size: String(f.bytes.length) })) });
    }
    if (api && method === "POST") {
      const parsed = JSON.parse(String(init.body)) as { name?: string; parents?: string[]; mimeType?: string };
      const file: StubFile = {
        id: `file-${this.next++}`, name: parsed.name ?? "", parents: (parsed.parents ?? []).map(alias),
        mimeType: parsed.mimeType ?? "", bytes: new Uint8Array(), version: 1, trashed: false, createdTime: stamp(), modifiedTime: stamp()
      };
      this.files.push(file);
      return json({ id: file.id });
    }
    if (api && method === "DELETE" && new URL(url).pathname.endsWith("/permissions")) {
      const target = decodeURIComponent(pathParts.at(-2)!);
      const permissionId = decodeURIComponent(pathParts.at(-1)!);
      const kept = (this.permissions.get(target) ?? []).filter(permission => permission.id !== permissionId);
      if (this.permissions.has(target)) this.permissions.set(target, kept);
      return new Response(null, { status: 204 });
    }
    if (api && method === "DELETE") {
      // Drive answers a successful delete with an empty 204.
      const id = decodeURIComponent(pathParts.at(-1)!);
      const file = this.byId(id);
      if (!file || file.trashed) return json({ error: { message: "missing" } }, 404);
      file.trashed = true;
      file.modifiedTime = stamp();
      return new Response(null, { status: 204 });
    }
    if (api && method === "PATCH") {
      const id = decodeURIComponent(pathParts.at(-1)!);
      const file = this.byId(id);
      if (!file) return json({ error: { message: "missing" } }, 404);
      const patch = JSON.parse(String(init.body ?? "{}")) as { trashed?: boolean; name?: string; contentRestrictions?: StubFile["contentRestrictions"] };
      if (patch.contentRestrictions) file.contentRestrictions = patch.contentRestrictions;
      if (patch.trashed !== undefined) file.trashed = patch.trashed;
      if (patch.name !== undefined) file.name = patch.name;
      const addParents = params.get("addParents");
      const removeParents = params.get("removeParents");
      if (addParents || removeParents) {
        if (removeParents) file.parents = file.parents.filter(p => !removeParents.split(",").includes(p));
        if (addParents && !file.parents.includes(addParents)) file.parents = [...file.parents, addParents];
      }
      file.modifiedTime = stamp();
      return json({ id: file.id });
    }
    return json({ error: { message: `unhandled ${method} ${url}` } }, 500);
  };

  private byId(id: string): StubFile | undefined {
    return this.files.find(f => f.id === id);
  }
}

/**
 * Multi-account in-memory Google Drive fixture for the two-browser suite.
 *
 * Derived from `tests/sync/driveStub.ts` (the single-account unified-store
 * stub) and the fault/ACL model of `tests/recovery/harness.ts`'s
 * `DriveFixture`; the multi-browser suite needs per-caller answers that neither
 * upstream fake can give, and the two suites are owned by different work in
 * flight, so this is a deliberate copy-forward rather than a shared edit.
 *
 * What this adds over the stub: every request resolves the caller from its
 * `Authorization` bearer (unknown token → 403), file visibility follows
 * ownership + inherited folder ACLs per caller, `ownedByMe` /
 * `capabilities(canAddChildren)` (the exact `folderRole()` oracle in
 * `src/sync/operations/driveStore.ts`) answer *that caller's* role, `appDataFolder`
 * is private per account, and permission records are stored per file so
 * `listPermissions`/`createPermission` (sharing, ownership proofs, identity)
 * see truthful email → role rows. There is no global "the role": a role query
 * without an account cannot be answered here, which is the point.
 */

export type FakePermission = { id: string; type: 'user'; role: string; emailAddress: string };

type FakeFile = {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array;
  version: number;
  trashed: boolean;
  createdTime: string;
  modifiedTime: string;
  /** The account that created (and therefore owns) this file. */
  ownerEmail: string;
  /** Per-file ACL grants; folder grants apply to everything below them. */
  permissions: Map<string, string>;
  /** Set on AppData files: AppData is visible to exactly this account. */
  appDataOwner?: string;
  contentRestrictions?: { readOnly: boolean; ownerRestricted: boolean; reason?: string }[];
};

/** The stub's `root` alias behavior: queries accept "root", listings carry a real id. */
export const FAKE_ROOT_ID = '0pboardfakerootalias000000000000';
const alias = (parent: string) => (parent === 'root' ? FAKE_ROOT_ID : parent);

const WRITABLE = new Set(['owner', 'writer', 'editor']);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let clock = 0;
const stamp = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();
export class FakeDrive {
  readonly requests: string[] = [];
  readonly files: FakeFile[] = [];
  /** Every 401/403-style refusal, recorded so a scenario can assert a refusal
   * was the *Drive* answer rather than a client-side guess. */
  readonly refusals: { email: string | null; url: string; status: number }[] = [];
  /** Drive write faults for persistence scenarios. Each entry is consumed by the
   * next Drive *mutation* and answered with `status` instead of being applied.
   * `hold` stalls the answer until the caller settles it, so a scenario can
   * observe behaviour while a publication is genuinely in flight without any
   * test sleeping on wall-clock time. Reads are never affected — a scenario that
   * needs a stale listing arranges that by not writing, which keeps the
   * distinction between "not yet published" and "publish failed" observable. */
  readonly writeFaults: { status: number; hold?: Promise<void> }[] = [];
  /** Sustained outage: while set, every Drive mutation answers this status. */
  writeOutage: number | null = null;
  /** Drive read faults — the read-side counterpart of `writeFaults`, which the
   * delete-materialisation contract needs: a verification *read* that fails
   * must leave the board in place, and only a fake that can refuse a read
   * proves it. Each entry is consumed by the next Drive GET whose URL answers
   * `match` and is answered with `status` instead of the file. Matching is by
   * URL, not by account, because the two browsers of one Google account share
   * one identity here — a scenario targets one browser's read by scoping the
   * matcher to the resource only that browser reads while the other is idle. */
  readonly readFaults: { status: number; match: (url: string) => boolean }[] = [];
  /** Every mutation this service saw, successful, refused, or injected —
   * recorded before the fault decision so a scenario can assert a *zero*:
   * "verifying this hint touched Drive read-only" is a claim about the
   * absence of mutations, and only a log of attempts can prove an absence. */
  readonly mutations: { email: string; url: string }[] = [];
  private next = 1;
  private readonly tokens = new Map<string, string>();

  /** Registers a Google account with the Drive service; returns its bearer token. */
  addAccount(email: string): string {
    const token = `drive-token-${email}`;
    this.tokens.set(token, email);
    return token;
  }

  /** Direct fixture access to model an explicit Drive share (what the product
   * would do through `drivePermissions.invite`): grants `email` a role on a
   * file/folder; children inherit it. */
  grant(name: string, email: string, role: string, parent?: string): void {
    const file = this.mustFind(name, parent);
    file.permissions.set(email.toLowerCase(), role);
  }

  mustFind(name: string, parent?: string): FakeFile {
    const file = this.find(name, parent);
    if (!file) throw new Error(`Fake Drive: no visible file named ${name}`);
    return file;
  }

  find(name: string, parent?: string): FakeFile | undefined {
    return this.files.find(f => f.name === name && !f.trashed);
  }

  /** Whether `email`'s Drive view actually lists a (non-trashed) file name —
   * ownership or an inherited ACL, never a global listing. */
  visibleTo(name: string, email: string): boolean {
    return this.files.some(f => f.name === name && !f.trashed && this.effectiveRole(f, email) !== null);
  }

  /** All file contents under the folder named `name`, as text. */
  contentsUnder(folderName: string): { name: string; text: string }[] {
    const folder = this.find(folderName);
    if (!folder) return [];
    const inside = new Set([folder.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const file of this.files) if (!file.trashed && file.parents.some(p => inside.has(p)) && !inside.has(file.id)) { inside.add(file.id); grew = true; }
    }
    // Newest first, the way a `files.list` view ordered by createdTime answers:
    // immutable versioned files (snapshots) accumulate, and callers asking
    // "what is this folder's snapshot" mean the current one, not the oldest.
    return this.files.filter(f => inside.has(f.id) && f.mimeType !== 'application/vnd.google-apps.folder' && !f.trashed)
      .reverse()
      .map(f => ({ name: f.name, text: new TextDecoder().decode(f.bytes) }));
  }

  /** The effective role `email` holds on `file` through ownership or any ancestor ACL. */
  effectiveRole(file: FakeFile, email: string): string | null {
    if (file.appDataOwner !== undefined) return file.appDataOwner === email ? 'owner' : null;
    let node: FakeFile | undefined = file;
    const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.ownerEmail === email) return 'owner';
      const granted = node.permissions.get(email);
      if (granted) return granted;
      const parent: FakeFile | undefined = node.parents.map(p => this.byId(p)).find(p => p !== undefined);
      node = parent;
    }
    return null;
  }

  private takeWriteFault(): { status: number; hold?: Promise<void> } | null {
    if (this.writeOutage !== null) return { status: this.writeOutage };
    return this.writeFaults.shift() ?? null;
  }
  private byId(id: string): FakeFile | undefined { return this.files.find(f => f.id === id); }

  private visible(file: FakeFile, email: string): boolean { return this.effectiveRole(file, email) !== null; }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    this.requests.push(url);
    const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? null;
    const email = token === null ? null : this.tokens.get(token) ?? null;
    if (email === null) {
      this.refusals.push({ email, url, status: 401 });
      return json({ error: { status: 'UNAUTHENTICATED', message: 'no such Drive account' } }, 401);
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const params = new URL(url).searchParams;
    const path = new URL(url).pathname;
    const isUpload = url.startsWith('https://www.googleapis.com/upload/drive/v3');
    const isApi = url.startsWith('https://www.googleapis.com/drive/v3');
    const parts = path.split('/').filter(Boolean);
    const idOf = (fromEnd: 1 | 2) => decodeURIComponent(parts[parts.length - fromEnd] ?? '');

    // A queued write fault consumes the next mutation and answers the injected
    // status without touching state, so a scenario can distinguish a client that
    // retries publication from one that silently marks an edit durable.
    if ((isUpload || isApi) && method !== 'GET') {
      this.mutations.push({ email, url });
      const fault = this.takeWriteFault();
      if (fault !== null) {
        if (fault.hold !== undefined) await fault.hold;
        this.refusals.push({ email, url, status: fault.status });
        return json({ error: { status: 'INJECTED_WRITE_FAILURE', message: 'injected by a persistence scenario' } }, fault.status);
      }
    }

    // A queued read fault consumes the next matching GET and answers the
    // injected status without touching state — the read-side mirror of the
    // write-fault contract above.
    if (method === 'GET') {
      const at = this.readFaults.findIndex(fault => fault.match(url));
      if (at >= 0) {
        const fault = this.readFaults.splice(at, 1)[0];
        this.refusals.push({ email, url, status: fault.status });
        return json({ error: { status: 'INJECTED_READ_FAILURE', message: 'injected by a persistence scenario' } }, fault.status);
      }
    }

    if (method === 'GET' && isApi && path === '/drive/v3/about') {
      return json({ user: { emailAddress: email, displayName: email.split('@')[0] } });
    }
    if (method === 'GET' && isApi && path.endsWith('/files/generateIds')) return json({ ids: [`reserved-${this.next++}`] });
    if (isUpload && method === 'GET') return json({ error: { status: 'METHOD_NOT_ALLOWED', message: 'media downloads use the v3 host' } }, 405);
    if (isUpload && method === 'POST') {
      const text = typeof init.body === 'string' ? init.body : '';
      const meta = /\{[\s\S]*?\}(?=\r\n--)/.exec(text)?.[0];
      if (!meta) return json({ error: { message: 'multipart metadata missing' } }, 400);
      const parsed = JSON.parse(meta) as { id?: string; name?: string; parents?: string[] | string; mimeType?: string };
      const parents = (typeof parsed.parents === 'string' ? JSON.parse(parsed.parents) as string[] : parsed.parents ?? []).map(alias);
      const parts = [...text.matchAll(/Content-Type: [^\r\n]+\r\n\r\n([\s\S]*?)(?=\r\n--)/g)].map(m => m[1]);
      const payload = parts.length > 1 ? parts[1] : '';
      if (parsed.id && this.byId(parsed.id)) return json({ error: { message: 'exists' } }, 409);
      const appData = parents.includes('appDataFolder');
      if (!appData) {
        const parent = this.byId(parents[0] ?? '');
        if (!parent || !WRITABLE.has(this.effectiveRole(parent, email) ?? '')) {
          this.refusals.push({ email, url, status: 403 });
          return json({ error: { status: 'PERMISSION_DENIED', message: 'cannot add children' } }, 403);
        }
      }
      const file: FakeFile = {
        id: parsed.id ?? `file-${this.next++}`, name: parsed.name ?? '', parents, mimeType: parsed.mimeType ?? '',
        bytes: new TextEncoder().encode(payload), version: 1, trashed: false, createdTime: stamp(), modifiedTime: stamp(),
        ownerEmail: email, permissions: new Map(), ...(appData ? { appDataOwner: email } : {}),
      };
      this.files.push(file);
      return json({ id: file.id, version: String(file.version) });
    }
    if (isUpload && method === 'PATCH') {
      const file = this.byId(idOf(1));
      if (!file || file.trashed || !this.visible(file, email)) return json({ error: { message: 'missing' } }, 404);
      if (file.contentRestrictions?.some(r => r.readOnly)) return json({ error: { message: 'read-only legacy file' } }, 403);
      if (!WRITABLE.has(this.effectiveRole(file, email) ?? '')) { this.refusals.push({ email, url, status: 403 }); return json({ error: { status: 'PERMISSION_DENIED' } }, 403); }
      const expected = new Headers(init.headers).get('If-Match');
      if (expected !== null && expected !== String(file.version)) return json({ error: { message: 'precondition failed' } }, 412);
      file.bytes = typeof init.body === 'string' ? new TextEncoder().encode(init.body)
        : init.body instanceof Uint8Array ? init.body
          : init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : new Uint8Array();
      file.version += 1;
      file.modifiedTime = stamp();
      return json(this.metadata(file, email));
    }
    if (isApi && path.endsWith('/permissions') && method === 'GET') {
      const target = this.byId(idOf(2));
      if (!target || !this.visible(target, email)) return json({ error: { message: 'missing' } }, 404);
      return json({ permissions: this.permissionsOf(target) });
    }
    if (isApi && path.endsWith('/permissions') && method === 'POST') {
      const target = this.byId(idOf(2));
      if (!target || !this.visible(target, email)) return json({ error: { message: 'missing' } }, 404);
      if (target.ownerEmail !== email) { this.refusals.push({ email, url, status: 403 }); return json({ error: { status: 'PERMISSION_DENIED', message: 'only the owner shares' } }, 403); }
      const body = JSON.parse(String(init.body)) as { role: string; emailAddress: string };
      const permission: FakePermission = { id: `perm-${this.next++}`, type: 'user', role: body.role, emailAddress: body.emailAddress };
      target.permissions.set(body.emailAddress.toLowerCase(), body.role);
      return json(permission);
    }
    if (isApi && method === 'GET' && params.get('alt') === 'media') {
      const file = this.byId(idOf(1));
      if (!file || file.trashed || !this.visible(file, email)) return json({ error: { message: 'missing' } }, 404);
      return new Response(file.bytes.slice().buffer as ArrayBuffer);
    }
    if (isApi && method === 'GET' && /^\/drive\/v3\/files\/[^/]+$/.test(path)) {
      const file = this.byId(idOf(1));
      if (!file || file.trashed || !this.visible(file, email)) return json({ error: { message: 'missing' } }, 404);
      return json(this.metadata(file, email));
    }
    if (isApi && method === 'GET') {
      const query = params.get('q') ?? '';
      const appData = params.get('spaces') === 'appDataFolder';
      const nameEq = /name = '([^']*)'/.exec(query)?.[1];
      const nameIn = /'([^']*)' in name/.exec(query)?.[1] ?? /name contains '([^']*)'/.exec(query)?.[1];
      const parentIn = /'([^']*)' in parents/.exec(query)?.[1];
      const mimeType = /mimeType\s*=\s*'([^']*)'/.exec(query)?.[1];
      const listed = this.files.filter(f => !f.trashed
        && (appData ? f.appDataOwner === email : !f.appDataOwner && this.visible(f, email))
        && (parentIn === undefined || f.parents.includes(alias(parentIn)))
        && (nameEq === undefined || f.name === nameEq)
        && (nameIn === undefined || f.name.includes(nameIn))
        && (mimeType === undefined || f.mimeType === mimeType));
      return json({ files: listed.map(f => ({ id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType,
        createdTime: f.createdTime, modifiedTime: f.modifiedTime, size: String(f.bytes.length) })) });
    }
    if (isApi && method === 'POST') {
      const parsed = JSON.parse(String(init.body)) as { name?: string; parents?: string[]; mimeType?: string };
      const parents = (parsed.parents ?? ['root']).map(alias);
      const parent = this.byId(parents[0] ?? '');
      if (parent && !WRITABLE.has(this.effectiveRole(parent, email) ?? '')) { this.refusals.push({ email, url, status: 403 }); return json({ error: { status: 'PERMISSION_DENIED' } }, 403); }
      const file: FakeFile = { id: `file-${this.next++}`, name: parsed.name ?? '', parents, mimeType: parsed.mimeType ?? '',
        bytes: new Uint8Array(), version: 1, trashed: false, createdTime: stamp(), modifiedTime: stamp(), ownerEmail: email, permissions: new Map() };
      this.files.push(file);
      return json({ id: file.id });
    }
    if (isApi && method === 'PATCH') {
      const file = this.byId(idOf(1));
      if (!file || !this.visible(file, email)) return json({ error: { message: 'missing' } }, 404);
      const patch = JSON.parse(String(init.body ?? '{}')) as { trashed?: boolean; name?: string; contentRestrictions?: FakeFile['contentRestrictions'] };
      if (patch.contentRestrictions) file.contentRestrictions = patch.contentRestrictions;
      if (patch.trashed !== undefined) file.trashed = patch.trashed;
      if (patch.name !== undefined) file.name = patch.name;
      const addParents = params.get('addParents');
      const removeParents = params.get('removeParents');
      if (removeParents) file.parents = file.parents.filter(p => !removeParents.split(',').includes(p));
      if (addParents && !file.parents.includes(addParents)) file.parents = [...file.parents, addParents];
      file.version += 1;
      file.modifiedTime = stamp();
      return json(this.metadata(file, email));
    }
    if (isApi && method === 'DELETE') {
      const file = this.byId(idOf(1));
      if (!file || file.trashed) return json({ error: { message: 'missing' } }, 404);
      if (file.ownerEmail !== email) { this.refusals.push({ email, url, status: 403 }); return json({ error: { status: 'PERMISSION_DENIED' } }, 403); }
      file.trashed = true;
      return new Response(null, { status: 204 });
    }
    this.refusals.push({ email, url, status: 404 });
    return json({ error: { message: `fake Drive: unhandled ${method} ${url}` } }, 404);
  };

  private permissionsOf(file: FakeFile): FakePermission[] {
    const rows: FakePermission[] = [];
    if (file.appDataOwner === undefined) rows.push({ id: 'self', type: 'user', role: 'owner', emailAddress: file.ownerEmail });
    for (const [emailAddress, role] of file.permissions) rows.push({ id: `perm-for-${emailAddress}`, type: 'user', role, emailAddress });
    return rows;
  }

  private metadata(file: FakeFile, email: string) {
    const role = this.effectiveRole(file, email) ?? '';
    return { id: file.id, name: file.name, parents: file.parents, mimeType: file.mimeType,
      trashed: file.trashed, size: String(file.bytes.length), ownedByMe: file.ownerEmail === email,
      owners: [{ emailAddress: file.ownerEmail }], capabilities: { canAddChildren: WRITABLE.has(role) },
      contentRestrictions: file.contentRestrictions ?? [], version: String(file.version), md5Checksum: 'md5' };
  }
}

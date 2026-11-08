import { expect, it, vi } from "vitest";
import { createBoardGrantService, type BoardGrantBundle } from "../../src/collab/boardGrants";
import { instantAuthBudget } from "../helpers/authBudget";
import { generateDeviceKey, importSigningKey, publicKeyFingerprint, signBytes, verifyBytes } from "../../src/collab/security/keys";
import { signedBytes } from "../../src/collab/security/canonical";

// The Drive-first discovery contract (boardGrants decideAuthority + write):
// a published grant mirror is joined, never rivaled; announced same-account
// members join the roster at the next issuance; a failed mirror lookup blocks
// creation instead of blinding the decision.
const settings = { provider: "websocket" as const, url: "wss://relay.example.test/ws" };

type Member = { format: string; boardId: string; deviceKeyId: string; publicKey: unknown; signature: string };

function world(options: { blindLookup?: boolean } = {}) {
  const mirror = new Map<string, string>();
  const members = new Map<string, string>();
  const clients: Promise<ReturnType<typeof make>>[] = [];
  function make() {
    const values: Record<string, unknown> = {};
    const storage = { get: async (id: string) => ({ [id]: structuredClone(values[id]) }), set: async (patch: Record<string, unknown>) => { Object.assign(values, structuredClone(patch)); } };
    const keys = new Map<string, Awaited<ReturnType<typeof generateDeviceKey>>>();
    const minting = new Map<string, Promise<Awaited<ReturnType<typeof generateDeviceKey>>>>();
    // `ensureDeviceKey`'s production counterpart is concurrency-safe; the fake
    // must be too — announcement and creation race for the same board key.
    const getKey = async (scope: string) => {
      if (!keys.has(scope)) {
        if (!minting.has(scope)) minting.set(scope, generateDeviceKey().then(key => { keys.set(scope, key); minting.delete(scope); return key; }));
        return await minting.get(scope)!;
      }
      return keys.get(scope)!;
    };
    const service = createBoardGrantService({
      storage, getKey,
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/grants/challenge") return new Response(JSON.stringify({ version: 2, challenge: "a".repeat(43) }));
        if (url.pathname === "/grants/publish") return new Response(null, { status: 204 });
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
      authBudget: instantAuthBudget(),
      grantExchange: {
        async publish(board: string, bundle: BoardGrantBundle) { mirror.set(board, JSON.stringify({ ...bundle, history: [...bundle.history] })); },
        async advertise(board: string) {
          if (options.blindLookup) throw new Error("Drive unavailable");
          return mirror.has(board) ? JSON.parse(mirror.get(board)!) as BoardGrantBundle : null;
        }
      },
      boardMembers: {
        async announce(board: string) {
          const device = await getKey(`board-device:${board}`);
          const payload = { format: "pboard-board-member-v1", boardId: board, deviceKeyId: device.keyId, publicKey: device.publicJwk };
          const signature = await signBytes(await importSigningKey(device.privateJwk), signedBytes("pboard-board-member-v1", payload as never));
          members.set(`${board}--${device.keyId}`, JSON.stringify({ ...payload, signature }));
        },
        async list(board: string) {
          const found: { deviceKeyId: string; publicKey: never; role: "editor" }[] = [];
          for (const [id, raw] of members) {
            if (!id.startsWith(`${board}--`)) continue;
            const value = JSON.parse(raw) as Member;
            if (value.format !== "pboard-board-member-v1" || value.boardId !== board) continue;
            const { signature, ...body } = value;
            if (await publicKeyFingerprint(body.publicKey as never) !== body.deviceKeyId) continue;
            if (!await verifyBytes(body.publicKey as never, signature, signedBytes("pboard-board-member-v1", body as never))) continue;
            found.push({ deviceKeyId: body.deviceKeyId, publicKey: body.publicKey as never, role: "editor" });
          }
          return found;
        }
      }
    });
    return { service, keys, values };
  }
  return { mirror, members, make: () => { const created = Promise.resolve(make()); clients.push(created); return created; }, settings };
}

it("joins a published board authority instead of creating a second one, refusing while unlisted", async () => {
  const f = world();
  const owner = await f.make();
  await owner.service.configure(f.settings);
  const bundle = await owner.service.initialize("board");
  expect(f.mirror.has("board")).toBe(true); // publication mirrored at issuance

  // Second browser of the account: no record, mirror present → it must not
  // mint an authority. Its device is not yet granted, so adoption refuses —
  // and the mirror and its own storage prove nothing was created.
  const joiner = await f.make();
  await joiner.service.configure(f.settings);
  await expect(joiner.service.initialize("board")).rejects.toThrow(/grant/i);
  expect(JSON.parse(f.mirror.get("board")!).history).toHaveLength(bundle.history.length);
  expect(joiner.values["pboardBoardGrants"]).toBeUndefined();
});

it("grants announced same-account members at the next issuance and admits them to the published authority", async () => {
  const f = world();
  const owner = await f.make();
  await owner.service.configure(f.settings);
  await owner.service.initialize("board");
  const joiner = await f.make();
  await joiner.service.configure(f.settings);

  // The first attempt refuses (device not granted yet) but announces this
  // browser's board identity — the authority device was created blind (no
  // mirror existed), so only the joiner announces; await the landing.
  await joiner.service.initialize("board").catch(() => {});
  await vi.waitFor(() => expect(f.members.size).toBe(1));

  // The authority device re-issues for any reason: announced members join the
  // roster without an explicit approval call.
  await owner.service.updateAuthorizedDevices("board", {});
  expect(JSON.parse(f.mirror.get("board")!).history.at(-1)!.payload.devices).toHaveLength(2);

  const joined = await joiner.service.initialize("board");
  const own = (await joiner.keys.get("board-device:board"))!;
  expect(joined.history.at(-1)!.payload.devices.some(d => d.deviceKeyId === own.keyId && d.role === "editor")).toBe(true);
  expect(await joiner.service.ownsAuthority("board")).toBe(false); // presentation, not ownership
});

it("treats a failed grant-mirror lookup as unsafe, never as absence", async () => {
  const f = world({ blindLookup: true });
  const device = await f.make();
  await device.service.configure(f.settings);
  await expect(device.service.initialize("board")).rejects.toThrow(/Drive unavailable/);
  expect(device.values["pboardBoardGrants"]).toBeUndefined();
});

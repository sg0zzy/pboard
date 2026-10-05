import { describe, expect, it, vi } from "vitest";
import { createAccountSignalStore } from "../src/sync/accountSignaling";
import { createDriveTransport, type DriveTransport } from "../src/sync/driveTransport";
import type { PboardDriveSignalRecord } from "../src/collab/signaling";

describe("account-only signaling", () => {
  it("reads changed account signaling records at the same URL without HTTP cache reuse", async () => {
    let contents = "old-presence";
    const cache = new Map<string, string>();
    const transport = createDriveTransport({
      connect: async () => {}, disconnect: async () => {}, getConnectionState: async () => "connected",
      getAccessToken: async () => "token", isConfigured: () => true
    }, async (input, init) => {
      const url = String(input);
      if (init?.cache === "no-store") return new Response(contents);
      if (!cache.has(url)) cache.set(url, contents);
      return new Response(cache.get(url)!);
    }, "account-signal-");
    expect(await transport.download("signal-file")).toBe("old-presence");
    contents = "new-offer";
    expect(await transport.download("signal-file")).toBe("new-offer");
  });
  it("stores rendezvous records in appDataFolder with a namespace separate from project snapshots", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ files: [], id: "signal-file" })));
    const transport = createDriveTransport({
      connect: async () => {}, disconnect: async () => {}, getConnectionState: async () => "connected",
      getAccessToken: async () => "token", isConfigured: () => true
    }, fetcher, "account-signal-");
    await transport.listProjectFiles();
    await transport.findProjectFile("account-peer");
    await transport.upload("account-peer", "{}");
    for (const [url] of fetcher.mock.calls.slice(0, 2)) expect(new URL(String(url)).searchParams.get("spaces")).toBe("appDataFolder");
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("q")).toContain("account-signal-");
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("q")).toContain("account-signal-account-peer.pboard");
    const body = String(fetcher.mock.calls[2][1]?.body);
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain('"name":"account-signal-account-peer.pboard"');
  });

  it("reads only the current account's peer records and removes its own record on leave", async () => {
    const files = new Map<string, { id: string; name: string; body: string }>();
    const transport: DriveTransport = {
      listProjectFiles: async () => [...files.values()],
      findProjectFile: async (key) => files.get(key) ?? null,
      download: async (id) => [...files.values()].find((file) => file.id === id)!.body,
      upload: async (key, body) => {
        const file = { id: key, name: `account-signal-${key}.pboard`, body };
        files.set(key, file); return file;
      },
      delete: async (id) => { files.delete(id); }
    };
    const own = createAccountSignalStore({ transport, account: "pippo", peerId: "firefox" });
    const other = createAccountSignalStore({ transport, account: "pluto", peerId: "chrome" });
    const record: PboardDriveSignalRecord = { updatedAt: 1, peers: [], outbox: [] };
    await own.writeOwn(record);
    await other.writeOwn(record);
    expect(await own.readPeer("firefox")).toEqual(record);
    expect(await own.readPeer("chrome")).toBeNull();
    expect(await own.listPeers()).toEqual({ firefox: record });
    await own.deleteOwn();
    expect(await own.listPeers()).toEqual({});
    expect(Object.keys(await other.listPeers())).toEqual(["chrome"]);
  });
});

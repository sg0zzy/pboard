import type { DriveTransport } from "./driveTransport";
import type { PboardDriveSignalRecord, PboardDriveSignalStore } from "../collab/signaling";

/** Account-only rendezvous in appDataFolder; never placed in a shared project. */
export function createAccountSignalStore(options: {
  transport: DriveTransport;
  account: string;
  peerId: string;
}): PboardDriveSignalStore {
  const { transport, account, peerId } = options;
  const key = (peer: string) => `${account}-${peer}`;
  const prefix = `account-signal-${account}-`;
  return {
    peerId, now: Date.now,
    async readPeer(peer) {
      const file = await transport.findProjectFile(key(peer));
      return file ? JSON.parse(await transport.download(file.id)) as PboardDriveSignalRecord : null;
    },
    async writeOwn(record) {
      const file = await transport.findProjectFile(key(peerId));
      await transport.upload(key(peerId), JSON.stringify(record), file?.id);
    },
    async listPeers() {
      const files = (await transport.listProjectFiles()).filter((file) => file.name.startsWith(prefix) && file.name.endsWith(".pboard"));
      const records: Record<string, PboardDriveSignalRecord> = {};
      await Promise.all(files.map(async (file) => {
        try { records[file.name.slice(prefix.length, -".pboard".length)] = JSON.parse(await transport.download(file.id)); }
        catch { /* Skip a torn read; the next signaling poll retries. */ }
      }));
      return records;
    },
    async deleteOwn() {
      const file = await transport.findProjectFile(key(peerId));
      if (file) await transport.delete(file.id);
    }
  };
}

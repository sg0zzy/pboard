import type { RxRepository } from "../storage/rxdbRepository";
import { parseProjectOrder } from "../storage/projectOrder";
import type { DriveTransport } from "./driveTransport";

/** Durable, account-private order; live WebRTC replication remains available. */
export function createAccountPreferenceSync(options: {
  transport: DriveTransport;
  legacySource?: DriveTransport;
  getAccountId: () => Promise<string | null>;
  getRepository: () => Promise<Pick<RxRepository, "getProjectOrder" | "applyProjectOrder" | "setProjectOrderAccount" | "listProjects" | "db"> | null>;
}) {
  let running: Promise<void> | null = null;
  async function sync() {
    const account = await options.getAccountId();
    const rx = await options.getRepository();
    if (!rx || !account) return;
    await rx.setProjectOrderAccount(account);
    const fallback = await rx.db.settings.findOne("localProjectOrder").exec();
    const source = await rx.db.settings.findOne("localProjectOrderAccount").exec();
    if (fallback && (!source || source.value === account)) {
      await rx.applyProjectOrder(account, parseProjectOrder(fallback.value));
    } else if (!await rx.getProjectOrder(account)) {
      await rx.applyProjectOrder(account, { ids: [], updatedAt: "1970-01-01T00:00:00.000Z" });
    }
    let file = await options.transport.findProjectFile(account);
    let saved: string | null = null;
    if (!file && options.legacySource) {
      const legacy = await options.legacySource.findProjectFile(account);
      if (legacy) await rx.applyProjectOrder(account, parseProjectOrder(await options.legacySource.download(legacy.id)));
    }
    if (file) {
      const remote = parseProjectOrder(await options.transport.download(file.id));
      await rx.applyProjectOrder(account, remote);
      saved = JSON.stringify(remote);
    }
    while (true) {
      const local = await rx.getProjectOrder(account);
      if (!local) return;
      const added = (await rx.listProjects()).map((project) => project.id).filter((id) => !local.ids.includes(id));
      if (added.length) {
        await rx.applyProjectOrder(account, {
          ids: [...local.ids, ...added],
          updatedAt: new Date(Math.max(Date.now(), Date.parse(local.updatedAt) + 1)).toISOString()
        });
        continue;
      }
      const contents = JSON.stringify(local);
      if (contents === saved) return;
      file = await options.transport.upload(account, contents, file?.id);
      saved = contents;
      // A reorder during an upload must also become durable before we finish.
    }
  }
  return () => {
    running ??= sync().finally(() => { running = null; });
    return running;
  };
}

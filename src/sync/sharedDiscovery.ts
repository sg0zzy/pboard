import type { DrivePermissionService } from "./drivePermissions";
import type { RxRepository } from "../storage/rxdbRepository";
import { deserializeProjectSnapshot } from "./snapshot";

/** Import newly invited boards without replacing local edits or changing selection. */
export function createSharedBoardDiscovery(options: {
  connected: () => Promise<boolean>;
  permissions: Pick<DrivePermissionService, "discoverSharedProjects" | "readSharedSnapshot" | "myRole">;
  getRepository: () => Promise<RxRepository | null>;
  isDeleted: (projectId: string) => Promise<boolean>;
  /**
   * A locally deleted (left) board whose Drive grant demonstrably postdates
   * the deletion — the owner re-invited. Returning true authorizes the
   * restore below; pending self-removals must report false so a queued
   * leave revocation is never eaten by a stale-looking grant check.
   */
  isReshared?: (projectId: string) => Promise<boolean>;
  /** Clears this account's deletion marker so the import below can land. */
  onReshared?: (projectId: string) => Promise<void>;
}) {
  let running: Promise<void> | null = null;
  async function discover() {
    if (!await options.connected()) return;
    const rx = await options.getRepository();
    if (!rx) return;
    const failures: string[] = [];
    for (const entry of await options.permissions.discoverSharedProjects()) {
      try {
        if (await options.isDeleted(entry.projectId)) {
          if (!await options.isReshared?.(entry.projectId)) continue;
          await options.onReshared?.(entry.projectId);
        } else if (await rx.getProject(entry.projectId)) continue;
        const snapshot = deserializeProjectSnapshot(await options.permissions.readSharedSnapshot(entry.projectId));
        if (snapshot.project.id !== entry.projectId) throw new Error("Shared board snapshot belongs to a different project");
        const role = await options.permissions.myRole(entry.projectId);
        if (!role || await options.isDeleted(entry.projectId) || await rx.getProject(entry.projectId)) continue;
        await rx.importProject(snapshot.project, snapshot.items);
        rx.setMutatorRole(entry.projectId, role);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) throw new Error(`Could not import some shared boards: ${failures.join("; ")}`);
  }
  return () => {
    running ??= discover().finally(() => { running = null; });
    return running;
  };
}

/**
 * Extension build's stand-in for `peerRuntime.ts`.
 *
 * The extension's composition root calls `setWebRtcDisabled(true)`
 * (`src/sync/browser.ts`), so no peer pool, DataChannel or history session can
 * ever start in it; `vite.sidebar.config.ts` and `vite.background.config.ts`
 * alias `./peerRuntime` to this file for that build. Android builds the same
 * sources with no alias and gets the real modules.
 *
 * Every function here throws for two reasons:
 *
 *  - Silence would be worse than a crash. A path that reached this file means the
 *    gate that makes the platform split true has been removed; the board would
 *    otherwise look like it collaborates while carrying no edits. A throw names
 *    that bug on the first attempt instead of at the end of a lost afternoon.
 *  - The types are the real ones, imported from `./peerRuntime`. In the type
 *    check there is no alias, so these annotations resolve against the real
 *    modules: a signature change there breaks this file's compile instead of
 *    drifting silently. The type import is erased, so the bundled stub has no
 *    dependency on the stack it replaces.
 *
 * The export list and order match `peerRuntime.ts` exactly. The stub replaces
 * that module wholesale, so a named import the barrel has and the stub lacks is
 * a build error rather than a silent `undefined` in the extension.
 */
import type * as Real from "./peerRuntime";

const refused = (name: string): never => {
  throw new Error(`${name} is unavailable: this build has WebRTC peer pools switched off and ships no peer stack.`);
};

function unavailable<T>(name: string): T {
  return (() => refused(name)) as unknown as T;
}

export const replicateWebRTC = unavailable<typeof Real.replicateWebRTC>("WebRTC replication");
export const createPboardWebRTCConnectionHandler = unavailable<typeof Real.createPboardWebRTCConnectionHandler>("The WebRTC connection handler");
export const scopeMasterChanges = unavailable<typeof Real.scopeMasterChanges>("WebRTC master-change scoping");
export const createProjectImageSync = unavailable<typeof Real.createProjectImageSync>("Peer image sync");
export const createDriveSignaling = unavailable<typeof Real.createDriveSignaling>("Drive signaling");
export const createOperationRealtime = unavailable<typeof Real.createOperationRealtime>("The operation DataChannel");

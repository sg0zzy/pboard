import { describe, expect, it } from "vitest";
import * as peerRuntime from "../src/collab/peerRuntime";
import * as stub from "../src/collab/peerRuntime.stub";
import { createPboardWebRTCConnectionHandler as realHandler } from "../src/collab/webrtcHandler";
import { scopeMasterChanges as realScope } from "../src/collab/scopedPull";

/**
 * Pins the platform split that keeps the WebRTC stack out of the extension
 * bundle (see `src/collab/peerRuntime.ts`).
 *
 * The extension's build aliases `peerRuntime.ts` to `peerRuntime.stub.ts`; this
 * run has no alias, so it exercises both files side by side. Two properties
 * matter and neither is observable from the app itself:
 *
 *  - The barrel must be pure re-exports. If someone adds logic to it, Android's
 *    behaviour and the extension's stub start to diverge — the stub replaces the
 *    whole module, so anything defined rather than re-exported would silently
 *    disappear on one platform.
 *  - The stub must throw rather than no-op. A stub that returned a plausible
 *    empty value would let a board look like it collaborates while carrying no
 *    edits, which is exactly the failure the throw exists to prevent.
 */
describe("peer runtime barrel and the extension's stub", () => {
  it("re-exports the real modules by identity, so Android runs the same functions", () => {
    expect(peerRuntime.replicateWebRTC).toBeTypeOf("function");
    expect(peerRuntime.createPboardWebRTCConnectionHandler).toBe(realHandler);
    expect(peerRuntime.scopeMasterChanges).toBe(realScope);
    expect(peerRuntime.createDriveSignaling).toBeTypeOf("function");
    expect(peerRuntime.createProjectImageSync).toBeTypeOf("function");
    expect(peerRuntime.createOperationRealtime).toBeTypeOf("function");
  });

  it("exports exactly the names the barrel does, so the stub cannot shadow a missing one", () => {
    // The stub replaces the barrel wholesale. A name the barrel gains and the stub
    // lacks becomes a build error in the extension; a name the stub gains is dead
    // weight. Comparing the two lists catches drift in the test run instead.
    expect(Object.keys(stub).sort()).toEqual(Object.keys(peerRuntime).sort());
  });

  it("throws from every peer entry point the extension cannot reach", () => {
    const invoke = (fn: unknown) => () => (fn as (...args: unknown[]) => unknown)();
    const calls: [string, () => unknown][] = [
      ["replication", invoke(stub.replicateWebRTC)],
      ["connection handler", invoke(stub.createPboardWebRTCConnectionHandler)],
      ["master-change scoping", invoke(stub.scopeMasterChanges)],
      ["image sync", invoke(stub.createProjectImageSync)],
      ["Drive signaling", invoke(stub.createDriveSignaling)],
      ["operation DataChannel", invoke(stub.createOperationRealtime)]
    ];
    for (const [name, call] of calls) {
      expect(call, name).toThrow(/ships no peer stack/);
    }
  });
});

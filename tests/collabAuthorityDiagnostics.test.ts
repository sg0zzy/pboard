import { expect, it } from "vitest";
import { classifyBoardAuthority } from "../src/collab/authorityDiagnostics";
import type { KeyValueStorage } from "../src/storage/repository";

const storageWith = (grants: Record<string, unknown> | undefined): KeyValueStorage => ({
  get: async () => ({ pboardBoardGrants: grants }),
  set: async () => { throw new Error("classification must never write"); }
}) as unknown as KeyValueStorage;

it("classifies boards with no signed data as unsigned", async () => {
  const diagnosis = await classifyBoardAuthority({ boardId: "b", storage: storageWith(undefined),
    hasSignedHistory: false, hasDocumentSignature: false, loadRootKey: async () => null });
  expect(diagnosis.state).toBe("unsigned");
});

it("classifies boards with a local grant bundle as consistent, even with signed history", async () => {
  const diagnosis = await classifyBoardAuthority({ boardId: "b", storage: storageWith({ b: { bundle: {} } }),
    hasSignedHistory: true, hasDocumentSignature: true, loadRootKey: async () => null });
  expect(diagnosis.state).toBe("consistent");
});

it("separates a lost grant record from foreign signed history by root-key possession", async () => {
  const withKey = await classifyBoardAuthority({ boardId: "b", storage: storageWith(undefined),
    hasSignedHistory: true, hasDocumentSignature: false, loadRootKey: async () => ({ keyId: "k" }) });
  expect(withKey.state).toBe("authority-metadata-missing");
  expect(withKey.recovery).toContain("recovery file");
  const withoutKey = await classifyBoardAuthority({ boardId: "b", storage: storageWith(undefined),
    hasSignedHistory: false, hasDocumentSignature: true, loadRootKey: async () => null });
  expect(withoutKey.state).toBe("authority-foreign");
  expect(withoutKey.recovery).toContain("readable and exportable");
});

import { expect, it } from "vitest";
import { validateReplicationRequest } from "../src/collab/security/replicationRequests";
const includes = (doc: any) => doc?.projectId === "board";
it("rejects method injection, unbounded reads, cross-room writes and private ID collisions", async () => {
  await expect(validateReplicationRequest({ method: "constructor", params: [] }, includes)).rejects.toThrow();
  await expect(validateReplicationRequest({ method: "masterChangesSince", params: [null, 1000000] }, includes)).rejects.toThrow();
  await expect(validateReplicationRequest({ method: "masterWrite", params: [[{ newDocumentState: { id: "id", projectId: "private" } }]] }, includes)).rejects.toThrow();
  await expect(validateReplicationRequest({ method: "masterWrite", params: [[{ newDocumentState: { id: "private-id", projectId: "board" } }]] }, includes, async () => [{ id: "private-id", projectId: "private" }])).rejects.toThrow(/collides/);
  await expect(validateReplicationRequest({ method: "masterWrite", params: [[{ newDocumentState: { id: "id", projectId: "board" } }]] }, includes, async () => [])).resolves.toBeUndefined();
  await expect(validateReplicationRequest({ method: "masterChangesSince", params: [undefined, 100] }, includes)).resolves.toBeUndefined();
});

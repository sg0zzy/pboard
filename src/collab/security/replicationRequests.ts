/** Bound the authenticated RxDB RPC surface before it reaches the master handler. */
export async function validateReplicationRequest(message: { method: string; params?: unknown }, includes: (doc: unknown) => boolean,
  existingDocuments?: (ids: string[]) => Promise<unknown[]>): Promise<void> {
  if (!Array.isArray(message.params)) throw new Error("Invalid replication parameters");
  if (message.method === "token") { if (message.params.length) throw new Error("Invalid token request"); return; }
  if (message.method === "masterChangesSince") {
    if (message.params.length !== 2 || !Number.isSafeInteger(message.params[1]) || message.params[1] < 1 || message.params[1] > 1000) throw new Error("Invalid replication batch size");
    return;
  }
  if (message.method !== "masterWrite" || message.params.length !== 1 || !Array.isArray(message.params[0]) || message.params[0].length > 1000) throw new Error("Unsupported replication method");
  const ids: string[] = [];
  for (const row of message.params[0]) {
    if (!row || !includes(row.newDocumentState) || (row.assumedMasterState && !includes(row.assumedMasterState)) ||
        typeof row.newDocumentState.id !== "string" || (row.assumedMasterState && row.assumedMasterState.id !== row.newDocumentState.id)) throw new Error("Replication write is outside the authorized room");
    ids.push(row.newDocumentState.id);
  }
  if (existingDocuments && (await existingDocuments(ids)).some(doc => !includes(doc))) throw new Error("Replication write collides with a document outside the room");
}

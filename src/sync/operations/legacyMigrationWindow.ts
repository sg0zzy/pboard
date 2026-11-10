import type { LegacyRelayRow } from './legacyRelayRecovery';

/** Read fenced history separately from the live replay cursor, which can
 * intentionally skip rows encrypted with an unavailable key. */
export async function readLegacyMigrationWindow(
  ask: (afterSeq: number) => Promise<Record<string, unknown>>, after: number, through: number
): Promise<LegacyRelayRow[]> {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through) || after < 0 || through < after)
    throw new Error('Invalid migration replay bounds');
  if (through - after > 200_000) throw new Error('Migration relay window exceeds recovery limit');
  const rows: LegacyRelayRow[] = [];
  let cursor = after;
  while (cursor < through) {
    const reply = await ask(cursor);
    if (reply.action !== 'window' || reply.synced !== true || !Array.isArray(reply.operations) || !reply.operations.length)
      throw new Error('Migration relay history is unavailable or incomplete');
    for (const raw of reply.operations) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid migration relay row');
      const row = raw as Record<string, unknown>;
      if (row.seq !== cursor + 1 || typeof row.opId !== 'string' || typeof row.payload !== 'string')
        throw new Error('Migration relay history is not contiguous');
      if (Number(row.seq) > through) throw new Error('Migration relay changed after the fence');
      rows.push({ seq: Number(row.seq), opId: row.opId, payload: row.payload });
      cursor++;
    }
  }
  return rows;
}

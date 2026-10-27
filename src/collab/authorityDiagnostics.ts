/**
 * Read-only collaboration authority classification for one board.
 *
 * This never writes, repairs, or exposes key material. It answers why a
 * board with signed collaboration data lacks a usable local authority, so
 * the application (and support) can show a precise, safe recovery path
 * instead of guessing from one generic error.
 */
import type { KeyValueStorage } from "../storage/repository";
import { loadPurposeKey } from "./security/keys";

export type BoardAuthorityState =
  /** No signed collaboration data: a new or never-shared local board. */
  | "unsigned"
  /** A local grant bundle exists; the board's authority is usable (owner or member state). */
  | "consistent"
  /** Signed history exists, this device still holds the original authority key, but the grant bundle record is gone (lost storage record). */
  | "authority-metadata-missing"
  /** Signed history exists and this device never held its authority (imported, restored, or foreign-owned). */
  | "authority-foreign";

export type BoardAuthorityDiagnosis = { boardId: string; state: BoardAuthorityState; recovery: string };

const RECOVERY: Record<BoardAuthorityState, string> = {
  unsigned: "No collaboration authority is needed yet; automatic initialization remains available.",
  consistent: "No action required; the board's authority record is present on this device.",
  "authority-metadata-missing":
    "The original authority key is on this device but its grant record was lost. Re-open the sharing controls to re-publish the grant, or restore from the sealed recovery file; the signed history itself is intact.",
  "authority-foreign":
    "The signed history was created under an authority this device does not hold. Open the board from the original browser, restore the sealed authority recovery file, or accept a pairing invitation; local content stays readable and exportable."
};

/** Classify one board's authority state from local data only. Never writes. */
export async function classifyBoardAuthority(input: {
  boardId: string;
  storage: KeyValueStorage;
  /** Journal flag: committed signed entries exist for this board. */
  hasSignedHistory: boolean;
  /** Documents (project or cards) carry signed provenance. */
  hasDocumentSignature: boolean;
  /** Injectable for tests; defaults to the real purpose-key store. */
  loadRootKey?: (purpose: string) => Promise<unknown | null>;
}): Promise<BoardAuthorityDiagnosis> {
  const diagnose = (state: BoardAuthorityState): BoardAuthorityDiagnosis => ({ boardId: input.boardId, state, recovery: RECOVERY[state] });
  if (!input.hasSignedHistory && !input.hasDocumentSignature) return diagnose("unsigned");
  const grants = (await input.storage.get("pboardBoardGrants")).pboardBoardGrants as Record<string, unknown> | undefined;
  if (grants?.[input.boardId]) return diagnose("consistent");
  const load = input.loadRootKey ?? ((purpose: string) => loadPurposeKey(purpose));
  const rootKey = await load(`standalone-board-authority:${input.boardId}`);
  return diagnose(rootKey ? "authority-metadata-missing" : "authority-foreign");
}

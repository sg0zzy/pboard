/** Versioned plaintext relay payloads. This codec is not selected by the
 * production transport until the relay admission and migration barriers exist. */
import { parseStrictJson } from '../../collab/security/canonical';
import { digest, record, validateOperation, type Operation } from './protocol';

const FORMAT = 'pboard-plaintext-operation-v1';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export function createPlaintextOperationCodec(boardId: string) {
  return {
    async seal(operation: Operation): Promise<string> {
      validateOperation(operation, boardId);
      const body = { format: FORMAT, operation };
      return JSON.stringify({ ...body, integrity: await digest(body) });
    },
    async open(payload: string, opId: string): Promise<Operation> {
      if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) throw new Error('Operation payload exceeds size limit');
      const envelope: unknown = parseStrictJson(payload, MAX_PAYLOAD_BYTES);
      if (!record(envelope) || Object.keys(envelope).sort().join(',') !== 'format,integrity,operation'
        || envelope.format !== FORMAT || typeof envelope.integrity !== 'string' || !record(envelope.operation)) {
        throw new Error('Invalid plaintext operation envelope');
      }
      const operation = envelope.operation as Operation;
      validateOperation(operation, boardId);
      if (operation.opId !== opId) throw new Error('Operation payload does not match its identifier');
      if (envelope.integrity !== await digest({ format: FORMAT, operation })) throw new Error('Operation payload integrity mismatch');
      return operation;
    }
  };
}

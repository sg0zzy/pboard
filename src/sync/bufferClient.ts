/**
 * HTTP client for the signaling server's buffer and leader endpoints
 * (Sync v2). Authorization material (grant-bound device signatures) is
 * injected: the collab runtime adapter produces it from the same manifest and
 * device key the WebRTC admission path already uses, keeping crypto out of
 * this module and this module testable against a fake server.
 */
import { BufferBackpressureError, type BufferTransport } from "./bufferProtocol";
import type { SealedOp } from "./bufferCrypto";

export type AuthMaterial = {
  deviceKeyId: string;
  session: string;
  signature: string;
  authority: { kty: string; crv: string; x: string; y: string };
  manifestPayload: string;
  manifestSignature: string;
};

export type Authorizer = {
  /** Fresh single-use challenge plus a device signature bound to it. */
  authorize(board: string): Promise<AuthMaterial>;
};

export type BufferClientOptions = {
  baseUrl: string;
  fetcher?: (input: string, init?: Record<string, unknown>) => Promise<Response>;
  authorizer: Authorizer;
  signal?: AbortSignal;
};

export type LeaderInfo = { epoch: number; expiresAt: number };

export class BufferClientError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string) {
    super(message ?? `buffer api: ${code} (${status})`);
    this.name = "BufferClientError";
  }
}

export type BufferClient = {
  transport(): BufferTransport;
  listOps(board: string): Promise<SealedOp[]>;
  commitOps(board: string, epoch: number, ids: string[]): Promise<number>;
  claim(board: string): Promise<LeaderInfo | null>;
  observe(board: string, epoch: number, driveEtag: string): Promise<void>;
  leaderCommit(board: string, epoch: number, snapshotSeq: number, driveEtag: string): Promise<{ stale: boolean }>;
};

export function createBufferClient(options: BufferClientOptions): BufferClient {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init as RequestInit));

  async function call(path: string, board: string, extra: Record<string, unknown>): Promise<Response> {
    const auth = await options.authorizer.authorize(board);
    const response = await fetcher(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board, ...auth, ...extra }),
      ...(options.signal ? { signal: options.signal } : {})
    });
    return response;
  }

  async function callJson<T>(path: string, board: string, extra: Record<string, unknown> = {}): Promise<T> {
    const response = await call(path, board, extra);
    if (!response.ok) {
      const code = (await response.json().catch(() => ({}))) as { code?: string };
      throw new BufferClientError(code.code ?? "unavailable", response.status);
    }
    return (await response.json()) as T;
  }
  return {
    transport() {
      return {
        async send(board, ops) {
          // The server's wire form is the sealed envelope without `v`
          // (deny_unknown_fields); `v` is a local format marker only.
          const response = await call("/buffer/ops", board, {
            ops: ops.map(({ opId, keyId, iv, ct }) => ({ opId, keyId, iv, ct }))
          });
          if (response.status === 429) throw new BufferBackpressureError(board);
          if (!response.ok) {
            const code = (await response.json().catch(() => ({}))) as { code?: string };
            throw new BufferClientError(code.code ?? "unavailable", response.status);
          }
        }
      };
    },
    async listOps(board) {
      const result = await callJson<{ ops: SealedOp[] }>("/buffer/list", board);
      return result.ops;
    },
    async commitOps(board, epoch, ids) {
      const result = await callJson<{ committed: number }>("/buffer/commit", board, { epoch, ids });
      return result.committed;
    },
    async claim(board) {
      try {
        return await callJson<LeaderInfo>("/leader/claim", board);
      } catch (error) {
        if (error instanceof BufferClientError && error.code === "lease_busy") return null;
        throw error;
      }
    },
    async observe(board, epoch, driveEtag) {
      await callJson<{ ok: boolean }>("/leader/observe", board, { epoch, driveEtag });
    },
    async leaderCommit(board, epoch, snapshotSeq, driveEtag) {
      return await callJson<{ stale: boolean }>("/leader/commit", board, { epoch, snapshotSeq, driveEtag });
    }
  };
}

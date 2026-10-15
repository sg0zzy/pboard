import type { RxJsonSchema } from "rxdb";
import type { BoardItem, Project } from "../types";
import { MUTATION_PROVENANCE_FIELD } from "../collab/security/mutation";

const MUTATION_FIELD = MUTATION_PROVENANCE_FIELD;

export type ProjectRecord = Project & { orderKey: string; tailOrderKey?: string; _sec?: SecurityEnvelope };
export type CardRecord = Omit<BoardItem, "image" | "order"> & {
  orderKey: string;
  imageId?: string;
  imageMimeType?: string;
  imageWidth?: number;
  imageHeight?: number;
  deletedAt?: string;
  _sec?: SecurityEnvelope;
};
export type SettingRecord = { id: string; value: string };

/** Protocol-2 mutation provenance envelope (see collab/security/mutation.ts). */
export type SecurityEnvelope = {
  provenance: {
    boardId: string;
    collection: string;
    documentId: string;
    deleted: boolean;
    payloadHash: string;
    authorKeyId: string;
    epoch: number;
    operationId: string;
    sequence: number;
    parents: string[];
    issuedAt: number;
    authorizationExpiresAt: number;
  };
  signature: string;
};

/**
 * Protocol-2 mutation provenance carried on every replicated document. Populated
 * at the write origin and verified at every receive path before persistence (see
 * `collab/security/mutation.ts`). Optional: private (never-replicated) documents
 * carry none.
 */
export const securityFieldSchema = {
  type: "object",
  properties: {
    provenance: {
      type: "object",
      properties: {
        boardId: { type: "string", maxLength: 120 },
        collection: { type: "string", maxLength: 20 },
        documentId: { type: "string", maxLength: 100 },
        deleted: { type: "boolean" },
        payloadHash: { type: "string", maxLength: 64 },
        authorKeyId: { type: "string", maxLength: 60 },
        epoch: { type: "number" },
        operationId: { type: "string", maxLength: 100 },
        sequence: { type: "number" },
        parents: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 8 },
        issuedAt: { type: "number" },
        authorizationExpiresAt: { type: "number" }
      },
      required: ["boardId", "collection", "documentId", "deleted", "payloadHash", "authorKeyId", "epoch", "operationId", "sequence", "parents", "issuedAt", "authorizationExpiresAt"]
    },
    signature: { type: "string", maxLength: 120 }
  },
  required: ["provenance", "signature"]
} as const;

const sourceProperties = {
  provider: { type: "string" },
  conversationUrl: { type: "string" },
  sourceText: { type: "string" }
} as const;

const securitySchemaProperty = () => securityFieldSchema as never;

export const projectSchema: RxJsonSchema<ProjectRecord> = {
  title: "pboard project", version: 1, primaryKey: "id", type: "object",
  properties: {
    id: { type: "string", maxLength: 100 }, name: { type: "string" },
    template: { type: "string" }, revision: { type: "number" },
    createdAt: { type: "string" }, updatedAt: { type: "string" },
    orderKey: { type: "string", maxLength: 100 },
    tailOrderKey: { type: "string", maxLength: 100 },
    [MUTATION_FIELD]: securitySchemaProperty()
  },
  required: ["id", "name", "template", "revision", "createdAt", "updatedAt", "orderKey"],
  indexes: ["orderKey"]
};

export const cardSchema: RxJsonSchema<CardRecord> = {
  title: "pboard card", version: 1, primaryKey: "id", type: "object",
  properties: {
    id: { type: "string", maxLength: 100 }, projectId: { type: "string", maxLength: 100 },
    type: { type: "string" }, title: { type: "string" }, content: { type: "string" },
    status: { type: "string", maxLength: 100 }, displayMode: { type: "string" },
    orderKey: { type: "string", maxLength: 100 },
    source: { type: "object", properties: sourceProperties, additionalProperties: true },
    imageId: { type: "string" }, imageMimeType: { type: "string" },
    imageWidth: { type: "number" }, imageHeight: { type: "number" },
    createdAt: { type: "string" }, updatedAt: { type: "string" }, deletedAt: { type: "string" },
    [MUTATION_FIELD]: securitySchemaProperty()
  },
  required: ["id", "projectId", "type", "content", "status", "orderKey", "createdAt", "updatedAt"],
  indexes: ["projectId", ["projectId", "orderKey"], ["projectId", "status"]]
};

export const settingSchema: RxJsonSchema<SettingRecord> = {
  title: "pboard local setting", version: 0, primaryKey: "id", type: "object",
  properties: { id: { type: "string", maxLength: 100 }, value: { type: "string" } },
  required: ["id", "value"]
};

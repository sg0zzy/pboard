import type { RxJsonSchema } from "rxdb";
import type { BoardItem, Project } from "../types";

export type ProjectRecord = Project & { orderKey: string; tailOrderKey?: string };
export type CardRecord = Omit<BoardItem, "image" | "order"> & {
  orderKey: string;
  imageId?: string;
  imageMimeType?: string;
  imageWidth?: number;
  imageHeight?: number;
  deletedAt?: string;
};
export type SettingRecord = { id: string; value: string };

const sourceProperties = {
  provider: { type: "string" },
  conversationUrl: { type: "string" },
  sourceText: { type: "string" }
} as const;

export const projectSchema: RxJsonSchema<ProjectRecord> = {
  title: "pboard project", version: 0, primaryKey: "id", type: "object",
  properties: {
    id: { type: "string", maxLength: 100 }, name: { type: "string" },
    template: { type: "string" }, revision: { type: "number" },
    createdAt: { type: "string" }, updatedAt: { type: "string" },
    orderKey: { type: "string", maxLength: 100 },
    tailOrderKey: { type: "string", maxLength: 100 }
  },
  required: ["id", "name", "template", "revision", "createdAt", "updatedAt", "orderKey"],
  indexes: ["orderKey"]
};

export const cardSchema: RxJsonSchema<CardRecord> = {
  title: "pboard card", version: 0, primaryKey: "id", type: "object",
  properties: {
    id: { type: "string", maxLength: 100 }, projectId: { type: "string", maxLength: 100 },
    type: { type: "string" }, title: { type: "string" }, content: { type: "string" },
    status: { type: "string", maxLength: 100 }, displayMode: { type: "string" },
    orderKey: { type: "string", maxLength: 100 },
    source: { type: "object", properties: sourceProperties, additionalProperties: true },
    imageId: { type: "string" }, imageMimeType: { type: "string" },
    imageWidth: { type: "number" }, imageHeight: { type: "number" },
    createdAt: { type: "string" }, updatedAt: { type: "string" }, deletedAt: { type: "string" }
  },
  required: ["id", "projectId", "type", "content", "status", "orderKey", "createdAt", "updatedAt"],
  indexes: ["projectId", ["projectId", "orderKey"], ["projectId", "status"]]
};

export const settingSchema: RxJsonSchema<SettingRecord> = {
  title: "pboard local setting", version: 0, primaryKey: "id", type: "object",
  properties: { id: { type: "string", maxLength: 100 }, value: { type: "string" } },
  required: ["id", "value"]
};

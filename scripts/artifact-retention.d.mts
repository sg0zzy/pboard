export const ARTIFACTS_DIR: string;
export const RETENTION_DEFAULT: 10;
export const MANAGER: string;
export type Build = { schema: number; manager: string; buildId: string; version: string; state: string; completionSequence?: number; completedAt?: string; targets: Array<{ id: string; required: boolean; outcome: string }>; outputs: Array<{ filename: string; sha256: string; bytes: number }> };
export function createBuild(manifest: Record<string, unknown>, root?: string): string;
export function updateBuild(dir: string, update: Record<string, unknown>, success?: boolean): Build;
export function readManaged(dir: string): { manifest: Build; dev: number; ino: number } | null;
export function safeRoot(root: string, create?: boolean): string;
export function withArtifactLock<T>(root: string, operation: (root: string) => T): T;
export function protectBuild(id: string, root?: string): void;
export function inspectBuilds(root?: string): Array<{ path: string; reason: string; eligible: boolean; protected: boolean }>;
export function retentionCandidates(root?: string): Array<{ path: string; utcTime: string; buildId: string }>;
export function buildsToDelete(candidates: ReturnType<typeof retentionCandidates>, keep: number): string[];
export function runRetention(keep?: number, root?: string): string[];

export function removeBuild(id: string, confirmation?: string, root?: string): Record<string, unknown>;

import type { GoogleAuthProvider } from "./googleAuth";
import { DRIVE_TRANSIENT_ATTEMPTS, DRIVE_TRANSIENT_STATUSES, driveRetryDelayMs, isDriveReplayableMethod } from "./driveRetry";
import { defaultDriveQuotaThrottle, driveQuotaError, driveRequestCost, isDriveQuotaFailure, type DriveQuotaThrottle } from "./driveQuota";
import { driveBoundedRetryDelayMs } from "./driveRetry";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export type DriveAppDataFile = {
  id: string;
  name: string;
  modifiedTime?: string;
};

export interface DriveTransport {
  listProjectFiles(): Promise<DriveAppDataFile[]>;
  findProjectFile(projectId: string): Promise<DriveAppDataFile | null>;
  download(fileId: string): Promise<string>;
  upload(projectId: string, contents: string, fileId?: string): Promise<DriveAppDataFile>;
  delete(fileId: string): Promise<void>;
}

type GoogleDriveErrorResponse = {
  error?: {
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string }>;
  };
};

const escapeDriveQuery = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export function createDriveTransport(auth: GoogleAuthProvider, fetcher: typeof fetch = fetch, filePrefix = "project-", regularParent?: () => Promise<string>, quota: DriveQuotaThrottle = defaultDriveQuotaThrottle()): DriveTransport {
  const projectFileName = (projectId: string) => `${filePrefix}${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}.pboard`;
  async function errorDetail(response: Response): Promise<string> {
    try {
      const body = await response.json() as GoogleDriveErrorResponse;
      const reason = body.error?.errors?.find((entry) => entry.reason)?.reason;
      return [reason, body.error?.status, body.error?.message].filter(Boolean).join(": ");
    } catch {
      // Some intermediary failures return a non-JSON response.
      return "";
    }
  }

  async function requestError(response: Response): Promise<Error> {
    const detail = await errorDetail(response);
    // Quota denial stays distinguishable from permission denial.
    if (isDriveQuotaFailure(detail)) return driveQuotaError(response.status, detail, quota);
    return new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  async function authorizedFetch(input: string, init: RequestInit = {}, retry = true, attempt = 0, spentMs = 0): Promise<Response> {
    const token = await auth.getAccessToken(!retry);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const cost = driveRequestCost(input);
    // Respect projected budget deferrals and real Google quota cooldowns.
    await quota.acquire(cost, init.signal);
    // Account signaling/preferences and snapshots must observe writes made
    // by another browser, including when the URL is unchanged between polls.
    const response = await fetcher(input, { ...init, headers,
      ...(!init.method || init.method === "GET" ? { cache: "no-store" as const } : {}) });
    quota.observe(cost, response.headers);
    if (response.status === 401 && retry) return authorizedFetch(input, init, false, attempt, spentMs);
    if (response.status === 429 && isDriveQuotaFailure(await errorDetail(response.clone()))) throw await requestError(response);
    // A transient Google-side failure (internalError, rate limit) usually
    // clears on a replay; only one-shot methods are replayed. A quota denial is
    // not replayed blindly.
    if (!response.ok && DRIVE_TRANSIENT_STATUSES[response.status] && attempt + 1 < DRIVE_TRANSIENT_ATTEMPTS &&
        isDriveReplayableMethod(init.method)) {
      const delay = driveBoundedRetryDelayMs(attempt, response.headers.get("Retry-After"), spentMs, await errorDetail(response));
      await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
      return authorizedFetch(input, init, retry, attempt + 1, spentMs + delay);
    }
    if (!response.ok) throw await requestError(response);
    return response;
  }

  async function findProjectFile(projectId: string): Promise<DriveAppDataFile | null> {
    const name = projectFileName(projectId);
    const params = new URLSearchParams({
      spaces: regularParent ? "drive" : "appDataFolder",
      q: `name = '${escapeDriveQuery(name)}' and trashed = false${regularParent ? ` and '${escapeDriveQuery(await regularParent())}' in parents` : ''}`,
      fields: "files(id,name,modifiedTime)",
      pageSize: "2"
    });
    const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
    const body = await response.json() as { files?: DriveAppDataFile[] };
    return body.files?.[0] ?? null;
  }

  async function listProjectFiles(): Promise<DriveAppDataFile[]> {
    const files: DriveAppDataFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: regularParent ? "drive" : "appDataFolder",
        q: `name contains '${escapeDriveQuery(filePrefix)}' and trashed = false${regularParent ? ` and '${escapeDriveQuery(await regularParent())}' in parents` : ''}`,
        fields: "nextPageToken,files(id,name,modifiedTime)",
        pageSize: "100"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
      const body = await response.json() as { files?: DriveAppDataFile[]; nextPageToken?: string };
      files.push(...(body.files ?? []).filter(file => file.name.startsWith(filePrefix)));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async function download(fileId: string): Promise<string> {
    const response = await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return response.text();
  }

  async function upload(projectId: string, contents: string, fileId?: string): Promise<DriveAppDataFile> {
    if (fileId) {
      const response = await authorizedFetch(
        `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: contents }
      );
      return await response.json() as DriveAppDataFile;
    }

    const boundary = `pboard_${crypto.randomUUID().replaceAll("-", "")}`;
    const metadata = JSON.stringify({
      name: projectFileName(projectId),
      parents: [regularParent ? await regularParent() : "appDataFolder"],
      mimeType: "application/json"
    });
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      metadata,
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      contents,
      `--${boundary}--`,
      ""
    ].join("\r\n");
    const response = await authorizedFetch(
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime`,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body
      }
    );
    return await response.json() as DriveAppDataFile;
  }

  async function deleteFile(fileId: string): Promise<void> {
    try {
      await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) return;
      throw error;
    }
  }

  return { listProjectFiles, findProjectFile, download, upload, delete: deleteFile };
}

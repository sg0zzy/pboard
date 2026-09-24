import type { GoogleAuthProvider } from "./googleAuth";

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

const projectFileName = (projectId: string) => `project-${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}.pboard`;
const escapeDriveQuery = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export function createDriveTransport(auth: GoogleAuthProvider, fetcher: typeof fetch = fetch): DriveTransport {
  async function requestError(response: Response): Promise<Error> {
    let detail = "";
    try {
      const body = await response.json() as GoogleDriveErrorResponse;
      const reason = body.error?.errors?.find((entry) => entry.reason)?.reason;
      detail = [reason, body.error?.status, body.error?.message].filter(Boolean).join(": ");
    } catch {
      // Some intermediary failures return a non-JSON response.
    }
    return new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  async function authorizedFetch(input: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await auth.getAccessToken(!retry);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetcher(input, { ...init, headers });
    if (response.status === 401 && retry) return authorizedFetch(input, init, false);
    if (!response.ok) throw await requestError(response);
    return response;
  }

  async function findProjectFile(projectId: string): Promise<DriveAppDataFile | null> {
    const name = projectFileName(projectId);
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name = '${escapeDriveQuery(name)}' and trashed = false`,
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
        spaces: "appDataFolder",
        q: "name contains 'project-' and trashed = false",
        fields: "nextPageToken,files(id,name,modifiedTime)",
        pageSize: "100"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
      const body = await response.json() as { files?: DriveAppDataFile[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
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
      parents: ["appDataFolder"],
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

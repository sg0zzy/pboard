export type CapturePermissionApi = {
  sidePanel?: unknown;
  permissions?: {
    request(details: { origins: string[] }): Promise<boolean>;
  };
};

/** Chromium side-panel clicks do not grant activeTab, so capture needs optional access. */
export async function requestPageCaptureAccess(api: CapturePermissionApi): Promise<boolean> {
  if (!api.sidePanel || !api.permissions?.request) return true;
  return api.permissions.request({ origins: ["<all_urls>"] });
}

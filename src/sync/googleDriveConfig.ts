export type GoogleDriveBrowser = "chromium" | "firefox";
export type GoogleDriveStage = "dev" | "production";

/**
 * Google Drive OAuth client IDs, versioned per browser and per build stage.
 *
 * These are public OAuth client identifiers. Paste the real IDs created in
 * your Google Cloud project below. If Google's Firefox Desktop client requires
 * its client secret, provide it at build time through
 * VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET; never put it in this source file.
 *
 * Resolution (src/sync/browser.ts):
 *   - browser: `firefox` for `moz-extension://` origins, `chromium` otherwise.
 *   - stage:   `dev` under `npm run dev`, `production` under `npm run build` /
 *              `npm run build:chromium`.
 */
export const googleDriveConfig: Record<
  GoogleDriveBrowser,
  { dev: string; production: string }
> = {
  chromium: {
    dev: "337977813621-fng9g7fu9jelmjcunq2mth8p1kt78u1u.apps.googleusercontent.com",
    production: "337977813621-fng9g7fu9jelmjcunq2mth8p1kt78u1u.apps.googleusercontent.com",
  },
  firefox: {
    dev: "337977813621-qnh1m6i7osqq6s7disek6fv4095itm1n.apps.googleusercontent.com",
    production: "337977813621-qnh1m6i7osqq6s7disek6fv4095itm1n.apps.googleusercontent.com",
  },
};

# Google Drive setup for Android

Use the **same Google Cloud project as Firefox**, and add a separate OAuth client of type **Android**. Do not create a second Cloud project: the private Drive app-data folder is scoped to the application/project, so a separate project would not see the Firefox backups. Google's [cross-client identity guide](https://developers.google.com/identity/protocols/oauth2/cross-client-identity) describes grouping clients for the same application in one project.

## Google Cloud fields

1. Open the existing project in [Google Cloud Console](https://console.cloud.google.com/).
2. Ensure **Google Drive API** is enabled under APIs & Services → Library.
3. Under **Google Auth Platform → Clients → Create client**, select **Android**.
4. Enter these values:

   | Field | Value |
   | --- | --- |
   | Name | pboard Android debug (any descriptive name) |
   | Package name | `it.stefanogozzi.pboard` |
   | SHA-1 certificate fingerprint | The SHA-1 printed for the `app` debug variant below |

   This machine's current debug certificate SHA-1 is **`BA:2D:83:08:85:A9:5D:EA:DA:29:A7:5F:3D:FC:AE:0B:1D:B4:14:04`**. A different development machine or a regenerated keystore may have a different value.

5. Use the project's existing branding/consent configuration. Under **Data Access**, include the scopes already requested by the extension: `https://www.googleapis.com/auth/drive.appdata` and `https://www.googleapis.com/auth/drive`. Full Drive access supports discovery of incoming shared boards. If the consent app is in testing, add each test Google account under **Audience → Test users**; production publication/verification follows the same Cloud consent requirements as the extension.
6. Before distributing a release build, add a separate Android client for the release signing certificate (or Play App Signing certificate), using the same package name and Cloud project. Debug and release signing fingerprints differ.

Google's [Android authorization guide](https://developer.android.com/identity/authorization) documents the Android package/SHA-1 registration and `AuthorizationClient` API used here.

## Google Identity and relay configuration

Android uses Credential Manager for a Google OpenID Connect ID token and the native Google authorization API for a Drive access token. Create a **Web application** OAuth client in the same Google Cloud project. Its public client ID is the Credential Manager server client ID. Configure the relay's `PBOARD_SIGNALING_GOOGLE_AUDIENCES` to include that exact web client ID; configuring the APK alone does not change the relay. The relay validates the Google identity and matches it to the Drive access token before checking the board folder permissions. An Android package/SHA-1 OAuth client is still required for Drive authorization. A client secret is not embedded in Android.

The project's public Web client ID is configured in `src/sync/googleDriveConfig.ts` and embedded in the APK. To build against another Google Cloud project, override it with `VITE_PBOARD_GOOGLE_WEB_CLIENT_ID` and configure the relay to accept that audience. A client ID is not a secret. The existing Firefox desktop/extension client is not automatically a Web application client.

The selected Google identity must match the account used for Drive. Connect from Settings and select that same account in Google sign-in. On resume the app attempts to renew identity without prompting; if Google cannot silently return a credential, reconnect from Settings. No device manifest or online owner is needed for v3 admission.

## Build and Pixel 8a test

```bash
npm run apk:debug
```

The command prints the debug APK path. Register its actual debug signing SHA-1 with the Android OAuth client and install it on a Pixel 8a (Android 13 or newer) with `adb install -r <apk>`. Installing over an existing app requires the same signing certificate.

With the app open, connect Drive with the same account as Firefox. Create a board in Firefox, wait for Android discovery, open it, create a card in Firefox and check that it arrives on Android. Edit it on Android and check Firefox. Background Android, edit the card in Firefox, then foreground Android and check it catches up. Repeat while offline, after process termination, and with another Google account granted editor access to the board folder; verify a non-member is denied and a removed editor loses access after renewal. Confirm local pending edits survive the offline and restart cases.

The shared v3 operation log multiplexes board and account rooms on one WebSocket. Backgrounding closes the live rooms and stops the Android polling timers; no foreground service is used. On foreground the app reconnects, resumes persisted cursors, reconciles Drive and sends pending operations. Drive snapshots are the recovery source if relay history is unavailable. Actual device and cross-account verification is still required for this integration.

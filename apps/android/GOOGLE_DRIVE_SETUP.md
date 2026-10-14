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

## Where to put variables

**There are no Android OAuth environment variables to set.** The native Google authorization request uses the installed package name and signing certificate to select the Android OAuth client registered in Google Cloud. Keep the returned client ID in Cloud Console for reference; this integration does not pass it to the SDK.

- No Android client secret or web/server client ID is needed: there is no backend token exchange or offline server access.
- No redirect URI is used; authorization opens the native Google account/consent UI.
- No `google-services.json` or Firebase setup is needed.
- Keep Firefox's existing configuration in the repository-root `.env.local` according to `.env.example`. Do not replace its Firefox client ID/secret with Android credentials.
- WebRTC uses the existing Drive signaling implementation and browser/WebView data channels. No separate signaling URL or API key is required.

Only connection metadata, account email and sync state persist locally. Access tokens stay in memory and the Google Identity Services token cache; the app does not persist refresh tokens or secrets. Disconnect clears the local connection/token cache and keeps the account pinned, avoiding accidental merging with another account on reconnect. Account switching is not currently exposed.

## Get the signing fingerprint and build

From `apps/android` (with JDK 21 and Android SDK configured):

```bash
cd android
./gradlew :app:signingReport
cd ..
npm run android:debug
```

Register the `SHA1` from `Variant: debug`, then install `android/app/build/outputs/apk/debug/app-debug.apk` using `adb install -r` on the chosen test device. Ordinary updates preserve existing local boards and photos.

## Verify the integration

1. Open Settings → Google Drive → Connect Google Drive. Choose the same account as Firefox and grant both permissions. Cancellation leaves local data unchanged.
2. Tap Sync now. A private board created in Firefox should appear on Android, including its photo. Edit it on Android and sync; reconcile in Firefox to verify the update.
3. Open a shared board on both devices. Invite a second test account as Editor (or use an existing browser invitation). With the board open on both devices, verify the peer count becomes nonzero and text/status changes propagate through WebRTC.
4. Repeat as Viewer: editing controls should be disabled; changing permissions and waiting for the next role refresh should update access.
5. Background/resume the Android app, interrupt/restore network access, then disconnect/reconnect. Confirm saved local content survives and sync errors can be retried.

Both peers need to be open for live replication. Networks that require a TURN relay have the same connectivity limitations as the extension. Shared Drive backup handling uses the existing policy: missing boards are bootstrapped from Drive, while newer text on an existing shared board merges through a live peer. This change does not add headless background sync or a TURN service.

If Google reports a developer/configuration error, check the project, exact package, signing SHA-1, enabled Drive API and test-user list. An Android debug build must match its debug key; a release/Play build must match its actual distribution key. Reconnect in Settings if authorization expires or permissions are removed.

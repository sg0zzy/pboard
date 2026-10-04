import type { GoogleAuthProvider, GoogleConnectionState } from "./googleAuth";
import { DRIVE_SCOPE } from "./googleAuth";

const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

type ChromeTokenResult = string | { token?: string; grantedScopes?: string[] } | undefined;
const scopes = DRIVE_SCOPE.split(" ");

export interface ChromiumIdentityApi {
  getAuthToken(details: { interactive: boolean; scopes?: string[] }): Promise<ChromeTokenResult>;
  removeCachedAuthToken(details: { token: string }): Promise<void>;
}

type Options = {
  clientId: string;
  identity: ChromiumIdentityApi;
  fetch?: typeof fetch;
};

function tokenFrom(result: ChromeTokenResult): string | undefined {
  return typeof result === "string" ? result : result?.token;
}

export function createChromiumGoogleAuthProvider(options: Options): GoogleAuthProvider {
  const fetcher = options.fetch ?? fetch;
  let currentToken: string | undefined;

  function isConfigured() {
    return Boolean(options.clientId.trim());
  }

  async function requestToken(interactive: boolean): Promise<string> {
    if (!isConfigured()) throw new Error("Google Drive OAuth client ID is not configured");
    const result = await options.identity.getAuthToken({ interactive, scopes });
    const token = tokenFrom(result);
    if (!token) throw new Error(interactive
      ? "Google Drive authorization was cancelled"
      : "Reconnect Google Drive to continue syncing");
    if (result && typeof result === "object" && result.grantedScopes && !scopes.every((scope) => result.grantedScopes!.includes(scope))) {
      currentToken = undefined;
      await options.identity.removeCachedAuthToken({ token });
      throw new Error("Reconnect Google Drive and allow both private sync and project sharing access");
    }
    currentToken = token;
    return token;
  }

  async function connect(): Promise<void> {
    await requestToken(true);
  }

  async function getAccessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) {
      const staleToken = currentToken ?? tokenFrom(await options.identity.getAuthToken({ interactive: false }));
      if (staleToken) await options.identity.removeCachedAuthToken({ token: staleToken });
      currentToken = undefined;
    }
    return currentToken ?? requestToken(false);
  }

  async function disconnect(): Promise<void> {
    let token = currentToken;
    if (!token) {
      try {
        token = tokenFrom(await options.identity.getAuthToken({ interactive: false }));
      } catch {
        // A missing cached token already means the extension is disconnected.
      }
    }
    currentToken = undefined;
    if (!token) return;
    await options.identity.removeCachedAuthToken({ token });
    try {
      await fetcher(REVOCATION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token })
      });
    } catch {
      // Removing Chrome's cached token is sufficient for a local disconnect.
    }
  }

  async function getConnectionState(): Promise<GoogleConnectionState> {
    if (!isConfigured()) return "disconnected";
    if (currentToken) return "connected";
    try {
      await requestToken(false);
      return "connected";
    } catch {
      return "disconnected";
    }
  }

  return { connect, disconnect, getConnectionState, getAccessToken, isConfigured };
}

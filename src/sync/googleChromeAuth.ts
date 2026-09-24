import type { GoogleAuthProvider, GoogleConnectionState } from "./googleAuth";

const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

type ChromeTokenResult = string | { token?: string } | undefined;

export interface ChromiumIdentityApi {
  getAuthToken(details: { interactive: boolean }): Promise<ChromeTokenResult>;
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
    const token = tokenFrom(await options.identity.getAuthToken({ interactive }));
    if (!token) throw new Error(interactive
      ? "Google Drive authorization was cancelled"
      : "Reconnect Google Drive to continue syncing");
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
      currentToken = tokenFrom(await options.identity.getAuthToken({ interactive: false }));
      return currentToken ? "connected" : "disconnected";
    } catch {
      return "disconnected";
    }
  }

  return { connect, disconnect, getConnectionState, getAccessToken, isConfigured };
}

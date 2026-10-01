import type { KeyValueStorage } from "../storage/repository";
import { DRIVE_AUTH_STORAGE_KEY } from "./state";

/**
 * Both scopes are requested together:
 *  - `drive.appdata` — the private per-user sync path (app-data folder), unchanged.
 *  - `drive.file` — required to create **visible** shared files and manage their
 *    permissions (the collaboration ACL).
 * `drive.appdata` alone cannot create or share visible files, and `drive.file` alone
 * cannot reach the app-data folder, so both must be granted.
 */
export const DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/drive.file"
].join(" ");
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

type StoredGoogleAuth = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

type GoogleOAuthErrorResponse = {
  error?: string;
  error_description?: string;
};

class GoogleOAuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export type GoogleConnectionState = "disconnected" | "connected";

export interface ExtensionIdentityApi {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
}

export interface GoogleAuthProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionState(): Promise<GoogleConnectionState>;
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  isConfigured(): boolean;
}

type Options = {
  clientId: string;
  clientSecret?: string;
  identity: ExtensionIdentityApi;
  storage: KeyValueStorage;
  fetch?: typeof fetch;
  now?: () => number;
  redirectUri?: () => string;
};

function base64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = base64Url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Google Drive authorization failed";
}

export function createGoogleAuthProvider(options: Options): GoogleAuthProvider {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let refreshPromise: Promise<string> | null = null;

  async function load(): Promise<StoredGoogleAuth> {
    const result = await options.storage.get(DRIVE_AUTH_STORAGE_KEY);
    const saved = result[DRIVE_AUTH_STORAGE_KEY];
    return saved && typeof saved === "object" ? saved as StoredGoogleAuth : {};
  }

  async function store(value: StoredGoogleAuth | null): Promise<void> {
    await options.storage.set({ [DRIVE_AUTH_STORAGE_KEY]: value });
  }

  function isConfigured() {
    return Boolean(options.clientId.trim());
  }

  async function exchange(params: URLSearchParams): Promise<TokenResponse> {
    const clientSecret = options.clientSecret?.trim();
    if (clientSecret) params.set("client_secret", clientSecret);
    const response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });
    if (!response.ok) {
      let detail = "";
      let code: string | undefined;
      try {
        const body = await response.json() as GoogleOAuthErrorResponse;
        code = body.error;
        detail = [body.error, body.error_description].filter(Boolean).join(": ");
      } catch {
        // Some intermediary failures return a non-JSON response.
      }
      throw new GoogleOAuthError(`Google authorization failed (${response.status})${detail ? `: ${detail}` : ""}`, code);
    }
    return await response.json() as TokenResponse;
  }

  async function connect(): Promise<void> {
    if (!isConfigured()) throw new Error("Google Drive OAuth client ID is not configured");
    const redirectUri = options.redirectUri?.() ?? options.identity.getRedirectURL("google-drive");
    const { verifier, challenge } = await createPkce();
    const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "select_account",
      state
    }).toString();

    const finalUrl = await options.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    if (!finalUrl) throw new Error("Google Drive authorization was cancelled");
    const result = new URL(finalUrl);
    if (result.searchParams.get("state") !== state) throw new Error("Google Drive authorization state did not match");
    const oauthError = result.searchParams.get("error");
    if (oauthError) throw new Error(`Google Drive authorization failed: ${oauthError}`);
    const code = result.searchParams.get("code");
    if (!code) throw new Error("Google Drive authorization returned no code");

    const existing = await load();
    const token = await exchange(new URLSearchParams({
      client_id: options.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }));
    await store({
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? existing.refreshToken,
      expiresAt: now() + token.expires_in * 1000
    });
  }

  async function refresh(auth: StoredGoogleAuth): Promise<string> {
    if (!auth.refreshToken) throw new Error("Reconnect Google Drive to continue syncing");
    let token: TokenResponse;
    try {
      token = await exchange(new URLSearchParams({
        client_id: options.clientId,
        refresh_token: auth.refreshToken,
        grant_type: "refresh_token"
      }));
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code === "invalid_grant") await store(null);
      throw error;
    }
    await store({
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? auth.refreshToken,
      expiresAt: now() + token.expires_in * 1000
    });
    return token.access_token;
  }

  async function getAccessToken(forceRefresh = false): Promise<string> {
    if (!isConfigured()) throw new Error("Google Drive OAuth client ID is not configured");
    const auth = await load();
    if (!forceRefresh && auth.accessToken && (auth.expiresAt ?? 0) > now() + 60_000) return auth.accessToken;
    refreshPromise ??= refresh(auth).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function disconnect(): Promise<void> {
    const auth = await load();
    const token = auth.refreshToken ?? auth.accessToken;
    await store(null);
    if (!token) return;
    try {
      await fetcher(REVOCATION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token })
      });
    } catch {
      // Local disconnect succeeds even if Google's revocation endpoint is offline.
    }
  }

  async function getConnectionState(): Promise<GoogleConnectionState> {
    if (!isConfigured()) return "disconnected";
    const auth = await load();
    return auth.refreshToken || (auth.accessToken && (auth.expiresAt ?? 0) > now()) ? "connected" : "disconnected";
  }

  return { connect, disconnect, getConnectionState, getAccessToken, isConfigured };
}

export const describeGoogleAuthError = errorMessage;

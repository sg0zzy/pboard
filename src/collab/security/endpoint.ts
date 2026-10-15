/**
 * Network endpoint policy (protocol 2).
 *
 * Production content transports are HTTPS for fetches and WSS for WebSockets;
 * WebRTC data channels always run on the browser's DTLS transport. The only
 * exception is an explicit loopback development mode, which must:
 *  - never be enabled by received board or signaling data,
 *  - be visible (tagged) in the wiring, and
 *  - be compiled out of release builds via the explicit flag below.
 */

export type EndpointException = {
  /** Explicit development override; never influenced by remote data. */
  loopbackDevMode: boolean;
};

/** Development-only escape hatch; wired from build/runtime flags, never remote input. */
export const endpointException: EndpointException = { loopbackDevMode: false };

export function enableLoopbackDevMode(): void {
  endpointException.loopbackDevMode = true;
}

export function endpointExceptionEnabled(): boolean {
  return endpointException.loopbackDevMode && isDevelopmentBuild();
}

/** Vite defines `import.meta.env.DEV` in extension builds; tests exercise the flag directly. */
function isDevelopmentBuild(): boolean {
  return import.meta.env?.DEV ?? false;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export type EndpointCheck = "ok" | "insecure";

export type EndpointValidation =
  | { check: "ok"; url: URL }
  | { check: "insecure"; reason: string };

/**
 * Validates a network content endpoint. Call with the exact URL a transport is
 * about to open. Restrict to https:/wss: at production, http:/ws: only for
 * explicit loopback development endpoints.
 */
export function validateEndpoint(rawUrl: string, protocol: "fetch" | "websocket"): EndpointValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { check: "insecure", reason: "Endpoint is not a valid URL" };
  }
  const secureProtocol = protocol === "fetch" ? "https:" : "wss:";
  if (url.protocol === secureProtocol) return { check: "ok", url };
  const plaintextProtocol = protocol === "fetch" ? "http:" : "ws:";
  if (url.protocol === plaintextProtocol && isLoopbackHost(url.hostname) && endpointExceptionEnabled()) {
    return { check: "ok", url };
  }
  return {
    check: "insecure",
    reason: `Refusing non-${secureProtocol}//${url.protocol}//${protocol} endpoint (${url.host})${isLoopbackHost(url.hostname) ? "" : "; loopback development mode is disabled"}`
  };
}

/** Same check for WebSockets, spelled out at call sites for readability. */
export function validateWebSocketEndpoint(rawUrl: string): EndpointValidation {
  return validateEndpoint(rawUrl, "websocket");
}

/** Google API origins that Drive transports may contact. */
const GOOGLE_API_ORIGINS = new Set([
  "https://www.googleapis.com",
  "https://oauth2.googleapis.com",
  "https://accounts.google.com",
  "https://drive.google.com"
]);

/** Restricts Google transports to their intended API origins. */
export function validateGoogleEndpoint(rawUrl: string): EndpointValidation {
  const https = validateEndpoint(rawUrl, "fetch");
  if (https.check === "insecure") return https;
  if (!GOOGLE_API_ORIGINS.has(https.url.origin)) {
    return { check: "insecure", reason: `Refusing unexpected Google endpoint origin: ${https.url.origin}` };
  }
  return https;
}
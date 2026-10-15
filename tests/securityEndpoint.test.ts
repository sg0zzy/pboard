import { describe, expect, it } from "vitest";
import { validateEndpoint, validateWebSocketEndpoint, validateGoogleEndpoint, enableLoopbackDevMode, endpointException } from "../src/collab/security/endpoint";

describe("endpoint policy", () => {
  it("accepts HTTPS and WSS endpoints", () => {
    expect(validateEndpoint("https://www.googleapis.com/drive/v3/files", "fetch").check).toBe("ok");
    expect(validateWebSocketEndpoint("wss://signaling.example/").check).toBe("ok");
  });

  it("rejects insecure endpoints in production mode", () => {
    expect(endpointException.loopbackDevMode).toBe(false);
    expect(validateEndpoint("http://www.googleapis.com/drive/v3/files", "fetch").check).toBe("insecure");
    expect(validateWebSocketEndpoint("ws://signaling.example:8080/").check).toBe("insecure");
    expect(validateWebSocketEndpoint("ws://localhost:8943/").check).toBe("insecure");
  });

  it("allows only explicit loopback development endpoints when dev mode is on", () => {
    enableLoopbackDevMode();
    try {
      expect(validateWebSocketEndpoint("ws://localhost:8943/").check).toBe("ok");
      expect(validateWebSocketEndpoint("ws://127.0.0.1:8943/").check).toBe("ok");
      expect(validateWebSocketEndpoint("ws://signaling.example:8080/").check).toBe("insecure");
      expect(validateEndpoint("http://localhost/x", "fetch").check).toBe("ok");
    } finally {
      endpointException.loopbackDevMode = false;
    }
    expect(validateWebSocketEndpoint("ws://localhost:8943/").check).toBe("insecure");
  });

  it("restricts Google transports to intended API origins", () => {
    expect(validateGoogleEndpoint("https://www.googleapis.com/drive/v3/files").check).toBe("ok");
    expect(validateGoogleEndpoint("https://oauth2.googleapis.com/token").check).toBe("ok");
    expect(validateGoogleEndpoint("https://evil.example/token").check).toBe("insecure");
    expect(validateGoogleEndpoint("http://www.googleapis.com/token").check).toBe("insecure");
  });

  it("rejects unparseable endpoints and wrong transport types", () => {
    expect(validateEndpoint("not a url", "fetch").check).toBe("insecure");
    expect(validateWebSocketEndpoint("https://example/").check).toBe("insecure");
  });
});
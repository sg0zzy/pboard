import { ensureDeviceKey } from "../../src/collab/security/keys";
import { createExperimentalWebSocketSignaling } from "../../src/collab/experimentalWebSocketSignaling";
const key = await ensureDeviceKey("websocket-experiment-browser-probe");
let provider: ReturnType<typeof createExperimentalWebSocketSignaling>;
const probe = {
  keyId: key.keyId, publicKey: key.publicJwk,
  peers: [] as string[], received: [] as unknown[], errors: [] as string[],
  async start(url: string) {
    provider = createExperimentalWebSocketSignaling({ topic: "browser-room", url, getKey: async () => key, loopbackDevelopment: true });
    provider.onError(error => probe.errors.push(String(error)));
    provider.onSignal((from, data) => probe.received.push({ from, data }));
    await provider.join(peers => { probe.peers = peers; });
  },
  async send(to: string, data: unknown) { await provider.sendSignal(to, data); },
  async stop() { await provider.leave(); }
};
Object.assign(window, { probe });

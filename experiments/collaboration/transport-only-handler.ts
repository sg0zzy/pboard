import { createPboardWebRTCConnectionHandler as createHandler } from "../../src/collab/webrtcHandler";
import type { PboardWebRTCConnectionOptions } from "../../src/collab/webrtcHandler";
import { createPboardWebRTCConnectionHandler as createFixture } from "../../tests/helpers/transportOnlyHandler";

// Selected only by the browser convergence harness's build resolver.
export const createPboardWebRTCConnectionHandler = (options: PboardWebRTCConnectionOptions) => createFixture(options, createHandler);

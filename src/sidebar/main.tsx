import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";
import { exposeDriveQuotaDiagnostics } from "../sync/driveQuota";
import { exposeCollaborationDiagnostics, roomSnapshots } from "../sync/realtimeDiagnostics";
import { collaborationManager } from "../sync/browser";
import { loadIceServers } from "../collab/security/ice";
import { browser } from "../platform/browser";

// The sidebar is a second JS context with its own Drive ledger; read it here as
// `pboardDriveQuota()` to tell a context that is idle from one that is looping.
exposeDriveQuotaDiagnostics();
// `await pboardCollaboration()` answers what the one status sentence cannot:
// whether the room sees no peers, peers it cannot verify, or peers it cannot
// reach — and which ICE endpoints it was given. Identities and outcomes only.
exposeCollaborationDiagnostics("sidebar", async () => ({
  ...(collaborationManager.state() as object),
  iceServers: (await loadIceServers(browser.storage.local)).map(server => ({ urls: typeof server.urls === "string" ? [server.urls] : [...(server.urls ?? [])] })),
  rooms: roomSnapshots(),
}));

// Keep the MV3 worker that owns the collaboration sockets alive while this
// window lives: Firefox otherwise terminates the idle worker in well under a
// minute, closing the relay lanes with it (observed as synchronized socket
// deaths and edits reaching other devices only after the next local event).
// The port is the whole protocol; disconnect means the worker went away and
// will redial when anything wakes it.
try {
  const connectKeepAlive = (): void => {
    const workerKeepAlive = browser.runtime.connect({ name: "pboard-worker-keepalive" });
    workerKeepAlive.onDisconnect.addListener(() => {
      // The worker went away (upgrade, crash, a termination before this port
      // existed). Re-form the port so the restarted worker stays up too.
      setTimeout(connectKeepAlive, 1_000);
    });
  };
  connectKeepAlive();
} catch { /* best-effort; sync still reconnects on activity */ }

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);

# Server-side observation (relay logs)

The Rust relay (`services/pboard-signaling`) logs structured `tracing` lines
to **stdout** (`tracing_subscriber::fmt()`):

```
2026-11-11T00:33:17.412101Z  INFO pboard_signaling: signaling session opened event="connect" session="C2BCtM70DWuv"
2026-11-11T00:33:17.990003Z  INFO pboard_signaling::board_grants: signed board authorization cached event="board_grant_published" epoch=2
```

`tools/pboard-debug/relayObserver.ts` turns each such line into a schema-v1
`relay.*` event on the bridge. The observer emits through the same debug bus
as any external producer (`clientId: "relay-observer"`), so server stages and
browser stages interleave in one timeline, ordered by the bridge's
`receivedAt`/`bridgeSeq`.

## Contract with `lib.rs` (whitelist)

`parseRelayLine` accepts only lines shaped
`<stamp> <LEVEL> <target>: <message>` whose `event=` field is one of:

| relay `event=` | mapped `relay.*` event | severity |
|---|---|---|
| `connect` | `connection.accepted` | info |
| `disconnect` | `connection.closed` | info |
| `authenticated` | `authentication.result` | info |
| `room_attached` / `room_detached` / `join` | `subscription.changed` | info/debug |
| `attach_refused` | `authorization.denied` | warn |
| `signal_forwarded` | `operation.forwarded` | debug |
| `transport_rejected` | `error` | error |

Unknown lines are counted (`consumed().unmapped`) and dropped: a relay that
changes its logging degrades to *partial observation with a visible count*,
never to silence or invented facts. `details` carry only whitelisted fields —
`session`, `room`, `peer`, `reason`, `code`, `role`, `version`, `count` plus
stamp/level; the message is truncated to 160 chars. Correlation to browser
traces goes by room (relay lines carry the relay's own `session` id, not
operation ids — see [limitations.md](limitations.md)).

## Feeding the observer

The observer takes an async iterable of text chunks. Local development wires
the spawned process directly (`firefox-e2e.mjs` tees stdout — where tracing
writes — and stderr too, so a future switch keeps observation intact):

```ts
import { observeRelayLogs, toLines } from "tools/pboard-debug/relayObserver.ts";
observeRelayLogs(toLines(chunksOf(stdout)));
```

For a relay managed by systemd, a journald tail feeds the same parser.
Bridge side: run it with `PBOARD_DEBUG_MODE=production-observer` (fault
injection is rejected by construction), bind loopback, and reach the machine
over a tunnel you control (`ssh -L 8790:127.0.0.1:8790 host`) — the bridge
itself must never listen beyond loopback:

```bash
journalctl -u pboard-signaling -f -o cat \
  | node --input-type=module -e '
import { observeRelayLogs, toLines } from "./tools/pboard-debug/relayObserver.ts";
import { configureDebugBus } from "./src/debug/bus.ts";
import { HttpBridgeTransport } from "./src/debug/bridgeTransport.ts";
configureDebugBus({
  enabled: true,
  identity: () => ({ clientId: "relay-observer", sessionId: process.env.RUN_ID ?? "journald", context: "node-journald" }),
  transport: () => new HttpBridgeTransport({ url: process.env.PBOARD_DEBUG_URL ?? "http://127.0.0.1:8790",
    ...(process.env.PBOARD_DEBUG_TOKEN ? { token: process.env.PBOARD_DEBUG_TOKEN } : {}),
    clientId: "relay-observer", sessionId: process.env.RUN_ID ?? "journald", context: "node-journald" }),
});
const dec = new TextDecoder();
observeRelayLogs(toLines((async function* () { for await (const c of process.stdin) yield dec.decode(c); })()));
'
```

## Operational rules

- **Production is observation-only.** The bridge modes gate this:
  `production-observer` (like `local`) refuses `POST /command`, so no fault,
  no disconnect, no test control against production clients — the server
  stage of a trace can only ever be read, never poked.
- **No secrets ride the logs.** The relay's own logging already names only
  sessions, rooms, codes and counts; the observer whitelist is a second
  enforcement of that. Relay logs, journald output and captures stay on the
  operator's machine.
- **Access to production is a separate authorization.** Observing production
  requires the applicable authorization under the repository's SECURITY policy
  (see the pinned standards in `DEVELOPMENT_STANDARDS.md`); nothing in this
  tooling grants or assumes it. The commands above are operator recipes, run
  when and where authorized.

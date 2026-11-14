# Live Debug Bridge

Versioned diagnostic events from the **real** Pboard runtime (browser
extension, Node harness, relay log observer) flow over loopback HTTP into a
local bridge, which a developer — or an AI coding agent speaking MCP — reads
live: event history, connection registry, per-operation traces, pull-model
state inspection, and exportable captures.

The bridge observes; it never participates. Diagnostics are **disabled by
default** in every build and every context; enabling them changes no
application behaviour. Fault injection exists only for the mock-mode test
harness and is rejected by the bridge in every other mode.

## Quickstart (development browser)

```bash
npm run debug:bridge          # loopback bridge on 127.0.0.1:8790
# load the built extension in Firefox with:
await browser.storage.local.set({ pboardDebugBridge: { enabled: true } })
# then reload the extension — the background and sidebar dials appear at:
npm run debug:status
open http://127.0.0.1:8790/ui   # dashboard
```

`scripts/build_all.sh` also stages a diagnostics build at `dist-debug/` (manifest name
`Pboard (debug channel)`) that has the channel compiled in and enabled by default
against the same loopback URL, so no storage switch is needed; load it with
`about:debugging` → Load Temporary Add-on → `dist-debug/manifest.json` in its own
profile (one temporary add-on per extension ID per profile). `npm run build:firefox-debug`
builds only that tree. It is developer-only; CI does not build it.

A `DEV` build (or a `VITE_PBOARD_DIAGNOSTICS=1` / `__PBOARD_DIAGNOSTICS__=true`
build) enables the channel automatically, pointing at the loopback default;
`{ enabled: false }` silences it. Production builds without the storage
setting enable nothing — `emit()` stays a boolean test. See
[firefox-debugging.md](firefox-debugging.md) for the full enablement policy
and the WebDriver E2E (`npm run debug:test:e2e`).

## Quickstart (MCP — OMP / Codex / Qwen)

The MCP server is a stdio bridge client; the agent gets 23 `pboard_debug_*`
tools ([reference](mcp-tools.md)). Example MCP config:

```json
{
  "mcpServers": {
    "pboard-debug": {
      "command": "npm",
      "args": ["run", "--silent", "debug:mcp"],
      "env": { "PBOARD_DEBUG_URL": "http://127.0.0.1:8790" }
    }
  }
}
```

Start `npm run debug:bridge` first, or set `PBOARD_DEBUG_AUTO_START=1` so the
MCP server spawns one locally. When the bridge requires a token, pass the same
`PBOARD_DEBUG_TOKEN` to both.

## npm scripts

| Script | What it runs |
|---|---|
| `debug:bridge` | the bridge (`tools/pboard-debug/server.ts`) |
| `debug:mcp` | the stdio MCP server (`tools/pboard-debug/mcp.ts`) |
| `debug:status` | operator CLI status read (`tools/pboard-debug/cli.ts`) |
| `debug:test` | bridge unit/integration/stress suites (vitest) |
| `debug:test:e2e` | two real Firefox profiles against a real relay (A–E) |
| `debug:harness` | mock-mode scenario runner (`tools/pboard-debug/harness.ts`) |

## Map of this directory

- [architecture.md](architecture.md) — components, dataflow, invariants
- [instrumentation.md](instrumentation.md) — every emit site in `src/`, how to add one
- [event-schema.md](event-schema.md) — schema v1: components, events, identity, limits, redaction
- [mcp-tools.md](mcp-tools.md) — the 23 tools and their bridge endpoints
- [firefox-debugging.md](firefox-debugging.md) — enabling the bridge; WebDriver E2E A–E
- [trace-format.md](trace-format.md) — capture files (`test-results/debug-traces/*.json`)
- [test-harness-integration.md](test-harness-integration.md) — scenarios, fault injection, failure captures
- [server-observation.md](server-observation.md) — relay log observer (local and journald)
- [security.md](security.md) — binding, token, CORS, modes, no-secrets rules
- [troubleshooting.md](troubleshooting.md) — symptom → cause → check
- [limitations.md](limitations.md) — what this cannot show you

## HTTP surface (contract summary)

`GET /status` · `GET /clients` · `GET /sessions` · `GET /connections` ·
`GET /connections/checks` → `{findings, counts}` · `GET /events` (filters are
JSON in the `filter=` parameter; `after=` is a dense `bridgeSeq` cursor;
`limit` is a newest-N tail window) · `GET /trace?traceId=|operationId=` ·
`GET /traces?limit=` · `GET /captures`, `GET /captures/:id` ·
`POST /capture/start|stop|export` · `POST /command` (mock mode only) ·
`POST /ingest` · `GET /inspect/request` + `POST /inspect/respond` (pull
model) · `GET /inspect/:clientId` · `GET /fault/poll` (mock harness poll) ·
`GET /events/subscribe` (WebSocket; control frames `subscribe`/`unsubscribe`/
`ping`). `/` answers a plain-text endpoint index; `/ui` serves the dashboard.
When `PBOARD_DEBUG_TOKEN` is set, every request must carry `?token=`.

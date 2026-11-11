# Security posture

The bridge reads a developer's live collaboration runtime — connections,
timings, ids. That is sensitive even when content is not, so the posture is
defense in depth: loopback binding, an optional shared token, strict CORS,
content-free events, and mode-gated control.

## Network

- Binds `127.0.0.1` by default (`BRIDGE_DEFAULT_HOST`). A non-loopback
  `PBOARD_DEBUG_HOST` is **refused** unless `PBOARD_DEBUG_ALLOW_REMOTE=1` is
  set explicitly, and refusal is loud. Nothing about the design changes when
  you do expose it: the token then stops being optional.
- The browser transport mirrors the rule: `isSafeBridgeEndpoint` accepts only
  loopback URLs (`http://127.0.0.1|localhost|[::1]`), so an enabled-but-
  misconfigured client cannot be pointed at a remote collector by accident.
- Responses carry `cache-control: no-store` and `x-content-type-options:
  nosniff`.

## Authentication

- `PBOARD_DEBUG_TOKEN`, when set, must appear as `?token=` on every request
  (HTTP and the `/events/subscribe` WebSocket upgrade). Missing/wrong → 401.
- The token rides a loopback request; that is the trade for keeping the
  extension's ingest a CORS-simple POST. On a shared machine treat the token
  like a local credential and don't expose the port.

## CORS / cross-origin

- Same-origin posture: requests with **no** `Origin` (curl, node, the MCP
  stdio process) are tooling; `Origin` values with a loopback host, or an
  extension-origin scheme (`moz-extension:`, `chrome-extension:` — the
  developer's own local install), are echoed back exactly once in
  `access-control-allow-origin`.
- **No wildcard is ever emitted.** A foreign `Origin` gets 403
  `cross-origin requests are not allowed`.
- `OPTIONS` is answered 405 with no CORS grant: preflighted requests are not
  our client; the SDK deliberately stays CORS-simple (text body, `token` in
  the query).

## Modes: observation vs control

| Mode | Ingest | Reads | Fault/`POST /command` |
|---|---|---|---|
| `mock` | yes | yes | yes (harness clients only) |
| `local` (default) | yes | yes | **403** |
| `production-observer` | yes | yes | **403** |

Control is therefore impossible against anything real: a running extension
can never be told to disconnect, drop, or inject. Fault injection exists only
inside the mock harness loop
([test-harness-integration.md](test-harness-integration.md)).

## Content rules (what must never appear)

Producer-side, before an event leaves the context:

- `details` carry ids, counts, state names, close codes — never document
  contents, card text, board names beyond the board *id*, Drive file
  contents, or user content.
- `REDACTED_KEY_PATTERN` redacts values under keys matching
  `token|secret|privatekey|wrapkey|credential|authorization|receipt|apikey|password|cookie|sdp|keymaterial`
  → `"[redacted]"`. This is a backstop; emit sites must not aim at those keys
  in the first place.
- Frame events project only `{type, action, room}`. Drive events project
  status, ids and retry metadata. Auth events carry versions and room names,
  never credentials — a bearer token or id_token is never even constructed
  into an event.
- Strings truncate at 480 chars, arrays at 24 entries, nesting at 4, events
  at 16 KiB — so an accidentally-large payload is truncated loudly rather
  than exported whole.

Identity fields themselves (`clientId`, `sessionId`, `boardId`, `userId`) are
dev-scope diagnostics; they may reveal *who/which device* on a shared machine,
which is why the bridge is loopback-only by default and captures live in the
gitignored `test-results/`.

## Captures and artefacts

- Exported captures go to `test-results/debug-traces/` (gitignored; the repo
  `.gitignore` entry `/test-results/` covers them). They are still sensitive:
  they contain ids, rooms, timing, and failure summaries. Never commit one;
  when including one in a report, prefer a minimal excerpt.
- The E2E relay log (`test-results/debug-e2e-relay.log`) follows the same
  rule.

## Pull-model inspection

`GET /inspect/:clientId` returns only what the client's own projection code
chooses to expose: controlled board/connection state (`ClientStateSnapshot`:
counts, sync phases, ids; `restricted` set when the client refused sensitive
fields). The bridge relays; it never assembles state itself, so a malicious
bridge cannot ask for a field the instrumentation didn't define. The poll
interval bounds staleness, and inspection never triggers application work
beyond a read.

## Production access

Observing a production relay via the log observer is read-only by design
([server-observation.md](server-observation.md)), but *access to production
itself* requires the applicable authorization under the pinned SECURITY
policy (`DEVELOPMENT_STANDARDS.md`). This tooling grants nothing by itself.

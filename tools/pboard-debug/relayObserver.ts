/**
 * Relay log observer: parse the Rust relay's tracing output into `relay.*`
 * diagnostic events.
 *
 * The relay logs plain-text `tracing` lines with structured fields
 * (`event="authenticated" session=… room=…`). This parser turns each line
 * into a schema-v1 event so mock-mode scenarios and (later, by an operator)
 * a journald tail can feed the same bridge. Only the *known event* field
 * names pass — the whitelist is the contract with lib.rs; unknown lines are
 * counted and dropped, so a relay that changes its logs degrades to
 * "partial observation", never to silence-with-false-confidence.
 *
 * Correlation honesty: relay log lines carry `session` (its own session id)
 * and no operation ids today; server events therefore correlate to browser
 * traces by room hash prefix, and traces that need per-operation server
 * stages are labelled partial by the trace view.
 */

import { emit } from "../../src/debug/bus.ts";

const RELAY_EVENT_MAP: Record<string, { event: string; severity: "debug" | "info" | "warn" | "error" }> = {
  connect: { event: "connection.accepted", severity: "info" },
  disconnect: { event: "connection.closed", severity: "info" },
  authenticated: { event: "authentication.result", severity: "info" },
  room_attached: { event: "subscription.changed", severity: "info" },
  room_detached: { event: "subscription.changed", severity: "info" },
  attach_refused: { event: "authorization.denied", severity: "warn" },
  join: { event: "subscription.changed", severity: "debug" },
  signal_forwarded: { event: "operation.forwarded", severity: "debug" },
  transport_rejected: { event: "error", severity: "error" },
};

/** `key="value"` and `key=value` field extraction from a tracing fmt line. */
export function parseRelayLine(line: string): { event: string; fields: Record<string, string>; message: string } | undefined {
  const match = /^(?<stamp>\S+)\s+(?<level>TRACE|DEBUG|INFO|WARN|ERROR)\s+(?<target>[A-Za-z0-9_:]+):\s(?<message>.*)$/.exec(line);
  if (!match?.groups) return undefined;
  const { level, message, stamp } = match.groups;
  const fields: Record<string, string> = { stamp, level };
  const pattern = /(\w+)=(?:"([^"]*)"|([^\s]+))/g;
  let field: RegExpExecArray | null;
  while ((field = pattern.exec(message)))
    fields[field[1]] = field[2] ?? field[3] ?? "";
  const known = fields.event !== undefined ? RELAY_EVENT_MAP[fields.event] : undefined;
  if (!known) return undefined;
  return { event: known.event, fields, message };
}

export function observeRelayLogs(lines: AsyncIterable<string> | Iterable<string>): { consumed: () => { lines: number; mapped: number; unmapped: number } } {
  const counts = { lines: 0, mapped: 0, unmapped: 0 };
  void (async () => {
    for await (const line of lines) {
      counts.lines += 1;
      const parsed = parseRelayLine(line);
      if (!parsed) {
        counts.unmapped += 1;
        continue;
      }
      counts.mapped += 1;
      emit({
        component: "relay",
        event: parsed.event,
        severity: RELAY_EVENT_MAP[parsed.fields.event ?? ""]?.severity ?? "info",
        details: {
          source: "relay-log",
          message: parsed.message.slice(0, 160),
          ...pick(parsed.fields, ["session", "room", "peer", "reason", "code", "role", "version", "count", "stamp", "level"]),
        },
      });
    }
  })();
  return { consumed: () => counts };
}

function pick(fields: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) if (fields[key] !== undefined) out[key] = fields[key];
  return out;
}

/** Split an incoming byte/text stream into lines (observer stdin/file mode). */
export async function* toLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffered = "";
  for await (const chunk of chunks) {
    buffered += chunk;
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      yield buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
    }
  }
  if (buffered) yield buffered;
}

/**
 * Canonical serialization, encoding and parsing limits for the pboard
 * collaboration security protocol (protocol 2).
 *
 * Signatures are computed over `domain || lengthPrefix || canonicalBytes` of the
 * protocol payload. Every producer and consumer must derive identical bytes from
 * identical payloads, which the canonical JSON serialization below guarantees:
 * object members sorted (UTF-16 lexicographic, the order `Array.prototype.sort`
 * and `Object.keys` give), no insignificant whitespace, and finite numbers in
 * their ECMAScript shortest round-trip form (RFC 8785's number formatting).
 *
 * Limits reject oversized or ambiguous encoding before verification so malicious
 * input cannot consume unbounded signature/parse work.
 */

/** Domain separators: one reviewed constant per protocol object type. */
export const DOMAIN_MANIFEST = "pboard-manifest-v2";
export const DOMAIN_PRESENCE = "pboard-presence-v2";
export const DOMAIN_SIGNAL = "pboard-signal-v2";
export const DOMAIN_SESSION_PROOF = "pboard-session-proof-v2";
export const DOMAIN_MUTATION = "pboard-mutation-v2";
export const DOMAIN_CHECKPOINT = "pboard-checkpoint-v2";

/** Maximum size of one canonical protocol payload (signaling cap: 64 KiB). */
export const MAX_PROTOCOL_PAYLOAD_BYTES = 65536;
/** Maximum canonical payload size for a signed mutation. */
export const MAX_MUTATION_PAYLOAD_BYTES = 131072;
/** Maximum canonical board permission manifest size. */
export const MAX_MANIFEST_PAYLOAD_BYTES = 65536;
/** Protocol version this module implements. */
export const PROTOCOL_VERSION = 2 as const;
/** Allowed signature algorithm binding. Never select an algorithm from a message. */
export const SIGNATURE_ALGORITHM = { name: "ECDSA" as const, namedCurve: "P-256" as const, hash: "SHA-256" as const };

/** RFC 4648 base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type Json = null | boolean | number | string | Json[] | { [member: string]: Json };

/** ECMAScript `String(number)`: the shortest round-trip form for finite doubles. */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
  return String(value);
}

/** Serializes a JSON string with the required minimal escaping, per RFC 8785. */
function serializeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return out + '"';
}

function serialize(value: Json, out: string[]): void {
  if (value === null) { out.push("null"); return; }
  if (typeof value === "boolean") { out.push(value ? "true" : "false"); return; }
  if (typeof value === "number") { out.push(serializeNumber(value)); return; }
  if (typeof value === "string") { out.push(serializeString(value)); return; }
  if (Array.isArray(value)) {
    out.push("[");
    for (const [index, entry] of value.entries()) {
      if (entry === undefined) throw new Error("Cannot canonicalize `undefined` array entries");
      if (index > 0) out.push(",");
      serialize(entry, out);
    }
    out.push("]");
    return;
  }
  const record = value as { [member: string]: Json };
  const members = Object.keys(record).sort();
  out.push("{");
  let first = true;
  for (const key of members) {
    const member = record[key];
    if (member === undefined) throw new Error("Cannot canonicalize `undefined` object members");
    if (!first) out.push(",");
    first = false;
    out.push(serializeString(key), ":");
    serialize(member, out);
  }
  out.push("}");
}

/** Deterministic canonical JSON text for one value. */
export function canonicalize(value: Json): string {
  const out: string[] = [];
  serialize(value, out);
  return out.join("");
}

export function canonicalBytes(value: Json): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** Signs `domainPrefix || byteLength(4 bytes LE) || canonical(value)`. */
function prefixBytes(domain: string, length: number): Uint8Array {
  const payload = new TextEncoder().encode(domain);
  const prefix = new Uint8Array(payload.length + 4);
  prefix.set(payload);
  new DataView(prefix.buffer).setUint32(payload.length, length, true);
  return prefix;
}

export function signedBytes(domain: string, value: Json): Uint8Array {
  const body = canonicalBytes(value);
  if (body.length > MAX_PROTOCOL_PAYLOAD_BYTES && domain !== DOMAIN_MUTATION) {
    throw new Error(`Protocol payload exceeds ${MAX_PROTOCOL_PAYLOAD_BYTES} bytes`);
  }
  const prefix = prefixBytes(domain, body.length);
  const bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  return bytes;
}

/** Hex digest of the domain-separated canonical bytes; binds proofs to payloads. */
export function signedBytesHash(domain: string, value: Json): string {
  return Array.from(signedBytes(domain, value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses untrusted JSON, rejects duplicate members (ambiguous canonical input),
 * depth > 16 and non-finite numbers. `Object.keys` of the plain parse cannot
 * detect duplicates; this scanner operates on the raw text.
 */
export function parseStrictJson(text: string, maxBytes = MAX_PROTOCOL_PAYLOAD_BYTES): Json {
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("Payload exceeds protocol limits");
  let depth = 0, inString = false, escaped = false;
  for (const char of text) {
    // Braces inside JSON strings (including chunk data) are content, not
    // nesting. Counting them rejects valid frames or bypasses depth limits.
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (depth > 16) throw new Error("Payload nesting exceeds protocol limits");
    if (depth < 0) throw new Error("Unbalanced payload");
  }
  rejectDuplicateMembers(text);
  const parsed: Json = JSON.parse(text, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite number in payload");
    return value;
  });
  return parsed;
}

/**
 * Rejects duplicate members before any canonicalization: plain `JSON.parse`
 * silently keeps the last occurrence, so a producer and consumer could otherwise
 * sign different byte streams for the "same" payload. Scans the raw text: every
 * fully-escaped string that is *followed* by `:` is an object member key.
 *
 * Two keys compare equal when their decoded values match, so `"a"` and
 * `"\\u0061"` collide. The scanner only treats whitespace as insignificant
 * between tokens; keys containing escapes decode through `JSON.parse` per pair.
 */
function rejectDuplicateMembers(text: string): void {
  // Stack of object scopes; each scope collects the *decoded* member keys.
  // ("a" and "\\u0061" must collide.) Strings are scanned with escape awareness;
  // a key is any string token immediately followed (ignoring whitespace) by ':'.
  const scopes: Array<Set<string>> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "{") { scopes.push(new Set()); index++; continue; }
    if (char === "}") { scopes.pop(); index++; continue; }
    if (char === '"') {
      const start = ++index;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index += 2;
        else index++;
      }
      if (index >= text.length) throw new Error("Unterminated string");
      const raw = text.slice(start, index);
      index++;
      let cursor = index;
      while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t" || text[cursor] === "\n" || text[cursor] === "\r")) cursor++;
      if (text[cursor] !== ":") continue;
      const scope = scopes.at(-1);
      if (!scope) throw new Error("Object member outside of an object");
      let decoded: string;
      try { decoded = JSON.parse(`"${raw}"`) as string; }
      catch { throw new Error("Invalid member key escape"); }
      if (scope.has(decoded)) throw new Error("Duplicate JSON member");
      scope.add(decoded);
      continue;
    }
    index++;
  }
}

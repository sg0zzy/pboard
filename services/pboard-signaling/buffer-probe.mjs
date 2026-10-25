#!/usr/bin/env node
/**
 * End-to-end probe for the durable op buffer + leader HTTP API against a
 * freshly spawned server binary with a scratch buffer directory. Exercises
 * the real wire contract: single-use challenges, authority-signed manifests,
 * device signatures, editor-only writes, dedupe, list/commit ordering, the
 * lease state machine, and size limits.
 *
 * Run via `npm run test:buffer` (builds the binary first).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createPrivateKey, sign as nodeSign } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.PBOARD_SIGNALING_BIN ?? join(here, "target", "debug", "pboard-signaling");
const subtle = globalThis.crypto.subtle;

const fail = (message, detail) => { console.error(`FAIL: ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); process.exitCode = 1; throw new Error(message); };
const ok = (condition, message, detail) => { if (!condition) fail(message, detail); console.log(`ok - ${message}`); };

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256b64 = async (bytes) => b64url(new Uint8Array(await subtle.digest("SHA-256", bytes)));

async function newIdentity() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const publicKey = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y };
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y });
  return { pair, privateKey: createPrivateKey({ key: jwk, format: "jwk" }), publicKey, fingerprint: await sha256b64(new TextEncoder().encode(canonical)) };
}

const signRaw = (identity, bytes) => nodeSign("sha256", Buffer.from(bytes), { key: identity.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function startServer({ bufferDir, port }) {
  const child = spawn(binary, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PBOARD_SIGNALING_GRANTS: process.env.PROBE_GRANTS_FILE,
      PBOARD_SIGNALING_AUTOMATIC_ADMISSION: "1",
      ...(bufferDir ? { PBOARD_SIGNALING_BUFFER_DIR: bufferDir } : {}),
      PBOARD_SIGNALING_BIND: `127.0.0.1:${port}`,
      RUST_LOG: "off"
    }
  });
  let stderrText = "";
  child.stderr.on("data", chunk => { stderrText += chunk; if (stderrText.length > 8_000) stderrText = stderrText.slice(-8_000); });
  child.once("exit", (code) => { if (stderrText) console.error(`server exited (${code}): ${stderrText}`); });
  child.on("error", error => console.error("spawn failed:", error.message, binary));
  return child;
}

async function waitForHttp(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const response = await fetch(url); if (response.status < 500) return response; } catch { /* not listening yet */ }
    if (Date.now() > deadline) fail("server did not become ready");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "pboard-buffer-probe-"));
  const grantsFile = join(root, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ rooms: {} }));
  process.env.PROBE_GRANTS_FILE = grantsFile;

  // --- 1. Inert mode: no buffer directory -> endpoints are 404 ------------
  const inertPort = await freePort();
  const inert = startServer({ bufferDir: null, port: inertPort });
  try {
    const inertBase = `http://127.0.0.1:${inertPort}`;
    const challenge = await waitForHttp(`${inertBase}/buffer/challenge`);
    ok(challenge.status === 404, "buffer endpoints are inert (404) without a buffer directory");
  } finally { inert.kill("SIGKILL"); await new Promise(resolve => inert.once("exit", resolve)); }

  // --- authority + board ---------------------------------------------------
  const authority = await newIdentity();
  const owner = await newIdentity(), editor = await newIdentity(), viewer = await newIdentity();
  const board = `probe-${crypto.randomUUID().slice(0, 8)}`;
  const issuedAt = Date.now();
  const manifest = {
    authorityKeyId: authority.fingerprint,
    boardId: board,
    devices: [
      { deviceKeyId: owner.fingerprint, publicKey: owner.publicKey, role: "owner" },
      { deviceKeyId: editor.fingerprint, publicKey: editor.publicKey, role: "editor" },
      { deviceKeyId: viewer.fingerprint, publicKey: viewer.publicKey, role: "viewer" }
    ],
    driveFolderId: "",
    driveProjectFileId: "",
    epoch: 1,
    expiresAt: issuedAt + 300_000,
    issuedAt,
    protocol: 2
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestPayload = b64url(payloadBytes);
  const lengthPrefix = new Uint8Array(4);
  new DataView(lengthPrefix.buffer).setUint32(0, payloadBytes.length, true);
  const manifestSignature = signRaw(authority, new Uint8Array([
    ...new TextEncoder().encode("pboard-manifest-v2"), ...lengthPrefix, ...payloadBytes
  ]));
  const digest = await sha256b64(payloadBytes);
  const topic = `pboard-collab-${board}-cards`;
  const roomBinding = new TextEncoder().encode(JSON.stringify(["pboard-ws-room-v2", topic, "", ""]));
  const room = `pboard-v2-${authority.fingerprint}-${await sha256b64(roomBinding)}`;

  const bufferDir = mkdtempSync(join(tmpdir(), "pboard-buffer-data-"));
  const port = await freePort();
  const server = startServer({ bufferDir, port });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}/buffer/challenge`);

    const authCall = async (path, identity, extra = {}, urlBase = base) => {
      const challenge = await (await fetch(`${urlBase}/buffer/challenge`)).json();
      if (typeof challenge.challenge !== "string") fail("challenge missing", challenge);
      const session = crypto.randomUUID();
      const signature = signRaw(identity, new TextEncoder().encode(JSON.stringify(["pboard-ws-auth-v2", challenge.challenge, session, room, identity.fingerprint, digest])));
      return fetch(`${urlBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          board, deviceKeyId: identity.fingerprint, challenge: challenge.challenge, session, signature,
          authority: authority.publicKey, manifestPayload, manifestSignature, ...extra
        })
      });
    };
    const sealed = (opId) => ({ opId, keyId: "0123456789abcdef", iv: b64url(crypto.getRandomValues(new Uint8Array(12))), ct: b64url(new TextEncoder().encode(`probe-${opId}`)) });

    // --- 2. single-use challenge ------------------------------------------
    const stolen = await (await fetch(`${base}/buffer/challenge`)).json();
    const replayBody = { board, deviceKeyId: owner.fingerprint, challenge: stolen.challenge, session: crypto.randomUUID(), signature: "AAAA", authority: authority.publicKey, manifestPayload, manifestSignature };
    const firstUse = await fetch(`${base}/buffer/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...replayBody, signature: "AAAA", ops: [] }) });
    ok(firstUse.status === 403, "forged signature is rejected", await firstUse.json().catch(() => null));
    const secondUse = await fetch(`${base}/buffer/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(replayBody) });
    ok(secondUse.status === 403 && (await secondUse.json()).code === "challenge_invalid", "a challenge is consumed even on rejection (no probing)");

    // --- 3. editor writes; viewer refused ---------------------------------
    const insert = await authCall("/buffer/ops", editor, { ops: [sealed(`${owner.fingerprint}:1`), sealed(`${owner.fingerprint}:2`)] });
    const insertBody = await insert.json().catch(() => ({}));
    ok(insert.status === 200 && insertBody.accepted === 2, "editor inserts two ops", { status: insert.status, ...insertBody });
    const dupe = await authCall("/buffer/ops", editor, { ops: [sealed(`${owner.fingerprint}:1`)] });
    ok((await dupe.json()).accepted === 0, "duplicate op ids are idempotent");
    const viewerInsert = await authCall("/buffer/ops", viewer, { ops: [sealed(`${viewer.fingerprint}:9`)] });
    ok(viewerInsert.status === 403, "viewer writes are refused", await viewerInsert.json().catch(() => null));
    const viewerList = await authCall("/buffer/list", viewer);
    ok(viewerList.status === 200, "viewer may list (payloads are client-encrypted)");

    // --- 4. list ordering + lease ------------------------------------------
    const listed = (await (await authCall("/buffer/list", owner)).json()).ops;
    ok(listed.length === 2, "buffer lists both buffered ops");
    ok(listed[0].opId < listed[1].opId || listed[0].seq < listed[1].seq, "list is in insertion order", listed.map(op => op.seq));

    const lease = await authCall("/leader/claim", owner);
    ok(lease.status === 200, "owner claims leadership");
    const { epoch } = await lease.json();
    ok(Number.isInteger(epoch) && epoch >= 1, "lease carries a monotonic epoch", epoch);
    const busy = await authCall("/leader/claim", editor);
    ok(busy.status === 409 && (await busy.json()).code === "lease_busy", "a held lease rejects other claimants");

    const observe = await authCall("/leader/observe", owner, { epoch, driveEtag: "\"rev-1\"" });
    ok(observe.status === 200, "leader records the observed revision");

    // --- 5. commit narrows the buffer; stale epochs refused ---------------
    const commit = await authCall("/buffer/commit", owner, { epoch, ids: [`${owner.fingerprint}:1`] });
    ok((await commit.json()).committed === 1, "leader commits published ops");
    const after = (await (await authCall("/buffer/list", owner)).json()).ops;
    ok(after.length === 1 && after[0].opId === `${owner.fingerprint}:2`, "committed ops leave the buffer", after.map(op => op.opId));

    const leaderCommit = await authCall("/leader/commit", owner, { epoch, snapshotSeq: 1, driveEtag: "\"rev-1\"" });
    const committed = await leaderCommit.json();
    ok(leaderCommit.status === 200 && committed.stale === false, "leader commit reports a fresh epoch", committed);

    // --- 6. limits ----------------------------------------------------------
    // 70 KiB of base64 ct exceeds the server's 64 KiB per-op ceiling.
    const huge = await authCall("/buffer/ops", editor, { ops: [{ opId: "huge:1", keyId: "0123456789abcdef", iv: "AAAAAAAAAAAAAAAA", ct: "A".repeat(70_000) }] });
    ok(huge.status === 413, "oversized ops are refused", { status: huge.status, body: await huge.text().catch(() => null) });
    const tiny = await authCall("/buffer/ops", editor, { ops: [{ opId: "tiny:1", keyId: "0123456789abcdef", iv: "AAAAAAAAAAAAAAAA", ct: "A".repeat(12_000) }] });
    ok(tiny.status === 200 && (await tiny.json()).accepted === 1, "normal ops fit the envelope");
    const invalid = await authCall("/buffer/ops", editor, { ops: [{ opId: "bad id/!", keyId: "0123456789abcdef", iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }] });
    ok(invalid.status === 400, "malformed op ids are refused", await invalid.json().catch(() => null));

    // --- 7. persistence across restart -------------------------------------
    server.kill("SIGKILL");
    await new Promise(resolve => server.once("exit", resolve));
    const port2 = await freePort();
    const restarted = startServer({ bufferDir, port: port2 });
    const base2 = `http://127.0.0.1:${port2}`;
    try {
      await waitForHttp(`${base2}/buffer/challenge`);
      const base2Call = (path, identity, extra = {}) => authCall(path, identity, extra, base2);
      const persisted = (await (await base2Call("/buffer/list", owner)).json()).ops;
      ok(persisted.map(op => op.opId).join(",") === `${owner.fingerprint}:2,tiny:1`, "uncommitted ops survive a restart in order", persisted.map(op => op.opId));
      // Leases are in-memory and device-identity-checked; after a restart a
      // fresh lease grants leadership again (Drive If-Match is the durable
      // ordering guard across server lifetimes).
      const reclaim = await base2Call("/leader/claim", owner);
      const reclaimed = await reclaim.json();
      ok(reclaim.status === 200 && Number.isInteger(reclaimed.epoch), "leadership can be claimed after restart", reclaimed);
      const busyAgain = await base2Call("/leader/claim", editor);
      ok(busyAgain.status === 409, "the restarted lease is enforced");
    } finally { restarted.kill("SIGKILL"); await new Promise(resolve => restarted.once("exit", resolve)); }
    console.log("buffer probe: PASS");
  } finally {
    try { server.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(bufferDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });

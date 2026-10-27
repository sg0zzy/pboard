import { describe, expect, it } from "vitest";
import { DEFAULT_ICE_SERVERS, ICE_SERVERS_SETTINGS, iceServersWithDefaults, loadIceServers, selectedPairCode, validateIceServers } from "../src/collab/security/ice";

const storage = (value: unknown) => ({ get: async () => ({ [ICE_SERVERS_SETTINGS]: value }), set: async () => {} });

describe("explicit ICE configuration", () => {
  it("pins the endpoints simple-peer 9.11.1 defaults to, so a dependency bump cannot silently change them", () => {
    expect(DEFAULT_ICE_SERVERS.flatMap(server => server.urls as string[]).sort())
      .toEqual(["stun:global.stun.twilio.com:3478", "stun:stun.l.google.com:19302"]);
  });

  it("keeps valid configured endpoints first and appends the pinned fallback for resilience", () => {
    const servers = iceServersWithDefaults(validateIceServers(["stun:stun.cecosl.ovh:3478"]));
    expect(servers.flatMap(server => server.urls as string[])).toEqual(["stun:stun.cecosl.ovh:3478", "stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"]);
  });

  it("deduplicates rather than doubling a re-declared default and preserves TURN credentials", () => {
    const servers = iceServersWithDefaults(validateIceServers([
      "stun:stun.l.google.com:19302",
      { urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"], username: "u", credential: "c" }
    ]));
    expect(servers.flatMap(server => server.urls as string[])).toEqual(["stun:stun.l.google.com:19302", "turn:turn.example.org:3478", "turns:turn.example.org:5349", "stun:global.stun.twilio.com:3478"]);
    expect(servers[1]).toEqual({ urls: ["turn:turn.example.org:3478", "turns:turn.example.org:5349"], username: "u", credential: "c" });
    const urls = iceServersWithDefaults(validateIceServers(["stun:stun.l.google.com:19302"])).flatMap(server => server.urls as string[]);
    expect(urls.filter(url => url === "stun:stun.l.google.com:19302")).toHaveLength(1);
  });

  it("rejects malformed, oversized, credential-on-STUN and non-scheme input, degrading to the pinned defaults", () => {
    expect(validateIceServers("stun:x")).toBeNull();
    expect(validateIceServers([])).toBeNull();
    expect(validateIceServers(["http://relay.example.org"])).toBeNull();
    expect(validateIceServers(["stun:ok.example.org:3478", { urls: ["stun:cred.example.org"], username: "u", credential: "c" }])).toBeNull();
    expect(validateIceServers(Array.from({ length: 9 }, (_, i) => `stun:h${i}.example.org`))).toBeNull();
    expect(validateIceServers([{ urls: ["turn:t.example.org"], username: "u" }])).toBeNull();
    expect(iceServersWithDefaults(null).flatMap(server => server.urls as string[]).length).toBe(2);
  });

  it("loads storage settings as array or JSON string and falls back to defaults on garbage", async () => {
    expect((await loadIceServers(storage(["stun:custom.example.org"])))[0].urls).toEqual(["stun:custom.example.org"]);
    expect((await loadIceServers(storage(JSON.stringify(["stun:custom.example.org"]))))[0].urls).toEqual(["stun:custom.example.org"]);
    const garbage = await loadIceServers(storage("{oops"));
    expect(garbage.length).toBe(1); // defaults only (both default URLs share one entry)
    expect((await loadIceServers(storage(undefined)))[0].urls).toEqual(DEFAULT_ICE_SERVERS[0].urls);
  });
});

describe("selected ICE pair diagnostics", () => {
  const stats = (entries: Record<string, unknown>[]) => new Map(entries.map((entry, index) => [String(entry.id ?? index), entry as never]));

  it("reads Chrome transport-selected pairs (lowercase keys) and encodes only candidate types", () => {
    const code = selectedPairCode(stats([
      { id: "IT1", type: "local-candidate", candidateType: "srflx" },
      { id: "IR1", type: "remote-candidate", candidateType: "srflx" },
      { id: "IP1", type: "candidate-pair", state: "succeeded", localCandidateId: "IT1", remoteCandidateId: "IR1", transportId: "T1" },
      { id: "T1", type: "transport", selectedcandidateid: "IP1" }
    ]));
    expect(code).toBe(22); // srflx <-> srflx: direct server-reflexive connectivity
  });

  it("reads Firefox selected flags and reports relay involvement distinctly", () => {
    const code = selectedPairCode(stats([
      { id: "L", type: "local-candidate", candidateType: "relay" },
      { id: "R", type: "remote-candidate", candidateType: "host" },
      { id: "P", type: "candidate-pair", isSelected: true, localCandidateId: "L", remoteCandidateId: "R" }
    ]));
    expect(code).toBe(31); // relay(local) <-> host(remote)
  });

  it("returns 0 when nothing is selected yet or types are unknown, so diagnostics stay silent instead of guessing", () => {
    expect(selectedPairCode(stats([{ id: "P", type: "candidate-pair", state: "in-progress" }]))).toBe(0);
    expect(selectedPairCode(stats([
      { id: "P", type: "candidate-pair", selected: true, localCandidateId: "L", remoteCandidateId: "R" },
      { id: "L", type: "local-candidate" }, { id: "R", type: "remote-candidate" }
    ]))).toBe(0);
    expect(selectedPairCode(new Map())).toBe(0);
  });
});

# Local measurements — 18 October 2026

Command: `node services/pboard-signaling/benchmark.mjs 100 500 1000 2000` after
`cargo build --release --locked --manifest-path services/pboard-signaling/Cargo.toml`.
Raw results: [benchmark-results.jsonl](benchmark-results.jsonl).

Host: Linux x86_64, AMD Ryzen 9 5900X (24 logical CPUs), Rust 1.98.1, Node 24.21.0.
Server and synthetic clients run on this same development machine over plaintext
loopback. Each target starts a fresh optimized server with freshly generated,
expiring public grants. At most 32 members per room; all reported connections were
open at measurement completion. Binary approximately 2.3 MiB. These are single runs,
not confidence intervals or guarantees for the proposed 2 GB Debian VPS.

| Peers | Baseline RSS KiB | Loaded RSS KiB | Incremental KiB/peer | Connect ms | Connect CPU seconds | Quiet CPU % of one core | Forward median / p95 ms | 50 reconnects ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4,624 | 8,444 | 38.20 | 235 | 0.06 | 0* | 0.138 / 0.201 | 99 |
| 500 | 5,092 | 18,716 | 27.25 | 697 | 0.30 | 0* | 0.106 / 0.220 | 69 |
| 1,000 | 5,056 | 31,376 | 26.32 | 1,043 | 0.59 | 0* | 0.117 / 0.148 | 70 |
| 2,000 | 5,528 | 55,192 | 24.83 | 1,981 | 1.24 | 0* | 0.194 / 0.244 | 65 |

*No additional CPU ticks registered during a three-second quiet window. CPU uses
`/proc/<pid>/stat` and host `CLK_TCK`; this does not imply literally zero cost.
The quiet window is shorter than the 15-second client heartbeat interval and does
not establish sustained idle CPU under heartbeats. RSS is user-space resident memory,
not kernel socket buffers or total machine memory. Client resource usage is excluded.
Forwarding samples are 20 small synthetic offers, 50 ms apart, one sender/receiver
pair; p95 is nearest-rank 95th percentile. Connects and churn are sequential and fast,
not synchronized bursts. No real SDP generation, NAT, DTLS, RxDB or images participate.

The initial implementation was also measured: at 2,000 peers RSS was 279,756 KiB and
quiet CPU about 33% of one core. Deadline-based timers and 16 KiB socket buffers
removed unnecessary periodic wakeups and default buffer overhead. The table records
the revised implementation, not the initial run.

Measured: up to 2,000 authenticated sockets in this load shape. Not measured:
long-running steady state, coordinated bursts/floods, slow readers, TLS overhead,
real VPS limits, restrictive networks, WebRTC meshes or production availability.
The server's 64-peer room cap is a bound, not a claim of usable 64-way collaboration.
No capacity claim should be extrapolated to the target VPS without repeating these
and heartbeat-inclusive soak tests there under explicit deployment authorization.

## Current production executable — 21 October 2026

The owner authorized a bounded load test and doubling the public connection caps.
Production now enforces HAProxy **128** backend connections and Rust **256** total
connections. These are configured bounds, not measured end-to-end user capacity.
Other production quotas and admission requirements remain unchanged.

The following tests use the exact production executable, SHA-256
`1c1035b491c61e3e87bffca205eecd4b4959a5665ab992c50b6ebf774acd46ea`,
in **separate** loopback processes. They use temporary expiring operator-signed
grants with challenge/session-bound authentication. They do not test Google
service admission, board-grant protocol v2, public TLS/HAProxy, WebRTC DataChannels,
RxDB, images or real board traffic. No production auth setting was relaxed.

Each target creates fresh peers, authenticates and joins them sequentially,
holds them idle for 30 seconds including 15-second heartbeats, forwards 20
synthetic SDP offers between one pair, then disconnects/reconnects 50 peers.
All reported sockets remain open at completion. Connects and reconnects include
40 ms pacing; they are not coordinated bursts. No long soak or slow-reader test
was performed. CPU is measured in kernel ticks, RSS excludes kernel socket
buffers and client processes, and incremental RSS includes allocator effects.
These are single runs, not statistical capacity guarantees.

### Actual VPS, isolated relay core

Host: Debian GNU/Linux 13, one logical CPU, 1,972,068 KiB total RAM. The test
backend runs as `pboard-signaling`, with two Tokio worker threads and a 512 MiB
address-space limit. Node 24.21.0 clients run on the development workstation;
connections pass through a loopback-bound SSH tunnel. Latency therefore includes
the workstation→VPS→workstation path and SSH encryption in both directions;
it is sender-to-receiver message delivery time, not backend processing latency.
The real service remains online alongside the
isolated test. Both benchmark ports were confirmed closed afterward.

| Authenticated sockets | Baseline RSS KiB | Loaded RSS KiB | Incremental KiB/peer | Connect ms | Connect CPU seconds | Heartbeat-window CPU % of one core | Forward median / p95 ms | 50 reconnects ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 5,356 | 7,464 | 32.94 | 6,349 | 0.11 | 0.067 | 14.810 / 15.007 | 5,852 |
| 128 | 5,408 | 9,160 | 29.31 | 13,111 | 0.22 | 0.100 | 15.847 / 16.152 | 6,083 |
| 256 | 5,328 | 12,420 | 27.70 | 26,020 | 0.45 | 0.200 | 15.813 / 16.093 | 6,031 |

Reproduce only with authorization for the named host:

```sh
PBOARD_BENCH_SSH=cecosl node services/pboard-signaling/benchmark.mjs 64 128 256
```

The 64-socket target was run first; a repeated-port startup check then encountered
TIME_WAIT and stopped the harness. The probe was fixed to use `SO_REUSEADDR`, and
the 128/256 targets completed in a subsequent run. This was a test-harness startup
failure, with no change to the public service. Temporary grants and test processes
were cleaned up. The tool now permits repeat runs on the same idle port.

### Current executable, local loopback

Same Ryzen 5900X development host as the historical measurements; two Tokio
worker threads. The current harness uses heartbeat-inclusive 30-second windows
and paced connects, so connect times and CPU columns cannot be compared directly
with the historical three-second/no-heartbeat profile.

```sh
PBOARD_BENCH_BINARY="$PWD/services/pboard-signaling/target/quota-production/release/pboard-signaling" \
  node services/pboard-signaling/benchmark.mjs 100 500 1000 2000
```

| Authenticated sockets | Baseline RSS KiB | Loaded RSS KiB | Incremental KiB/peer | Connect ms | Connect CPU seconds | Heartbeat-window CPU % of one core | Forward median / p95 ms | 50 reconnects ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 5,640 | 8,448 | 28.08 | 4,258 | 0.08 | 0.067 | 0.300 / 0.371 | 2,139 |
| 500 | 5,944 | 18,992 | 26.10 | 20,996 | 0.52 | 0.267 | 0.265 / 0.331 | 2,136 |
| 1,000 | 6,080 | 31,900 | 25.82 | 41,567 | 1.03 | 0.367 | 0.187 / 0.274 | 2,108 |
| 2,000 | 6,668 | 57,932 | 25.63 | 83,044 | 2.11 | 0.867 | 0.150 / 0.322 | 2,114 |

Raw results for both current profiles: [benchmark-results-2026-10-21.jsonl](benchmark-results-2026-10-21.jsonl).

Measured here: up to 256 authenticated synthetic sockets on the actual VPS and 2,000 on local loopback. Not established: 2,000 production clients on the VPS, Google identity polling capacity, realistic negotiation bursts, public TLS saturation, long-term reliability or browser/WebRTC replication at that scale. An active independent board normally uses two sockets per browser; HTTP/control requests share the proxy backend capacity. Stored board count is not concurrent socket count.

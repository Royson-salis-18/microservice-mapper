# Measuring precisely

Reading a host from outside gives you raw material, not answers. `docker stats` rounds its numbers. A socket table lists the same connection in every sweep. A CPU figure is a percentage of one core, not of what the container is allowed to use. This chapter goes through each measurement the mapper publishes, what the raw source gets wrong, and what the code does about it.

The guiding test for every figure: **if someone checked it on the host by hand, would it agree?**

---

## The two loops that read the target

Two loops run per target in `server/discovery/EndpointDiscoveryEngine.ts`. Each one waits for its previous run to finish before scheduling the next, so they can never pile up:

| Loop | Runs | Reads | Produces |
|---|---|---|---|
| **poll** | 5 s after the last one finished | `docker stats --no-stream`, container state | CPU, memory, status, and byte totals from Docker |
| **sweep** | 5 s after the last one finished | per container: `/proc/<pid>/net/tcp`, `tcp6`, then `/proc/<pid>/net/dev` | connections, edge direction, exact network counters |
| rediscovery | every 180 s | `docker ps` + `docker inspect` per container | new containers, names, types, compose declarations |

The sweep reads the socket tables and the interface counters in a **single** `exec` per container. The command prints a marker line (`##NETDEV##`) between them, and the collector splits the output on that marker:

```bash
PID=$(docker inspect <id> --format '{{.State.Pid}}')
cat /proc/$PID/net/tcp /proc/$PID/net/tcp6
echo '##NETDEV##'
cat /proc/$PID/net/dev
```

Reading `/proc/<pid>/net/*` from the host shows the container's own network namespace without entering the container. Nothing runs inside it.

---

## Network: exact counters, real rates

**The problem.** `docker stats` prints NET I/O rounded to three significant figures. A 9.87 MB counter can only move in 10 kB steps, so a rate computed from two readings is mostly rounding noise. For a long time the field was also a cumulative total that some views displayed as if it were a rate.

**What is done now:**

- `parseNetDev()` (in `MetricCollector.ts`) reads `/proc/<pid>/net/dev` and sums received bytes (field 0) and transmitted bytes (field 8) over every interface except `lo`. These are the kernel's exact counters.
- `recordNetwork()` keeps the previous reading and computes `rxPerSec` and `txPerSec` from the byte delta over the time between reads. If a counter went *down* (the container restarted), the rate is `null` for that sweep, not a huge negative or a fake spike.
- The published node metrics keep the two meanings apart:

| Field | Meaning | Source |
|---|---|---|
| `networkRx`, `networkTx` | **cumulative** bytes since the container started | `/proc` counters if read in the last 30 s, else Docker's rounded figure |
| `networkRxRate`, `networkTxRate` | **bytes per second** right now | `/proc` counter deltas |
| `networkSource` | which of the two produced the totals | |

The ML pipeline still computes its own rates from the cumulative totals, the same way at training time and at scoring time, so it is unaffected. A consistency rule (`rate-not-total`) flags any rate above 10 GB/s, a sure sign of a total shown as a rate.

---

## CPU: a share of what the container may use

**The problem.** Docker reports CPU as a percentage of **one core**. A container limited to 2 cores and using both reads `200%`. A container with no limit on an 8-core host can read `800%`. Comparing those numbers with "80% = busy" is meaningless.

**What is done now:**

- Every container is inspected for its limit the first time a scan sees it. `HostConfig.NanoCpus` (as set by `--cpus`) is used if present, else `CpuQuota / CpuPeriod`. With no limit, the allowance is the host's core count, read once with `nproc`. Inspection used to happen only when the cache was empty, so containers that started later never got a limit.
- Each node publishes:

| Field | Meaning |
|---|---|
| `cpu` | Docker's figure: % of one core |
| `cpuAllowanceCores` | how many cores this container may use |
| `cpuOfAllowance` | `cpu / allowance`, 0–100: the share of its allowance in use |

- **Status** uses the share of allowance: above 80% the service is `degraded`, with the reason "CPU N% of its X-core allowance".
- **The anomaly detector's** absolute CPU threshold uses `cpuOfAllowance` too.
- **The UI** shows `cpuShown()` (share of allowance when known, otherwise the raw figure), and the tooltip says which one you are looking at.

---

## Connections: counted once each

**The problem.** A sweep sees a socket table, not a list of connections opened. A long-lived connection appears in every sweep, so counting rows says more about how often you swept than about traffic. A connection that closes sits in `TIME_WAIT` for about 60 s, so it appears in roughly a dozen sweeps after it ended.

**What is done now.** Every socket event carries a **connection key**:

```
connKey = callerIp:callerPort>calleeIp:calleePort
```

`GraphStore.recordConnectionSweep()` then, for each sweep:

1. Groups events by edge and de-duplicates keys within the sweep. A connection is often seen from both ends; it still counts once.
2. Records **open** = the number of distinct keys in `ESTABLISHED`.
3. Records **fresh** = the number of keys never seen before. A key is remembered for 150 s after it was last seen, longer than `TIME_WAIT`, so a closing connection cannot come back as "new".
4. Records a zero for every edge of this target that had no sockets in this sweep, so the averages include the time a link sat idle.
5. Counts nothing as fresh on the target's **first** sweep. Every connection is new to a fresh process, and counting them would invent a burst.

`applyEdgeActivity()` turns the last 120 s of sweeps into two figures, published once there are at least two sweeps:

| Field | Meaning |
|---|---|
| `openConnections` | average number of distinct open connections across the window |
| `newConnectionsPerMin` | distinct connections opened, per minute (span at least 30 s) |
| `connectionSweeps` | how many sweeps the figures rest on |

**Checked against ground truth.** `scripts/simulate-target.ts` plays a target whose sockets are known exactly: 2 persistent connections per link, new connections at a tenth of its request rate, `TIME_WAIT` lasting 60 s. Against it, `openConnections` matched on **9 of 9** links, and `newConnectionsPerMin` was within **1.4% on average (4.4% worst)** once the window had filled.

### `samplesPerMin`, and why it stays

The older figure, `activity.samplesPerMin`, counts socket sightings per minute. It is kept because the colour bands for link volume and the dependency baseline are calibrated on it. It is labelled for what it is, a **relative activity index**. It is good for comparing two links and wrong for counting requests.

It also has a slow companion, `baselinePerMin`: an exponential average that rises quickly (τ = 60 s) and falls slowly (τ = 600 s), fed only once the window is at least 20 s long. Dependency weights use the baseline, so a link that went quiet *because its callee died* still counts for what it usually carries. Otherwise a crashed database would look less important the longer it stayed down.

---

## IPv4 hiding in IPv6 tables

**The problem.** Servers that listen on `::` (many Java and Node services do) accept IPv4 clients on a dual-stack socket. Their IPv4 connections show up in `/proc/net/tcp6` as IPv4-mapped addresses (`::ffff:10.0.0.5`). Decoded as plain IPv6, they match no container, and the link disappears.

**What is done now.** `decodeProcNetIp()` reads the four 32-bit words of a tcp6 address. When the first three words read `00000000`, `00000000`, `FFFF0000` (the kernel prints each word in host byte order), the address is IPv4-mapped and it returns the IPv4 address held in the last word. A genuine IPv6 address returns `''`, which deliberately matches no container instead of being guessed.

---

## Direction: who is calling whom

**The problem.** A socket table row has two ends and no label saying which end started the conversation.

**What is done now.** `orientConnection()` uses each container's LISTEN rows. The end whose port is a listening port is the **callee**. If no listen table was readable, the ephemeral port range (32768–60999) marks the client end. If neither works, the scan's own orientation is kept and the edge is tagged `direction:unresolved`, with its confidence lowered to 0.5 so it counts for less. See [Lifecycle and direction](06-node-edge-lifecycle.md).

---

## Latency and errors: one set of thresholds

When a source provides request data (the gateway log at Tier 1, Prometheus at Tier 2), a link's status comes from `linkStatus()` in `server/graph/linkThresholds.ts`:

| | warn (orange, `degraded`) | severe (red, `failed`) |
|---|---|---|
| latency (p95 if available, else mean) | ≥ 300 ms | ≥ 1000 ms |
| error rate | ≥ 1% | ≥ 5% |

The client uses the same numbers in `edgeAppearance()`, and a test fails if the two sets ever differ. p95 is preferred because a mean hides the slow tail that users actually feel.

---

## Traffic shares that add up

Each edge's `weight.dependency` says what share of its caller's work goes to that callee. Within one caller and one kind (functional or telemetry), the shares now **always sum to exactly 1**:

- If every sibling edge has a request rate, the share is `requests / total requests`.
- Otherwise, each edge with no traffic figure gets an even slice, `1/N`, and the measured edges split what remains in proportion to their activity baseline.
- If nothing is measured, every edge gets `1/N`, and the basis says `uniform`.

The old version gave unmeasured edges `1/N` *on top of* a full measured split, so one caller's shares added up to 183%. The consistency rule `reliance-sums-to-one` now checks every caller.

---

## Summary: what each published figure is

| Figure | Unit | Exact or estimated | Null when |
|---|---|---|---|
| `cpu` | % of one core | exact (Docker) | no stats sample |
| `cpuOfAllowance` | % of allowance | exact ratio | limit and core count unknown |
| `memoryPercent` | % of memory limit | exact (Docker) | no stats sample |
| `networkRxRate` / `TxRate` | bytes/s | exact counter delta | first read, counter reset, or no `/proc` read |
| `networkRx` / `Tx` | bytes total | exact, or Docker's 3-significant-figure figure | no reading |
| `openConnections` | connections | exact per sweep, averaged | fewer than 2 sweeps |
| `newConnectionsPerMin` | connections/min | exact keys; rate over a ≥ 30 s span | fewer than 2 sweeps |
| `samplesPerMin` | sightings/min | relative index | link never observed (the field is absent) |
| `requestRate`, `errorRate`, `latency`, `p95Latency` | req/s, 0–1, ms | measured by the source | no Tier 1 or Tier 2 source covers the link |

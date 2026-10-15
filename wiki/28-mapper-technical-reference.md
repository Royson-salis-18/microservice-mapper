


 01 


## 01 Process topology


Three Node processes, one Python pipeline, one target reached only over SSH.



> [!IMPORTANT]
> Why traffic-gen is its own process

      The process generating load must not be the process measuring the result. Sharing an event
      loop means a slow target stalls collection, and a busy collector throttles the load
      generator - each would silently distort the other.



 02 


## 02 Discovery


What exists, what it is, and what it claims to depend on.



> [!WARNING]
> Guard: an empty scan is almost never true

      These hosts are resource-constrained and drop docker commands under load, and
      discover() returns an empty list rather than throwing when that happens.
    

      On a periodic rescan, a zero-service result keeps the previous set and logs the
      reason. On the initial cycle it is taken as-is, because then it really is the state.



 03 


## 03 The collection cycle


One TargetAgent per target. This loop repeats while the agent lives - the next run is queued only after the current one finishes.



> [!WARNING]
> Trap 1 - the scan that failed 100% of the time, silently

      The socket scan used to run docker exec <id> sh -c 'cat /proc/net/tcp'.
      That needs a shell inside the container. The OpenTelemetry demo's frontend is a
      distroless image whose entrypoint is /nodejs/bin/node, so every scan returned:
    
OCI runtime exec failed: exec: "sh": executable file not found in $PATH

collectObservedEdges treated non-zero exit as “skip this service” and
      moved on without a word. frontend is precisely the service that calls cart,
      currency, checkout and product-catalog - so those edges could never be observed. Across
      500 connection events it appeared as a source zero times, while every other
      service appeared at least once.
    

      Now it resolves the container's host PID and reads
      /proc/<hostPid>/net/tcp from the host - needs nothing inside the
      container, so it works on distroless, scratch and ordinary images alike.


> [!WARNING]
> Trap 2 - overlapping cycles exhausting SSH sessions

      The loop was setInterval(poll, 5000) with an async poll. A cycle
      takes far longer than 5s on 25 services, so cycles stacked and ran concurrently until they
      passed OpenSSH's MaxSessions (default 10):
    
(SSH) Channel open failure: open failed

      Measured at 2.66 refused scans per cycle. Self-scheduling - queue the
      next run 5s after the last one ends, as drawn above - took that to
      0.00 over 41 cycles.



 04 


## 04 The graph


server/graph/GraphStore.ts - the single source of truth the UI reads.




### Identity


Node ids are project:service - open-telemetry:cart. Every
    ingest path runs raw ids through normalizeId(), which is what makes it impossible
    for two projects' data to merge. Edge ids are source->target.



### Edge shape


```
{
  id: "open-telemetry:frontend->open-telemetry:cart",
  declared: true,          // a config file said so
  observed: true,          // a live TCP connection was caught
  evidenceSources: ["compose", "network-tcp"],

  activity: {              // tier 0 volume proxy - absent until seen once
    samplesPerMin: 184,   // socket OBSERVATIONS, not requests
    windowSec: 76,
    lastSeen: "2026-09-18T…"
  },

  metrics: null            // tier 1/2 only. null is correct, not missing.
       | { p95Latency, errorRate, requestRate, provenance },

  status: "active" | "degraded" | "failed" | "unknown"
}
```


> [!IMPORTANT]
> Why samplesPerMin is named that and not requestRate

      The collector re-counts every ESTABLISHED and TIME_WAIT socket on
      each sweep, so one long-lived connection contributes on every scan. It is a proxy for
      concurrent traffic, not a count of requests. TIME_WAIT is counted deliberately:
      the ~60s post-close linger state catches fast request cycles that begin and end between two
      5-second sweeps.



### Lifecycle


| Rule | Value | Reason |
| --- | --- | --- |
| Stale node pruning | STALE_NODE_MS = 900_000 | 15 min unseen. A flat short grace killed everything on slow hosts. |
| Load-time baseline | lastSeen stamped on disk load | Nodes restored from disk must not instantly look stale. |
| Metric retention | 1 hour, 10,000 events | Ring buffer in MetricStore. |
| Edge activity window | 120s, halved on rollover | Rate decays rather than snapping to zero. |



 05 


## 05 Telemetry tiers & provenance


Where each number came from, enforced rather than annotated.



| Tier | Source | Resource | Topology | Latency | Errors |
| --- | --- | --- | --- | --- | --- |
| tier 0 | cgroup | yes | - | no | no |
| tier 0 | socket-scan | - | yes | no | no |
| tier 1 | access-log | - | yes | yes | yes |
| tier 2 | prometheus | yes | - | yes | yes |
| tier 2 | trace-backend | - | yes | yes | yes |


This table is SOURCE_CAPABILITIES in models/MetricProvenance.ts, and it
    is checked, not documentation - a test asserts a socket scan cannot write into a latency field.



### Enabling tier 2


```
// server/data/remote_config.json
"open-telemetry": {
  "ec2PublicIp": "…",
  "sshKeyPath": "~/…​.pem",
  "telemetrySources": {
    "prometheus": { "enabled": true, "url": "http://localhost:9090" }
  }
}
```


> [!IMPORTANT]
> Why localhost is correct here

      The query runs on the target, via curl over the SSH connection already held.
      Prometheus is bound to localhost there and only :8080 is open in the security
      group - querying from outside would mean asking someone to open a port to read a metric.


> [!WARNING]
> Three things tier 2 refuses to do
NaN is not zero. A missing quantile stays absent - 0ms would read as “instant”.
No traffic is not 0% errors. A ratio needs a denominator; unknown stays unknown.
No caller attribution. Prometheus measures the serving side and cannot say who called.



 06 


## 06 Traffic generation


Finding what actually answers, then driving load only at that.



### Entry point resolution - a waterfall



> [!IMPORTANT]
> Why observability UIs are ranked last in step 3

      Ranking by lowest port made Grafana on :3000 beat the real app frontend on
      :8080. Observability components are demoted by service name instead,
      because ports collide: :3000 is Grafana here and a perfectly normal frontend elsewhere.



### The two-phase probe - a funnel




49 404s from generic guesses on DeathStarBench - its API is 
 → 6usable endpoints once its own workflow paths were used
 → 0sock-shop endpoints wrongly called dead, once timeouts adapted

> [!IMPORTANT]
> Adaptive timeouts, and why a timeout is retried but a 404 is not

      A flat 6s budget called 23 of 41 sock-shop candidates dead. They were alive:
      /catalogue?size=5 answered in 15.1s. Reporting a live endpoint as
      dead means that service gets no load and produces no telemetry at all. Phase 2 now scales its
      timeout off the slowest origin, and anything that only timed out is retried once at
      25s. A refused connection or a 404 is an answer, and is not retried.


> [!WARNING]
> The user-cap bug that made HEAVY and STRESS unstartable

maxUsers was hard-capped at Math.min(x, 20) while profiles asked for
      40 and 80, so engine.validateConfig rejected the profile's own request. The cap now
      floats above whatever is requested, with one real ceiling (TRAFFIC_MAX_USERS,
      default 200) an operator can see and change.



 07 


## 07 The ML pipeline


Four Python scripts, driven from the UI, one model per service per detector.




### The four detectors - deliberately different shapes of judgment



| Key | Catches | Note |
| --- | --- | --- |
| iforest | globally rare points | the default; cheap, mixed scales fine |
| lof | normal globally, odd locally | refuses below 20 distinct rows |
| ocsvm | outside the normal frontier | nu maps from contamination |
| zscore | large deviation on any feature | no fitting; the baseline the others must beat |


> [!WARNING]
> LOF and the 3.37×109 threshold

      Fitted naively, LOF produced thresholds in the billions: the training data is mostly duplicate
      rows, so a point's 20 nearest neighbours are 20 copies of itself at distance zero, and local
      density goes to infinity. LOF now fits on distinct rows and refuses entirely below 20
      of them - at 6 distinct rows it fired on 84.6% of its holdout, which is
      not a detector.


> [!IMPORTANT]
> Chronological holdout, not random

      The last 20% by time is held out, never a random split, which would leak adjacent samples
      across the boundary and flatter the result. The holdout is unlabelled, so what is reported is a
      firing rate, not accuracy - compare it to contamination, not to 100%.



### Suggestions are computed, not quoted


| Project | Services | Median distinct | Suggested n_estimators | Suggested detectors |
| --- | --- | --- | --- | --- |
| sock-shop | 13 | 7 of 1960 | 100 | iforest, ocsvm, zscore |
| death-star | 10 | 150 | 200 | all four |


LOF is dropped from sock-shop's recommendation because 0 of 13 services have the
    20 distinct rows it needs.



 08 


## 08 Incidents & root-cause


Rule-based throughout. server/rca/ imports nothing from ml/.



### Root-cause scoring - weighted evidence




### The ten incident rules


| Rule | Default | Effect |
| --- | --- | --- |
| minHistorySamples | 3 | below this a service is skipped, not guessed at |
| zScoreAnomaly | 2.5 | |z| at or above this is anomalous |
| zScoreHigh / Critical | 3.0 / 4.0 | severity bands |
| absoluteHighPercent | 70 | HIGH regardless of deviation |
| absoluteCriticalPercent | 85 | CRITICAL regardless of deviation |
| flatlineStdDev | 0.001 | below this the baseline counts as flat |
| flatlineDeltaPercent | 30 | on a flat baseline, the jump that is the anomaly |
| flatlineCriticalPercent | 80 | flat-baseline CRITICAL bound |
| criticalServicesForCritical | 2 | how many at once make the incident CRITICAL |


> [!IMPORTANT]
> Why the flat-baseline rule exists at all

      A z-score divides by the standard deviation. sock-shop:front-end records 6
      distinct values across 1,568 samples, so the deviation approaches zero and the z-score
      explodes. Below flatlineStdDev the baseline is judged on absolute movement
      instead - the rule that catches an idle service suddenly doing work.


> [!WARNING]
> A validation bug worth knowing about

Number(null) and Number([]) are both 0, and finite. So
      {"zScoreAnomaly": null} passed an isFinite guard and clamped to
      0.5, the most sensitive possible value, making every sample anomalous.
      Non-numeric input is now rejected outright.



 09 


## 09 API surface


54 routes under /api. The ones worth knowing:





#### Graph & telemetry


```
GET  /graph
GET  /nodes/:id            /metrics  /logs
GET  /traffic?targetId=    // http OR socket, tagged
GET  /traces/events
GET  /targets/:id/discovery  /endpoints  /routes
```



#### Traffic


```
POST /traffic/surface/probe   // read-only, no load
POST /experiments/start       // mode, users, durationSec
POST /traffic/stop            // targetId or "all"
GET  /traffic/entrypoints     // pinned vs resolved, stale flag
```





#### ML


```
GET  /ml/status  /models  /projects
GET  /ml/features?serviceId=&limit=
GET  /ml/suggestions?project=
GET  /ml/source/:name         // allow-listed, read-only
POST /ml/retrain              // project, algorithms, hyperparams
POST /ml/processes/:name/start|stop
```



#### Incidents


```
GET  /incidents  /:id/timeline  /evidence
GET  /incidents/thresholds
POST /incidents/thresholds    // clamped; {reset:true} restores
```




> [!WARNING]
> Express route ordering

/incidents/thresholds must be registered before
/incidents/:id, or Express matches thresholds as an incident id and
      returns {"error":"Incident not found"}.



 10 


## 10 Performance


Both wins came from doing less work, not from a faster runtime.



### Tail-reading the feature table


/api/ml/features returns the most recent 300 rows and was reading all 33 MB to do it.




 → 2.0 msunfiltered - 97×, byte-identical output
 → 57 msfiltered by service - 5.6×
 → 0.00refused SSH scans per collection cycle

> [!TIP]
> Two details that mattered more than the raw speed

      The filter predicate reads one column with fieldAt() rather than
      line.split(','), which allocates a 19-element array per line and discards it.
    

      A filter matching nothing would otherwise walk the whole file backwards. maxBytes
      caps the scan so a bad filter degrades instead of hanging.



### Still open


| Path | Cost | Shape of the fix |
| --- | --- | --- |
| /api/ml/suggestions | 160 ms full scan | 30s cache today; same tail/stream treatment available |
| telemetry_db.json save | 17.9 ms stringify, 3.8 MB | blocks the event loop on every persist |



 11 


## 11 Honest limits


From outside a container you can see how much work it is doing, exactly. You
    cannot see what the work was. That is physics, not a missing feature.


The workaround is tier 2, genuinely available on targets that instrument themselves:


```
histogram_quantile(0.95, sum(rate(
  demo_cart_get_cart_latency_seconds_bucket[1h])) by (le))
  → 0.0829      // 82.9 ms p95, service_name="cart", 2,296 samples
```


> [!WARNING]
> The models currently say very little, and it is a data problem

sock-shop:front-end holds 1,568 training rows containing 6 distinct
      values - 0.4%. No detector learns a boundary from six points, and no
      hyperparameter fixes that. Latency and error rate do not behave that way, which is the
      strongest argument for tier 1/2 beyond fidelity.



### Current target status


| Target | Available | Note |
| --- | --- | --- |
| open-telemetry | tier 2 | full OTLP - histograms, status codes, service metadata |
| death-star | tier 0 | Jaeger running on :16686 but 0 services, null spans |
| sock-shop | tier 0 | 909 MB box, load average 26, swapping - no APM at all |
| vertikal | tier 0 | Next.js + Supabase, no APM |





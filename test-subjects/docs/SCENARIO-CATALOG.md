# Scenario catalogue

Generated from each `scenario.yaml` (`ground_truth`, `verified`). Open the spec for the full story: why review/tests pass, the production condition, load command, mapper signals, blind spots and the fix.

| ID | What happens | Class | Verified | True root cause |
|---|---|---|---|---|
| [`ll-00-baseline`](../ledgerline/scenarios/ll-00-baseline/scenario.yaml) | Healthy baseline (control group) | control | — | — |
| [`ll-01-pool-starvation-cycle`](../ledgerline/scenarios/ll-01-pool-starvation-cycle/scenario.yaml) | Two healthy services wait on each other and nothing looks busy | circular dependency / resource starvation | local-process | accounts <-> fraud-screening (cycle) |
| [`ll-02-provider-outage`](../ledgerline/scenarios/ll-02-provider-outage/scenario.yaml) | Third-party outage with a circuit breaker -- the silence is the symptom | external dependency failure / partial outage | local-process | fx-provider |
| [`ll-03-hot-row`](../ledgerline/scenarios/ll-03-hot-row/scenario.yaml) | Every transfer in the bank queues on one row | lock contention / data skew | local-process | ledger-db |
| [`ll-04-connection-budget`](../ledgerline/scenarios/ll-04-connection-budget/scenario.yaml) | Pools that are each reasonable add up to more than the database allows | capacity planning / connection exhaustion | local-process (exhaustion reproduced; the restart/failover amplification is documented but NOT reproduced locally) | ledger-db |
| [`ll-05-batch-oom`](../ledgerline/scenarios/ll-05-batch-oom/scenario.yaml) | The month-end job that kills itself, restarts, and tries again | data skew / batch memory / restart loop | local-process (memory spike measured); OOM kill itself requires the container memory limit | statements-worker |
| [`ll-06-shadow-dependency`](../ledgerline/scenarios/ll-06-shadow-dependency/scenario.yaml) | fraud-screening quietly depends on fx-rates | undocumented dependency | local-process (flag path) | — |
| [`sf-00-baseline`](../shopflow/scenarios/sf-00-baseline/scenario.yaml) | Healthy baseline (control group) | control | — | — |
| [`sf-01-missing-index`](../shopflow/scenarios/sf-01-missing-index/scenario.yaml) | Order history is fast in staging, melts the database in production | capacity / data volume | local-process | orders-db |
| [`sf-02-cache-thrash`](../shopflow/scenarios/sf-02-cache-thrash/scenario.yaml) | Cache sized for staging evicts itself in production | capacity / infrastructure sizing | local-process | catalog-cache |
| [`sf-03-unbounded-cache`](../shopflow/scenarios/sf-03-unbounded-cache/scenario.yaml) | Memory climbs for an hour, then the container is OOM-killed | resource leak (configuration-induced) | local-process | cart |
| [`sf-04-retry-storm`](../shopflow/scenarios/sf-04-retry-storm/scenario.yaml) | A third party throttles us; our own retries make it ten times worse | cascading failure / retry amplification | local-process | psp-sandbox |
| [`sf-05-secret-rotation`](../shopflow/scenarios/sf-05-secret-rotation/scenario.yaml) | Rotated database password; one service still has the old one | deployment / configuration drift | local-process (exit behaviour); auth failure itself requires the real Postgres container (scram) | orders |
| [`sf-06-shadow-dependency`](../shopflow/scenarios/sf-06-shadow-dependency/scenario.yaml) | A dependency that exists only in the code | undocumented dependency / hidden blast radius | local-process | — |
| [`sf-07-dead-dependency`](../shopflow/scenarios/sf-07-dead-dependency/scenario.yaml) | A declared dependency nobody calls | stale configuration / wasted capacity | compose-validated | — |
| [`sf-08-noisy-neighbor`](../shopflow/scenarios/sf-08-noisy-neighbor/scenario.yaml) | A reporting job on the shared database slows checkout | shared infrastructure contention | local-process (direction confirmed; magnitude depends on host cores -- compose caps catalog-db at 1 CPU) | catalog-db |
| [`sf-09-cpu-throttle`](../shopflow/scenarios/sf-09-cpu-throttle/scenario.yaml) | Slow but healthy -- a container throttled at a quarter of a core | resource sizing / CFS throttling | compose-validated (cgroup CPU quota semantics; not executed here) | catalog |
| [`sf-10-poison-message`](../shopflow/scenarios/sf-10-poison-message/scenario.yaml) | One un-processable message stops every confirmation e-mail | asynchronous failure / silent degradation | local-process | notifier |
| [`sf-11-wrong-hostname`](../shopflow/scenarios/sf-11-wrong-hostname/scenario.yaml) | A renamed service still referenced by its old name | configuration drift / silent degradation | local-process | — |

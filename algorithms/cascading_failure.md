# Cascading failure: who fails next?

One page with the whole idea. Code: **`cascading_failure.py`** next to this page (about 60 lines, run it to see the example below), `detailed/graph/cascade_engine.py` (the full version, mirrors `server/algorithms/graph/CascadeEngine.ts`) and `root_cause.py` and `demo.py` (which feed it). Details and more examples: `detailed/graph/graph.md`, section 4.

## The problem

Service `web` calls `orders`, and `orders` calls `db`. If `db` goes down, `orders` starts to fail, and then `web` starts to fail because its calls to `orders` fail. One failure spreads through the dependency chain. The mapper should say, before it happens, which healthy services are exposed.

## The model

1. **Starting probability `p0`** for each service, from what is measured now: stopped container = 1.0, critical = 1.0, degraded = 0.5, healthy = 0, unknown = 0 (no data is not evidence). Abnormal readings can raise it.
2. **Risk flows from callee to caller** along each call link:

```
P(service) = 1 - (1 - p0) x  product over its callees c of  (1 - tau x w(service -> c) x P(c))
```

   - `w` is how strongly the caller depends on the callee (0 to 1), from `graph/edge_weights.py`: a link seen carrying traffic counts fully, one only declared in a config file counts less, a monitoring link counts a tenth.
   - `tau = 0.7` is the share of a dependency's failure that actually reaches its caller. It is below 1 because of retries, timeouts, caches and graceful degradation.
   - Read the formula as: the service survives only if it survives on its own AND survives every dependency.
3. **Repeat until stable.** Services can call each other in loops, so the numbers are recomputed until they stop changing (they only go up and are capped at 1, so they converge; at most 200 rounds).
4. **Bands:** at least 0.7 high, 0.4 elevated, 0.15 low, below that minimal.
5. **At risk** = looks fine by its own measurements (`p0` below 0.15) but its predicted probability is 0.15 or more. These are the services a cascade reaches next, shown with the dependency it travels through.
6. **What if X failed?** Start from a healthy system, set X to failed, run the same calculation, read the others.
7. **Structural criticality:** for each service, the expected share of the project's traffic that would be disrupted if it failed alone. This says how important a service is in the graph, independent of what is failing now.

## Worked example (real output of `python3 algorithms/cascading_failure.py`)

`web -> orders -> db`, `db` stopped, `orders` degraded:

```
chance of failing: {'web': 0.456, 'orders': 0.815, 'db': 1.0, 'mail': 0.0}
at risk (look fine, but exposed): {'web': 0.456}
what if db alone failed: {'web': 0.353, 'orders': 0.63}
```

In this demo the links are `web -> orders` (weight 0.8), `orders -> db` (0.9) and `web -> mail` (0.2).

By hand for `orders` (`p0` = 0.5 because it is degraded): `1 - (1 - 0.5) x (1 - 0.7 x 0.9 x 1.0)` = `1 - 0.5 x 0.37` = **0.815**.
For `web` (`p0` = 0, it is healthy itself): `1 - (1 - 0.7 x 0.8 x 0.815) x (1 - 0.7 x 0.2 x 0)` = **0.456**. `mail` has nothing failing below it, so it stays at 0. `web` is therefore the one service listed as at risk.

## Honest limits (say these first)

- **This is a model, not a measurement.** `tau` and the weights are stated assumptions. They have not been calibrated against recorded real cascades, because we did not record whether predicted failures happened. The dashboard labels these as estimates.
- What was validated against the fault injector is detection and the root-cause ranking (see `wiki/41-learning-and-calibration.md`), not the cascade probabilities.
- Changing `tau` changes the probabilities but hardly the order of the services.

## Questions an evaluator may ask

**Why a noisy-OR?** Each dependency is an independent route to failure, and the service fails if any route fires. Noisy-OR combines independent chances: 1 minus the chance that none fires.

**Why 0.7?** A judgement: most failures propagate but not all. It is shown in every output and can be changed in one place (`settings.py` / `DEFAULT_TRANSMISSION`).

**What about cycles?** Iterate to a fixed point. Probabilities only rise from `p0` and are bounded by 1, so the iteration converges.

**How is this different from root cause analysis?** RCA looks backwards from symptoms to the source. Cascade looks forwards from the failure to who is exposed. They use the same call graph in opposite directions.

**Which services are never marked at risk?** Ones with no failing dependency, and ones already failing themselves (they are incidents, not risks).

**Where do the weights come from?** `graph/edge_weights.py`: evidence behind the link (listening port and log lines count 1.0, an ephemeral-port sighting 0.85, a legacy observation 0.7, an unresolved direction 0.5, config-only 0.4), normalised across the caller's outgoing links, and monitoring traffic is multiplied by 0.1.

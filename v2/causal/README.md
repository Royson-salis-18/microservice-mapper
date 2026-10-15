# v2/causal: learning call directions from telemetry

The random walk that ranks root causes needs to know who calls whom. The collector sees connections, but most pairs
show up from both ends, so the direction is unknown. v1 guesses it from service names (`tierOf` and
`resolveDirections` in `server/algorithms/ml/mlEngine.ts`): entry names go first, stores and external names go last,
and a pair inside one tier stays mutual. This module learns the direction from what the services do, and then checks
whether better directions give a better root-cause ranking.

Short answer: the learned directions are much more accurate than the name rule, and they do not depend on names at
all. But the root-cause ranking hardly changes. Even the true call graph does not beat v1's ranking on these data.
Directions are not what limits the ranking today.

## Files

| file | what it does |
|---|---|
| `direction.ts` | `DirectionLearner`: online statistics per service and per pair, a score per method, the combined direction. Also the v1 name rule for comparison, `nameBlind` (rename services to s1..sn) and the truth lookup used for scoring. |
| `rca.ts` | `causalEngine`: V1.hybrid's detection, then facts first, then `rootCauseWalk` with the chosen directions. |
| `study.ts` | All tables, and `results.json`. |
| `run.ts` | Entry point that loads `study.ts` (see the note in the file: a v1 module runs its own command for any script named `run.ts`). |
| `causal.test.ts` | Unit tests on small synthetic series. |
| `results.json` | Every number below, plus per-class results. |

## How to run

From the repo root:

```
node server/node_modules/tsx/dist/cli.mjs v2/causal/run.ts
node server/node_modules/tsx/dist/cli.mjs --test v2/causal/causal.test.ts
```

The study takes about 6 minutes on 4 cores. It reads `v2/.cache/{real,tune,tune2,test}.json`.

## Method

Everything is online. The learner sees one moment at a time, in order. The direction used to rank moment i comes
from moments 0..i of the same run and nothing else. There is no warm-up fit and no data from other runs. A new
run starts with an empty learner.

### Indicators per service

For each service x at moment t, each reading is judged against the window of the last 120 readings before it:

- `H_x(t)`: a container fact (down, paused, restarting, detached). This is `ml[x][4]` from the v1 engine.
- Robust z-scores: `z = (v - median) / max(1.4826 * MAD, floor)` for the error share (floor 0.02), log p95 latency
  (floor 0.15) and log request rate (floor 0.15). A service without request metrics uses log received bytes instead.
- `U_x(t)`, upward symptom: not H, and `max(zE, zL) >= 3`. Errors and slow calls travel up to callers.
- `D_x(t)`, traffic drop: not H, and `zR <= -3`. Missing traffic travels down to callees.
- `S_x(t)`, source-like: H, or own (resource) level `ml[x][1] >= 1`.
- `T_x(t)`, trouble: H or U.

### Methods

Each method gives a score in [-1, 1] for "a calls b". Positive means a calls b. Zero means no evidence.

| method | score for "a calls b" | idea |
|---|---|---|
| edges | `(n(a->b) - n(b->a)) / (n(a->b) + n(b->a))` | the collector's own view; decides a pair seen from one end only |
| up | `lift(U_a | S_b) - lift(U_b | S_a)` | when the callee breaks, the caller shows errors and latency |
| down | `lift(D_b | S_a) - lift(D_a | S_b)` | when the caller breaks, the callee loses traffic |
| implication | `P(T_a | T_b) - P(T_b | T_a)` | whatever hurts b also hurts its caller, not the other way round |
| onset | `(#b first - #a first) / (total + 2)` | b's trouble starts within 6 moments before a's |
| xcorr | `max_k corr(y_b(t-k), y_a(t)) - max_k corr(y_a(t-k), y_b(t))`, k = 1..3 | the callee's changes lead |
| granger | `tanh((ln(1 + F_ba) - ln(1 + F_ab)) / 2)` | VAR(2) per pair: does b's past help predict a? |
| bytes | `tanh(r_b - r_a)`, `r = ln((tx + 50) / (rx + 50))` | servers send more than they receive |
| instrumented | share of moments with error metrics, a minus b | an HTTP service calls a store without such metrics |
| depth | `clamp(depth_b - depth_a, -1, 1)` | BFS depth from the entry on the undirected graph |

Details:

- `lift(X | C) = (k + m * base) / (n + m) - base`, where k of the n moments with condition C also had X, base is the
  overall share of X, and m = 4 pseudo-readings pull a thin sample towards no lift. Up and down are multiplied by 4
  and clipped.
- xcorr and granger run on two series: the v1 anomaly `ml[x][3]` and a symptom intensity
  `min(3, max(0, zE, zL) / 3)` (3 when H). Both keep running sums only, so they cost O(1) per pair per moment.
- Granger: one 7 x 7 Gram matrix per pair over `[1, a(t-1), a(t-2), b(t-1), b(t-2), a(t), b(t)]`. The residual sum
  of squares of the restricted model (own lags) and the full model (both lags) come from it by a small ridge solve.
  `F = ((RSS_r - RSS_f) / p) / (RSS_f / (n - 2p - 1))`, p = 2. Transfer entropy equals Granger causality for
  Gaussian series (Barnett, Barrett and Seth 2009), so it is not computed separately.
- depth: the entry is any service connected to a node the collector does not watch (the load generator, or outside
  clients). This reads no names.

### The combined direction

`s(a, b) = sum_m w_m * s_m(a, b)`. A pair seen mostly from one end (`|edges| >= 0.5`) keeps the collector's view,
as in v1. Otherwise `|s| < 0.05` leaves it mutual, and the sign of s decides.

Two weight presets were chosen by a grid search (each weight in {0, 0.5, 1, 2}, tau in {0.02, 0.05, 0.1, 0.2}) on
`tune.json` and `tune2.json` only. The objective was right minus wrong directions on pairs seen from both ends,
scored every 60 moments:

- **learned**: depth 1, implication 1, down 1, up 2, instrumented 2, granger-symptom 0.5.
- **dynamic**: only what the series do: implication 1, down 2, up 1, granger-symptom 0.5. No graph structure and no
  metric presence.

### Ranking

`rca.ts` keeps `max` from V1.hybrid, so detection, false alarms and alarm time are identical by construction. The
ranking is: container facts first, then `rootCauseWalk` with `a(v) = ml[v][3]` and
`own(v) = 1` for a fact, else `ownLevel >= 0.5 ? min(1, ownLevel / 2) : 0`, then the v1 level, then the id. The
directions come from one of:

- `none`: every pair mutual. This shows how much the walk depends on directions at all.
- `name`: v1's name rule. This replica gives exactly V1.hybrid's numbers on named data.
- `learned`, `dynamic`: the learner with that preset.
- `name+`: the name rule where it decides, the learned direction where it leaves a pair mutual.
- `oracle`: the true call graph. It reads `trueCalls`, so it is an analysis aid, not an engine.
- `learned + learned weights`: learned directions, and edge weight `0.25 + P(T_caller | T_callee)`.

## Results

Real: 2 recorded runs (ShopFlow, LedgerLine), 62 faults. Tune: tune + tune2, 16 runs, 170 faults (settings chosen
here). Test: 16 held-out runs, 178 faults, run once with the chosen settings.

### Direction accuracy

Counted on observed pairs that are true calls in one direction, once per run, with the learner state at the end of
the run. Accuracy is right / all; "unknown" counts as not right. Pairs that are true calls both ways (one in real)
are left out.

| data | pairs | collector view | v1 name rule | learned | dynamic |
|---|---|---|---|---|---|
| real | 31 | 3% (1) | 68% (21 right, 0 wrong, 10 unknown) | **90%** (28, 3, 0) | 81% (25, 4, 2) |
| real, name-blind | 31 | 3% | 3% (name rule adds nothing) | **90%** | 81% |
| tune | 238 | 46% | 87% (207, 0, 31) | **99%** (236, 2, 0) | 96% (229, 6, 3) |
| tune, name-blind | 238 | 46% | 46% | **99%** | 96% |
| test | 204 | 47% | 84% (172, 0, 32) | **97%** (197, 6, 1) | 93% (190, 12, 2) |
| test, name-blind | 204 | 47% | 47% | **97%** | 93% |

The pairs that matter are the ones the collector saw from both ends: 30 of 31 in real, 129 in tune, 109 in test.
On those alone, end of run:

| data | v1 name rule | learned | dynamic |
|---|---|---|---|
| real | 67% (20, 0, 10) | **90%** (27, 3, 0) | 80% (24, 4, 2) |
| tune | 76% (98, 0, 31) | **98%** (127, 2, 0) | 93% (120, 6, 3) |
| test | 71% (77, 0, 32) | **94%** (102, 6, 1) | 87% (95, 12, 2) |

Online, averaged over a checkpoint every 5 minutes (each using only the run so far), the learned directions on these
pairs are right 89% of the time on real (572 right, 66 wrong), 96% on tune and 93% on test. The name rule is at 66%,
76% and 71%. It is never wrong, but it leaves a quarter to a third of the pairs unknown, and with names removed it
decides none of them.

Single methods on both-ends pairs, end of run (right / all):

| method | real | tune | test |
|---|---|---|---|
| implication | 90% | 79% | 84% |
| depth | 70% | 84% | 81% |
| instrumented | 80% | 64% | 61% |
| granger-symptom | 67% | 71% | 72% |
| up | 67% | 58% | 65% |
| down | 60% | 72% | 65% |
| xcorr-anomaly | 60% | 55% | 61% |
| granger-anomaly | 57% | 55% | 48% |
| bytes | 57% | 46% | 55% |
| xcorr-symptom | 53% | 22% | 27% |
| onset | 27% (18 of 30 no evidence) | 28% | 25% |

What this says:

- The asymmetry of trouble works best: whatever hurts a callee also hurts its caller (implication), callers show
  errors when a callee breaks (up), callees lose traffic when a caller breaks (down). These need incidents in the
  run's own history, so they start empty.
- The lead-lag methods (xcorr, granger on the anomaly, onset) are weak. At 5 second readings, a failure and its
  effect on the caller usually land in the same reading. In the synthetic generator they always do, so there is no
  lag to find. xcorr on the symptom series even points the wrong way on synthetic data (22%, 27%), because a caller's
  errors can outlast the callee's outage in the robust baseline. Onset order is mostly ties.
- Granger on the symptom series does better (around 70%), but mostly from the size of the coupling, not from timing.
- Structure helps a lot: BFS depth from the entry is right on 81 to 84% of synthetic pairs and wrong on very few.
  It cannot order two services at the same depth, and it is wrong for workers that call into the system from the
  side (`notifier`, `statements-worker`).
- Byte asymmetry is about a coin flip.

### Root-cause ranking

Detection is V1.hybrid's in every row, so detected, false alarms per hour and alarm time are the same in each block.
"named" is caught and named first, as a count; "+/-" is faults gained and lost against V1.hybrid.

| data | engine | right-first | caught+named | named | +/- |
|---|---|---|---|---|---|
| real | v1 hybrid | 82% | 74% | 46 | |
| real | walk, all mutual | 75% | 68% | 42 | +0/-4 |
| real | walk, learned | 79% | 71% | 44 | +0/-2 |
| real | walk, dynamic | 79% | 71% | 44 | +0/-2 |
| real | walk, name+ | 79% | 71% | 44 | +0/-2 |
| real | walk, true directions | 80% | 73% | 45 | +0/-1 |
| real | walk, learned + weights | 77% | 69% | 43 | +0/-3 |
| tune | v1 hybrid | 84% | 78% | 132 | |
| tune | walk, all mutual | 82% | 76% | 130 | +2/-4 |
| tune | walk, learned | 84% | 78% | 132 | +1/-1 |
| tune | walk, true directions | 84% | 78% | 133 | +2/-1 |
| test | v1 hybrid | 79% | 72% | 128 | |
| test | walk, all mutual | 79% | 72% | 129 | +2/-1 |
| test | walk, learned | 79% | 72% | 128 | +0/-0 |
| test | walk, true directions | 79% | 72% | 128 | +0/-0 |

Detection in these blocks: real 90% detected, 6.2 false alarms/h; tune 93%, 0.8/h; test 92%, 0.8/h.

Name-blind (the v1 replica now sees names s1..sn, so its name rule falls back to the collector's view):

| data | v1 name rule, blind | learned, blind | true directions |
|---|---|---|---|
| real | 43 named (69%) | 44 (71%) | 45 (73%) |
| tune | 130 (76%) | 132 (78%) | 133 (78%) |
| test | 130 (73%) | 129 (72%) | 129 (72%) |

What this says:

- Learned directions do not improve the ranking. On real data they name 2 faults fewer than V1.hybrid (44 against
  46). On tune and test they tie.
- Without names they help a little where v1 is hurt: real 44 against 43, tune 132 against 130. On test the blind v1
  replica (130) is better than both learned (129) and the true graph (129).
- The true call graph is not a ceiling. On real it names 45, one fewer than v1's name rule. On test it ties v1.
- With every pair mutual the walk loses 4 on real and 2 on tune, and gains 1 on test. So directions are worth a few
  faults at most on these data.

Why so little: most faults are named either by a container fact (always ranked first) or by the target's own
resource anomaly, which keeps the walker on it whatever the edges say. The walk only decides between services that
are both anomalous without a fact, and there a mutual edge has a useful property: it lets the walker move but cannot
"explain away" a service (`randomWalk.ts`). Forcing a direction removes that hedge. On real LedgerLine, the two
faults lost by the learned directions show this. In f003 (crash of `accounts`), `accounts` and `fraud-screening` call
each other; the learner picks one direction, so `fraud-screening` becomes a sink and ranks first. In f003#2 (stop of
`statements-worker`) even the true graph ranks `fraud-screening` first.

## Limits

- The dynamic methods learn from incidents. Before the first incident in a run, only the collector view, depth and
  metric presence say anything, and early checkpoints are weaker (online accuracy is a few points below the
  end-of-run number).
- A pair that really calls both ways gets forced into one direction. Nothing here detects two-way calls.
- depth and instrumented are structural guesses, not measurements. They fail for side-entry workers and for
  services that report no request metrics but do call others (`notifier` in ShopFlow).
- The real set has 31 scorable pairs in two systems, so 90% against 68% is 28 against 21 pairs. The synthetic
  generator has no propagation delay, which favours same-moment statistics over lead-lag ones, and its random
  topologies are tree-like, which favours depth.
- Weights were chosen on tune and tune2 and then run once on test and real. Real was also looked at during
  development (method accuracies) before the final weights were fixed, but no setting was chosen on it.
- The RCA comparison changes only the edges. A learned propagation strength used as an edge weight
  (`learned + weights`) made real slightly worse (43) and left synthetic unchanged.

## Suggested use

Use the learned directions where the graph itself is shown or where names are unusual: they are right on about 90%
of real pairs and 97% of synthetic ones, with no names. For the root-cause walk, keep v1's ranking for now. If names
are unreliable, the walk with learned directions is at least as good as the name rule on two of the three data sets
and a fault ahead on real.

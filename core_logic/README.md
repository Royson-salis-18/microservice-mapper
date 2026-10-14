# core_logic

The decision-making of the mapper in plain Python, standard library only. Nothing here needs a server, Docker or a package install.
It is a simplified twin of the TypeScript in `../server/algorithms/` (same ideas, same numbers from `settings.py`; every file of it has a Python version in `../algorithms/`), written so the whole thing can be read and explained in a few minutes.

```
python core_logic/demo.py               # a made-up shop, one broken service, all four steps printed
python core_logic/test_core_logic.py    # 18 checks
```

| File | Question it answers | Size |
|---|---|---|
| `settings.py` | What are the numbers (thresholds, weights)? | one screen |
| `detector.py` | Is this service behaving abnormally compared with its own past? | ~120 lines |
| `root_cause.py` | Several services look bad: which one is the cause? | ~110 lines |
| `cascade.py` | Who will fail next, and what if service X failed? | ~70 lines |
| `demo.py` | Runs the three steps on a small shop | |
| `test_core_logic.py` | Proves the behaviours described below | |

## The three steps in one minute

**1. Detect (`detector.py`).** For each metric of each service: take the older samples as the baseline, find the median and the typical wobble (MAD), and measure how many wobbles the newest sample sits away from the median, only in the direction that is bad. Both of the last two samples must be abnormal. Old faults are left out of the baseline so a long outage never becomes "normal", and jumpy series are turned down so they do not raise false alarms.

**2. Find the cause (`root_cause.py`).** Failures travel from the called service to its callers. For each service: `score = max(own evidence, symptoms - what its dependencies explain)`, plus 100 if its container is stopped. The service with the highest score is the root cause. A service whose errors are explained by a broken dependency scores low: it is a victim.

**3. Predict the spread (`cascade.py`).** Each service has a starting failure probability `p0`. A caller inherits risk from each dependency: `P = 1 - (1 - p0) x product(1 - 0.7 x weight x P(callee))`. Repeat until the numbers settle. Services that look fine but have a high `P` are "at risk".

## Questions you may be asked

- *Why median and MAD, not mean and standard deviation?* One big spike drags the mean and the standard deviation up, hiding the next spike. Median and MAD barely move.
- *Why two samples?* One odd reading is usually noise. Two in a row is a trend. It costs one sample of delay.
- *Why compare a service with itself?* Normal differs per service. A fixed limit is wrong for most of them.
- *Why 0.7?* A dependency failing does not always take its caller down (retries, timeouts, caches). 0.7 is the share that gets through; it is a modelling choice, shown in every output, not a measured frequency.
- *What if two services are equally bad?* The current verdict is kept unless another beats it by 15%, and the confidence is reported as LOW when the margin is small.
- *Where does the real system differ?* The TypeScript adds silence rules based on expected request counts, a CPU-throttling signal, container facts from Docker, edge weights from how a link was discovered, and a per-service learned model. The logic above is the core of all of it.

"""All the numbers the logic uses, in one place. Same values as the TypeScript version in algorithms/."""

# --- detector -------------------------------------------------------------
MAD_TO_STD = 1.4826        # MAD * 1.4826 equals the standard deviation for bell-shaped data
Z_ALARM = 3.5              # a reading this many "normal wobbles" away counts as abnormal
Z_HIGH = 5.0               # severity levels
Z_CRITICAL = 8.0
Z_CAP = 50.0               # largest score we report
MIN_HISTORY = 12           # samples a service needs before we judge it at all
JUDGED = 2                 # the newest samples that are judged; all of them must be abnormal
SELF_HEAL_Z = 4.0          # old runs of 2+ samples above this are left out of the baseline
HEALTHY_QUANTILE = 0.995   # noisy series are turned down so their healthy extreme sits at HEALTHY_Z
HEALTHY_Z = 3.0
MIN_REQUESTS = 5           # latency and error share need at least this many requests to mean anything

# --- root cause -----------------------------------------------------------
EXPLAIN_AWAY = 1.0         # how much a broken dependency excuses its callers (0 = off)
HARD_FACT_BONUS = 100      # a stopped container beats any statistical score
INCUMBENT_BONUS = 1.15     # the current verdict must be beaten by 15% to be replaced

# --- cascade --------------------------------------------------------------
TRANSMISSION = 0.7         # share of a dependency's failure that reaches its caller
STATUS_PROBABILITY = {"critical": 1.0, "degraded": 0.5, "healthy": 0.0, "unknown": 0.0}
AT_RISK_MIN = 0.15

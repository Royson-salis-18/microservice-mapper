"""Link status: is a connection between two services fine, slow or failing?

Question answered: "given the error rate and latency measured on a link, what
colour is it: active, degraded or failed?"

Mirrors: server/algorithms/graph/linkThresholds.ts

Idea: two simple limits per measurement. An error rate of 1% or a latency of
300 ms makes a link "degraded"; 5% errors or 1000 ms makes it "failed". The
worse of the two measurements decides. The web client uses the same numbers to
draw edge colours, so a link is never drawn calm while its status says failed.
Latency should be the p95 when the source gives percentiles, the mean otherwise.

Left out compared with the TypeScript: nothing (the file is tiny).
"""

SLOW_MS = 300
VERY_SLOW_MS = 1000
ERROR_WARN = 0.01       # 1% of calls fail
ERROR_CRITICAL = 0.05   # 5% of calls fail


def link_status(error_rate=None, latency_ms=None):
    """Return 'failed', 'degraded' or 'active'. Missing numbers count as 0 (no evidence of trouble)."""
    err = error_rate or 0
    lat = latency_ms or 0
    if err >= ERROR_CRITICAL or lat >= VERY_SLOW_MS:
        return "failed"
    if err >= ERROR_WARN or lat >= SLOW_MS:
        return "degraded"
    return "active"


if __name__ == "__main__":
    samples = [(0.0, 40), (0.02, 120), (0.0, 450), (0.06, 50), (None, None), (0.0, 1200)]
    for err, lat in samples:
        print(f"error_rate={err}, latency_ms={lat} -> {link_status(err, lat)}")

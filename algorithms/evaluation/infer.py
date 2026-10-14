"""From the evidence the mapper recorded on its named root cause, guess what kind of fault it is.

Question answered: the injector applied a fault class and the mapper never knew it. Does
the evidence the mapper collected look like the evidence that class leaves behind?

Mirrors: server/algorithms/evaluation/infer.ts

Idea: eight injected classes collapse into five "families" an operator could tell apart
from outside the service: down (crash, stop, crash-loop), frozen (pause), slow (brownout,
flap), memory, isolated (partition). Evidence comes as tokens like "metric" or
"metric:reason". We look at them in a fixed priority order, most specific first: a paused
container beats everything, then network-detached, then plain container/restart facts,
memory, silence, and finally the latency/error/cpu or traffic-only patterns.
No evidence at all gives None (the caller counts that as "unclear").

Nothing was dropped from the TS; it is already pure logic.
"""

FAMILY_OF = {"crash": "down", "stop": "down", "crash-loop": "down", "pause": "frozen",
             "brownout": "slow", "flap": "slow", "memory": "memory", "partition": "isolated"}
FAMILIES = ["down", "frozen", "slow", "memory", "isolated"]


def infer_family(evidence):
    if not evidence:
        return None

    def has(s):
        # "silence" matches "silence" and "silence:something", but not "silenceX"
        return any(e == s or e.startswith(s + ":") for e in evidence)

    if has("container-health:container-paused"):
        return "frozen"
    if has("container-health:container-network-detached"):
        return "isolated"
    if has("container-health") or has("restarts"):
        return "down"
    if has("memoryPercent"):
        return "memory"
    if has("silence"):
        # silence plus traffic/network loss means unreachable; silence alone means frozen
        return "isolated" if has("requestRate") or has("networkRxRate") else "frozen"
    if has("requestRate") and (has("networkRxRate") or has("networkTxRate")) and not has("latency") and not has("errorRate"):
        return "isolated"
    if has("latency") or has("errorRate") or has("cpu") or has("cpuThrottledPct"):
        return "slow"
    if has("requestRate") or has("networkRxRate") or has("networkTxRate"):
        return "isolated"
    return None


if __name__ == "__main__":
    samples = [["container-health:container-paused"], ["restarts", "container-health"], ["memoryPercent"],
               ["latency", "errorRate", "cpu"], ["requestRate", "networkRxRate"], ["silence"], []]
    for ev in samples:
        print(f"{str(ev):<50} -> {infer_family(ev)}")
    print("class 'brownout' belongs to family:", FAMILY_OF["brownout"])

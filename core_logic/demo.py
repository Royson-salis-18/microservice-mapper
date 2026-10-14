"""Run the whole logic on a small made-up shop. No dependencies, no server:  python core_logic/demo.py

Shop:  mobile-api -> web -> cart -> cart-db      web -> payments -> bank-gateway
The payments service freezes: its CPU stays normal but it stops answering, so web's errors rise.
"""
import random

from cascade import at_risk, what_if
from detector import detect_service
from root_cause import confidence, rank_root_causes

random.seed(4)
N = 40                                           # 40 samples, the last 2 are "now"


def quiet(level, wobble):
    return [max(0.0, random.gauss(level, wobble)) for _ in range(N)]


def history(cpu=2.0, latency=40.0, errors=0.0, requests=20.0):
    return {"cpu": quiet(cpu, 0.3), "memory": quiet(30, 1.0), "latency": quiet(latency, 3),
            "error_rate": quiet(errors, 0.003), "request_rate": quiet(requests, 1.5),
            "request_count": [100.0] * N}


shop = {name: history() for name in ["mobile-api", "web", "cart", "cart-db", "payments", "bank-gateway"]}
shop["payments"]["request_rate"][-2:] = [1.0, 0.5]           # traffic collapses
shop["payments"]["latency"][-2:] = [900.0, 1100.0]           # what is left is very slow
shop["web"]["error_rate"][-2:] = [0.30, 0.35]                # web inherits the failure
shop["web"]["latency"][-2:] = [700.0, 800.0]

calls = [("mobile-api", "web", 1.0), ("web", "cart", 1.0), ("cart", "cart-db", 1.0), ("web", "payments", 1.0), ("payments", "bank-gateway", 0.85)]
services = {n: {"status": "healthy", "hard": False, "has_data": True, "findings": detect_service(h)} for n, h in shop.items()}

print("1. detector findings (per service)")
for name, svc in services.items():
    print(f"   {name:13s}", [(f['metric'], f['score']) for f in svc["findings"]] or "normal")

ranked = rank_root_causes(services, calls)
print("\n2. root cause ranking  (confidence:", confidence(ranked) + ")")
for r in ranked:
    print(f"   {r['service']:13s} score {r['score']:6.2f}   own {r['own']:5.2f}  symptom {r['symptom']:5.2f}  explained away {r['explained']:5.2f}")

print("\n3. who is next in line (cascade risk)")
for r in at_risk(services, calls) or [{"service": "nobody", "probability": 0, "via": []}]:
    print(f"   {r['service']:13s} {r['probability']:.0%} via {', '.join(r['via'])}")

print("\n4. what if bank-gateway went down?")
for name, p in what_if("bank-gateway", services, calls).items():
    print(f"   {name:13s} {p:.0%}")

"""Scoring: one "is this the cause?" score per service at one moment.

Question answered: "given the feature vectors, how likely is each service to be
the root cause right now?"

Mirrors: server/algorithms/detection/scoring.ts

Idea: two interchangeable scorers use the same 18 features.
  learned: a logistic regression fitted offline on labelled faults. Each feature is
           standardised ((x - mean) / std), multiplied by its weight, summed with a
           bias b, and passed through a sigmoid to give a probability 0..1.
  rules:   the hand-written fallback when no weights exist. Score = the larger of
           the service's own evidence and its symptoms that no broken callee
           explains, plus 10 for any container fact (down, paused, restarting,
           detached). Evidence is stored as log(1+z), so expm1 turns it back into z.
The per-target model (model/target_model.py) then sets the alarm threshold.

Weights is a dict {'mean': [...], 'std': [...], 'w': [...], 'b': float}.

Left out: types and the ServiceNode/MetricSnapshot models. Nodes are dicts with
'id' and 'name'; histories(id) returns that node's snapshot list.
"""
import math
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from detection.container_facts import is_load_generator
from detection.features import FEATURE_NAMES, feature_vectors, node_signals


def _idx(name):
    return FEATURE_NAMES.index(name)


def sigmoid(z):
    """Numerically stable logistic function (avoids overflow of exp for big |z|)."""
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def learned_score(weights, x):
    z = weights["b"]
    for j, value in enumerate(x):
        std = weights["std"][j] or 1          # a zero std would divide by zero
        z += weights["w"][j] * ((value - weights["mean"][j]) / std)
    return sigmoid(z)


def rules_score(x):
    facts = max(x[_idx("down")], x[_idx("paused")], x[_idx("restarting")], x[_idx("detached")])
    own = math.expm1(x[_idx("own")])
    # symptoms are discounted by the worst thing among the callees: if a dependency is
    # broken, the caller's slowness is explained by it and is not the cause
    unexplained = math.expm1(x[_idx("symptom")]) - math.expm1(x[_idx("calleesEvidenceMax")])
    return max(own, unexplained) + 10 * facts


def make_scorer(weights):
    """Returns (kind, score_function). Learned if weights are given, otherwise rules."""
    if weights:
        return "learned", lambda x: learned_score(weights, x)
    return "rules", rules_score


def moment_scores(nodes, histories, edges, scorer):
    """{node id: score} for the judged services. Load generators are not judged."""
    judged = [n for n in nodes if not is_load_generator(n["name"])]
    signals = [node_signals(n, histories(n["id"])) for n in judged]
    names = {n["id"]: n["name"] for n in nodes}
    vectors = feature_vectors(signals, edges, lambda i: names.get(i, i))
    _, score = scorer
    return {n["id"]: score(vectors[n["id"]]) for n in judged}


if __name__ == "__main__":
    # Hand-made vectors: web is slow because api (its callee) is broken.
    def vec(**kw):
        v = [0.0] * len(FEATURE_NAMES)
        for k, val in kw.items():
            v[_idx(k)] = val
        return v

    api = vec(own=math.log1p(9), cpu=math.log1p(9))                           # own cpu z = 9
    web = vec(symptom=math.log1p(9), calleesEvidenceMax=math.log1p(9))        # symptom z = 9, explained by api
    crashed = vec(down=1)
    for label, v in [("api (own evidence z=9)", api), ("web (symptom explained away)", web), ("crashed container", crashed)]:
        print(f"{label:30} rules score = {rules_score(v):.2f}")
    weights = {"mean": [0.0] * 18, "std": [1.0] * 18, "w": [1.5] + [0.0] * 17, "b": -2.0}
    print("learned score for api:", round(learned_score(weights, api), 3))

"""Container facts: what does the container runtime say about a service?

Question answered: "is this container down, paused, restarting, cut off from the
network, stopped on purpose, or fine?"

Mirrors: server/algorithms/detection/containerFacts.ts

Idea: docker reports state in messy ways ("exited (137)", "Exited (0) 2 minutes
ago", plain "exited" plus a separate exit code). We boil all of that down to one
fact. The important distinction is between a crash and a deliberate stop: a job
that finished with exit code 0, a container that was only created, or a load
generator someone switched off are "benign" and must NOT be reported as failures.
A non-zero exit, a dead or vanished container is "down".

A node here is a plain dict with optional keys: name, state, status_text,
exit_code, network_detached, vanished, health ("critical" when the source marked
it so). In the TypeScript these live inside node.metadata.

Left out: the TypeScript ServiceNode type and its metadata plumbing.
"""
import re

# Names of containers that exist only to produce traffic. They are not part of
# the system being judged, so stopping them is never a fault.
LOAD_GENERATOR = re.compile(
    r"(^|[-_])(traffic|user-sim|usersim|load-?gen|loadgenerator|locust|k6|jmeter|"
    r"gatling|stress|wrk2?|siege|vegeta|artillery)([-_]|$)",
    re.IGNORECASE,
)


def is_load_generator(name):
    return bool(LOAD_GENERATOR.search(name or ""))


def exit_code_of(node):
    """Exit code if known: an explicit number, else parsed from text like 'Exited (137)'."""
    code = node.get("exit_code")
    if isinstance(code, (int, float)) and not isinstance(code, bool):
        return code
    text = f"{node.get('state') or ''} {node.get('status_text') or ''}"
    hit = re.search(r"exited \((\d+)\)", text, re.IGNORECASE)
    return int(hit.group(1)) if hit else None


def container_fact(node):
    """Return 'down', 'paused', 'restarting', 'detached', 'benign' or None (running fine / unknown)."""
    state = str(node.get("state") or "").lower()
    base = re.split(r"[\s(]", state)[0]          # "exited (137)" -> "exited"

    if node.get("network_detached") and base == "running":
        return "detached"                         # alive but on no network
    if base == "paused":
        return "paused"
    if base == "restarting":
        return "restarting"
    if base == "created":
        return "benign"                           # never started: not a failure
    if base in ("exited", "dead", "removing") or state == "not found" or node.get("vanished"):
        if is_load_generator(node.get("name")):
            return "benign"                       # traffic is started/stopped by people
        if base == "exited" and exit_code_of(node) == 0:
            return "benign"                       # finished cleanly
        return "down"
    # No runtime state at all, but the source flagged it critical (e.g. listed in
    # the compose file yet missing from `docker ps`).
    if not base and node.get("health") == "critical":
        return "down"
    return None


if __name__ == "__main__":
    examples = [
        {"name": "api", "state": "running"},
        {"name": "api", "state": "exited (137)"},
        {"name": "migrate", "state": "Exited (0) 2 minutes ago"},
        {"name": "traffic-gen", "state": "exited", "exit_code": 1},
        {"name": "db", "state": "paused"},
        {"name": "cache", "state": "running", "network_detached": True},
        {"name": "web", "state": "", "health": "critical"},
        {"name": "web", "state": "created"},
    ]
    for n in examples:
        print(f"{n['name']:12} state={n.get('state')!r:28} -> {container_fact(n)}")

#!/usr/bin/env bash
# Steady-load steps, NO faults. The organic traffic container is stopped; a closed-loop load generator holds a constant number of
# concurrent visitors and the level is stepped (for example 2, 8, 2, 0, 20, 2) every few minutes. A step is a sustained change of the
# work every service is given: busier or quieter, not broken. Every alarm in the recording is a false alarm by construction.
#   run/scripts/workload-steps-experiment.sh <shopflow|ledgerline> [phases]      phases: "2:8 8:6 2:6 0:6 20:5 2:5" (concurrency:minutes)
set -uo pipefail
SUBJECT=${1:?subject}; PHASES=${2:-"2:8 8:6 2:6 0:6 20:5 2:5"}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH=$([ "$SUBJECT" = shopflow ] && echo /home/user/bench-1 || echo /home/user/bench-2)
PORT=$([ "$SUBJECT" = shopflow ] && echo 8080 || echo 8081)
KEY=${LAB_KEY:-/tmp/claude-0/sshkey/lab_key}
OUT="$ROOT/run/recorded-runs/steps/$SUBJECT"; mkdir -p "$OUT"; rm -f "$OUT"/*
MAPPER=http://127.0.0.1:3001; TSX="$ROOT/server/node_modules/tsx/dist/cli.mjs"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }
other=$([ "$SUBJECT" = shopflow ] && echo ledgerline || echo shopflow)
docker ps -q --filter "label=com.docker.compose.project=$other" | xargs -r docker stop >/dev/null
docker ps -aq --filter "label=com.docker.compose.project=$SUBJECT" | xargs -r docker start >/dev/null
docker stop "$SUBJECT-traffic-1" >/dev/null 2>&1
mv "$ROOT/server/data" "$ROOT/server/data.real" 2>/dev/null; mkdir -p "$ROOT/server/data"
GEN=0
stopgen() { [ "$GEN" != 0 ] && kill "$GEN" 2>/dev/null; GEN=0; }
trap 'stopgen; kill ${SRV:-0} ${OBS:-0} 2>/dev/null; docker start '"$SUBJECT"'-traffic-1 >/dev/null 2>&1; sleep 2; rm -rf "$ROOT/server/data"; mv "$ROOT/server/data.real" "$ROOT/server/data" 2>/dev/null' EXIT
cd "$ROOT/server"
MAPPER_AUTO_RESTART=off PORT=3001 setsid nohup node node_modules/tsx/dist/cli.mjs index.ts >"$OUT/server.log" 2>&1 </dev/null & SRV=$!
for i in $(seq 90); do curl -sf "$MAPPER/api/targets" >/dev/null && break; sleep 2; done
curl -sf -X POST "$MAPPER/api/config/remote" -H 'content-type: application/json' -d "{\"targetId\":\"$SUBJECT\",\"projectName\":\"$SUBJECT\",\"ec2PublicIp\":\"127.0.0.1\",\"sshKeyPath\":\"$KEY\",\"sshUsername\":\"root\"}" >/dev/null
curl -sf -X POST "$MAPPER/api/engine" -H 'content-type: application/json' -d '{"mode":"ml"}' >/dev/null
cd "$ROOT"
node "$TSX" run/cli/eval/run.ts observe --subject "$SUBJECT" --target "$SUBJECT" --observed "$OUT/observed-$SUBJECT.jsonl" --interval 5 >"$OUT/observe.log" 2>&1 & OBS=$!
for ph in $PHASES; do
  conc=${ph%%:*}; mins=${ph##*:}
  stopgen
  if [ "$conc" != 0 ]; then node "$BENCH/$SUBJECT/loadgen/loadgen.mjs" --continuous --base "http://127.0.0.1:$PORT" --concurrency "$conc" --think-ms 400 >"$OUT/loadgen-$conc.log" 2>&1 & GEN=$!; fi
  echo "$(date +%s) $conc" >>"$OUT/phases.log"; log "load: $conc concurrent visitors for $mins min"
  sleep $((mins*60))
done
stopgen
curl -sf "$MAPPER/api/engine/info" >"$OUT/engine-info.json" || true
log "done"

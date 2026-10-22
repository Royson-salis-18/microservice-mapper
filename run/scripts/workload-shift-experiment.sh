#!/usr/bin/env bash
# Workload-shift recording: NO faults at all. Traffic runs, stops, runs, stops longer, runs again, while the mapper watches over SSH
# and an outside observer records what it says. Every alarm in this recording is a false alarm by construction: nothing was broken,
# only the amount of work changed. Used to test that a detector does not mistake a change of load for a fault.
#   run/scripts/workload-shift-experiment.sh <shopflow|ledgerline> [phases]      phases: "on:8 off:5 on:5 off:8 on:5" (minutes)
set -uo pipefail
SUBJECT=${1:?subject}; PHASES=${2:-"on:8 off:5 on:5 off:8 on:5"}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KEY=${LAB_KEY:-/tmp/claude-0/sshkey/lab_key}
OUT="$ROOT/run/recorded-runs/workload/$SUBJECT"; mkdir -p "$OUT"; rm -f "$OUT"/*
MAPPER=http://127.0.0.1:3001; TSX="$ROOT/server/node_modules/tsx/dist/cli.mjs"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }
other=$([ "$SUBJECT" = shopflow ] && echo ledgerline || echo shopflow)
docker ps -q --filter "label=com.docker.compose.project=$other" | xargs -r docker stop >/dev/null
docker ps -aq --filter "label=com.docker.compose.project=$SUBJECT" | xargs -r docker start >/dev/null
mv "$ROOT/server/data" "$ROOT/server/data.real" 2>/dev/null; mkdir -p "$ROOT/server/data"
trap 'kill ${SRV:-0} ${OBS:-0} 2>/dev/null; docker start '"$SUBJECT"'-traffic-1 >/dev/null 2>&1; sleep 2; rm -rf "$ROOT/server/data"; mv "$ROOT/server/data.real" "$ROOT/server/data" 2>/dev/null' EXIT
cd "$ROOT/server"
MAPPER_AUTO_RESTART=off PORT=3001 setsid nohup node node_modules/tsx/dist/cli.mjs index.ts >"$OUT/server.log" 2>&1 </dev/null & SRV=$!
for i in $(seq 90); do curl -sf "$MAPPER/api/targets" >/dev/null && break; sleep 2; done
curl -sf -X POST "$MAPPER/api/config/remote" -H 'content-type: application/json' -d "{\"targetId\":\"$SUBJECT\",\"projectName\":\"$SUBJECT\",\"ec2PublicIp\":\"127.0.0.1\",\"sshKeyPath\":\"$KEY\",\"sshUsername\":\"root\"}" >/dev/null
curl -sf -X POST "$MAPPER/api/engine" -H 'content-type: application/json' -d '{"mode":"ml"}' >/dev/null
cd "$ROOT"
node "$TSX" run/cli/eval/run.ts observe --subject "$SUBJECT" --target "$SUBJECT" --observed "$OUT/observed-$SUBJECT.jsonl" --interval 5 >"$OUT/observe.log" 2>&1 & OBS=$!
for ph in $PHASES; do
  state=${ph%%:*}; mins=${ph##*:}
  if [ "$state" = on ]; then docker start "$SUBJECT-traffic-1" >/dev/null; else docker stop "$SUBJECT-traffic-1" >/dev/null; fi
  echo "$(date +%s) $state" >>"$OUT/phases.log"; log "traffic $state for $mins min"
  sleep $((mins*60))
done
curl -sf "$MAPPER/api/engine/info" >"$OUT/engine-info.json" || true
log "done"

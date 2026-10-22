#!/usr/bin/env bash
# Targeted auto-restart test: stop two containers by hand (Fault Lab `stop`, 5 min each) and record, once a second,
# whether each is running again and when. With auto-restart on the mapper may bring one back before the injector does.
#   run/scripts/autorestart-stop-test.sh <on|off>        (ShopFlow, mapper reaches the local host over SSH like the other experiment)
set -uo pipefail
MODE=${1:?on|off}; SUBJECT=shopflow
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; BENCH=/home/user/bench-1
KEY=${LAB_KEY:-/tmp/claude-0/sshkey/lab_key}
OUT="$ROOT/run/recorded-runs/autorestart/stop-test-$MODE"; mkdir -p "$OUT"; rm -f "$OUT"/*
MAPPER=http://127.0.0.1:3001; log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }
docker ps -q --filter "label=com.docker.compose.project=ledgerline" | xargs -r docker stop >/dev/null
docker ps -aq --filter "label=com.docker.compose.project=$SUBJECT" | xargs -r docker start >/dev/null
node "$BENCH/lab/faultlab/faultlab.mjs" $SUBJECT heal >/dev/null 2>&1
mv "$ROOT/server/data" "$ROOT/server/data.real" 2>/dev/null; mkdir -p "$ROOT/server/data"
trap 'kill ${SRV:-0} ${POLL:-0} 2>/dev/null; sleep 2; rm -rf "$ROOT/server/data"; mv "$ROOT/server/data.real" "$ROOT/server/data" 2>/dev/null' EXIT
cd "$ROOT/server"
MAPPER_AUTO_RESTART=$MODE PORT=3001 setsid nohup node node_modules/tsx/dist/cli.mjs index.ts >"$OUT/server.log" 2>&1 </dev/null & SRV=$!
for i in $(seq 90); do curl -sf "$MAPPER/api/targets" >/dev/null && break; sleep 2; done
curl -sf -X POST "$MAPPER/api/config/remote" -H 'content-type: application/json' -d "{\"targetId\":\"$SUBJECT\",\"projectName\":\"$SUBJECT\",\"ec2PublicIp\":\"127.0.0.1\",\"sshKeyPath\":\"$KEY\",\"sshUsername\":\"root\"}" >/dev/null
log "mapper up, auto-restart $MODE; warming up 4 min"; sleep 240
( while true; do for c in cart payments; do echo "$(date +%s) $c $(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' shopflow-$c-1)"; done; sleep 2; done >"$OUT/state.log" ) & POLL=$!
for svc in cart payments; do
  log "stop $svc for 5 min"
  node "$BENCH/lab/faultlab/faultlab.mjs" $SUBJECT inject $svc stop --for 5m --ledger "$OUT/ledger-$SUBJECT.jsonl" >>"$OUT/faultlab.log" 2>&1
  log "$svc released by the injector"; sleep 45
done
log "done"

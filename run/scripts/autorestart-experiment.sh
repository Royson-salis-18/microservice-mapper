#!/usr/bin/env bash
# One live experiment: replay the SAME Fault Lab plan against a bench with the mapper's auto-restart on or off, and score it.
#   run/scripts/autorestart-experiment.sh <shopflow|ledgerline> <on|off> [seed] [fault-minutes] [warmup-minutes]
# Needs: the bench running in Docker on this machine, and `ssh root@127.0.0.1` working with the key in $LAB_KEY
# (the mapper reaches the host over SSH, the only path where auto-restart exists). Output: run/recorded-runs/autorestart/<subject>-<mode>/
set -euo pipefail
SUBJECT=${1:?subject}; MODE=${2:?on|off}; SEED=${3:-11}; MINUTES=${4:-18}; WARM=${5:-6}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BENCH=$([ "$SUBJECT" = shopflow ] && echo /home/user/bench-1 || echo /home/user/bench-2)
KEY=${LAB_KEY:-/tmp/claude-0/sshkey/lab_key}
OUT="$ROOT/run/recorded-runs/autorestart/$SUBJECT-$MODE"; mkdir -p "$OUT"; rm -f "$OUT"/*.jsonl
MAPPER=http://127.0.0.1:3001
TSX="$ROOT/server/node_modules/tsx/dist/cli.mjs"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }

other=$([ "$SUBJECT" = shopflow ] && echo ledgerline || echo shopflow)
docker ps -q --filter "label=com.docker.compose.project=$other" | xargs -r docker stop >/dev/null
docker ps -aq --filter "label=com.docker.compose.project=$SUBJECT" | xargs -r docker start >/dev/null
node "$BENCH/lab/faultlab/faultlab.mjs" "$SUBJECT" heal >/dev/null 2>&1 || true

mv "$ROOT/server/data" "$ROOT/server/data.real" 2>/dev/null || true; mkdir -p "$ROOT/server/data"
trap 'kill ${SRV:-0} ${OBS:-0} 2>/dev/null || true; sleep 2; rm -rf "$ROOT/server/data"; mv "$ROOT/server/data.real" "$ROOT/server/data" 2>/dev/null || true' EXIT
cd "$ROOT/server"
MAPPER_AUTO_RESTART=$([ "$MODE" = off ] && echo off || echo on) PORT=3001 setsid nohup node node_modules/tsx/dist/cli.mjs index.ts >"$OUT/server.log" 2>&1 </dev/null & SRV=$!
for i in $(seq 90); do curl -sf "$MAPPER/api/targets" >/dev/null && break; sleep 2; done
log "mapper up (auto-restart $MODE)"
curl -sf -X POST "$MAPPER/api/config/remote" -H 'content-type: application/json' \
  -d "{\"targetId\":\"$SUBJECT\",\"projectName\":\"$SUBJECT\",\"ec2PublicIp\":\"127.0.0.1\",\"sshKeyPath\":\"$KEY\",\"sshUsername\":\"root\"}" >/dev/null
curl -sf -X POST "$MAPPER/api/engine" -H 'content-type: application/json' -d '{"mode":"hybrid"}' >/dev/null
log "target $SUBJECT registered, hybrid engine; warming up ${WARM} min"
sleep $((WARM*60))

cd "$ROOT"
node "$TSX" run/cli/eval/run.ts observe --subject "$SUBJECT" --target "$SUBJECT" --observed "$OUT/observed-$SUBJECT.jsonl" --interval 5 >"$OUT/observe.log" 2>&1 & OBS=$!
log "campaign start: seed $SEED, $MINUTES min, stormy, crash/stop/pause/brownout"
node "$BENCH/lab/faultlab/faultlab.mjs" "$SUBJECT" run --profile stormy --seed "$SEED" --duration "${MINUTES}m" --classes crash,stop,pause,brownout --ledger "$OUT/ledger-$SUBJECT.jsonl" >"$OUT/faultlab.log" 2>&1 || true
log "campaign done; 90 s of grace"
sleep 90
curl -sf "$MAPPER/api/engine/info" >"$OUT/engine-info.json" || true
grep -c "restart" "$OUT/server.log" | xargs -I{} echo "restart log lines: {}" | tee -a "$OUT/run.log"
kill $OBS 2>/dev/null || true; sleep 2
node "$TSX" run/cli/eval/run.ts all --subject "$SUBJECT" --ledger "$OUT/ledger-$SUBJECT.jsonl" --observed "$OUT/observed-$SUBJECT.jsonl" --out "$OUT" --warmup 0 --traffic "$SUBJECT-traffic-1" >"$OUT/score.log" 2>&1 || true
log "scored: $OUT/eval-$SUBJECT.json"

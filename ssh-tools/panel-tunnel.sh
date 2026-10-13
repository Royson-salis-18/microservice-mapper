#!/usr/bin/env bash
# Start the fault/traffic panel on the bench host and open it on your machine at http://localhost:8099 (Ctrl-C stops both).
#   ssh-tools/panel-tunnel.sh <public-ip> <key.pem> [user] [subject=shopflow]
set -euo pipefail
IP="${1:?public ip}"; KEY="${2:?key.pem}"; USER_="${3:-ubuntu}"; SUBJ="${4:-shopflow}"; KEY="${KEY/#\~/$HOME}"
echo "panel: http://localhost:8099  (Ctrl-C to stop)"
exec ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -L 8099:localhost:8099 "$USER_@$IP" "cd ~/bench && node lab/faultlab/panel.mjs $SUBJ"

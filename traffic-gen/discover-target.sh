#!/usr/bin/env bash
set -euo pipefail

TARGET_ID="${1:?target id required, e.g. sock-shop}"
PUBLIC_IP="${2:?public IP required}"
KEY_FILE="${3:?path to .pem key file required}"
SSH_USER="${4:-ubuntu}"

if [[ ! -f "$KEY_FILE" ]]; then
  echo "Key file not found: $KEY_FILE" >&2
  exit 1
fi
chmod 400 "$KEY_FILE" 2>/dev/null || true
echo "Connecting to ${SSH_USER}@${PUBLIC_IP} ..."
REMOTE_INFO=$(ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new "${SSH_USER}@${PUBLIC_IP}" 'sudo ss -ltnp 2>/dev/null | grep LISTEN || netstat -ltnp 2>/dev/null | grep LISTEN')
echo "$REMOTE_INFO"
PORT=80
if ! echo "$REMOTE_INFO" | grep -q ':80 '; then
  PORT=$(echo "$REMOTE_INFO" | grep -oE ':[0-9]+->80' | head -1 | grep -oE '^:[0-9]+' | tr -d ':' || true)
  PORT="${PORT:-80}"
fi
BASE_URL="http://${PUBLIC_IP}${PORT:+:${PORT}}"
[[ "$PORT" == "80" ]] && BASE_URL="http://${PUBLIC_IP}"
echo "Detected base URL: $BASE_URL"
if curl -sf -o /dev/null --max-time 5 "$BASE_URL"; then echo "Verified reachable."; else echo "WARNING: could not reach $BASE_URL" >&2; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '{\n  "%s": "%s"\n}\n' "$TARGET_ID" "$BASE_URL" > "$SCRIPT_DIR/targets.json"
echo "Wrote $TARGET_ID -> $BASE_URL to $SCRIPT_DIR/targets.json"

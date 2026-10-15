#!/usr/bin/env bash
# Is this host ready to be mapped? Run on your own machine (Mac/Linux, or Git Bash on Windows).
#   run/ssh/check-host.sh <public-ip> <key.pem> [user]
# Prints one line per check and says what to fix. Changes nothing on the host.
set -u
IP="${1:-}"; KEY="${2:-}"; USER_="${3:-ubuntu}"
[ -n "$IP" ] && [ -n "$KEY" ] || { echo "usage: $0 <public-ip> <key.pem> [user]"; exit 2; }
KEY="${KEY/#\~/$HOME}"
ok() { echo "  ok    $*"; }; bad() { echo "  FAIL  $*"; }
[ -f "$KEY" ] && ok "key file exists" || { bad "key file not found: $KEY"; exit 1; }
chmod 600 "$KEY" 2>/dev/null && ok "key permissions 600" || bad "could not chmod the key"
case "$IP" in 10.*|172.1[6-9].*|172.2?.*|172.3[01].*|192.168.*) bad "$IP is a private address: use the instance's PUBLIC IPv4 from the EC2 console";; esac
if command -v nc >/dev/null; then nc -z -w 6 "$IP" 22 2>/dev/null && ok "port 22 reachable" || { bad "port 22 not reachable: open TCP 22 for your IP in the security group, or the IP changed after a stop/start"; exit 1; }; fi
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 "$USER_@$IP")
out=$("${SSH[@]}" 'echo hello; docker info >/dev/null 2>&1 && echo DOCKER_OK || echo DOCKER_NO; docker compose ls 2>/dev/null | tail -n +2; docker ps -q 2>/dev/null | wc -l' 2>&1) || { bad "ssh failed: $out"; exit 1; }
ok "ssh login works"
echo "$out" | grep -q DOCKER_OK && ok "docker usable by $USER_ (no sudo)" || bad "docker not usable by $USER_: sudo usermod -aG docker $USER_ , then log out and in"
echo "  compose projects / running containers:"; echo "$out" | grep -v -e hello -e DOCKER_ | sed 's/^/        /'

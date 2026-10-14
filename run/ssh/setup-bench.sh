#!/usr/bin/env bash
# Install and start the ShopFlow bench (app + organic traffic + monitoring + fault panel prerequisites) on a fresh Ubuntu EC2 host.
#   run/ssh/setup-bench.sh <public-ip> <key.pem> [user]
set -euo pipefail
IP="${1:?public ip}"; KEY="${2:?key.pem}"; USER_="${3:-ubuntu}"; KEY="${KEY/#\~/$HOME}"
chmod 600 "$KEY"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$USER_@$IP")
"${SSH[@]}" 'curl -fsSL https://raw.githubusercontent.com/Royson-salis-18/bench-1/faultlab/bootstrap/ec2-setup.sh | BRANCH=faultlab bash -s -- shopflow'
"${SSH[@]}" 'command -v node >/dev/null || sudo apt-get install -y nodejs'     # the fault panel is a small node script
echo; echo "Done. Next: run/ssh/check-host.sh $IP $KEY $USER_   then add the host in the mapper (see run/ssh/README.md)."

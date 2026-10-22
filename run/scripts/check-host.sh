#!/usr/bin/env bash
# Is it the host or the mapper? Checks one benchmark instance step by step and says where it stops working.
#
#   npm run check-host -- <public-ip> [key.pem] [app-port]
#   npm run check-host -- 13.201.78.55 ~/Downloads/sock-shop-key.pem 8080
#
# Run it on the machine the mapper runs on, so it sees what the mapper sees. (`npm run hosts` lists every target.)
IP="${1:?usage: npm run check-host -- <public-ip> [key.pem] [app-port]}"
KEY="${2:-$HOME/Downloads/sock-shop-key.pem}"
PORT="${3:-8080}"
USER_NAME="${SSH_USER:-ubuntu}"
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '       %s\n' "$*"; }

echo "1. network: can this machine reach $IP:22 ?"
if nc -z -w 6 "$IP" 22 2>/dev/null; then ok "port 22 answers"; else
  bad "port 22 does not answer"
  note "HOST side: the instance is still starting, stopped, has a new address, or its security group does not allow SSH from this machine."
  note "Check the status checks in the EC2 console (need 2/2) and that the group allows 22 from your IP."
  exit 1
fi

echo "2. key: $KEY"
if [ ! -f "$KEY" ]; then bad "file not found"; note "MAPPER config: fix sshKeyPath (npm run hosts -- key <target> <path>)"; exit 1; fi
perms=$(stat -f '%Lp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY" 2>/dev/null)
if [ "$perms" != "400" ] && [ "$perms" != "600" ]; then bad "permissions are $perms, ssh refuses it"; note "run: chmod 400 $KEY"; exit 1; fi
ok "found, permissions $perms"

echo "3. ssh login as $USER_NAME"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$USER_NAME@$IP")
if ! "${SSH[@]}" 'echo ok' >/dev/null 2>&1; then
  bad "login failed"
  note "Wrong user (Ubuntu images use ubuntu, Amazon Linux uses ec2-user: SSH_USER=ec2-user npm run check-host -- ...) or the instance was launched with a different key pair."
  exit 1
fi
ok "logged in"

echo "4. the host itself (memory, load, disk)"
LOAD=$("${SSH[@]}" -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "uptime; free -m | sed -n 2,3p; df -h / | tail -n 1; nproc" 2>&1)
if [ -z "$LOAD" ]; then bad "the host did not answer a plain command"; note "HOST side: it is overloaded or frozen. Reboot it from the EC2 console, or use a larger instance."; exit 1; fi
echo "$LOAD" | sed 's/^/         /'
note "(free -m: Mem total/used/free, Swap; the last number is the CPU count)"

echo "5. docker on the host (waits 25 s)"
OUT=$("${SSH[@]}" -o ServerAliveInterval=5 -o ServerAliveCountMax=6 "timeout 25 docker ps --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>&1; echo EXIT=\$?" 2>&1)
if echo "$OUT" | grep -q "EXIT=124"; then
  bad "docker did not answer within 25 s"
  note "HOST side: the machine is too busy for docker to respond (look at step 4: low free memory, heavy swap or load above the CPU count)."
  note "The mapper's own scan asks docker the same way, so it would see nothing from this host either. Use a larger instance or stop other stacks on it."
  exit 1
fi
if echo "$OUT" | grep -qi "permission denied\|cannot connect\|command not found"; then
  bad "docker is not usable by $USER_NAME"; note "$(echo "$OUT" | head -n 1)"; note "run on the host: sudo usermod -aG docker $USER_NAME   (then log in again), or install docker"; exit 1
fi
N=$(echo "$OUT" | grep -c '|')
if [ "$N" -eq 0 ]; then
  bad "no containers are running"
  note "HOST side: the benchmark was never started on this instance. Start it (docker compose up -d) and give it a few minutes."
  exit 1
fi
ok "$N containers running"
echo "$OUT" | grep '|' | grep -iE "restarting|unhealthy|exited" | sed 's/^/       PROBLEM: /'

echo "6. the app answers on port $PORT"
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://$IP:$PORT/" 2>/dev/null)
if [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
  bad "no answer from http://$IP:$PORT/"
  note "HOST side: the front end is not up yet, crashed (low memory), or the security group does not allow $PORT from this machine."
else ok "http $CODE"; fi

echo "8. who do the front-end containers talk to?  (the mapper can only draw an edge to another container)"
FRONT="${FRONT:-front|nginx|proxy|gateway|web}"
"${SSH[@]}" "python3 - '$FRONT'" <<'PY' 2>&1 | sed 's/^/       /'
import re, socket, struct, subprocess, sys, collections
def sh(c):
    return subprocess.run(c, shell=True, capture_output=True, text=True).stdout
pattern = re.compile(sys.argv[1], re.I)
ip2name = {}
boxes = []
for line in sh("docker ps --format '{{.ID}} {{.Names}}'").splitlines():
    cid, name = line.split(None, 1)
    boxes.append((cid, name))
    for ip in sh("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' " + cid).split():
        ip2name[ip] = name
def hexaddr(h):
    ip, port = h.split(':')
    return socket.inet_ntoa(struct.pack('<I', int(ip, 16))), int(port, 16)
found = False
for cid, name in boxes:
    if not pattern.search(name):
        continue
    found = True
    pid = sh("docker inspect -f '{{.State.Pid}}' " + cid).strip()
    try:
        rows = open('/proc/%s/net/tcp' % pid).read().splitlines()[1:]
    except Exception as e:
        print('%s: cannot read its sockets (%s)' % (name, e))
        continue
    seen = collections.Counter()
    for r in rows:
        f = r.split()
        if len(f) < 4 or f[3] not in ('01', '06', '08', '04', '05'):
            continue
        lip, lport = hexaddr(f[1]); rip, rport = hexaddr(f[2])
        if lport < 32768 and rport >= 32768:
            continue  # someone calling this container, not this container calling out
        seen[(rip, rport)] += 1
    if not seen:
        print('%s: no outgoing sockets right now (it makes none, or none are open at this moment)' % name)
        continue
    print('%s calls:' % name)
    for (rip, rport), n in seen.most_common(8):
        who = ip2name.get(rip)
        print('   %s:%d  x%d  -> %s' % (rip, rport, n, who if who else 'NOT A CONTAINER (host or outside address): the mapper cannot name this peer'))
if not found:
    print('no container name matches %s; run again with FRONT=<part of its name>' % sys.argv[1])
PY

echo "9. the mapper"
MAPPER="${MAPPER_URL:-http://localhost:3001}"
if curl -s -m 5 "$MAPPER/api/status" >/dev/null 2>&1; then
  ok "mapper server answers at $MAPPER"
  note "If steps 1-8 passed and the mapper still shows nothing for this host, the cause is on the mapper side: send the server log lines for this project."
else bad "mapper server is not running at $MAPPER"; fi

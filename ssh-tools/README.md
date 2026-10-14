# ssh-tools: reaching a host, and how the mapper does it

Scripts you run on **your own machine** (the cloud sandbox this was written in cannot open port 22, so nothing here was run against a live EC2 host by the author; the checks are simple and read-only).

| Script | What it does | Changes the host? |
|---|---|---|
| `check-host.sh <ip> <key> [user]` | key file, permissions, private-IP mistake, port 22, login, docker access, compose projects | no |
| `setup-bench.sh <ip> <key> [user]` | installs Docker, clones bench-1 (`faultlab` branch), starts ShopFlow + traffic + monitoring, installs node | yes |
| `panel-tunnel.sh <ip> <key> [user] [subject]` | starts the fault and traffic panel on the host and tunnels it to `http://localhost:8099` | starts one process |

## Saved hosts went stale

EC2 public IPs change on every stop/start. The mapper keeps the last IP it was given in `server/data/remote_config.json`, so after a restart of the instance every connection times out (`Timed out while waiting for handshake`). Fix the IP in the app (Edit project) or from a terminal:

```
npm run hosts                                 # list targets and whether port 22 answers
npm run hosts -- set bench1 43.204.141.48     # new public IP
npm run hosts -- remove bench2                # a host that no longer exists
```

## The algorithm the mapper uses (SSH discovery path)

Source: `server/connection/SSHConnection.ts`, `server/discovery/EndpointDiscoveryEngine.ts`, `server/util/platform.ts`.

1. **Resolve the key** (`resolveKeyPath`): strip quotes; expand `~`, `$HOME`, `%USERPROFILE%`; if the file is missing, look for the same file name in `~/.ssh`, `~/Downloads`, `~/Desktop`, `~/Documents`.
2. **Connect** with `ssh2` to `host:22` as the given user, 15 s ready timeout. The key is read once; permissions do not matter to `ssh2` (they do for the terminal tab, which shells out to OpenSSH, so `keyPathForOpenSSH` makes a 600 copy).
3. **Read the compose manifest** at the configured path (default search: the host's running compose projects) to learn declared services and dependencies.
4. **Observe**: `docker ps`, `docker stats`, `/proc/net/tcp` inside each container for ESTABLISHED sockets (direction from listening ports), container logs for HTTP lines.
5. **Merge** declared and observed into one graph with edge confidence; unmeasured values stay null.

The push path (`remote-collector`, used by `npm run local`) does steps 4 and 5 from a machine that has the Docker socket, and also reads each service's own request log lines for request rate, error rate and latency.

## Why a host will not connect

| Symptom | Cause | Fix |
|---|---|---|
| timeout on port 22 | security group, wrong or stale IP | open TCP 22 for your IP; use the current public IPv4 (it changes on stop/start without an Elastic IP) |
| `banner exchange` timeout | instance hung or out of memory (small types) | reboot it; look at "Get system log" |
| `Permission denied (publickey)` | wrong key or user, or you are on the wrong machine | the key belongs to the instance's key pair; user is `ubuntu` on Ubuntu AMIs |
| 172.x / 10.x address | private IP | use the public IPv4 |
| `docker: permission denied` | user not in the docker group | `sudo usermod -aG docker ubuntu`, log out and in |
| nothing in the graph | no compose project running | `docker compose ls` on the host |

Never commit a `.pem`. Rotate any key that has been pasted into a chat or a ticket.

/**
 * Reading who talks to whom from a container's /proc/net/tcp.
 *
 * Each connection shows up in the table of BOTH containers, so a socket only means "I call them" on the client's side.
 * Two things were wrong with taking every established socket as an outgoing call:
 *   - the server's view of the same connection pointed the edge the wrong way round (a database "calling" the service),
 *   - a front end or proxy that opens a connection per request (nginx in front of a service, for instance) is almost never
 *     ESTABLISHED at the instant of the sample, so it showed no edges at all.
 * Recently closed sockets (TIME_WAIT and friends) stay in the table for a minute and catch those.
 */

/** TCP states that mean a connection was in use a moment ago: ESTABLISHED, FIN_WAIT1/2, TIME_WAIT, CLOSE_WAIT. */
const LIVE_STATES = new Set(['01', '04', '05', '06', '08']);
/** Linux picks client ports from here up (net.ipv4.ip_local_port_range default 32768-60999). */
const EPHEMERAL_FROM = 32768;

export function hexToIp(hex: string): string {
  if (hex.length !== 8) return '';
  const a = parseInt(hex.substring(6, 8), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const c = parseInt(hex.substring(2, 4), 16);
  const d = parseInt(hex.substring(0, 2), 16);
  return `${a}.${b}.${c}.${d}`;
}

export interface Socket { localPort: number; remoteIp: string; remotePort: number; state: string }

/** The sockets in a /proc/net/tcp dump that count as traffic. */
export function parseTcpTable(text: string): Socket[] {
  const out: Socket[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || !LIVE_STATES.has(parts[3])) continue;
    const [, localPortHex] = parts[1].split(':');
    const [remoteIpHex, remotePortHex] = parts[2].split(':');
    if (!remoteIpHex || !remotePortHex) continue;
    out.push({ localPort: parseInt(localPortHex, 16), remoteIp: hexToIp(remoteIpHex), remotePort: parseInt(remotePortHex, 16), state: parts[3] });
  }
  return out;
}

/**
 * Which way the call went. The side with the high, random port is the caller; the side with the service port is the callee.
 * `self` is the container whose table this is, `peer` the one at the other end. Both ports high or both low: unclear, keep
 * the table owner as the caller (the old behaviour).
 */
export function callDirection(s: Socket, self: string, peer: string): { caller: string; callee: string; port: number } {
  const selfIsClient = s.localPort >= EPHEMERAL_FROM && s.remotePort < EPHEMERAL_FROM;
  const selfIsServer = s.localPort < EPHEMERAL_FROM && s.remotePort >= EPHEMERAL_FROM;
  if (selfIsServer) return { caller: peer, callee: self, port: s.localPort };
  if (selfIsClient) return { caller: self, callee: peer, port: s.remotePort };
  return { caller: self, callee: peer, port: s.remotePort };
}

/** Which way a container's sockets say a call went, and which sockets count. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTcpTable, callDirection, hexToIp } from '../../remote-collector/sockets.ts';

// 172.18.0.12 is 0C0012AC in /proc/net/tcp byte order; port 6379 is 18EB; 59282 is E792
const row = (state: string, localPort: number, remoteIp: string, remotePort: number) => {
  const hex = (ip: string) => ip.split('.').reverse().map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase();
  return `  0: 0D0012AC:${localPort.toString(16).toUpperCase().padStart(4, '0')} ${hex(remoteIp)}:${remotePort.toString(16).toUpperCase().padStart(4, '0')} ${state} 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 20 4 30 10 -1`;
};

test('hexToIp reads the kernel byte order', () => {
  assert.equal(hexToIp('0C0012AC'), '172.18.0.12');
});

test('sockets: recently closed ones count, listening and unrelated ones do not', () => {
  const table = ['  sl  local_address rem_address   st', row('01', 59282, '172.18.0.12', 6379), row('06', 59283, '172.18.0.12', 6379), row('0A', 80, '0.0.0.0', 0), row('07', 1, '172.18.0.9', 2)].join('\n');
  const got = parseTcpTable(table);
  assert.deepEqual(got.map((s) => s.state), ['01', '06']);
  assert.equal(got[0].remoteIp, '172.18.0.12');
  assert.equal(got[0].remotePort, 6379);
  assert.equal(got[0].localPort, 59282);
});

test('direction: the side with the random port is the caller, from either table', () => {
  const client = { localPort: 59282, remoteIp: '', remotePort: 6379, state: '01' };
  const server = { localPort: 6379, remoteIp: '', remotePort: 59282, state: '01' };
  assert.deepEqual(callDirection(client, 'timeline', 'redis'), { caller: 'timeline', callee: 'redis', port: 6379 });
  assert.deepEqual(callDirection(server, 'redis', 'timeline'), { caller: 'timeline', callee: 'redis', port: 6379 });
});

test('direction: when neither port tells, the table owner stays the caller', () => {
  const s = { localPort: 8080, remoteIp: '', remotePort: 9090, state: '01' };
  assert.deepEqual(callDirection(s, 'a', 'b'), { caller: 'a', callee: 'b', port: 9090 });
});

import { isHostSideAddress } from '../../server/telemetry-platform/src/collection/MetricCollector.ts';
test('host-side addresses: private, loopback and link-local yes; the internet no', () => {
  for (const ip of ['172.17.0.1', '172.31.4.9', '10.0.3.7', '192.168.1.5', '127.0.0.1', '169.254.169.254']) assert.equal(isHostSideAddress(ip), true, ip);
  for (const ip of ['13.201.78.55', '172.32.0.1', '8.8.8.8', '', 'not-an-ip']) assert.equal(isHostSideAddress(ip), false, ip);
});

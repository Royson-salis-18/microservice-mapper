/**
 * The remote-command sanitizers are the only thing standing between a value
 * and a shell on someone else's machine. Each test here is a payload that
 * must never reach a command string.
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { REMOTE_COMMANDS } from '../server/telemetry-platform/src/connection/RemoteCommand.ts';

const VALID_ISO = '2026-01-01T00:00:00Z';
const VALID_ID = 'a1b2c3d4e5f6';

const INJECTIONS = [
  '; rm -rf /',
  '$(whoami)',
  '`id`',
  '&& echo pwned',
  '| cat /etc/passwd',
  "' ; echo x ; '",
  'a\nrm -rf /',
];

test('container ids: injection payloads are refused', () => {
  for (const bad of INJECTIONS) {
    assert.throws(() => REMOTE_COMMANDS.dockerInspect(bad), /unsafe identifier/, `accepted: ${bad}`);
    assert.throws(() => REMOTE_COMMANDS.dockerContainerTcp(bad), /unsafe identifier/, `accepted: ${bad}`);
    assert.throws(() => REMOTE_COMMANDS.dockerInspectLite(bad), /unsafe identifier/, `accepted: ${bad}`);
    assert.throws(() => REMOTE_COMMANDS.dockerNetworkInspect(bad), /unsafe identifier/, `accepted: ${bad}`);
  }
});

test('timestamps: lenient Date.parse formats are refused', () => {
  // The regression: V8 parses these, so a Date.parse-only check let the
  // payload through into `docker logs --since`.
  const sneaky = [
    'Jan 1 2026 $(whoami)',
    'Jan 1 2026 `id`',
    '2026-01-01T00:00:00Z extra',
    'now',
    '',
  ];
  for (const bad of [...sneaky, ...INJECTIONS]) {
    assert.throws(
      () => REMOTE_COMMANDS.dockerLogs(VALID_ID, bad, 100),
      /invalid ISO timestamp/,
      `accepted: ${JSON.stringify(bad)}`
    );
  }
});

test('timestamps: real ISO-8601 forms are accepted', () => {
  for (const good of [
    '2026-01-01T00:00:00Z',
    '2026-09-18T12:34:56.789Z',
    '2026-09-18T12:34:56+05:30',
    new Date().toISOString(),
  ]) {
    const cmd = REMOTE_COMMANDS.dockerLogs(VALID_ID, good, 100);
    assert.ok(cmd.command.includes(good), `rejected valid ISO: ${good}`);
  }
});

test('paths: traversal and metacharacters are refused', () => {
  for (const bad of ['/etc/../etc/passwd', '/tmp/x; id', '/tmp/$(id)', 'relative/path', '/tmp/a b']) {
    assert.throws(() => REMOTE_COMMANDS.catFile(bad), /unsafe path/, `accepted: ${bad}`);
  }
  assert.ok(REMOTE_COMMANDS.catFile('/home/ubuntu/app/docker-compose.yml').command.includes('docker-compose.yml'));
});

test('tail: only sane positive integers', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, 100_001]) {
    assert.throws(() => REMOTE_COMMANDS.dockerLogs(VALID_ID, VALID_ISO, bad as number), /unsafe tail/);
  }
  assert.ok(REMOTE_COMMANDS.dockerLogs(VALID_ID, VALID_ISO, 200).command.includes('--tail 200'));
});

test('no command contains an unexpanded template placeholder', () => {
  const built = [
    REMOTE_COMMANDS.dockerPs(),
    REMOTE_COMMANDS.dockerStats(),
    REMOTE_COMMANDS.dockerVersion(),
    REMOTE_COMMANDS.dockerInspect(VALID_ID),
    REMOTE_COMMANDS.dockerLogs(VALID_ID, VALID_ISO, 10),
  ];
  for (const c of built) {
    assert.doesNotMatch(c.command, /\$\{/, `unexpanded placeholder in ${c.name}`);
    assert.ok(c.timeoutMs > 0 && c.maxOutputBytes > 0, `${c.name} missing bounds`);
  }
});

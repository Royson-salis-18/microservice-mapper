/**
 * The mapper must behave the same on macOS, Linux and Windows. These cover the
 * pieces that differ by OS: key paths written on another machine, key
 * permissions for OpenSSH, the Docker socket and the Python binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveKeyPath, keyPathForOpenSSH, dockerOptions, pythonCmd, localShell, IS_WINDOWS } from '../server/util/platform.ts';

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(home); } finally { process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE; }
}

test('resolveKeyPath expands ~/ and ~\\ and strips quotes', () => withHome((home) => {
  fs.mkdirSync(path.join(home, 'Downloads'));
  const key = path.join(home, 'Downloads', 'k.pem'); fs.writeFileSync(key, 'x');
  assert.equal(resolveKeyPath('~/Downloads/k.pem'), key);
  assert.equal(resolveKeyPath('~\\Downloads\\k.pem').replace(/\\/g, '/'), key.replace(/\\/g, '/'));
  assert.equal(resolveKeyPath(`"${key}"`), key);
  assert.equal(resolveKeyPath('  '), '');
}));

test('a key path saved on Windows still works on a Mac (same file name in ~/Downloads or ~/.ssh)', () => withHome((home) => {
  fs.mkdirSync(path.join(home, '.ssh'));
  const key = path.join(home, '.ssh', 'sock-shop-key.pem'); fs.writeFileSync(key, 'x');
  assert.equal(resolveKeyPath('C:\\Users\\MITE\\Downloads\\sock-shop-key.pem'), key);
  assert.equal(resolveKeyPath('/home/olduser/Downloads/sock-shop-key.pem'), key);
}));

test('a missing key keeps the path the user gave, so the error names it', () => withHome(() => {
  assert.equal(resolveKeyPath('/nowhere/missing.pem'), '/nowhere/missing.pem');
}));

test('OpenSSH gets a private (0600) copy of a world-readable key; the original is untouched', { skip: IS_WINDOWS }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-key-test-'));
  const key = path.join(dir, 'k.pem'); fs.writeFileSync(key, 'secret'); fs.chmodSync(key, 0o644);
  const used = keyPathForOpenSSH(key);
  assert.notEqual(used, key);
  assert.equal(fs.statSync(used).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(used, 'utf8'), 'secret');
  assert.equal(fs.statSync(key).mode & 0o777, 0o644);
  fs.chmodSync(key, 0o600);
  assert.equal(keyPathForOpenSSH(key), key);
});

test('DOCKER_HOST wins over the platform socket', () => {
  const saved = process.env.DOCKER_HOST;
  process.env.DOCKER_HOST = 'tcp://127.0.0.1:2375';
  try { assert.deepEqual(dockerOptions(), {}); } finally { if (saved === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = saved; }
  const opts = dockerOptions();
  assert.ok(opts.socketPath, 'a socket path is always chosen when DOCKER_HOST is unset');
});

test('MAPPER_PYTHON overrides the python binary; otherwise a Python 3 name is chosen', () => {
  process.env.MAPPER_PYTHON = '/opt/venv/bin/python';
  try { assert.equal(pythonCmd(), '/opt/venv/bin/python'); } finally { delete process.env.MAPPER_PYTHON; }
  assert.match(pythonCmd(), /^(python3?|py)$/);
});

test('the local terminal uses the platform shell', () => {
  const { cmd } = localShell();
  if (IS_WINDOWS) assert.equal(cmd, 'powershell.exe'); else assert.ok(cmd.length > 0);
});

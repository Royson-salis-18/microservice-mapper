#!/usr/bin/env node
'use strict';

const { TrafficEngine } = require('./engine');
const targets = { 'sock-shop': require('./workflows/sockshop'), vertikal: require('./workflows/vertikal') };

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const targetId = arg('target', 'sock-shop');
const baseUrl = arg('base-url');
const profileName = arg('profile', 'BASELINE');
const users = arg('users') ? +arg('users') : undefined;
const durationSec = arg('duration') ? +arg('duration') : null;
const username = arg('username', process.env.SOCKSHOP_USERNAME);
const password = arg('password', process.env.SOCKSHOP_PASSWORD);

if (!baseUrl) {
  console.error('Usage: node cli.js --target sock-shop --base-url http://<ip> --profile MODERATE --users 15 --duration 300');
  process.exit(1);
}

const mod = targets[targetId];
if (!mod || mod.STUB) {
  console.error(`Target "${targetId}" is unavailable or a stub.`);
  process.exit(1);
}

const profile = mod.profiles[profileName] || mod.profiles.BASELINE;
const engine = new TrafficEngine({
  baseUrl,
  workflows: mod.workflows,
  workflowWeights: profile.workflowWeights || mod.defaultWorkflowWeights,
  users: users ?? profile.users,
  spawnRatePerSec: profile.spawnRatePerSec,
  defaultThinkTimeMs: profile.defaultThinkTimeMs,
  durationSec,
  maxUsers: 20,
  maxConcurrency: 20,
  maxErrorRate: 0.35,
  auth: username && password ? { username, password } : null,
  requestTimeoutMs: 8000,
});

engine.on('stopped', (stats) => {
  console.log('\nFinal stats:', JSON.stringify(stats, null, 2));
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nStopping...');
  engine.stop();
});

setInterval(() => {
  const s = engine.getStats();
  process.stdout.write(
    `\rusers=${s.currentUsers} reqs=${s.requestsCompleted} ok=${s.requestsSuccessful} fail=${s.requestsFailed} rate=${s.currentRate}/s p95=${s.p95LatencyMs}ms   `
  );
}, 1000);

console.log(`Starting ${targetId} traffic against ${baseUrl} (profile=${profileName})...`);
engine.start();

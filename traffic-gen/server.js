'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const path = require('path');
const { TrafficEngine } = require('./engine');
const sockshop = require('./workflows/sockshop');
const vertikal = require('./workflows/vertikal');
const deathstar = require('./workflows/deathstar');
const trainticket = require('./workflows/trainticket');
const opentelemetry = require('./workflows/opentelemetry');

const TARGETS = {
  'sock-shop': sockshop,
  vertikal: vertikal,
  'death-star': deathstar,
  'train-ticket': trainticket,
  'open-telemetry': opentelemetry,
};

const TARGETS_CONFIG_PATH = path.join(__dirname, 'targets.json');
function loadSavedUrls() {
  try {
    return JSON.parse(fs.readFileSync(TARGETS_CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveUrl(targetId, baseUrl, projectId = targetId) {
  const data = loadSavedUrls();
  const current = typeof data[projectId] === 'string' ? { targetId, baseUrl: data[projectId] } : (data[projectId] || {});
  data[projectId] = { ...current, targetId, baseUrl };
  fs.writeFileSync(TARGETS_CONFIG_PATH, JSON.stringify(data, null, 2));
}

function saveProjectEndpoints(projectId, endpoints) {
  const data = loadSavedUrls();
  const current = typeof data[projectId] === 'string' ? { baseUrl: data[projectId] } : (data[projectId] || {});
  data[projectId] = { ...current, endpoints };
  fs.writeFileSync(TARGETS_CONFIG_PATH, JSON.stringify(data, null, 2));
}

function saveProjectSettings(projectId, settings) {
  const data = loadSavedUrls();
  const current = typeof data[projectId] === 'string' ? { baseUrl: data[projectId] } : (data[projectId] || {});
  data[projectId] = { ...current, settings: { ...(current.settings || {}), ...settings } };
  fs.writeFileSync(TARGETS_CONFIG_PATH, JSON.stringify(data, null, 2));
}

function parseArchitecture(output, host) {
  const containers = [];
  const dockerSection = output.split('__DOCKER_CONTAINERS__')[1]?.split('__LOCAL_HTTP_PROBES__')[0] || '';
  for (const line of dockerSection.split('\n').map(item => item.trim()).filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 2 || parts[0] === 'NAMES') continue;
    const ports = parts[2] || '';
    const exposed = [...ports.matchAll(/(?:0\.0\.0\.0|\[::\]):(\d+)->(\d+)/g)].map(match => ({ hostPort: +match[1], containerPort: +match[2] }));
    containers.push({ name: parts[0], image: parts[1], ports, exposed, reachable: exposed.length > 0 });
  }
  const listening = [];
  const listenSection = output.split('__LISTENING_PORTS__')[1]?.split('__DOCKER_CONTAINERS__')[0] || '';
  for (const match of listenSection.matchAll(/(?:0\.0\.0\.0|\[::\]|\*):([0-9]+)/g)) {
    const port = +match[1];
    if (!listening.some(item => item.port === port)) listening.push({ port, url: `http://${host}:${port}` });
  }
  return { listening, containers };
}

function dynamicWorkflows(paths) {
  const steps = paths.map((path, index) => ({ id: `endpoint_${index + 1}`, method: 'GET', path, thinkTimeMs: [300, 1200] }));
  return { discovered: { id: 'discovered', name: 'Discovered endpoints', steps } };
}

function cfgAuthWeights(weights, authenticated) {
  if (authenticated) return weights;
  const filtered = weights.map(item => ({ ...item, weight: ['account', 'checkout'].includes(item.key) ? 0 : item.weight }));
  if (filtered.every(item => item.weight <= 0)) return [{ key: 'browse', weight: 80 }, { key: 'cart', weight: 20 }];
  return filtered;
}

const reachability = {};
async function checkReachable(projectId, baseUrl) {
  if (!baseUrl) {
    reachability[projectId] = { reachable: false, checkedAt: Date.now(), error: 'not configured' };
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(baseUrl, { signal: controller.signal });
    clearTimeout(timer);
    reachability[projectId] = { reachable: resp.status < 500, checkedAt: Date.now(), statusCode: resp.status };
  } catch (err) {
    reachability[projectId] = { reachable: false, checkedAt: Date.now(), error: err.message };
  }
}

function refreshAllReachability() {
  for (const [projectId, value] of Object.entries(loadSavedUrls())) {
    const baseUrl = typeof value === 'string' ? value : value.baseUrl;
    if (baseUrl) checkReachable(projectId, baseUrl);
  }
}
refreshAllReachability();
setInterval(refreshAllReachability, 30000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const engines = new Map();

function broadcastStats() {
  for (const [projectId, entry] of engines) {
    broadcastEvent('stats', { projectId, targetId: entry.targetId, running: entry.engine.running, ...entry.engine.getStats() });
  }
}
setInterval(broadcastStats, 1000);

function broadcastEvent(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

app.get('/api/targets', (req, res) => {
  const saved = loadSavedUrls();
  res.json(
    Object.entries(TARGETS).map(([id, mod]) => ({
      id,
      workflows: Object.keys(mod.workflows),
      profiles: Object.keys(mod.profiles),
      stub: !!mod.STUB,
      baseUrl: typeof saved[id] === 'string' ? saved[id] : saved[id]?.baseUrl || null,
      reachability: reachability[id] || null,
    }))
  );
});

app.get('/api/projects', (req, res) => {
  const saved = loadSavedUrls();
  res.json(Object.entries(saved).map(([projectId, value]) => ({
    projectId,
    targetId: typeof value === 'string' ? projectId : value.targetId,
    baseUrl: typeof value === 'string' ? value : value.baseUrl,
    endpoints: typeof value === 'string' ? [] : value.endpoints || [],
    architecture: typeof value === 'string' ? null : value.architecture || null,
    settings: typeof value === 'string' ? {} : value.settings || {},
    running: engines.get(projectId)?.engine.running || false,
    stats: engines.has(projectId) ? engines.get(projectId).engine.getStats() : null,
  })));
});

app.post('/api/projects', (req, res) => {
  const { projectId, targetId = 'sock-shop', baseUrl } = req.body;
  if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
    return res.status(400).json({ error: 'projectId is required and may contain only letters, numbers, ., _, or -' });
  }
  if (!TARGETS[targetId]) return res.status(400).json({ error: `unknown targetId: ${targetId}` });
  if (loadSavedUrls()[projectId]) return res.status(409).json({ error: `project ${projectId} already exists` });
  saveUrl(targetId, baseUrl || '', projectId);
  res.status(201).json({ ok: true, projectId, targetId, baseUrl: baseUrl || null, endpoints: [] });
});

app.post('/api/discover', (req, res) => {
  const { targetId, host, sshUser, keyPath, port } = req.body;
  const projectId = req.body.projectId || targetId;
  if (!TARGETS[targetId]) return res.status(400).json({ error: `unknown targetId: ${targetId}` });
  if (!host || !keyPath) return res.status(400).json({ error: 'host and keyPath are required' });
  const resolvedKeyPath = keyPath.replace(/^~(?=$|\/)/, process.env.HOME || '');
  if (!fs.existsSync(resolvedKeyPath)) return res.status(400).json({ error: `key file not found on this server at: ${resolvedKeyPath}` });

  const user = sshUser || 'ubuntu';
  const remoteCmd = [
    'echo __LISTENING_PORTS__',
    'sudo -n ss -ltnp 2>/dev/null || ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null',
    'echo __DOCKER_CONTAINERS__',
    'docker ps --format "{{.Names}}\\t{{.Image}}\\t{{.Ports}}" 2>/dev/null || true',
    'echo __LOCAL_HTTP_PROBES__',
    'for p in 80 3000 3001 4000 5000 5173 8000 8080 9090; do code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$p/" 2>/dev/null || true); test "$code" != 000 && test -n "$code" && echo "$p $code"; done',
  ].join('; ');
  const sshArgs = ['-i', resolvedKeyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', `${user}@${host}`, remoteCmd];

  execFile('ssh', sshArgs, { timeout: 15000 }, async (err, stdout, stderr) => {
    if (err && !stdout) return res.status(502).json({ error: `SSH failed: ${stderr || err.message}` });

    let detectedPort = 80;
    if (port) detectedPort = port;
    else if (!/:80\s/.test(stdout)) {
      const match = stdout.match(/:(\d{2,5})\s+.*LISTEN/);
      if (match) detectedPort = match[1];
    }

    const baseUrl = detectedPort == 80 ? `http://${host}` : `http://${host}:${detectedPort}`;
    saveUrl(targetId, baseUrl, projectId);
    await checkReachable(projectId, baseUrl);
    const architecture = parseArchitecture(stdout, host);
    const data = loadSavedUrls();
    const current = typeof data[projectId] === 'string' ? { baseUrl: data[projectId] } : (data[projectId] || {});
    data[projectId] = { ...current, targetId, baseUrl, architecture };
    fs.writeFileSync(TARGETS_CONFIG_PATH, JSON.stringify(data, null, 2));
    res.json({ ok: true, projectId, targetId, baseUrl, reachable: reachability[projectId], architecture, remoteDiscovery: stdout.trim() });
  });
});

app.post('/api/probe', async (req, res) => {
  const projectId = req.body.projectId || 'project';
  const saved = loadSavedUrls()[projectId];
  const baseUrl = req.body.baseUrl || (typeof saved === 'string' ? saved : saved?.baseUrl);
  const paths = Array.isArray(req.body.paths) ? req.body.paths : String(req.body.paths || '').split(/[\s,]+/);
  if (!baseUrl) return res.status(400).json({ error: 'connect or provide a baseUrl first' });
  const cleanPaths = [...new Set(paths.map(path => path.trim()).filter(path => path.startsWith('/')))];
  if (!cleanPaths.length) return res.status(400).json({ error: 'provide at least one path beginning with /' });
  const results = await Promise.all(cleanPaths.slice(0, 30).map(async path => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(baseUrl.replace(/\/$/, '') + path, { signal: controller.signal, redirect: 'manual' });
      return { path, statusCode: response.status, location: response.headers.get('location'), contentType: response.headers.get('content-type') };
    } catch (err) {
      return { path, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }));
  const confirmed = results.filter(result => result.statusCode >= 200 && result.statusCode < 400).map(result => ({
    path: result.path,
    statusCode: result.statusCode,
    location: result.location,
    contentType: result.contentType,
    enabled: result.statusCode < 400,
  }));
  saveProjectEndpoints(projectId, confirmed);
  res.json({ projectId, baseUrl, results, endpoints: confirmed });
});

app.post('/api/start', (req, res) => {
  try {
    const { targetId, profile, users, workflowWeights: requestedWorkflowWeights, durationSec, maxUsers, maxConcurrency, endpointPaths } = req.body;
    const projectId = req.body.projectId || targetId;
    let { baseUrl, targetUrl } = req.body;
    const mod = TARGETS[targetId];
    if (!mod) return res.status(400).json({ error: `unknown targetId: ${targetId}` });
    if (!baseUrl) {
      const saved = loadSavedUrls()[projectId];
      baseUrl = typeof saved === 'string' ? saved : saved?.baseUrl;
    }
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required (connect to AWS first, or supply baseUrl)' });
    const configuredPaths = endpointPaths || (loadSavedUrls()[projectId]?.endpoints || []).filter(endpoint => endpoint.enabled).map(endpoint => endpoint.path);
    const useDiscoveredEndpoints = Boolean(req.body.useDiscoveredEndpoints) || mod.STUB;
    const isDynamic = useDiscoveredEndpoints && Array.isArray(configuredPaths) && configuredPaths.length > 0;
    if (mod.STUB && !isDynamic) return res.status(400).json({ error: `${targetId} needs confirmed endpoints before starting` });
    if (engines.get(projectId)?.engine.running) return res.status(409).json({ error: `project ${projectId} is already running` });
    saveUrl(targetId, baseUrl, projectId);
    saveProjectSettings(projectId, { profile, users, durationSec, workflowWeights: requestedWorkflowWeights, endpointPaths: configuredPaths });
    targetUrl = targetUrl || baseUrl;

    const profileCfg = mod.profiles[profile] || mod.profiles.BASELINE;

    const workflows = isDynamic ? dynamicWorkflows(configuredPaths) : mod.workflows;
    const requestedWeights = requestedWorkflowWeights || profileCfg.workflowWeights || mod.defaultWorkflowWeights;
    const effectiveWorkflowWeights = cfgAuthWeights(requestedWeights, Boolean(req.body.authUsername && req.body.authPassword));
    const cfg = {
      baseUrl: targetUrl,
      workflows,
      workflowWeights: isDynamic ? [{ key: 'discovered', weight: 100 }] : effectiveWorkflowWeights,
      users: users ?? profileCfg.users,
      spawnRatePerSec: profileCfg.spawnRatePerSec,
      defaultThinkTimeMs: profileCfg.defaultThinkTimeMs,
      durationSec: durationSec || null,
      maxUsers: Math.min(maxUsers || 20, 20),
      maxConcurrency: Math.min(maxConcurrency || 20, 20),
      // These are RCA/failure-injection experiments: services are *expected*
      // to fail and the point is to observe it. 1 is the max engine.js
      // accepts and means "never auto-throttle on error rate" (see
      // TrafficEngine._applySafetyLimit in engine.js).
      maxErrorRate: 1,
      auth: req.body.authUsername && req.body.authPassword ? { username: req.body.authUsername, password: req.body.authPassword } : null,
      // sock-shop's /login has been taking 4-22s under load, well past the
      // old 8s timeout, so every checkout died there before ever reaching
      // payment/shipping. 30s gives it room to actually finish.
      requestTimeoutMs: 30000,
    };

    const engine = new TrafficEngine(cfg);
    engines.set(projectId, { targetId, engine });
    engine.on('requestCompleted', (d) => broadcastEvent('request', { projectId, ...d }));
    engine.on('stopped', (d) => broadcastEvent('stopped', { projectId, ...d }));
    engine.on('safetyReduced', (d) => {
      console.warn(`[TRAFFIC] target=${targetId} project=${projectId} safety=reduce users=${d.users} errorRate=${d.errorRate}`);
      broadcastEvent('safetyReduced', { projectId, ...d });
    });
    engine.start();
    console.log(`[TRAFFIC] target=${targetId} project=${projectId} users=${cfg.users} maxConcurrency=${cfg.maxConcurrency} duration=${cfg.durationSec || 'unlimited'}`);

    res.json({ ok: true, projectId, targetId, config: { ...cfg, workflows: undefined, auth: cfg.auth ? { configured: true } : null } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/update', (req, res) => {
  const projectId = req.body.projectId || req.query.projectId || 'sock-shop';
  const entry = engines.get(projectId);
  if (!entry || !entry.engine.running) return res.status(409).json({ error: `project ${projectId} is not running` });
  try {
    entry.engine.update(req.body);
    saveProjectSettings(projectId, {
      users: entry.engine.config.users,
      workflowWeights: entry.engine.config.workflowWeights,
      endpointPaths: req.body.endpointPaths || entry.engine.config.endpointPaths,
    });
    res.json({ ok: true, projectId, config: { ...entry.engine.config, workflows: undefined } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/stop', (req, res) => {
  const projectId = req.body.projectId || req.query.projectId || 'sock-shop';
  const entry = engines.get(projectId);
  if (!entry) return res.json({ ok: true, projectId, note: 'nothing running' });
  entry.engine.stop();
  res.json({ ok: true, projectId, finalStats: entry.engine.getStats() });
});

app.get('/api/stats', (req, res) => {
  const projectId = req.query.projectId;
  if (projectId) {
    const entry = engines.get(projectId);
    if (!entry) return res.json({ projectId, running: false });
    return res.json({ projectId, targetId: entry.targetId, running: entry.engine.running, ...entry.engine.getStats() });
  }
  res.json({ projects: Object.fromEntries([...engines].map(([id, entry]) => [id, { targetId: entry.targetId, running: entry.engine.running, ...entry.engine.getStats() }])) });
});

const PORT = process.env.PORT || 4400;
server.listen(PORT, () => {
  console.log(`traffic-gen control server listening on :${PORT}`);
});

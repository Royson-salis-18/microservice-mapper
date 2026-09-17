'use strict';

/**
 * Generic organic-traffic engine.
 * Target-agnostic: it knows nothing about Sock Shop or Vertikal.
 * It just runs virtual users through weighted workflows against a base URL,
 * with randomized think-time, bounded concurrency, and live-updatable config.
 */

const { randomUUID } = require('crypto');

function jitter(min, max) {
  return min + Math.random() * (max - min);
}

function pickWeighted(items) {
  // items: [{ key, weight }]
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    if (r < item.weight) return item.key;
    r -= item.weight;
  }
  return items[items.length - 1].key;
}

class Statistics {
  constructor() {
    this.reset();
  }

  reset() {
    this.requestsAttempted = 0;
    this.requestsCompleted = 0;
    this.requestsSuccessful = 0;
    this.requestsFailed = 0;
    this.timeouts = 0;
    this.networkErrors = 0;
    this.workflowsStarted = 0;
    this.workflowsCompleted = 0;
    this.workflowsAbandoned = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.perWorkflow = {}; // workflowId -> { started, completed, abandoned }
    this.recentLatencies = []; // rolling window for p50/p95
    this.recentStatusCodes = {};
    this.checkouts = 0;
  }

  recordRequestStart() {
    this.requestsAttempted++;
  }

  recordRequestEnd({ success, timeout, networkError, statusCode, latencyMs }) {
    this.requestsCompleted++;
    if (success) this.requestsSuccessful++;
    else this.requestsFailed++;
    if (timeout) this.timeouts++;
    if (networkError) this.networkErrors++;
    if (statusCode) {
      this.recentStatusCodes[statusCode] = (this.recentStatusCodes[statusCode] || 0) + 1;
    }
    if (typeof latencyMs === 'number') {
      this.recentLatencies.push(latencyMs);
      if (this.recentLatencies.length > 500) this.recentLatencies.shift();
    }
  }

  errorRate() {
    return this.requestsCompleted ? this.requestsFailed / this.requestsCompleted : 0;
  }

  recordWorkflowStart(workflowId) {
    this.workflowsStarted++;
    this._wf(workflowId).started++;
  }

  recordWorkflowEnd(workflowId, abandoned) {
    this._wf(workflowId)[abandoned ? 'abandoned' : 'completed']++;
    if (abandoned) this.workflowsAbandoned++;
    else this.workflowsCompleted++;
  }

  _wf(id) {
    if (!this.perWorkflow[id]) this.perWorkflow[id] = { started: 0, completed: 0, abandoned: 0 };
    return this.perWorkflow[id];
  }

  percentile(p) {
    if (this.recentLatencies.length === 0) return null;
    const sorted = [...this.recentLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  snapshot(currentUsers) {
    const elapsedSec = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    return {
      requestsAttempted: this.requestsAttempted,
      requestsCompleted: this.requestsCompleted,
      requestsSuccessful: this.requestsSuccessful,
      requestsFailed: this.requestsFailed,
      timeouts: this.timeouts,
      networkErrors: this.networkErrors,
      workflowsStarted: this.workflowsStarted,
      workflowsCompleted: this.workflowsCompleted,
      workflowsAbandoned: this.workflowsAbandoned,
      checkouts: this.checkouts,
      errorRate: +this.errorRate().toFixed(4),
      currentRate: elapsedSec > 0 ? +(this.requestsCompleted / elapsedSec).toFixed(2) : 0,
      p50LatencyMs: this.percentile(50),
      p95LatencyMs: this.percentile(95),
      statusCodes: { ...this.recentStatusCodes },
      perWorkflow: JSON.parse(JSON.stringify(this.perWorkflow)),
      currentUsers,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      elapsedSec: +elapsedSec.toFixed(1),
    };
  }
}

/**
 * A VirtualUser runs one workflow at a time in a loop:
 *   pick workflow (weighted) -> run steps with think-time between -> repeat
 * until stopped.
 */
class VirtualUser {
  constructor({ id, engine }) {
    this.id = id;
    this.engine = engine;
    this.stopped = false;
    this.vars = {};
    this.cookies = new Map();
  }

  async run() {
    while (!this.stopped) {
      const cfg = this.engine.config;
      const workflowId = pickWeighted(cfg.workflowWeights);
      const workflow = cfg.workflows[workflowId];
      if (!workflow) {
        await sleep(500);
        continue;
      }
      this.vars = {};
      this.engine.stats.recordWorkflowStart(workflowId);
      let abandoned = false;

      for (const step of workflow.steps) {
        if (this.stopped) {
          abandoned = true;
          break;
        }
        // optional abandon chance between steps (organic behavior)
        if (step.abandonChance && Math.random() < step.abandonChance) {
          abandoned = true;
          break;
        }
        const ok = await this._runStep(workflow, step);
        if (!ok && step.stopWorkflowOnFailure) {
          abandoned = true;
          break;
        }
        const think = step.thinkTimeMs || cfg.defaultThinkTimeMs || [500, 1500];
        await sleep(jitter(think[0], think[1]));
      }

      this.engine.stats.recordWorkflowEnd(workflowId, abandoned);
    }
  }

  async _runStep(workflow, step) {
    const cfg = this.engine.config;
    let path = step.path;
    // substitute extracted vars: /product/${slug}
    path = path.replace(/\$\{(\w+)\}/g, (_, k) => this.vars[k] ?? '');

    const url = cfg.baseUrl.replace(/\/$/, '') + path;
    const method = step.method || 'GET';
    const started = Date.now();
    this.engine.stats.recordRequestStart();
    this.engine.emit('requestStarted', { userId: this.id, workflowId: workflow.id, stepId: step.id, method, url });

    let result;
    try {
      const controller = new AbortController();
      const timeoutMs = step.timeoutMs || cfg.requestTimeoutMs || 8000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers = { ...(step.headers || {}) };
      if (step.auth && cfg.auth?.username && cfg.auth?.password) {
        headers.authorization = `Basic ${Buffer.from(`${cfg.auth.username}:${cfg.auth.password}`).toString('base64')}`;
      }
      const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookieHeader) headers.cookie = cookieHeader;
      if (step.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const resp = await fetch(url, {
        method,
        headers,
        body: step.body ? JSON.stringify(resolveTemplate(step.body, this.vars)) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      const success = resp.status < 500; // 4xx counted as "completed", 5xx as failure for anomaly purposes
      result = { success, statusCode: resp.status, latencyMs, timeout: false, networkError: false };
      for (const setCookie of resp.headers.getSetCookie?.() || []) {
        const first = setCookie.split(';', 1)[0];
        const separator = first.indexOf('=');
        if (separator > 0) this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
      }

      if (step.extract && resp.headers.get('content-type')?.includes('json')) {
        try {
          const json = await resp.json();
          for (const [varName, jsonPath] of Object.entries(step.extract)) {
            this.vars[varName] = extractPath(json, jsonPath);
          }
        } catch (_) {
          /* extraction is best-effort, never fatal */
        }
      }
    } catch (err) {
      const latencyMs = Date.now() - started;
      const isTimeout = err.name === 'AbortError';
      result = { success: false, statusCode: null, latencyMs, timeout: isTimeout, networkError: !isTimeout };
    }

    this.engine.stats.recordRequestEnd(result);
    if (step.checkout) this.engine.stats.checkouts++;
    this.engine.emit('requestCompleted', { userId: this.id, workflowId: workflow.id, stepId: step.id, ...result });
    return result.success;
  }

  stop() {
    this.stopped = true;
  }
}

function resolveTemplate(value, vars) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? '');
  if (Array.isArray(value)) return value.map(item => resolveTemplate(item, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, vars)]));
  return value;
}

function extractPath(obj, path) {
  // very small dotted-path + [0] index extractor, e.g. "data[0].slug"
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

class TrafficEngine {
  constructor(config) {
    this.validateConfig(config);
    this.config = config; // live-mutable
    this.stats = new Statistics();
    this.users = [];
    this.running = false;
    this.listeners = {};
    this._spawnLoopHandle = null;
    this._safetyTimer = null;
  }

  validateConfig(cfg) {
    const maxUsers = cfg.maxUsers ?? 20;
    const maxConcurrency = cfg.maxConcurrency ?? 20;
    const maxDurationSec = cfg.maxDurationSec ?? 1800;
    if (cfg.users > maxUsers) throw new Error(`users (${cfg.users}) exceeds maxUsers (${maxUsers})`);
    if ((cfg.concurrency ?? cfg.users) > maxConcurrency) throw new Error(`concurrency exceeds maxConcurrency (${maxConcurrency})`);
    if (cfg.durationSec && cfg.durationSec > maxDurationSec) throw new Error(`durationSec exceeds maxDurationSec (${maxDurationSec})`);
    if (cfg.users < 1 || !Number.isInteger(cfg.users)) throw new Error('users must be a positive integer');
    if (cfg.maxErrorRate != null && (cfg.maxErrorRate <= 0 || cfg.maxErrorRate > 1)) throw new Error('maxErrorRate must be between 0 and 1');
    if (!cfg.baseUrl) throw new Error('baseUrl is required');
    if (!cfg.workflows || Object.keys(cfg.workflows).length === 0) throw new Error('at least one workflow is required');
  }

  on(event, cb) {
    (this.listeners[event] ||= []).push(cb);
  }

  emit(event, payload) {
    for (const cb of this.listeners[event] || []) {
      try { cb(payload); } catch (_) { /* never let a listener crash the engine */ }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stats.reset();
    this.stats.startedAt = Date.now();
    this._spawnUsersUpTo(this.config.users);

    if (this.config.durationSec) {
      this._durationTimer = setTimeout(() => this.stop(), this.config.durationSec * 1000);
    }
    this._safetyTimer = setInterval(() => this._applySafetyLimit(), 5000);
    this.emit('started', {});
  }

  _applySafetyLimit() {
    const threshold = this.config.maxErrorRate ?? 0.5;
    if (this.stats.requestsCompleted < 10 || this.stats.errorRate() <= threshold || this.config.users <= 1) return;
    const reducedUsers = Math.max(1, Math.ceil(this.config.users / 2));
    if (reducedUsers >= this.config.users) return;
    this.update({ users: reducedUsers });
    this.emit('safetyReduced', { users: reducedUsers, errorRate: this.stats.errorRate(), threshold });
  }

  _spawnUsersUpTo(target) {
    const spawnRate = this.config.spawnRatePerSec || target; // users/sec, default: all at once
    let spawned = 0;
    const spawnOne = () => {
      if (!this.running || this.users.length >= target) return;
      const vu = new VirtualUser({ id: randomUUID(), engine: this });
      this.users.push(vu);
      vu.run();
      spawned++;
      if (this.users.length < target) {
        setTimeout(spawnOne, 1000 / spawnRate);
      }
    };
    spawnOne();
  }

  // Live update: never restarts the engine.
  update(partialConfig) {
    const merged = { ...this.config, ...partialConfig };
    if (partialConfig.workflowWeights) merged.workflowWeights = partialConfig.workflowWeights;
    this.validateConfig({ ...merged, users: merged.users });
    const prevUsers = this.config.users;
    this.config = merged;

    if (typeof partialConfig.users === 'number' && partialConfig.users !== prevUsers) {
      if (partialConfig.users > this.users.length) {
        this._spawnUsersUpTo(partialConfig.users);
      } else {
        const toRemove = this.users.length - partialConfig.users;
        for (let i = 0; i < toRemove; i++) {
          const vu = this.users.pop();
          vu.stop();
        }
      }
    }
    this.emit('configUpdated', this.config);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const vu of this.users) vu.stop();
    this.users = [];
    if (this._durationTimer) clearTimeout(this._durationTimer);
    if (this._safetyTimer) clearInterval(this._safetyTimer);
    this.stats.stoppedAt = Date.now();
    this.emit('stopped', this.stats.snapshot(0));
  }

  getStats() {
    return this.stats.snapshot(this.users.length);
  }
}

module.exports = { TrafficEngine, Statistics, pickWeighted, jitter };

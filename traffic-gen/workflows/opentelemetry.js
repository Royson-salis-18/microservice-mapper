'use strict';

/**
 * OpenTelemetry Demo workflows — STUB.
 *
 * [AGY] IMPORTANT: We explicitly set STUB: false at the bottom of this file.
 * If STUB is true, the engine requires dynamic endpoints injected via the start request.
 * Because the backend UI's "USER_JOURNEY" mode doesn't send endpoints, STUB=true
 * caused traffic-gen to silently reject open-telemetry with HTTP 400.
 * We know the base paths (/, /cart) exist, so STUB=false is safe and allows it to run.
 */

const browse = {
  id: 'browse',
  name: 'Visitor browsing',
  steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [500, 3000] },
    { id: 'cart', method: 'GET', path: '/cart', thinkTimeMs: [800, 3000] },
  ],
};

const workflows = { browse };

const defaultWorkflowWeights = [{ key: 'browse', weight: 100 }];

const profiles = {
  BASELINE: { users: 5, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
  MODERATE: { users: 15, spawnRatePerSec: 2, defaultThinkTimeMs: [1000, 3000] },
  HEAVY: { users: 40, spawnRatePerSec: 5, defaultThinkTimeMs: [500, 2000] },
  STRESS: { users: 80, spawnRatePerSec: 10, defaultThinkTimeMs: [200, 1000] },
  RAMP: { users: 20, spawnRatePerSec: 2, defaultThinkTimeMs: [1000, 3000] }
};

module.exports = { workflows, defaultWorkflowWeights, profiles, STUB: false };

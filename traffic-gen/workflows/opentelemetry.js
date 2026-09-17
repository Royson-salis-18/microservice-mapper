'use strict';

/**
 * OpenTelemetry Demo workflows — STUB.
 *
 * This target uses dynamic endpoints discovered from the frontend service,
 * or simple base paths. 
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

module.exports = { workflows, defaultWorkflowWeights, profiles, STUB: true };

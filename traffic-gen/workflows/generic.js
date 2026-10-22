'use strict';

/**
 * Fallback for any project that has no workflow of its own (a new benchmark, a renamed host, a project added from the UI).
 *
 * It fetches the front page. That is enough to put steady traffic on the system, and the usual way to aim it wider is
 * to confirm discovered endpoints for the project, which switches the run to those paths instead (see /api/start).
 * Not a stub: starting it needs nothing beyond a base URL.
 */

const browse = {
  id: 'browse',
  name: 'Front page',
  steps: [{ id: 'home', method: 'GET', path: '/', thinkTimeMs: [500, 3000] }],
};

const workflows = { browse };
const defaultWorkflowWeights = [{ key: 'browse', weight: 100 }];
const profiles = {
  BASELINE: { users: 5, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
  MODERATE: { users: 15, spawnRatePerSec: 2, defaultThinkTimeMs: [1000, 3000] },
  HEAVY: { users: 40, spawnRatePerSec: 5, defaultThinkTimeMs: [500, 2000] },
  STRESS: { users: 80, spawnRatePerSec: 10, defaultThinkTimeMs: [200, 1000] },
  RAMP: { users: 20, spawnRatePerSec: 2, defaultThinkTimeMs: [1000, 3000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles, STUB: false };

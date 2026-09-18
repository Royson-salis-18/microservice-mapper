'use strict';

/**
 * OpenTelemetry Demo workflows — NOT a stub (STUB: false at the bottom).
 *
 * Why STUB is false: with STUB true, /api/start rejects the target unless the
 * request also supplies confirmed endpoints (useDiscoveredEndpoints plus a
 * non-empty endpointPaths). The UI's USER_JOURNEY mode does not send those,
 * so the target failed with HTTP 400 while looking correctly configured.
 * The paths below are the OpenTelemetry Demo's own frontend routes, so
 * there is nothing to confirm dynamically.
 *
 * Entry point: the demo serves through frontend-proxy on :8080. If that port
 * is not open to you in the instance's security group, pin a tunnelled URL
 * instead of guessing — see wiki/15-troubleshooting.md.
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

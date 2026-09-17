'use strict';

/**
 * Train Ticket workflows — STILL A STUB, but for a different reason than
 * before. Updated 2026-09-17 after investigating the live box.
 *
 * What is now known (discovery resolves this target correctly — 18 real
 * ts-* services, not "unknown-<containerid>" as when this file was written):
 *   - ts-ui-dashboard      published on :8080
 *   - ts-gateway-service   published on :18888
 *   - services also publish directly, e.g. ts-travel-service :12346,
 *     ts-contacts-service :12347, ts-inside-payment-service :18673
 *
 * Why there are still no workflows here: the services do not respond.
 * Measured on-host (so not a security-group or network issue):
 *   - POST 127.0.0.1:12346/api/v1/travelservice/trips/left → no response
 *     in 60s (connection accepted, nothing came back)
 *   - GET  127.0.0.1:18888/ → connection refused
 *   - GET  127.0.0.1:8080/  → connection refused
 * The box is out of RAM: ~18 JVM services on 1.9GB, load average ~39,
 * kswapd0 pegged, constant swapping. `docker ps` alone takes 45s there.
 *
 * So writing workflows now would mean shipping paths nobody has seen
 * return a 200. Once the instance is resized and a request completes,
 * curl the real routes, put them here, and drop the STUB flag — the same
 * way deathstar.js was verified.
 */

const workflows = {};
const defaultWorkflowWeights = [];
const profiles = {
  BASELINE: { users: 2, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles, STUB: true };

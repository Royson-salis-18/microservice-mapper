'use strict';

/**
 * Vertikal workflows — STUB.
 *
 * Do not point this at the gateway's /rest/v1/* directly (that bypasses the
 * application and hammers Postgres/PostgREST, same mistake noted before).
 *
 * Before this is runnable:
 *   1. Confirm the actual reachable storefront entrypoint (the Next.js app
 *      was not confirmed exposed on :3000 — verify with curl before wiring
 *      this up, don't hard-code it).
 *   2. Confirm whether /product/[slug] and /orders/[id] need real data
 *      extracted from a prior step (catalog listing, order creation) —
 *      the `extract` mechanism in engine.js supports this once you know
 *      the actual response shape.
 *   3. Auth workflow (account/checkout) needs a real session mechanism —
 *      do not invent tokens.
 *
 * Once the entrypoint is confirmed, this file follows the exact same shape
 * as workflows/sockshop.js — steps, thinkTimeMs, extract, abandonChance.
 */

const browse = {
  id: 'browse',
  name: 'Visitor browsing',
  steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [500, 3000] },
    {
      id: 'catalog',
      method: 'GET',
      path: '/catalog',
      thinkTimeMs: [800, 3000],
      // TODO: confirm real response shape before trusting this extract path
      extract: { productSlug: 'products[0].slug' },
    },
    { id: 'product', method: 'GET', path: '/product/${productSlug}', thinkTimeMs: [1000, 5000] },
  ],
};

const workflows = { browse };

const defaultWorkflowWeights = [{ key: 'browse', weight: 100 }];

const profiles = {
  BASELINE: { users: 5, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles, STUB: true };

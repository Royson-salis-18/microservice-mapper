'use strict';

// Verified against the deployed weaveworks front-end at 65.1.91.28.
// Every request enters through the edge-router; downstream services are reached
// only by the real front-end workflow.
//
// WARNING (observed 2026-09-17 on the 909MB box at 65.2.80.40): the `cart`
// workflow crash-loops this deployment's front-end. POST /cart hits an
// unhandled error callback at /usr/src/app/api/cart/index.js:79 when the
// carts service errors or times out, which takes the whole node process
// down (exit 1, docker restarts it) and turns every request into a 502
// until it comes back. It is a fragility in the weaveworks front-end
// image, not in this file — but on a box where carts is slow enough to
// error, keep cart/account/checkout at weight 0 and run `browse` only.
// `browse` alone still exercises front-end -> catalogue -> catalogue-db.

const browse = {
  id: 'browse', name: 'Browse catalogue', steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [2500, 8000] },
    { id: 'catalogue', method: 'GET', path: '/catalogue', extract: { productId: '[0].id' }, thinkTimeMs: [2000, 6000] },
    { id: 'product', method: 'GET', path: '/catalogue/${productId}', thinkTimeMs: [3000, 10000], abandonChance: 0.15 },
    { id: 'second_product', method: 'GET', path: '/catalogue/${productId}', thinkTimeMs: [4000, 12000], abandonChance: 0.75 },
  ],
};

const cart = {
  id: 'cart', name: 'Browse and cart', steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [2000, 7000] },
    { id: 'catalogue', method: 'GET', path: '/catalogue', extract: { productId: '[0].id' }, thinkTimeMs: [2000, 6000] },
    { id: 'product', method: 'GET', path: '/catalogue/${productId}', thinkTimeMs: [2500, 8000] },
    { id: 'add_to_cart', method: 'POST', path: '/cart', body: { id: '${productId}' }, thinkTimeMs: [2500, 8000], stopWorkflowOnFailure: true },
    { id: 'view_cart', method: 'GET', path: '/cart', thinkTimeMs: [3000, 9000] },
  ],
};

const account = {
  id: 'account', name: 'Account login', steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [2000, 7000] },
    { id: 'login', method: 'GET', path: '/login', auth: true, thinkTimeMs: [2000, 6000], stopWorkflowOnFailure: true },
    { id: 'customer', method: 'GET', path: '/customers', thinkTimeMs: [2500, 8000] },
    { id: 'address', method: 'GET', path: '/address', thinkTimeMs: [2500, 8000], abandonChance: 0.4 },
    { id: 'card', method: 'GET', path: '/card', thinkTimeMs: [2500, 8000], abandonChance: 0.4 },
  ],
};

const checkout = {
  id: 'checkout', name: 'Authenticated checkout', steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [500, 1500] },
    { id: 'login', method: 'GET', path: '/login', auth: true, thinkTimeMs: [500, 1500], stopWorkflowOnFailure: true },
    { id: 'catalogue', method: 'GET', path: '/catalogue', extract: { productId: '[0].id' }, thinkTimeMs: [500, 1500] },
    { id: 'product', method: 'GET', path: '/catalogue/${productId}', thinkTimeMs: [500, 1500] },
    { id: 'add_to_cart', method: 'POST', path: '/cart', body: { id: '${productId}' }, thinkTimeMs: [500, 1500], stopWorkflowOnFailure: true },
    { id: 'view_cart', method: 'GET', path: '/cart', thinkTimeMs: [500, 1500] },
    { id: 'customer', method: 'GET', path: '/customers', thinkTimeMs: [500, 1500], stopWorkflowOnFailure: true },
    { id: 'address', method: 'GET', path: '/address', thinkTimeMs: [500, 1500], stopWorkflowOnFailure: true },
    { id: 'card', method: 'GET', path: '/card', thinkTimeMs: [500, 1500], stopWorkflowOnFailure: true },
    // Deliberately low abandonChance here (vs. the original 0.35/0.25): this
    // workflow's whole purpose is exercising orders -> payment -> shipping
    // -> rabbitmq -> queue-master reliably for RCA/cascading-failure
    // experiments, not simulating realistic shopper drop-off.
    { id: 'place_order', method: 'POST', path: '/orders', checkout: true, extract: { orderId: 'id' }, thinkTimeMs: [1000, 3000], abandonChance: 0.05, stopWorkflowOnFailure: true },
    { id: 'view_order', method: 'GET', path: '/orders', thinkTimeMs: [1000, 3000], abandonChance: 0.05 },
  ],
};

const workflows = { browse, cart, account, checkout };
// Weighted heavily toward checkout: this traffic generator now exists mainly
// to drive the full sock-shop dependency chain (front-end -> orders ->
// payment/shipping -> rabbitmq -> queue-master) for RCA and cascading-
// failure experiments, so the "realistic e-commerce visitor mix" from the
// original weights (browse 65 / cart 20 / account 10 / checkout 5) would
// almost never reach the services that matter for that.
const defaultWorkflowWeights = [
  { key: 'browse', weight: 20 },
  { key: 'cart', weight: 15 },
  { key: 'account', weight: 15 },
  { key: 'checkout', weight: 50 },
];
const profiles = {
  BASELINE: { users: 1, spawnRatePerSec: 1, defaultThinkTimeMs: [3000, 8000] },
  MODERATE: { users: 3, spawnRatePerSec: 1, defaultThinkTimeMs: [2000, 6000] },
  HEAVY: { users: 5, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 5000] },
  RAMP: { users: 10, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 5000] },
  STRESS: { users: 20, spawnRatePerSec: 1, defaultThinkTimeMs: [1000, 4000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles };

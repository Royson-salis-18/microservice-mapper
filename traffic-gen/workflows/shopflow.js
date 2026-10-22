'use strict';

/**
 * ShopFlow (online retail) journeys, from the bench's own loadgen (shopflow/loadgen/journeys.js).
 * Entry point: the api-gateway on :8080. Browse-heavy like real retail, with enough cart and checkout traffic to reach the
 * orders, payments, inventory and event-bus path.
 */

const CATEGORIES = ['shoes', 'shirts', 'hats', 'bags', 'socks', 'jackets'];
const PRODUCTS = ['7', '42', '215', '980', '1503', '2210', '3099', '4180', '4777', '4999'];
const USERS = ['u101', 'u202', 'u303', 'u404', 'u505', 'u606', 'u707', 'u808', 'u909', 'u1010'];

const browse = {
  id: 'browse', name: 'Browse the catalogue', vars: { category: CATEGORIES, product: PRODUCTS }, steps: [
    { id: 'list', method: 'GET', path: '/api/catalog/products?category=${category}&limit=20', thinkTimeMs: [500, 2000] },
    { id: 'detail', method: 'GET', path: '/api/catalog/products/${product}', thinkTimeMs: [500, 2000] },
  ],
};
const cart = {
  id: 'cart', name: 'Fill a cart', vars: { user: USERS, product: PRODUCTS }, steps: [
    { id: 'add', method: 'POST', path: '/api/cart/${user}/items', body: { productId: 1, qty: 1, priceCents: 1000 }, thinkTimeMs: [500, 2000] },
    { id: 'view', method: 'GET', path: '/api/cart/${user}', thinkTimeMs: [500, 2000] },
    { id: 'orders', method: 'GET', path: '/api/orders?userId=${user}', thinkTimeMs: [500, 2000] },
  ],
};
const checkout = {
  id: 'checkout', name: 'Check out', vars: { user: USERS }, steps: [
    { id: 'add', method: 'POST', path: '/api/cart/${user}/items', body: { productId: 1, qty: 1, priceCents: 1000 }, thinkTimeMs: [500, 1500] },
    { id: 'checkout', method: 'POST', path: '/api/checkout', body: { userId: '${user}', email: '${user}@example.test' }, checkout: true, thinkTimeMs: [1000, 3000] },
  ],
};

const workflows = { browse, cart, checkout };
const defaultWorkflowWeights = [
  { key: 'browse', weight: 60 },
  { key: 'cart', weight: 25 },
  { key: 'checkout', weight: 15 },
];
const profiles = {
  BASELINE: { users: 4, spawnRatePerSec: 1, defaultThinkTimeMs: [800, 2500] },
  MODERATE: { users: 15, spawnRatePerSec: 2, defaultThinkTimeMs: [500, 1500] },
  HEAVY: { users: 40, spawnRatePerSec: 5, defaultThinkTimeMs: [200, 1000] },
  STRESS: { users: 80, spawnRatePerSec: 10, defaultThinkTimeMs: [100, 500] },
  RAMP: { users: 20, spawnRatePerSec: 2, defaultThinkTimeMs: [500, 1500] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles };

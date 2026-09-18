'use strict';

/**
 * Vertikal workflows.
 *
 * Vertikal is not a container stack like the other targets — it is a single
 * Next.js storefront (app router) started from the project directory with
 *
 *     cd vertikal && bun run dev:lan     # next dev -H 0.0.0.0 -p 3000
 *
 * so the entry point is that app on :3000, not an EC2 host on :80 and not
 * the Supabase gateway on :54321. Its Postgres/GoTrue/PostgREST containers
 * are supporting services, and driving them directly would bypass the
 * application and hammer the database — which is the mistake the previous
 * version of this file warned about. Everything here goes through the app.
 *
 * Every path below was verified with curl against the running app rather
 * than read off the route tree, because the two disagree: /checkout,
 * /account, /orders and /admin/* all exist as routes but answer 307 to
 * sign-in when unauthenticated, so they generate a redirect and no real
 * work. Only the paths that actually do something are driven here.
 *
 *   /                      200    landing
 *   /catalog               200    listing (also ?q= and ?sort=)
 *   /product/<slug>        200    detail, real seeded slugs
 *   /api/plate?n=&h=&c=    200    SVG render, called per catalogue tile
 *   /cart                  200    empty-cart view
 *   /auth/sign-in          200    form
 *   /checkout /account     307 -> sign-in   (needs a session)
 *   /orders /admin/*       307 -> sign-in   (needs a session)
 *   /api/push/dispatch     401             (needs a service token)
 *
 * The catalogue must be seeded for the product paths to exist at all:
 * `bun run db:migrate` applies the migrations and loads supabase/seed.sql.
 * On an unseeded database /catalog renders with no products and every
 * /product/<slug> below would 404.
 */

// Real slugs from supabase/seed.sql, each confirmed to answer 200. Picked
// from per workflow run (see `vars` handling in engine.js) so load spreads
// across the catalogue instead of one product's cache.
const PRODUCT_SLUGS = [
  'blockprint-oxford',
  'bracket-canvas-tote',
  'brutal-shell-parka',
  'concrete-wool-overcoat',
  'corner-poplin-shirt',
  'grid-fleece-jacket',
  'hardline-boxy-tee',
  'kerning-pleated-pant',
  'margin-wide-trouser',
  'monolith-cable-knit',
  'null-pocket-tee',
  'offset-carpenter-jean',
];

const browse = {
  id: 'browse',
  name: 'Visitor browsing',
  vars: { productSlug: PRODUCT_SLUGS },
  steps: [
    { id: 'home', method: 'GET', path: '/', thinkTimeMs: [500, 3000] },
    { id: 'catalog', method: 'GET', path: '/catalog', thinkTimeMs: [800, 3000] },
    // The catalogue draws every tile through this route, so a real browse
    // pulls it too. Deterministic renderer — same query, same picture.
    { id: 'plate', method: 'GET', path: '/api/plate?n=Vertikal&h=1B1B1B&c=Bitumen&i=0', thinkTimeMs: [200, 800] },
    { id: 'product', method: 'GET', path: '/product/${productSlug}', thinkTimeMs: [1000, 5000], abandonChance: 0.2 },
    { id: 'cart', method: 'GET', path: '/cart', thinkTimeMs: [800, 2500] },
  ],
};

const search = {
  id: 'search',
  name: 'Search and sort the catalogue',
  vars: { productSlug: PRODUCT_SLUGS },
  steps: [
    { id: 'catalog', method: 'GET', path: '/catalog', thinkTimeMs: [500, 2000] },
    { id: 'query', method: 'GET', path: '/catalog?q=tee', thinkTimeMs: [800, 2500] },
    { id: 'sorted', method: 'GET', path: '/catalog?sort=price_asc', thinkTimeMs: [800, 2500] },
    { id: 'product', method: 'GET', path: '/product/${productSlug}', thinkTimeMs: [1000, 4000] },
  ],
};

// Hits the auth-gated surface deliberately. /account and /checkout answer
// 307 to /auth/sign-in when signed out, and engine.js leaves fetch on its
// default redirect:'follow', so these land on the sign-in page and record
// 200 — the middleware and the sign-in render are genuinely exercised, but
// the account and checkout pages behind them are not. Kept to a small share
// of the mix for exactly that reason. A session-backed checkout workflow
// needs a real GoTrue login and is not invented here.
const guest = {
  id: 'guest',
  name: 'Signed-out hitting gated routes',
  steps: [
    { id: 'signin', method: 'GET', path: '/auth/sign-in', thinkTimeMs: [800, 2500] },
    { id: 'account', method: 'GET', path: '/account', thinkTimeMs: [400, 1500] },
    { id: 'checkout', method: 'GET', path: '/checkout', thinkTimeMs: [400, 1500] },
  ],
};

const workflows = { browse, search, guest };

const defaultWorkflowWeights = [
  { key: 'browse', weight: 60 },
  { key: 'search', weight: 30 },
  { key: 'guest', weight: 10 },
];

// `next dev` compiles routes on first hit and is single-process, so it is far
// slower than a production build — the first /product/<slug> took 3.5s
// against 0.07s once warm. These stay modest on purpose; they are sized for
// a dev server on a laptop, not for an EC2 container stack.
const profiles = {
  BASELINE: { users: 3, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
  MODERATE: { users: 8, spawnRatePerSec: 2, defaultThinkTimeMs: [1000, 3000] },
  HEAVY: { users: 20, spawnRatePerSec: 3, defaultThinkTimeMs: [600, 2000] },
  STRESS: { users: 40, spawnRatePerSec: 5, defaultThinkTimeMs: [250, 1200] },
  RAMP: { users: 12, spawnRatePerSec: 2, defaultThinkTimeMs: [1000, 3000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles };

'use strict';

/**
 * DeathStarBench social-network workflows — VERIFIED 2026-09-17.
 *
 * Entrypoint: nginx-thrift on :8080.
 *
 * Reachability: port 8080 is NOT open in this EC2 instance's security
 * group, so the host is unreachable directly from a laptop (every request
 * times out). Rather than opening a port, reach it through an SSH local
 * forward and point traffic-gen at the local end:
 *
 *   ssh -N -L 18080:127.0.0.1:8080 -i <key.pem> ubuntu@<death-star-host>
 *   baseUrl = http://localhost:18080
 *
 * Verified by curl against the running stack (both on-host and through the
 * forward): the two read paths below return 200.
 *
 * composePost is deliberately NOT in the default weights. It returns 500
 * on this deployment because the social graph has no seeded users — the
 * endpoint exists (a GET returns 400 "bad request", not 404), it just has
 * nothing to compose against. Seed the dataset first, then give it weight.
 */

// Verified 200. Spreading user_id across a few values exercises more of
// the post-storage/redis/mongo path than hammering a single cached key.
const browseTimelines = {
  id: 'browseTimelines', name: 'Read home + user timelines', steps: [
    { id: 'home_timeline', method: 'GET', path: '/wrk2-api/home-timeline/read?user_id=1&start=0&stop=10', thinkTimeMs: [1000, 4000] },
    { id: 'user_timeline', method: 'GET', path: '/wrk2-api/user-timeline/read?user_id=2&start=0&stop=10', thinkTimeMs: [1000, 4000] },
    { id: 'home_timeline_alt', method: 'GET', path: '/wrk2-api/home-timeline/read?user_id=3&start=0&stop=20', thinkTimeMs: [1000, 4000] },
    { id: 'user_timeline_alt', method: 'GET', path: '/wrk2-api/user-timeline/read?user_id=4&start=0&stop=20', thinkTimeMs: [1000, 4000] },
  ],
};

const composePost = {
  id: 'composePost', name: 'Compose a post', steps: [
    {
      id: 'compose',
      method: 'POST',
      path: '/wrk2-api/post/compose',
      body: {
        username: 'username_1',
        user_id: 1,
        text: 'traffic-gen synthetic post',
        media_ids: [],
        media_types: [],
        post_type: 0,
      },
      thinkTimeMs: [2000, 6000],
    },
  ],
};

const workflows = { browseTimelines, composePost };
// composePost at 0 until the dataset is seeded — see the header note. It
// stays registered so it can be switched on without a code change.
const defaultWorkflowWeights = [
  { key: 'browseTimelines', weight: 100 },
  { key: 'composePost', weight: 0 },
];
const profiles = {
  BASELINE: { users: 2, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
  MODERATE: { users: 5, spawnRatePerSec: 1, defaultThinkTimeMs: [1000, 3000] },
  HEAVY: { users: 10, spawnRatePerSec: 1, defaultThinkTimeMs: [500, 2000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles };

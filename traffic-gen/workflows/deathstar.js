'use strict';

/**
 * DeathStarBench social-network workflows - VERIFIED 2026-09-17.
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
 * composePost sends form fields, not JSON. nginx-thrift reads the post with
 * ngx.req.get_post_args, so a JSON body came back 400 "Incomplete
 * arguments" - which is why it was once switched off (the note blaming an
 * unseeded social graph was wrong; with form fields it returns 200
 * "Successfully upload post", verified 2026-10-01). Composing is what drives
 * most of the graph: text, user-mention, url-shorten, unique-id, media,
 * post-storage and the timelines' write path.
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
      form: {
        username: 'username_1',
        user_id: '1',
        text: 'traffic-gen synthetic post @username_2 http://example.com/traffic-gen',
        media_ids: [],
        media_types: [],
        post_type: '0',
      },
      thinkTimeMs: [2000, 6000],
    },
  ],
};

// media-frontend (nginx + Lua) opens a connection to media-mongodb only when someone asks it for a file. A user who never
// posts a picture never touches it, so without this the mapper sees no traffic to or from it. Its own port (8081) is closed
// to the outside, so the host's nginx-thrift forwards /get-media and /upload-media to it (location blocks added to
// nginx-web-server/conf/nginx.conf on the host): the request travels nginx-thrift -> media-frontend -> media-mongodb on the
// one open port. An unknown file answers after the lookup, which is still the real call and counts as completed.
const viewMedia = {
  id: 'viewMedia', name: 'Fetch a media file', steps: [
    { id: 'get_media', method: 'GET', path: '/get-media?filename=traffic-gen.png', thinkTimeMs: [2000, 6000] },
  ],
};

const workflows = { browseTimelines, composePost, viewMedia };
// Mostly reads, as on a real social network, with enough posting to keep
// the write path (and the services only it touches) in the graph.
const defaultWorkflowWeights = [
  { key: 'browseTimelines', weight: 75 },
  { key: 'composePost', weight: 20 },
  { key: 'viewMedia', weight: 5 },
];
const profiles = {
  BASELINE: { users: 2, spawnRatePerSec: 1, defaultThinkTimeMs: [1500, 4000] },
  MODERATE: { users: 5, spawnRatePerSec: 1, defaultThinkTimeMs: [1000, 3000] },
  HEAVY: { users: 10, spawnRatePerSec: 1, defaultThinkTimeMs: [500, 2000] },
};

module.exports = { workflows, defaultWorkflowWeights, profiles };

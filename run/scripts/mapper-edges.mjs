#!/usr/bin/env node
// What does the running mapper hold for a project? Shows the target's state and, for the services matching a word, their node
// status and every edge in or out with its evidence. Use it when a service looks unlinked in the UI:
//
//   npm run mapper-edges -- death-star media-frontend
//   npm run mapper-edges -- death-star            (every edge of the project)
//
// MAPPER_URL overrides http://localhost:3001.
const base = process.env.MAPPER_URL || 'http://localhost:3001';
const [project, word = ''] = process.argv.slice(2);
if (!project) { console.error('usage: npm run mapper-edges -- <project> [service-name-part]'); process.exit(2); }
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
try {
  const [graph, targets] = await Promise.all([get('/api/graph'), get('/api/targets').catch(() => [])]);
  const t = (Array.isArray(targets) ? targets : Object.values(targets)).find((x) => x.targetId === project);
  console.log(`target ${project}: ${t ? `${t.status ?? '?'}  last seen ${t.lastSeen ?? 'never'}  host ${t.host ?? '?'}  endpoint ${t.endpointStatus ?? '?'}` : 'NOT REGISTERED in this mapper (is the project in server/data/remote_config.json, and was the server restarted after the change?)'}`);
  const nodes = graph.nodes.filter((n) => n.project === project);
  const ids = new Set(nodes.map((n) => n.id));
  console.log(`nodes: ${nodes.length}${nodes.length ? '' : '  (none: the mapper has read nothing from this host yet)'}`);
  const hit = nodes.filter((n) => n.name.toLowerCase().includes(word.toLowerCase()));
  for (const n of word ? hit : []) console.log(`  node ${n.id}  type=${n.type} status=${n.status}`);
  if (word && !hit.length) console.log(`  no node whose name contains "${word}". Names here: ${nodes.map((n) => n.name).slice(0, 40).join(', ')}`);
  const edges = graph.edges.filter((e) => ids.has(e.source) || ids.has(e.target)).filter((e) => !word || (e.source + e.target).toLowerCase().includes(word.toLowerCase()));
  console.log(`edges${word ? ` touching "${word}"` : ''}: ${edges.length}`);
  for (const e of edges) console.log(`  ${e.source.split(':').pop()} -> ${e.target.split(':').pop()}  observed=${!!e.observed} declared=${!!e.declared} status=${e.status}  evidence=[${(e.evidenceSources ?? []).join(', ')}]  lastSeen=${e.lastSeen ?? '-'}`);
  if (word && hit.length && !edges.length) console.log('  The node exists but has no edges. Run `npm run check-host` while traffic is flowing: if it shows this service calling named containers, send me the server log lines for this project.');
} catch (e) { console.error(`cannot reach the mapper at ${base}: ${e.message}`); process.exit(1); }

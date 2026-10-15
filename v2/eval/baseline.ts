// v2/eval/baseline.ts: the v1 engines scored on the cached traces (sanity check: must match npm run ml:hybrid).
//   node server/node_modules/tsx/dist/cli.mjs v2/eval/baseline.ts v2/.cache/real.json
import { loadTraces } from '../core/trace.ts';
import { score, V1, line, HEADER } from '../core/score.ts';
for (const f of process.argv.slice(2)) {
  const traces = loadTraces(f);
  console.log(`\n${f}: ${traces.length} runs, ${traces.reduce((s, t) => s + t.faults.length, 0)} faults\n${HEADER}`);
  for (const [k, e] of Object.entries(V1)) console.log(line(`v1 ${k}`, score(traces, e)));
}

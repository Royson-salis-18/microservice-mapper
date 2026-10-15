/**
 * v2 causal: entry point. Prints every table of the study and writes v2/causal/results.json (the work is in study.ts).
 *
 *   node server/node_modules/tsx/dist/cli.mjs v2/causal/run.ts            (from the repo root)
 *
 * Why a separate entry: v2/core/trace.ts imports run/cli/ml/run.ts, whose command-line guard is
 * `process.argv[1].endsWith('run.ts')`. Started as ".../run.ts", this script would also run that v1 command. So the
 * script name is changed first, and the study is loaded only afterwards (a static import would be evaluated earlier).
 */
process.argv[1] = process.argv[1].replace(/run\.ts$/, 'run-causal');
await import('./study.ts');

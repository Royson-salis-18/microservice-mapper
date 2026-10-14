/**
 * Logic stays separate from I/O. The decision-making modules (detection, root-cause ranking, cascade, weights, link status,
 * scoring) must be computable from their arguments alone: no filesystem, network, process or framework imports, directly or
 * through anything they import. That is what makes them testable without a running system and portable to the research code.
 * The shells that DO touch the world (stores, collectors, routes, the CLI) live elsewhere and are allowed to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** Everything under algorithms/ is decision logic, plus the client's edge colouring and the evaluation report. */
function listTs(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listTs(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}
const CORE = [...listTs('algorithms'), 'client/src/components/shared/edgeHeat.ts', 'graphs/eval-report.ts'];
const FORBIDDEN = /^(node:)?(fs|fs\/promises|path|os|http|https|net|tls|dns|child_process|worker_threads|cluster|crypto|stream|zlib)$|^(express|ws|axios|dockerode|ssh2|cors|socket\.io)(\/.*)?$/;

/** Value (non-type) static imports of a file. */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*import\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) if (!m[1]) out.push(m[3]);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}
function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, '.ts'));
  for (const c of [base, `${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}
function reachable(entry: string): { files: string[]; violations: string[] } {
  const seen = new Set<string>(), violations: string[] = [], stack = [entry];
  while (stack.length) {
    const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f);
    for (const spec of importsOf(f)) {
      if (spec.startsWith('.')) { const r = resolve(f, spec); if (r) stack.push(r); else violations.push(`${path.relative(ROOT, f)} imports unresolved ${spec}`); }
      else if (FORBIDDEN.test(spec)) violations.push(`${path.relative(ROOT, f)} imports ${spec}`);
    }
  }
  return { files: [...seen], violations };
}

for (const rel of CORE) {
  test(`pure: ${rel} reaches no I/O module`, () => {
    const { violations } = reachable(path.join(ROOT, rel));
    assert.deepEqual(violations, [], `${rel} is declared pure but:\n  ${violations.join('\n  ')}`);
  });
}

test('the I/O shells exist and are where the I/O went', () => {
  for (const [rel, needle] of [['server/rca/thresholdsStore.ts', 'node:fs'], ['run/cli/eval/load.ts', 'node:fs'], ['run/cli/eval/observe.ts', 'fetch('], ['server/rca/TargetModels.ts', 'node:fs'], ['server/rca/LearnedScorer.ts', 'node:fs']] as const) {
    assert.ok(fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(needle), `${rel} should hold the I/O`);
  }
});

test('the checker itself catches a violation', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'run', 'tests', '.purity-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), "import { b } from './b.ts';\nexport const a = b;\n");
    fs.writeFileSync(path.join(dir, 'b.ts'), "import fs from 'node:fs';\nexport const b = fs.existsSync('/');\n");
    const { violations } = reachable(path.join(dir, 'a.ts'));
    assert.equal(violations.length, 1);
    assert.match(violations[0], /b\.ts imports node:fs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

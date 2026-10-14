import type { ServiceNode } from '../../models/ServiceNode.js';
import type { DependencyEdge } from '../../models/DependencyEdge.js';
import type { Incident } from '../../models/Incident.js';
import { TELEMETRY_FACTOR } from './EdgeWeights.js';

/**
 * Invariants over everything the mapper publishes: the things that must hold
 * between its own numbers for any of them to be trusted. Each one here was
 * found broken at least once in live output before it was written down:
 * traffic shares that summed to 183%, incident service lists in a different
 * id format from everything else, a cumulative byte count displayed as a
 * rate.
 *
 * Pure: give it a graph and incidents, get back what is wrong. The API
 * serves it live (/api/diagnostics/consistency) and the tests run it over
 * fixtures, so a regression is caught by either.
 */

export interface Violation {
  rule: string;
  subject: string;
  detail: string;
}

export interface ConsistencyReport {
  checkedAt: string;
  nodes: number;
  edges: number;
  incidents: number;
  rulesChecked: number;
  violations: Violation[];
}

const TOL = 0.011;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function checkConsistency(nodes: ServiceNode[], edges: DependencyEdge[], incidents: Incident[] = []): ConsistencyReport {
  const violations: Violation[] = [];
  const add = (rule: string, subject: string, detail: string) => violations.push({ rule, subject, detail });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const RULES = 12;

  // 1. Every link joins two known services.
  for (const e of edges) {
    if (!byId.has(e.source)) add('edge-endpoints', e.id, `source ${e.source} is not a known service`);
    if (!byId.has(e.target)) add('edge-endpoints', e.id, `target ${e.target} is not a known service`);
  }

  for (const n of nodes) {
    const a = n.analytics ?? {};
    const m = n.metrics ?? {};

    // 2. The health breakdown adds up to the health score it explains.
    if (a.healthBreakdown?.length && isNum(a.healthScore)) {
      const sum = a.healthBreakdown.reduce((s, f) => s + f.score, 0);
      if (Math.abs(sum - a.healthScore) > TOL) add('health-breakdown-sum', n.id, `factors sum to ${sum.toFixed(3)}, score is ${a.healthScore}`);
    }

    // 3. Probabilities and scores are within 0..1, and the inherited part of
    //    a failure probability is never more than the whole.
    for (const k of ['failureProbability', 'affectedProbability', 'riskScore', 'healthScore', 'criticality', 'centrality', 'anomalyScore'] as const) {
      const v = (a as any)[k];
      if (v !== null && v !== undefined && (!isNum(v) || v < 0 || v > 1)) add('score-range', n.id, `${k} = ${v}`);
    }
    if (isNum(a.affectedProbability) && isNum(a.failureProbability) && a.affectedProbability > a.failureProbability + 1e-9) {
      add('inherited-within-total', n.id, `inherited ${a.affectedProbability} exceeds total ${a.failureProbability}`);
    }

    // 4. The dependency risk is said to arrive through is one of this
    //    service's own dependencies, referred to by id.
    if (a.cascadeVia) {
      const isCallee = edges.some((e) => e.source === n.id && e.target === a.cascadeVia);
      if (!isCallee) add('cascade-via-is-dependency', n.id, `cascadeVia ${a.cascadeVia} is not a service it calls`);
    }

    // 5. Measurements are physically possible.
    for (const k of ['cpuOfAllowance', 'memoryPercent'] as const) {
      const v = (m as any)[k];
      if (v !== undefined && v !== null && (!isNum(v) || v < 0 || v > 100.0001)) add('metric-range', n.id, `${k} = ${v}`);
    }
    if (m.cpu !== undefined && m.cpu !== null && (!isNum(m.cpu) || m.cpu < 0)) add('metric-range', n.id, `cpu = ${m.cpu}`);
    for (const k of ['networkRxRate', 'networkTxRate', 'networkRx', 'networkTx', 'memory'] as const) {
      const v = (m as any)[k];
      if (v !== undefined && v !== null && (!isNum(v) || v < 0)) add('metric-range', n.id, `${k} = ${v}`);
    }
    // 6. A rate cannot exceed what the link could carry: 10 GB/s is past any
    //    container network here, so a figure above it is a total shown as a
    //    rate (the bug this rule exists for).
    for (const k of ['networkRxRate', 'networkTxRate'] as const) {
      const v = (m as any)[k];
      if (isNum(v) && v > 1e10) add('rate-not-total', n.id, `${k} = ${v} bytes/s`);
    }
  }

  // 7. Weights are what they claim to be: confidence × reliance (× the
  //    telemetry factor).
  // 8. A caller's reliance shares, per kind, sum to 100%.
  const shares = new Map<string, number>();
  for (const e of edges) {
    const w = e.weight;
    if (!w) continue;
    const expected = w.confidence * w.dependency * (w.kind === 'telemetry' ? TELEMETRY_FACTOR : 1);
    if (Math.abs(expected - w.value) > TOL) add('weight-formula', e.id, `weight ${w.value} but confidence × reliance = ${expected.toFixed(3)}`);
    if (w.confidence > 0) {
      const key = `${e.source}|${w.kind}`;
      shares.set(key, (shares.get(key) ?? 0) + w.dependency);
    }
  }
  for (const [key, sum] of shares) {
    if (Math.abs(sum - 1) > 0.02) {
      const [source, kind] = key.split('|');
      add('reliance-sums-to-one', source, `${kind} shares sum to ${(sum * 100).toFixed(0)}%`);
    }
  }

  // 9. Connection figures are non-negative.
  for (const e of edges) {
    const act = e.activity;
    if (!act) continue;
    for (const k of ['samplesPerMin', 'openConnections', 'newConnectionsPerMin'] as const) {
      const v = (act as any)[k];
      if (v !== undefined && (!isNum(v) || v < 0)) add('activity-range', e.id, `${k} = ${v}`);
    }
  }

  // 10. Incidents refer to services that exist, in the target they belong
  //     to, by id. 11. A resolved incident names no live root cause score
  //     outside 0..1. 12. The named root cause is one of its candidates.
  for (const inc of incidents) {
    if (inc.status === 'RESOLVED') continue;
    const refs = [inc.rootCauseServiceId, ...(inc.affectedServices ?? [])].filter(Boolean) as string[];
    for (const id of refs) {
      const node = byId.get(id);
      if (!node) add('incident-references', inc.id, `refers to ${id}, which is not a known service id`);
      else if (node.project !== inc.targetId) add('incident-references', inc.id, `${id} belongs to ${node.project}, not ${inc.targetId}`);
    }
    if (!isNum(inc.rootCauseScore) || inc.rootCauseScore < 0 || inc.rootCauseScore > 1) add('score-range', inc.id, `rootCauseScore = ${inc.rootCauseScore}`);
    if (inc.rootCauseServiceId && !inc.candidateCauses?.some((c) => c.serviceId === inc.rootCauseServiceId)) {
      add('root-cause-is-candidate', inc.id, `root cause ${inc.rootCauseServiceId} is not among its candidates`);
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    nodes: nodes.length,
    edges: edges.length,
    incidents: incidents.length,
    rulesChecked: RULES,
    violations,
  };
}

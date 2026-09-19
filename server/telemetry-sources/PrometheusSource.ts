import type {
  TelemetrySource,
  TelemetrySourceStatus,
  TelemetrySnapshot,
  ServiceRequestMetrics,
} from './TelemetrySource.js';
import type { MetricSourceKind } from '../models/MetricProvenance.js';

/**
 * Tier 2 — reads the target's own Prometheus.
 *
 * This is the source that fills the fields the agentless path structurally
 * cannot: exact latency quantiles and error rates. It adds no instrumentation
 * and deploys nothing. It only reads what the target already publishes, so it
 * works on the OpenTelemetry demo (which instruments itself) and is correctly
 * unavailable on sock-shop (which has no Prometheus at all).
 *
 * Queries run *on the target* via curl over the existing SSH connection, not
 * from here. Prometheus is bound to localhost on these boxes and only :8080
 * is open in the security group, so querying from outside would require
 * opening a port — a change to someone's infrastructure to read a metric,
 * which is not a trade worth making.
 *
 * Verified against the live open-telemetry target on 2026-09-18:
 *
 *   histogram_quantile(0.95, sum(rate(demo_cart_get_cart_latency_seconds_bucket[1h])) by (le))
 *     -> 0.0829   (82.9 ms p95, service_name="cart", 2296 samples)
 *
 * Note that Prometheus there reports activeTargets: [] — it scrapes nothing,
 * the OTel Collector pushes into it. So availability must be judged on
 * whether queries return data, never on scrape health.
 */

/** Runs a shell command on the target and returns stdout. Supplied by the
 *  caller so this class owns no connection and can be tested with a stub. */
export type RemoteExec = (command: string) => Promise<string>;

interface PromResult {
  metric: Record<string, string>;
  value: [number, string];
}

/**
 * Metric families that carry request duration, most standard first.
 *
 * Semantic-convention names changed across OTel versions and the demo emits
 * several generations at once, so the family actually present is discovered
 * rather than assumed. Units differ between them, hence the explicit scale:
 * guessing seconds-vs-milliseconds silently produces numbers 1000x wrong,
 * which would look plausible and be entirely false.
 */
const DURATION_FAMILIES: { base: string; toMs: number }[] = [
  { base: 'http_server_request_duration_seconds', toMs: 1000 },
  { base: 'http_server_duration_milliseconds', toMs: 1 },
  { base: 'http_server_duration_seconds', toMs: 1000 },
  { base: 'rpc_server_duration_milliseconds', toMs: 1 },
  { base: 'rpc_server_duration_seconds', toMs: 1000 },
];

/** Labels that carry the service name, again varying by OTel version. */
const SERVICE_LABELS = ['service_name', 'service', 'job'];

/** Labels that carry an HTTP status code. */
const STATUS_LABELS = ['http_response_status_code', 'http_status_code', 'status_code'];

export class PrometheusSource implements TelemetrySource {
  readonly kind: MetricSourceKind = 'prometheus';

  private durationFamily: { base: string; toMs: number } | null = null;
  private serviceLabel: string | null = null;
  private statusLabel: string | null = null;

  constructor(
    readonly targetId: string,
    private readonly exec: RemoteExec,
    private readonly baseUrl: string = 'http://localhost:9090',
  ) {}

  /** Single-quote-safe: the URL and query go inside a shell command. */
  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async query(expr: string, timeoutSec = 12): Promise<PromResult[]> {
    const cmd =
      `curl -s --max-time ${timeoutSec} --get ${this.shellQuote(`${this.baseUrl}/api/v1/query`)} ` +
      `--data-urlencode ${this.shellQuote(`query=${expr}`)}`;
    const raw = await this.exec(cmd);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Prometheus did not return JSON (got ${String(raw).slice(0, 80)})`);
    }
    if (parsed?.status !== 'success') {
      throw new Error(parsed?.error ?? 'Prometheus query failed');
    }
    return Array.isArray(parsed?.data?.result) ? parsed.data.result : [];
  }

  private async labelValues(label: string): Promise<string[]> {
    const cmd = `curl -s --max-time 10 ${this.shellQuote(`${this.baseUrl}/api/v1/label/${label}/values`)}`;
    const raw = await this.exec(cmd);
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.data) ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async probe(): Promise<TelemetrySourceStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const names = await this.labelValues('__name__');
      if (names.length === 0) {
        return { kind: this.kind, available: false, reason: `no metrics at ${this.baseUrl}`, checkedAt };
      }

      // Which duration family does this target actually emit?
      this.durationFamily = DURATION_FAMILIES.find(f => names.includes(`${f.base}_bucket`)) ?? null;
      if (!this.durationFamily) {
        return {
          kind: this.kind,
          available: false,
          reason: `Prometheus is up with ${names.length} series but none is a known request-duration histogram — the target is not HTTP/RPC instrumented`,
          checkedAt,
        };
      }
      return { kind: this.kind, available: true, checkedAt };
    } catch (e: any) {
      return { kind: this.kind, available: false, reason: e?.message ?? 'unreachable', checkedAt };
    }
  }

  /** Resolve which label names this target uses, once per process. */
  private async resolveLabels(): Promise<void> {
    if (!this.serviceLabel) {
      for (const label of SERVICE_LABELS) {
        const values = await this.labelValues(label);
        if (values.length > 0) { this.serviceLabel = label; break; }
      }
    }
    if (!this.statusLabel) {
      for (const label of STATUS_LABELS) {
        const values = await this.labelValues(label);
        if (values.length > 0) { this.statusLabel = label; break; }
      }
    }
  }

  async collect(windowSec: number): Promise<TelemetrySnapshot> {
    const warnings: string[] = [];
    if (!this.durationFamily) {
      const status = await this.probe();
      if (!status.available) {
        return { services: [], edges: [], warnings: [status.reason ?? 'prometheus unavailable'] };
      }
    }
    const family = this.durationFamily!;
    await this.resolveLabels();

    if (!this.serviceLabel) {
      return {
        services: [],
        edges: [],
        warnings: ['Prometheus has duration histograms but no recognisable service label; cannot attribute metrics to services'],
      };
    }

    const svc = this.serviceLabel;
    const win = `${Math.max(60, Math.round(windowSec))}s`;
    const byService = new Map<string, ServiceRequestMetrics>();

    const upsert = (name: string): ServiceRequestMetrics => {
      let entry = byService.get(name);
      if (!entry) {
        entry = { serviceName: name, detail: `prometheus ${family.base}, window ${win}` };
        byService.set(name, entry);
      }
      return entry;
    };

    // --- latency quantiles -------------------------------------------------
    for (const [q, field] of [[0.5, 'latencyP50Ms'], [0.95, 'latencyP95Ms'], [0.99, 'latencyP99Ms']] as const) {
      const expr = `histogram_quantile(${q}, sum by (${svc}, le) (rate(${family.base}_bucket[${win}])))`;
      try {
        for (const row of await this.query(expr)) {
          const name = row.metric[svc];
          const value = Number(row.value?.[1]);
          // histogram_quantile returns NaN for a series with no observations
          // in the window. Recording that as 0 would read as "instant", which
          // is the opposite of "we do not know".
          if (!name || !Number.isFinite(value)) continue;
          (upsert(name) as any)[field] = value * family.toMs;
        }
      } catch (e: any) {
        warnings.push(`p${q * 100} query failed: ${e?.message ?? e}`);
      }
    }

    // --- request rate ------------------------------------------------------
    try {
      const expr = `sum by (${svc}) (rate(${family.base}_count[${win}]))`;
      for (const row of await this.query(expr)) {
        const name = row.metric[svc];
        const value = Number(row.value?.[1]);
        if (!name || !Number.isFinite(value)) continue;
        upsert(name).requestRate = value;
      }
    } catch (e: any) {
      warnings.push(`request rate query failed: ${e?.message ?? e}`);
    }

    // --- error rate --------------------------------------------------------
    if (this.statusLabel) {
      const status = this.statusLabel;
      try {
        const errExpr = `sum by (${svc}) (rate(${family.base}_count{${status}=~"5.."}[${win}]))`;
        const errors = new Map<string, number>();
        for (const row of await this.query(errExpr)) {
          const name = row.metric[svc];
          const value = Number(row.value?.[1]);
          if (name && Number.isFinite(value)) errors.set(name, value);
        }
        for (const [name, entry] of byService) {
          const errRate = errors.get(name) ?? 0;
          const total = entry.requestRate;
          // A ratio needs a denominator. With no traffic in the window the
          // error rate is unknown, not zero — "0% errors" on a service
          // nobody called is a false reassurance.
          entry.errorRate = total && total > 0 ? errRate / total : null;
        }
      } catch (e: any) {
        warnings.push(`error rate query failed: ${e?.message ?? e}`);
      }
    } else {
      warnings.push('no status-code label found; error rate unavailable');
    }

    return {
      services: Array.from(byService.values()),
      // Prometheus attributes to the *serving* side. Without explicit
      // client-side labels it cannot say who called, so no caller→callee
      // attribution is claimed here rather than inventing one.
      edges: [],
      warnings,
    };
  }
}

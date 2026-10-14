/**
 * Services that observe the system rather than serve it: trace, metric and
 * log pipelines and their UIs.
 *
 * Deliberately excludes elasticsearch: unlike OpenSearch in the OTel demo,
 * it is often an application's functional search backend, and treating it as
 * a telemetry sink would hide a real dependency.
 *
 * Identified by name rather than by port or classified type, because ports
 * collide (:3000 is Grafana on one stack and an app frontend on another) and
 * classification is inconsistent (opensearch classifies as a plain service).
 *
 * Shared by entry-point ranking (don't send load to a dashboard) and edge
 * weighting (a call *into* one of these is telemetry export, not a dependency
 * the caller needs in order to work).
 */
export const OBSERVABILITY_NAMES =
  /(grafana|jaeger|prometheus|opensearch|kibana|zipkin|tempo|loki|otel-?collector|opamp|telemetry-docs|flagd-ui|fluent-?bit|fluentd|logstash|vector-agent)/i;

/** The service part of a `project:service` id. */
function serviceName(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

export function isObservabilityService(idOrName: string): boolean {
  return OBSERVABILITY_NAMES.test(serviceName(idOrName));
}

"""Service roles: is this service part of the monitoring stack?

Question answered: "does this name belong to a service that only observes the
system (Grafana, Jaeger, an OpenTelemetry collector...) instead of serving it?"

Mirrors: server/algorithms/graph/serviceRoles.ts

Idea: calls INTO a monitoring service are fire-and-forget exports of traces,
metrics or logs. If the collector dies the app keeps serving, so these links must
not count as real dependencies. We recognise such services by NAME (a regex),
not by port, because ports collide (:3000 is Grafana in one stack and an app
frontend in another). Elasticsearch is left out on purpose: it is often a real
search backend of the application.

Left out compared with the TypeScript: nothing but the types; the regex and the
id handling are the same.
"""
import re

OBSERVABILITY_NAMES = re.compile(
    r"(grafana|jaeger|prometheus|opensearch|kibana|zipkin|tempo|loki|otel-?collector"
    r"|opamp|telemetry-docs|flagd-ui|fluent-?bit|fluentd|logstash|vector-agent)",
    re.IGNORECASE,
)


def service_part(service_id):
    """Ids look like 'project:service'. Return only the service part."""
    return service_id.split(":", 1)[1] if ":" in service_id else service_id


def is_observability_service(id_or_name):
    return OBSERVABILITY_NAMES.search(service_part(id_or_name)) is not None


if __name__ == "__main__":
    for name in ["shop:grafana", "shop:orders", "otel-collector", "elasticsearch", "shop:Jaeger-ui"]:
        print(f"{name:18} -> monitoring service: {is_observability_service(name)}")

export interface DiscoveredService {
  serviceId: string; // e.g. "sock-shop/carts" or "vertikal/vertikal-auth"
  targetId: string; // e.g. "sock-shop" or "vertikal"
  name: string; // e.g. "carts"
  containerId?: string;
  image?: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  health?: string;
  containerIP?: string;
  ports: number[];
  protocols: string[];
  labels: Record<string, string>;
  environmentMetadata?: Record<string, string>;
  restartCount?: number;
  networks?: string[];
  lastSeen: string;
}

export interface DiscoveredEndpoint {
  endpointId: string; // e.g. "sock-shop/edge-router/http-80"
  targetId: string; // e.g. "sock-shop"
  serviceId: string; // e.g. "sock-shop/edge-router"
  serviceName: string; // e.g. "edge-router"
  host: string;
  port: number;
  protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'GRPC' | 'AMQP';
  basePath?: string;
  type: 'PUBLIC' | 'INTERNAL';
  source: 'compose' | 'docker' | 'nginx' | 'traefik' | 'source-code' | 'openapi' | 'otel' | 'runtime-observation';
  discoveryMethod: 'container-ports' | 'nginx-config' | 'compose-config' | 'http-probe' | 'telemetry-span';
  reachable: boolean;
  lastChecked: string;
  statusCode?: number;
  latencyMs?: number;
}

export interface DiscoveredRoute {
  routeId: string; // e.g. "sock-shop/edge-router/http-80/GET/catalogue"
  targetId: string;
  serviceId: string;
  endpointId: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';
  path: string;
  protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'AMQP';
  source: 'compose' | 'docker' | 'nginx' | 'traefik' | 'nextjs' | 'source-code' | 'openapi' | 'otel' | 'http-log' | 'runtime-observation';
  declared: boolean;
  observed: boolean;
  trafficCapable: boolean;
  incapableReason?: string;
  firstSeen?: string;
  lastSeen?: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  latencyMs?: number;
}

export interface TargetDiscoverySummary {
  targetId: string;
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  lastDiscovery: string;
  servicesCount: number;
  publicEndpointsCount: number;
  internalEndpointsCount: number;
  routesCount: number;
  observedRoutesCount: number;
  trafficCapableRoutesCount: number;
}

import type {
  DiscoveredService,
  DiscoveredEndpoint,
  DiscoveredRoute,
  TargetDiscoverySummary
} from '../models/EndpointModels.js';

export class EndpointRegistry {
  private servicesByTarget = new Map<string, Map<string, DiscoveredService>>();
  private endpointsByTarget = new Map<string, Map<string, DiscoveredEndpoint>>();
  private routesByTarget = new Map<string, Map<string, DiscoveredRoute>>();
  private lastDiscoveryTimes = new Map<string, string>();

  // Ensure deterministic, stable IDs
  public static makeServiceId(targetId: string, serviceName: string): string {
    const cleanName = serviceName.replace(/^docker-compose-/, '').replace(/-\d+$/, '').replace(new RegExp(`^${targetId}-`), '');
    return `${targetId}:${cleanName}`;
  }

  public static makeEndpointId(targetId: string, serviceName: string, protocol: string, port: number): string {
    const cleanName = serviceName.replace(/^docker-compose-/, '').replace(/-\d+$/, '').replace(new RegExp(`^${targetId}-`), '');
    return `${targetId}/${cleanName}/${protocol.toLowerCase()}-${port}`;
  }

  public static makeRouteId(targetId: string, serviceName: string, port: number, method: string, path: string): string {
    const cleanName = serviceName.replace(/^docker-compose-/, '').replace(/-\d+$/, '').replace(new RegExp(`^${targetId}-`), '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${targetId}/${cleanName}/http-${port}/${method.toUpperCase()}${cleanPath}`;
  }

  public touchDiscovery(targetId: string): void {
    this.lastDiscoveryTimes.set(targetId, new Date().toISOString());
  }

  public registerService(service: DiscoveredService): void {
    if (!this.servicesByTarget.has(service.targetId)) {
      this.servicesByTarget.set(service.targetId, new Map());
    }
    this.servicesByTarget.get(service.targetId)!.set(service.serviceId, service);
    this.touchDiscovery(service.targetId);
  }

  public registerEndpoint(endpoint: DiscoveredEndpoint): void {
    if (!this.endpointsByTarget.has(endpoint.targetId)) {
      this.endpointsByTarget.set(endpoint.targetId, new Map());
    }
    this.endpointsByTarget.get(endpoint.targetId)!.set(endpoint.endpointId, endpoint);
    this.touchDiscovery(endpoint.targetId);
  }

  public registerRoute(route: DiscoveredRoute): void {
    if (!this.routesByTarget.has(route.targetId)) {
      this.routesByTarget.set(route.targetId, new Map());
    }
    const routesMap = this.routesByTarget.get(route.targetId)!;
    const existing = routesMap.get(route.routeId);

    if (existing) {
      existing.declared = existing.declared || route.declared;
      existing.observed = existing.observed || route.observed;
      if (route.firstSeen && (!existing.firstSeen || new Date(route.firstSeen) < new Date(existing.firstSeen))) {
        existing.firstSeen = route.firstSeen;
      }
      if (route.lastSeen && (!existing.lastSeen || new Date(route.lastSeen) > new Date(existing.lastSeen))) {
        existing.lastSeen = route.lastSeen;
      }
      existing.requestCount += route.requestCount;
      existing.successCount += route.successCount;
      existing.errorCount += route.errorCount;
      if (route.latencyMs !== undefined) existing.latencyMs = route.latencyMs;
      existing.trafficCapable = existing.trafficCapable || route.trafficCapable;
      if (!existing.trafficCapable && route.incapableReason) {
        existing.incapableReason = route.incapableReason;
      }
    } else {
      routesMap.set(route.routeId, route);
    }
    this.touchDiscovery(route.targetId);
  }

  public markRouteObserved(targetId: string, routeId: string, latencyMs?: number, isError: boolean = false): void {
    const routesMap = this.routesByTarget.get(targetId);
    if (!routesMap) return;

    const route = routesMap.get(routeId);
    if (route) {
      const nowIso = new Date().toISOString();
      if (!route.firstSeen) route.firstSeen = nowIso;
      route.lastSeen = nowIso;
      route.observed = true;
      route.requestCount += 1;
      if (isError) {
        route.errorCount += 1;
      } else {
        route.successCount += 1;
      }
      if (latencyMs !== undefined) {
        route.latencyMs = route.latencyMs ? Math.round((route.latencyMs * 0.7) + (latencyMs * 0.3)) : latencyMs;
      }
    }
  }

  public markAllRoutesObserved(targetId: string): void {
    const routesMap = this.routesByTarget.get(targetId);
    if (!routesMap) return;
    const nowIso = new Date().toISOString();
    for (const route of routesMap.values()) {
      if (!route.firstSeen) route.firstSeen = nowIso;
      route.lastSeen = nowIso;
      route.observed = true;
      route.requestCount += 1;
      route.successCount += 1;
    }
  }

  public getServices(targetId: string): DiscoveredService[] {
    const map = this.servicesByTarget.get(targetId);
    return map ? Array.from(map.values()) : [];
  }

  public getEndpoints(targetId: string, publicOnly: boolean = false): DiscoveredEndpoint[] {
    const map = this.endpointsByTarget.get(targetId);
    if (!map) return [];
    const all = Array.from(map.values());
    const filtered = publicOnly ? all.filter(e => e.type === 'PUBLIC') : all;
    // put the real entrypoint (public, port 80) first — otherwise whatever
    // got discovered first wins by accident (e.g. jaeger's :4318), and
    // that's what callers taking "the first endpoint" end up defaulting to
    return [...filtered].sort((a, b) => {
      const rank = (e: DiscoveredEndpoint) => (e.type === 'PUBLIC' ? (e.port === 80 ? 0 : 1) : 2);
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.port - b.port;
    });
  }

  public getEndpoint(targetId: string, endpointId?: string): DiscoveredEndpoint | undefined {
    const endpoints = this.getEndpoints(targetId);
    if (endpointId) {
      const found = endpoints.find(e => e.endpointId === endpointId);
      if (found) return found;
    }
    return endpoints.find(e => e.type === 'PUBLIC') || endpoints[0];
  }

  public getEndpointUrl(targetId: string, endpointId?: string, targetHost?: string): string | null {
    const endpoint = this.getEndpoint(targetId, endpointId);
    if (!endpoint) return null;

    let host = targetHost;
    if (!host || host === 'unknown' || host === 'AWS-EC2-Public-IP') {
      if (endpoint.host && endpoint.host !== 'AWS-EC2-Public-IP' && endpoint.host !== 'unknown') {
        host = endpoint.host;
      }
    }

    if (!host || host === 'unknown' || host === 'AWS-EC2-Public-IP') {
      return null;
    }

    const proto = (endpoint.protocol || 'HTTP').toLowerCase();
    const portStr = (endpoint.port === 80 && proto === 'http') || (endpoint.port === 443 && proto === 'https') ? '' : `:${endpoint.port}`;
    return `${proto}://${host}${portStr}${endpoint.basePath || ''}`;
  }

  public getRoutes(targetId: string, serviceId?: string, endpointId?: string): DiscoveredRoute[] {
    const map = this.routesByTarget.get(targetId);
    if (!map) return [];
    let routes = Array.from(map.values());
    if (serviceId) {
      routes = routes.filter(r => r.serviceId === serviceId);
    }
    if (endpointId) {
      routes = routes.filter(r => r.endpointId === endpointId);
    }
    return routes;
  }

  public getSummary(targetId: string): TargetDiscoverySummary {
    const services = this.getServices(targetId);
    const endpoints = this.getEndpoints(targetId);
    const publicEndpoints = endpoints.filter(e => e.type === 'PUBLIC');
    const internalEndpoints = endpoints.filter(e => e.type === 'INTERNAL');
    const routes = this.getRoutes(targetId);
    const observedRoutes = routes.filter(r => r.observed);
    const trafficCapableRoutes = routes.filter(r => r.trafficCapable);

    const lastDiscovery = this.lastDiscoveryTimes.get(targetId) || new Date().toISOString();
    
    let status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA' = 'NO DATA';
    if (services.length > 0) {
      const diff = Date.now() - new Date(lastDiscovery).getTime();
      if (diff < 30000) status = 'LIVE';
      else if (diff < 120000) status = 'STALE';
      else status = 'OFFLINE';
    }

    return {
      targetId,
      status,
      lastDiscovery,
      servicesCount: services.length,
      publicEndpointsCount: publicEndpoints.length,
      internalEndpointsCount: internalEndpoints.length,
      routesCount: routes.length,
      observedRoutesCount: observedRoutes.length,
      trafficCapableRoutesCount: trafficCapableRoutes.length
    };
  }

  public clearTarget(targetId: string): void {
    this.servicesByTarget.delete(targetId);
    this.endpointsByTarget.delete(targetId);
    this.routesByTarget.delete(targetId);
  }
}

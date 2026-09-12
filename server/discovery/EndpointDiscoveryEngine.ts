import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { EndpointRegistry } from '../registry/EndpointRegistry.js';
import { config } from '../config.js';
import type {
  DiscoveredService,
  DiscoveredEndpoint,
  DiscoveredRoute
} from '../models/EndpointModels.js';

export class EndpointDiscoveryEngine {
  private registry: EndpointRegistry;
  private getTargetHost?: (targetId: string) => string | undefined;

  constructor(registry: EndpointRegistry, getTargetHost?: (targetId: string) => string | undefined) {
    this.registry = registry;
    this.getTargetHost = getTargetHost;
  }

  public async discoverAll(): Promise<void> {
    await this.discoverSockShop();
    await this.discoverVertikal();
  }

  public async discoverTarget(targetId: string): Promise<void> {
    if (targetId.includes('sock')) {
      await this.discoverSockShop(targetId);
    } else if (targetId.includes('vertikal')) {
      await this.discoverVertikal(targetId);
    }
  }

  private async discoverSockShop(targetId: string = 'sock-shop'): Promise<void> {
    const nowIso = new Date().toISOString();
    const resolvedHost = this.getTargetHost ? this.getTargetHost(targetId) : undefined;

    // 1. Compose / Service Discovery
    const composePath = config.SOCK_SHOP_COMPOSE_PATH || path.resolve(process.cwd(), 'sock-shop-docker-compose.yml');
    let servicesList: Array<{ name: string; type: string; ports: number[]; isPublic: boolean }> = [];

    if (fs.existsSync(composePath)) {
      try {
        const fileContent = fs.readFileSync(composePath, 'utf8');
        const parsed = yaml.parse(fileContent);
        if (parsed && parsed.services) {
          for (const [svcName, svcConfig] of Object.entries<any>(parsed.services)) {
            const ports: number[] = [];
            let isPublic = false;
            if (svcConfig.ports) {
              for (const p of svcConfig.ports) {
                const str = String(p);
                const hostPort = str.includes(':') ? parseInt(str.split(':')[0], 10) : parseInt(str, 10);
                if (!isNaN(hostPort)) {
                  ports.push(hostPort);
                  isPublic = true;
                }
              }
            }

            servicesList.push({
              name: svcName,
              type: this.determineServiceType(svcName, svcConfig.image || ''),
              ports,
              isPublic
            });
          }
        }
      } catch (e) {
        console.warn(`[EndpointDiscovery] Failed parsing Sock Shop compose file at ${composePath}:`, e);
      }
    }

    if (servicesList.length === 0) {
      servicesList = [
        { name: 'edge-router', type: 'gateway', ports: [80], isPublic: true },
        { name: 'front-end', type: 'frontend', ports: [8079], isPublic: false },
        { name: 'catalogue', type: 'service', ports: [80], isPublic: false },
        { name: 'catalogue-db', type: 'database', ports: [3306], isPublic: false },
        { name: 'carts', type: 'service', ports: [80], isPublic: false },
        { name: 'carts-db', type: 'database', ports: [27017], isPublic: false },
        { name: 'orders', type: 'service', ports: [80], isPublic: false },
        { name: 'orders-db', type: 'database', ports: [27017], isPublic: false },
        { name: 'payment', type: 'service', ports: [80], isPublic: false },
        { name: 'shipping', type: 'service', ports: [80], isPublic: false },
        { name: 'user', type: 'service', ports: [80], isPublic: false },
        { name: 'user-db', type: 'database', ports: [27017], isPublic: false },
        { name: 'queue-master', type: 'service', ports: [80], isPublic: false },
        { name: 'rabbitmq', type: 'queue', ports: [5672], isPublic: false },
        { name: 'user-sim', type: 'service', ports: [], isPublic: false }
      ];
    }

    for (const svc of servicesList) {
      const serviceId = EndpointRegistry.makeServiceId(targetId, svc.name);
      
      const discoveredService: DiscoveredService = {
        serviceId,
        targetId,
        name: svc.name,
        status: 'healthy',
        ports: svc.ports.length > 0 ? svc.ports : [80],
        protocols: ['HTTP'],
        labels: { project: targetId, discoveredBy: 'compose-manifest' },
        lastSeen: nowIso
      };
      this.registry.registerService(discoveredService);

      const isPublicEndpoint = svc.name === 'edge-router' || svc.isPublic;
      const endpointPort = svc.ports[0] || (svc.name === 'edge-router' ? 80 : 8080);
      const endpointId = EndpointRegistry.makeEndpointId(targetId, svc.name, 'HTTP', endpointPort);

      const discoveredEndpoint: DiscoveredEndpoint = {
        endpointId,
        targetId,
        serviceId,
        serviceName: svc.name,
        host: isPublicEndpoint ? (resolvedHost || 'unknown') : `${svc.name}.sockshop.internal`,
        port: endpointPort,
        protocol: 'HTTP',
        type: isPublicEndpoint ? 'PUBLIC' : 'INTERNAL',
        source: 'compose',
        discoveryMethod: 'compose-config',
        reachable: isPublicEndpoint,
        lastChecked: nowIso
      };
      this.registry.registerEndpoint(discoveredEndpoint);
    }

    // Discover Routes for Sock Shop
    const publicEndpointId = EndpointRegistry.makeEndpointId(targetId, 'edge-router', 'HTTP', 80);
    
    const sockShopRoutes: Array<{ path: string; method: 'GET' | 'POST'; service: string; trafficCapable: boolean; reason?: string }> = [
      { path: '/', method: 'GET', service: 'front-end', trafficCapable: true },
      { path: '/category.html', method: 'GET', service: 'front-end', trafficCapable: true },
      { path: '/detail.html', method: 'GET', service: 'front-end', trafficCapable: true },
      { path: '/basket.html', method: 'GET', service: 'front-end', trafficCapable: true },
      { path: '/catalogue', method: 'GET', service: 'catalogue', trafficCapable: true },
      { path: '/catalogue/{id}', method: 'GET', service: 'catalogue', trafficCapable: true },
      { path: '/cart', method: 'GET', service: 'carts', trafficCapable: true },
      { path: '/cart', method: 'POST', service: 'carts', trafficCapable: true },
      { path: '/orders', method: 'GET', service: 'orders', trafficCapable: true },
      { path: '/orders', method: 'POST', service: 'orders', trafficCapable: true },
      { path: '/login', method: 'GET', service: 'user', trafficCapable: true },
      { path: '/card', method: 'GET', service: 'user', trafficCapable: true },
      { path: '/address', method: 'GET', service: 'user', trafficCapable: true },
    ];

    for (const r of sockShopRoutes) {
      const serviceId = EndpointRegistry.makeServiceId(targetId, r.service);
      const routeId = EndpointRegistry.makeRouteId(targetId, 'edge-router', 80, r.method, r.path);

      const route: DiscoveredRoute = {
        routeId,
        targetId,
        serviceId,
        endpointId: publicEndpointId,
        method: r.method,
        path: r.path,
        protocol: 'HTTP',
        source: 'nginx',
        declared: true,
        observed: false,
        trafficCapable: r.trafficCapable,
        incapableReason: r.reason,
        requestCount: 0,
        successCount: 0,
        errorCount: 0
      };
      this.registry.registerRoute(route);
    }
  }

  private async discoverVertikal(targetId: string = 'vertikal'): Promise<void> {
    const nowIso = new Date().toISOString();
    const resolvedHost = this.getTargetHost ? this.getTargetHost(targetId) : undefined;

    const vertikalServices: Array<{ name: string; type: string; port: number; isPublic: boolean; host: string }> = [
      { name: 'vertikal-gateway', type: 'gateway', port: 54321, isPublic: true, host: resolvedHost || 'unknown' },
      { name: 'storefront', type: 'frontend', port: 3000, isPublic: true, host: resolvedHost || 'unknown' },
      { name: 'vertikal-studio', type: 'frontend', port: 54323, isPublic: true, host: resolvedHost || 'unknown' },
      { name: 'vertikal-mail', type: 'infrastructure', port: 54324, isPublic: true, host: resolvedHost || 'unknown' },
      { name: 'vertikal-auth', type: 'service', port: 9999, isPublic: false, host: 'vertikal-auth.internal' },
      { name: 'vertikal-rest', type: 'service', port: 3000, isPublic: false, host: 'vertikal-rest.internal' },
      { name: 'vertikal-meta', type: 'service', port: 3000, isPublic: false, host: 'vertikal-meta.internal' },
      { name: 'vertikal-db', type: 'database', port: 54322, isPublic: false, host: 'vertikal-db.internal' },
    ];

    for (const svc of vertikalServices) {
      const serviceId = EndpointRegistry.makeServiceId(targetId, svc.name);

      const discoveredService: DiscoveredService = {
        serviceId,
        targetId,
        name: svc.name,
        status: 'healthy',
        ports: [svc.port],
        protocols: ['HTTP'],
        labels: { project: targetId, discoveredBy: 'nginx-compose-manifest' },
        lastSeen: nowIso
      };
      this.registry.registerService(discoveredService);

      const endpointId = EndpointRegistry.makeEndpointId(targetId, svc.name, 'HTTP', svc.port);
      const discoveredEndpoint: DiscoveredEndpoint = {
        endpointId,
        targetId,
        serviceId,
        serviceName: svc.name,
        host: svc.host,
        port: svc.port,
        protocol: 'HTTP',
        type: svc.isPublic ? 'PUBLIC' : 'INTERNAL',
        source: 'nginx',
        discoveryMethod: 'nginx-config',
        reachable: svc.isPublic,
        lastChecked: nowIso
      };
      this.registry.registerEndpoint(discoveredEndpoint);
    }

    const gatewayEndpointId = EndpointRegistry.makeEndpointId(targetId, 'vertikal-gateway', 'HTTP', 54321);
    const storefrontEndpointId = EndpointRegistry.makeEndpointId(targetId, 'storefront', 'HTTP', 3000);

    const vertikalRoutes: Array<{ path: string; method: 'GET' | 'POST'; service: string; endpointId: string; trafficCapable: boolean; reason?: string }> = [
      { path: '/', method: 'GET', service: 'storefront', endpointId: storefrontEndpointId, trafficCapable: true },
      { path: '/products', method: 'GET', service: 'storefront', endpointId: storefrontEndpointId, trafficCapable: true },
      { path: '/health', method: 'GET', service: 'vertikal-gateway', endpointId: gatewayEndpointId, trafficCapable: true },
      { path: '/auth/v1/health', method: 'GET', service: 'vertikal-auth', endpointId: gatewayEndpointId, trafficCapable: true },
      { path: '/auth/v1/signup', method: 'POST', service: 'vertikal-auth', endpointId: gatewayEndpointId, trafficCapable: true },
      { path: '/auth/v1/token', method: 'POST', service: 'vertikal-auth', endpointId: gatewayEndpointId, trafficCapable: true },
      { path: '/rest/v1/schema', method: 'GET', service: 'vertikal-rest', endpointId: gatewayEndpointId, trafficCapable: true },
      { path: '/rest/v1/meta', method: 'GET', service: 'vertikal-meta', endpointId: gatewayEndpointId, trafficCapable: true },
    ];

    for (const r of vertikalRoutes) {
      const serviceId = EndpointRegistry.makeServiceId(targetId, r.service);
      const routeId = EndpointRegistry.makeRouteId(targetId, r.service, 54321, r.method, r.path);

      const route: DiscoveredRoute = {
        routeId,
        targetId,
        serviceId,
        endpointId: r.endpointId,
        method: r.method,
        path: r.path,
        protocol: 'HTTP',
        source: 'nginx',
        declared: true,
        observed: false,
        trafficCapable: r.trafficCapable,
        incapableReason: r.reason,
        requestCount: 0,
        successCount: 0,
        errorCount: 0
      };
      this.registry.registerRoute(route);
    }
  }

  private determineServiceType(name: string, image: string): string {
    const n = name.toLowerCase();
    const img = image.toLowerCase();
    if (n.includes('db') || img.includes('mongo') || img.includes('mysql') || img.includes('postgres')) return 'database';
    if (n.includes('rabbitmq') || n.includes('queue')) return 'queue';
    if (n.includes('edge-router') || n.includes('gateway') || img.includes('traefik')) return 'gateway';
    if (n.includes('front-end') || n.includes('ui') || n.includes('storefront')) return 'frontend';
    return 'service';
  }
}

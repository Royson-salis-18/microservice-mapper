export interface Target {
  targetId: string;
  displayName: string;
  environment: 'local' | 'remote' | 'aws';
  host: string;
  transport: 'http' | 'ssh-tunnel';
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  lastSeen: string;
  baseUrl?: string;
  publicPort?: number;
  endpointStatus?: 'REACHABLE' | 'UNREACHABLE' | 'UNCONFIGURED';
  telemetryStatus?: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO DATA';
  capabilities: {
    dockerMetrics: boolean;
    serviceHealth: boolean;
    topology: boolean;
    httpInteractions: boolean;
    traces: boolean;
  };
  discoverySummary?: {
    lastDiscovery: string;
    servicesCount: number;
    publicEndpointsCount: number;
    internalEndpointsCount: number;
    routesCount: number;
    observedRoutesCount: number;
    trafficCapableRoutesCount: number;
  };
}


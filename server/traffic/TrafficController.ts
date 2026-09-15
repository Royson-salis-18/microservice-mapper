import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { config } from '../config.js';
import type { GraphStore } from '../graph/GraphStore.js';

export interface TargetTrafficOptions {
  profile?: string;
  mode?: 'USER_JOURNEY' | 'ENDPOINT' | 'SERVICE';
  routeId?: string;
  serviceId?: string;
  endpointId?: string;
  overrideUrl?: string;
}

export interface TargetTrafficStatus {
  targetId: string;
  isRunning: boolean;
  profileName: string;
  mode?: string;
  routeId?: string;
  serviceId?: string;
  endpointId?: string;
  startTime: string | null;
  pid: number | null;
  resolvedUrl?: string;
  error?: string;
  workloadSource?: 'EXTERNAL' | 'USER_SIM';
}

export class TrafficController {
  private processes: Map<string, { process: ChildProcess | null; startTime: string; profile: string; mode: string; resolvedUrl: string; workloadSource: 'EXTERNAL' | 'USER_SIM' }> = new Map();
  private graphStore?: GraphStore;
  public onStatsCallback?: (targetId: string, stats: any) => void;

  constructor(graphStore?: GraphStore) {
    this.graphStore = graphStore;
  }

  public setGraphStore(graphStore: GraphStore) {
    this.graphStore = graphStore;
  }

  public resolveBaseUrl(targetId: string, endpointId?: string, overrideUrl?: string): string | null {
    if (overrideUrl && overrideUrl.trim().length > 0) {
      return overrideUrl.trim();
    }

    if (this.graphStore) {
      const target = this.graphStore.targets.get(targetId);
      const targetHost = target?.host && target.host !== 'unknown' ? target.host : undefined;

      const registryUrl = this.graphStore.endpointRegistry.getEndpointUrl(targetId, endpointId, targetHost);
      if (registryUrl && !registryUrl.includes('unknown') && !registryUrl.includes('AWS-EC2-Public-IP')) {
        return registryUrl;
      }

      if (target?.baseUrl && !target.baseUrl.includes('unknown') && !target.baseUrl.includes('AWS-EC2-Public-IP')) {
        return target.baseUrl;
      }
    }

    return null;
  }

  public startTarget(targetId: string, options: TargetTrafficOptions & { workloadSource?: 'EXTERNAL' | 'USER_SIM' } = {}): TargetTrafficStatus {
    const profile = options.profile || 'normal';
    const mode = options.mode || 'USER_JOURNEY';
    const endpointId = options.endpointId;
    const overrideUrl = options.overrideUrl;
    const workloadSource = options.workloadSource || 'EXTERNAL';

    this.stopTarget(targetId);

    const resolvedUrl = this.resolveBaseUrl(targetId, endpointId, overrideUrl);
    
    console.log(`[EXPERIMENT] targetId=${targetId} endpoint=${endpointId || 'default'} resolvedUrl=${resolvedUrl || 'null'} status=STARTING trafficEngine=${workloadSource}`);

    if (!resolvedUrl) {
      console.warn(`[EXPERIMENT] status=ABORTED targetId=${targetId} reason="Public endpoint host not available from Target Registry"`);
      return {
        targetId,
        isRunning: false,
        profileName: profile,
        mode,
        startTime: null,
        pid: null,
        error: `PUBLIC HOST NOT AVAILABLE FROM CURRENT TARGET REGISTRY FOR ${targetId}`
      };
    }

    // Check if mode === SERVICE or ENDPOINT and verify traffic capability
    if (this.graphStore && options.serviceId && mode === 'SERVICE') {
      const routes = this.graphStore.endpointRegistry.getRoutes(targetId, options.serviceId);
      const capable = routes.some(r => r.trafficCapable);
      if (routes.length > 0 && !capable) {
        return {
          targetId,
          isRunning: false,
          profileName: profile,
          mode,
          startTime: null,
          pid: null,
          error: `No valid public workflow currently reaches service ${options.serviceId}.`
        };
      }
    }

    if (workloadSource === 'USER_SIM') {
      console.log(`[TrafficController] USER_SIM requested for ${targetId} - execution delegated to environment orchestrator`);
      
      const startTime = new Date().toISOString();
      this.processes.set(targetId, { process: null, startTime, profile, mode, resolvedUrl, workloadSource });
      
      return {
        targetId,
        isRunning: true,
        profileName: profile,
        mode,
        routeId: options.routeId,
        serviceId: options.serviceId,
        endpointId,
        startTime,
        pid: null,
        resolvedUrl,
        workloadSource
      };
    }

    const trafficGenDir = path.resolve(process.cwd(), '../traffic-generator');
    const cliPath = path.resolve(trafficGenDir, 'src/cli.ts');

    const args = [
      'src/cli.ts',
      '--target', targetId,
      '--profile', profile,
      '--url', resolvedUrl,
      '--mode', mode
    ];

    if (options.routeId) {
      const cleanPath = options.routeId.substring(options.routeId.indexOf('/HTTP-') + 8);
      args.push('--route', cleanPath);
    }
    if (options.serviceId) {
      const cleanSvc = options.serviceId.includes('/') ? options.serviceId.split('/')[1] : options.serviceId;
      args.push('--service', cleanSvc);
    }
    if (endpointId) {
      args.push('--endpoint', endpointId);
    }

    console.log(`[TrafficController] Spawning traffic for ${targetId} -> ${resolvedUrl} (Mode: ${mode}, Profile: ${profile})`);

    const child = spawn('node', ['--import', 'tsx', cliPath, ...args.slice(1)], {
      cwd: trafficGenDir,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startTime = new Date().toISOString();
    this.processes.set(targetId, { process: child, startTime, profile, mode, resolvedUrl, workloadSource });

    child.stdout?.on('data', (chunk) => {
      const output = chunk.toString('utf8');
      const lines = output.split('\n');
      for (const line of lines) {
        const msg = line.trim();
        if (!msg) continue;
        if (msg.startsWith('__STATS__')) {
          try {
            const parts = msg.substring(9).split('::');
            if (parts.length === 2 && this.onStatsCallback) {
              this.onStatsCallback(parts[0], JSON.parse(parts[1]));
            }
          } catch(e) {}
        } else {
          console.log(`[TrafficGen:${targetId}] ${msg}`);
        }
      }
    });

    child.stderr?.on('data', (chunk) => {
      console.error(`[TrafficGen:${targetId}:err] ${chunk.toString('utf8').trim()}`);
    });

    child.on('exit', (code) => {
      console.log(`[TrafficController] Process for ${targetId} exited with code ${code}`);
      this.processes.delete(targetId);
    });

    return {
      targetId,
      isRunning: true,
      profileName: profile,
      mode,
      routeId: options.routeId,
      serviceId: options.serviceId,
      endpointId,
      startTime,
      pid: child.pid || null,
      resolvedUrl
    };
  }

  public stopTarget(targetId: string): TargetTrafficStatus {
    const existing = this.processes.get(targetId);
    if (existing) {
      if (existing.workloadSource === 'USER_SIM') {
        console.log(`[TrafficController] Stopping USER_SIM for ${targetId} - delegated to environment orchestrator`);
      } else if (existing.process) {
        console.log(`[TrafficController] Stopping process for ${targetId} (PID: ${existing.process.pid})`);
        existing.process.kill('SIGTERM');
      }
      this.processes.delete(targetId);
      return {
        targetId,
        isRunning: false,
        profileName: existing.profile,
        mode: existing.mode,
        startTime: existing.startTime,
        pid: null,
        resolvedUrl: existing.resolvedUrl,
        workloadSource: existing.workloadSource
      };
    }
    return {
      targetId,
      isRunning: false,
      profileName: 'none',
      startTime: null,
      pid: null,
    };
  }

  public stopAll(): TargetTrafficStatus[] {
    const results: TargetTrafficStatus[] = [];
    for (const targetId of Array.from(this.processes.keys())) {
      results.push(this.stopTarget(targetId));
    }
    return results;
  }

  public getStatus(targetId?: string): TargetTrafficStatus[] {
    if (targetId && targetId !== 'all') {
      const p = this.processes.get(targetId);
      const resolvedUrl = this.resolveBaseUrl(targetId);
      return [{
        targetId,
        isRunning: !!p,
        profileName: p ? p.profile : 'normal',
        mode: p ? p.mode : 'USER_JOURNEY',
        startTime: p ? p.startTime : null,
        pid: p?.process?.pid || null,
        resolvedUrl: p ? p.resolvedUrl : (resolvedUrl || undefined),
        workloadSource: p?.workloadSource
      }];
    }

    const targets = this.graphStore && this.graphStore.targets.size > 0 
      ? Array.from(this.graphStore.targets.keys()) 
      : ['sock-shop', 'vertikal'];

    return targets.map((tId) => {
      const p = this.processes.get(tId);
      const resolvedUrl = this.resolveBaseUrl(tId);
      return {
        targetId: tId,
        isRunning: !!p,
        profileName: p ? p.profile : 'normal',
        mode: p ? p.mode : 'USER_JOURNEY',
        startTime: p ? p.startTime : null,
        pid: p?.process?.pid || null,
        resolvedUrl: p ? p.resolvedUrl : (resolvedUrl || undefined),
        workloadSource: p?.workloadSource
      };
    });
  }
}

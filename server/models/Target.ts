export interface Target {
  id: string;
  name: string;
  type: string;
  environment: string;
  platform: string;
  region?: string;
  endpoint?: string;
  status: 'LIVE' | 'STALE' | 'OFFLINE' | 'NO_DATA';
  lastSeen: string | null;
  metadata?: Record<string, any>;
}

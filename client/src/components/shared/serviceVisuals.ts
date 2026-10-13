import { Cloud, Database, Globe, Inbox, Layers, Monitor, Server, Wrench, type LucideIcon } from 'lucide-react';

/**
 * One palette for what a service *is* and how it is *doing*, shared by the 2D
 * cards, the inspection panel, the minimap and the 3D units.
 *
 * Category tints are all cool (blue, sky, indigo, violet, mint). Warm colours
 * are reserved for trouble, so anything amber or red on screen always means a
 * real problem and never "this is a queue".
 */
export const TYPE_VISUAL: Record<string, { color: string; icon: LucideIcon; label: string }> = {
  gateway:        { color: '#38bdf8', icon: Globe,    label: 'Gateway' },
  frontend:       { color: '#818cf8', icon: Monitor,  label: 'Frontend' },
  database:       { color: '#2ed3a0', icon: Database, label: 'Database' },
  cache:          { color: '#a78bfa', icon: Layers,   label: 'Cache' },
  queue:          { color: '#c084fc', icon: Inbox,    label: 'Queue' },
  service:        { color: '#6b8cff', icon: Server,   label: 'Service' },
  infrastructure: { color: '#94a3b8', icon: Wrench,   label: 'Infra' },
  external:       { color: '#cbd5e1', icon: Cloud,    label: 'External' },
};

export function typeVisual(type: string | undefined) {
  return TYPE_VISUAL[type ?? ''] ?? TYPE_VISUAL.service;
}

export const STATUS_VISUAL: Record<string, { color: string; label: string }> = {
  healthy:  { color: '#25e3a3', label: 'Healthy' },
  degraded: { color: '#ffab40', label: 'Degraded' },
  critical: { color: '#ff3d5e', label: 'Down' },
  unknown:  { color: '#6b7494', label: 'Unknown' },
};

export function statusVisual(status: string | undefined) {
  return STATUS_VISUAL[status ?? ''] ?? STATUS_VISUAL.unknown;
}

/** Load colour for a 0–100 figure: calm blue, amber past 60, red past 80. */
export function loadColor(percent: number): string {
  return percent > 80 ? '#ff3d5e' : percent > 60 ? '#ffab40' : '#5b7cff';
}

/** `project:service` → `service`. */
export function shortName(id: string | null | undefined): string {
  if (!id) return '';
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

type Metrics = { cpu?: number; cpuOfAllowance?: number; cpuAllowanceCores?: number } | null | undefined;

/**
 * CPU as every view shows it: the share of what the container may use
 * (its CPU limit, else the host's cores), 0..100. docker's own figure is a
 * percentage of ONE core and runs past 100 on multi-core hosts, so it is only
 * the fallback when the allowance is unknown. Undefined when not measured.
 */
export function cpuShown(m: Metrics): number | undefined {
  if (typeof m?.cpuOfAllowance === 'number') return m.cpuOfAllowance;
  return typeof m?.cpu === 'number' ? m.cpu : undefined;
}

/** What the CPU figure is a share of, for tooltips. */
export function cpuBasis(m: Metrics): string {
  if (typeof m?.cpuOfAllowance === 'number' && m.cpuAllowanceCores) {
    const cores = Math.round(m.cpuAllowanceCores * 100) / 100;
    return `${m.cpuOfAllowance.toFixed(1)}% of its ${cores}-core allowance (docker reports ${m.cpu?.toFixed(1) ?? '?'}% of one core)`;
  }
  return typeof m?.cpu === 'number' ? `${m.cpu.toFixed(1)}% of one core (allowance not known)` : 'not measured';
}

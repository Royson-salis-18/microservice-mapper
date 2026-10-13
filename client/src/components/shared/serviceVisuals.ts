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
  gateway:        { color: '#a9b0ba', icon: Globe,    label: 'Gateway' },
  frontend:       { color: '#8ab4ff', icon: Monitor,  label: 'Frontend' },
  database:       { color: '#3ecf8e', icon: Database, label: 'Database' },
  cache:          { color: '#8ab4ff', icon: Layers,   label: 'Cache' },
  queue:          { color: '#8ab4ff', icon: Inbox,    label: 'Queue' },
  service:        { color: '#8ab4ff', icon: Server,   label: 'Service' },
  infrastructure: { color: '#a9b0ba', icon: Wrench,   label: 'Infra' },
  external:       { color: '#a9b0ba', icon: Cloud,    label: 'External' },
};

export function typeVisual(type: string | undefined) {
  return TYPE_VISUAL[type ?? ''] ?? TYPE_VISUAL.service;
}

export const STATUS_VISUAL: Record<string, { color: string; label: string }> = {
  healthy:  { color: '#3ecf8e', label: 'Healthy' },
  degraded: { color: '#e8a33d', label: 'Degraded' },
  critical: { color: '#ef5f67', label: 'Down' },
  unknown:  { color: '#6b7079', label: 'Unknown' },
};

export function statusVisual(status: string | undefined) {
  return STATUS_VISUAL[status ?? ''] ?? STATUS_VISUAL.unknown;
}

/** Load colour for a 0–100 figure: calm blue, amber past 60, red past 80. */
export function loadColor(percent: number): string {
  return percent > 80 ? '#ef5f67' : percent > 60 ? '#e8a33d' : '#8ab4ff';
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

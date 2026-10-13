import { memo, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { ServiceNode } from '../types';
import { cpuBasis, cpuShown, loadColor, statusVisual, typeVisual } from './shared/serviceVisuals';

interface ServiceNodeProps {
  data: ServiceNode;
  selected: boolean;
}

function Meter({ label, value, title }: { label: string; value: number | undefined; title: string }) {
  const v = value ?? 0;
  const color = loadColor(v);
  return (
    <div className="svc-meter" title={title}>
      <span className="svc-meter-label">{label}</span>
      <div className="svc-meter-track">
        <div
          className="svc-meter-fill"
          style={{
            width: `${Math.min(Math.max(v, 0), 100)}%`,
            background: `linear-gradient(90deg, ${color}99, ${color})`,
            boxShadow: `0 0 6px ${color}88`,
          }}
        />
      </div>
      <span className="svc-meter-value">{value === undefined ? '—' : `${value.toFixed(1)}%`}</span>
    </div>
  );
}

/**
 * A service on the 2D canvas: a glass card with the category's icon tile,
 * its live CPU and memory, and a status light. Styling lives in index.css
 * (.svc-*); the card only sets its two colours as custom properties.
 *
 * Trouble reads from the card's edge: an amber rim for degraded, a pulsing
 * red one for down. Selection is the indigo accent used everywhere else.
 */
function ServiceNodeInner({ data, selected }: ServiceNodeProps) {
  const type = typeVisual(data.type as string);
  const status = statusVisual(data.status);
  const Icon = type.icon;
  const viewMode = ((data as any).viewMode as string) || 'dependency';
  const cpu = cpuShown(data.metrics);
  const mem = data.metrics?.memoryPercent;
  const risk = data.analytics?.riskScore ?? 0;

  const classes = ['svc-card'];
  if (selected) classes.push('selected');
  if (data.status === 'critical') classes.push('critical');
  else if (data.status === 'degraded') classes.push('degraded');
  if (viewMode === 'failure' && data.status === 'healthy') classes.push('faded');

  const vars = { '--svc-tint': type.color, '--svc-status': status.color } as CSSProperties;

  return (
    <div className={classes.join(' ')} style={vars}>
      <Handle type="target" position={Position.Top} className="svc-handle" />

      {risk > 0.6 && (
        <div
          className="svc-badge risk"
          style={{ color: risk > 0.8 ? '#ff3d5e' : '#ffab40' }}
          title={`Risk ${Math.round(risk * 100)}%: current exposure, not a predicted probability. See the Reliability tab for the breakdown.`}
        >
          RISK {Math.round(risk * 100)}%
        </div>
      )}

      {data.analytics?.anomalyPersistent && (
        <div
          className="svc-badge anomaly"
          title={`ML ensemble: at least half of this service's trained detectors agree it is anomalous (score ${Math.round((data.analytics?.anomalyScore ?? 0) * 100)}%), sustained over multiple scoring windows`}
        >
          ANOMALY
        </div>
      )}

      <div className="svc-head">
        <span className="svc-icon" aria-hidden="true">
          <Icon size={15} strokeWidth={2.2} />
        </span>
        <div className="svc-titles">
          <div className="svc-name" title={data.name}>{data.name}</div>
          <div className="svc-project">{data.project}</div>
        </div>
        <span
          className={`svc-status ${data.status === 'healthy' ? 'breathe' : ''}`}
          title={status.label}
          aria-label={status.label}
        />
      </div>

      <Meter label="CPU" value={cpu} title={cpuBasis(data.metrics)} />
      <Meter label="MEM" value={mem} title={typeof mem === 'number' ? `${mem.toFixed(1)}% of its memory limit` : 'not measured'} />

      <Handle type="source" position={Position.Bottom} className="svc-handle" />
    </div>
  );
}

/**
 * Re-render when something shown changes. App rebuilds node objects on every
 * graph push; the bars and figures on this card change only when their
 * displayed (one-decimal) values do.
 */
function sameNodeProps(a: ServiceNodeProps, b: ServiceNodeProps): boolean {
  if (a.selected !== b.selected) return false;
  const da = a.data as any, db = b.data as any;
  if (da.id !== db.id || da.status !== db.status || da.type !== db.type || da.name !== db.name || da.viewMode !== db.viewMode || da.project !== db.project) return false;
  const r1 = (v: unknown) => (typeof v === 'number' ? Math.round(v * 10) : -1);
  if (r1(cpuShown(da.metrics)) !== r1(cpuShown(db.metrics)) || r1(da.metrics?.memoryPercent) !== r1(db.metrics?.memoryPercent)) return false;
  const aa = da.analytics ?? {}, ab = db.analytics ?? {};
  if (Math.round((aa.riskScore ?? -1) * 100) !== Math.round((ab.riskScore ?? -1) * 100)) return false;
  if (Boolean(aa.anomalyPersistent) !== Boolean(ab.anomalyPersistent) || Math.round((aa.anomalyScore ?? -1) * 100) !== Math.round((ab.anomalyScore ?? -1) * 100)) return false;
  return true;
}

export const CustomServiceNode = memo(ServiceNodeInner, sameNodeProps);

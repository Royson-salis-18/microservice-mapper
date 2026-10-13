import { BaseEdge, EdgeLabelRenderer, getBezierPath, useStore } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { DependencyEdge } from '../types';
import { memo, useState } from 'react';
import { edgeAppearance } from './shared/edgeHeat';
import { shortName } from './shared/serviceVisuals';
import { formatFlow, linkFlow, svgPulses } from './shared/linkFlow';

type EdgeData = DependencyEdge & { emphasized?: boolean };

/**
 * How a link is drawn, from what is measured about it. Colour is the shared
 * heat scale (identical in the 3D scene); thickness is the dependency weight
 * (how much the caller relies on this callee). Before weights existed both
 * encoded traffic, so a link a service could not live without looked the same
 * as one it barely used.
 */
function edgeLook(edge: EdgeData | undefined, targetStatus?: string) {
  const a = edgeAppearance(edge, { targetStatus });
  const observed = edge?.observed ?? false;
  const w = edge?.weight?.value;
  const telemetry = edge?.weight?.kind === 'telemetry';
  const strokeWidth = telemetry
    ? 1
    : typeof w === 'number'
      ? 1.2 + 4.3 * Math.min(Math.max(w, 0), 1)
      : !observed ? 1 : a.heat === 'saturated' || a.heat === 'failed' ? 3.4 : a.heat === 'heavy' || a.heat === 'busy' || a.heat === 'degraded' ? 2.6 : 2;
  return {
    ...a,
    observed,
    telemetry,
    strokeWidth,
    // Telemetry links (export to a collector, scrapes, health checks) get no
    // glow or moving packet: on the OTel demo they are most of the links, and
    // animating them drew the eye to monitoring chatter.
    lit: observed && !telemetry,
    animated: observed && !telemetry && a.heat !== 'failed',
  };
}

function DependencyEdgeInner({
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps) {
  const edge = data as unknown as EdgeData | undefined;
  const [hovered, setHovered] = useState(false);
  // The callee's status, straight from React Flow's store: a link into a
  // service that is down reads as failing when no request data says
  // otherwise. The selector returns a string, so this re-renders only when
  // that status changes.
  const targetStatus = useStore((s) => (s.nodeLookup.get(target)?.data as { status?: string } | undefined)?.status);
  const look = edgeLook(edge, targetStatus);
  const faded = Number(style?.opacity ?? 1) < 1;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // The path always enters the callee through its top handle, travelling
  // downward, so the arrowhead can be drawn directly without solving for the
  // curve's tangent. Sized with the line so heavy links get heavy arrows.
  const s = 3.2 + look.strokeWidth * 0.55;
  const tipY = targetY - 4;
  const arrow = `M ${targetX} ${tipY} L ${targetX - s} ${tipY - s * 1.7} L ${targetX + s} ${tipY - s * 1.7} Z`;

  const opacity = look.telemetry && !hovered ? Math.min(Number(style?.opacity ?? 1), 0.35) : Number(style?.opacity ?? 1);
  // Pulses arrive at the link's own rate (requests/s where measured, socket
  // activity otherwise). Rounded to tenths so the SMIL timing, which
  // restarts when it changes, only changes when the rate really has.
  const flow = linkFlow(edge);
  const pulses = flow ? Math.round(flow.pulses * 10) / 10 : 0;
  const timing = svgPulses(pulses || 1, Math.hypot(targetX - sourceX, targetY - sourceY) * 1.15);
  const showWeight = Boolean(edge?.weight) && !look.telemetry && (edge?.emphasized || hovered);

  return (
    <>
      {/* Invisible wide hit area for hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />

      {/* The glow: a wide, faint stroke under the line. Cheaper than an SVG
          filter by a wide margin, and a filter was being re-rasterised on
          every link on every frame the canvas moved. */}
      {look.lit && (
        <path
          d={edgePath}
          fill="none"
          stroke={look.glow}
          strokeWidth={look.strokeWidth + (hovered || edge?.emphasized ? 9 : 6)}
          strokeLinecap="round"
          opacity={(hovered || edge?.emphasized ? 0.34 : 0.18) * opacity}
          style={{ pointerEvents: 'none', transition: 'opacity 0.3s' }}
        />
      )}

      <BaseEdge
        path={edgePath}
        interactionWidth={0}
        style={{
          ...style,
          opacity,
          strokeWidth: look.strokeWidth,
          stroke: hovered ? look.glow : look.color,
          strokeDasharray: look.observed ? 'none' : '6 6',
          strokeLinecap: 'round',
          transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.3s',
        }}
      />

      <path d={arrow} fill={hovered ? look.glow : look.color} opacity={opacity} style={{ pointerEvents: 'none', transition: 'opacity 0.3s' }} />

      {/* Flow packet, caller to callee. No filter on it: a filtered element
          that moves is re-rasterised every animation frame. */}
      {look.animated && !faded && pulses > 0 && Array.from({ length: timing.count }).map((_, i) => (
        <circle key={`${i}-${timing.count}-${timing.dur.toFixed(2)}`} r={3.2} fill={look.glow}>
          <animateMotion dur={`${timing.dur.toFixed(2)}s`} begin={`${(-i * timing.dur / timing.count).toFixed(2)}s`} repeatCount="indefinite" path={edgePath} />
        </circle>
      ))}

      {(hovered || showWeight) && (
        <EdgeLabelRenderer>
          {hovered ? (
            <div className="edge-card" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>
              <div className="edge-card-title">
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: look.color, boxShadow: `0 0 6px ${look.color}` }} />
                {shortName(edge?.source)} <span style={{ color: look.color }}>→</span> {shortName(edge?.target)}
              </div>
              <div className="edge-card-row"><span>State</span><b style={{ color: look.reason ? look.color : undefined }}>{edge?.observed || look.reason ? look.label : 'declared, not seen'}</b></div>
              {look.reason && <div className="edge-card-row"><span>Why</span><b style={{ color: look.color }}>{look.reason}</b></div>}
              <div className="edge-card-row"><span>Source</span><b>{edge?.declared ? (edge?.observed ? 'declared + seen' : 'declared') : 'seen, not declared'}</b></div>
              <div className="edge-card-row" title={flow?.basis === 'activity' ? 'No request-level data for this link: these are its connections, and the pulses follow its socket activity' : 'Measured requests per second'}>
                <span>{flow?.basis === 'requests' ? 'Requests' : 'Connections'}</span><b>{formatFlow(edge)}</b>
              </div>
              {edge?.weight && (
                <>
                  <div className="edge-card-row"><span>Weight</span><b style={{ color: look.glow }}>{edge.weight.value.toFixed(2)}</b></div>
                  <div className="edge-card-row">
                    <span>Reliance</span>
                    <b>
                      {edge.weight.dependencyBasis === 'uniform'
                        ? 'split evenly'
                        : `${Math.round(edge.weight.dependency * 100)}% of caller's ${edge.weight.dependencyBasis === 'requests' ? 'requests' : 'traffic'}`}
                    </b>
                  </div>
                  <div className="edge-card-row"><span>Confidence</span><b>{edge.weight.confidence.toFixed(2)}</b></div>
                  {look.telemetry && <div className="edge-card-row"><span>Kind</span><b>telemetry export</b></div>}
                </>
              )}
              {(edge?.metrics?.latency ?? 0) > 0 && <div className="edge-card-row"><span>Latency</span><b>{edge!.metrics!.latency!.toFixed(0)} ms</b></div>}
              {(edge?.metrics?.errorRate ?? 0) > 0 && <div className="edge-card-row"><span>Errors</span><b style={{ color: '#ff3d5e' }}>{((edge!.metrics!.errorRate ?? 0) * 100).toFixed(1)}%</b></div>}
            </div>
          ) : (
            <div
              className="edge-pill"
              style={{ color: look.glow, transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
              title="Share of the caller's traffic that goes to this callee"
            >
              {Math.round((edge!.weight!.dependency ?? 0) * 100)}%
            </div>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Re-render only when something drawn changes. App hands React Flow a new
 * edge object on every graph push, so without this every link re-rendered
 * every few seconds regardless. The hover card reads the live data when it is
 * opened; while it stays open it may lag one push behind, which is fine.
 */
function sameEdgeProps(a: EdgeProps, b: EdgeProps): boolean {
  if (a.id !== b.id || a.sourceX !== b.sourceX || a.sourceY !== b.sourceY || a.targetX !== b.targetX || a.targetY !== b.targetY) return false;
  if (a.sourcePosition !== b.sourcePosition || a.targetPosition !== b.targetPosition) return false;
  if ((a.style as any)?.opacity !== (b.style as any)?.opacity) return false;
  const da = a.data as unknown as EdgeData | undefined;
  const db = b.data as unknown as EdgeData | undefined;
  if (da?.observed !== db?.observed || da?.declared !== db?.declared || da?.status !== db?.status || Boolean(da?.emphasized) !== Boolean(db?.emphasized)) return false;
  const ha = edgeAppearance(da), hb = edgeAppearance(db);
  if (ha.color !== hb.color || ha.heat !== hb.heat) return false;
  if (Math.round((da?.weight?.value ?? -1) * 20) !== Math.round((db?.weight?.value ?? -1) * 20) || da?.weight?.kind !== db?.weight?.kind) return false;
  if (Math.round((da?.weight?.dependency ?? -1) * 100) !== Math.round((db?.weight?.dependency ?? -1) * 100)) return false;
  if (Math.round((linkFlow(da)?.pulses ?? 0) * 10) !== Math.round((linkFlow(db)?.pulses ?? 0) * 10)) return false;
  return true;
}

export const CustomDependencyEdge = memo(DependencyEdgeInner, sameEdgeProps);

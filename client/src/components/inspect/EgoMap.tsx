import type { DependencyEdge, ServiceNode } from '../../types';
import { edgeAppearance } from '../shared/edgeHeat';
import { shortName, statusVisual } from '../shared/serviceVisuals';
import { linkFlow, svgPulses } from '../shared/linkFlow';

const W = 364;
const ROW = 30;
const PILL_W = 106;
const PILL_H = 22;
const CENTER_W = 116;
const MAX_ROWS = 6;
const TOP = 30;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Strongest reliance first, so the links that matter are the ones shown. */
function byWeight(a: DependencyEdge, b: DependencyEdge): number {
  return (b.weight?.value ?? -1) - (a.weight?.value ?? -1)
    || (b.activity?.samplesPerMin ?? 0) - (a.activity?.samplesPerMin ?? 0);
}

interface Side {
  edge: DependencyEdge;
  otherId: string;
}

/**
 * One service and its immediate neighbours: callers on the left, callees on
 * the right, the service in the middle. Links are drawn as on the canvas
 * (colour = traffic, thickness = reliance), so this is the graph zoomed to
 * one service, not a new encoding to learn. Neighbours are buttons.
 */
export function EgoMap({ node, edges, nodesById, onSelect }: {
  node: ServiceNode;
  edges: DependencyEdge[];
  nodesById: Map<string, ServiceNode>;
  onSelect: (id: string) => void;
}) {
  const callers: Side[] = edges.filter((e) => e.target === node.id && e.source !== node.id).sort(byWeight).map((edge) => ({ edge, otherId: edge.source }));
  const callees: Side[] = edges.filter((e) => e.source === node.id && e.target !== node.id).sort(byWeight).map((edge) => ({ edge, otherId: edge.target }));
  const left = callers.slice(0, MAX_ROWS);
  const right = callees.slice(0, MAX_ROWS);
  const moreL = callers.length - left.length;
  const moreR = callees.length - right.length;
  const rows = Math.max(left.length, right.length, 1);
  const H = TOP + rows * ROW + (moreL || moreR ? 16 : 0) + 8;

  const cx = (W - CENTER_W) / 2;
  const cy = TOP + (rows * ROW) / 2;
  const rowY = (i: number, count: number) => TOP + (rows * ROW - count * ROW) / 2 + i * ROW + ROW / 2;

  const link = (x1: number, y1: number, x2: number, y2: number, e: DependencyEdge, key: string) => {
    const look = edgeAppearance(e, { targetStatus: nodesById.get(e.target)?.status });
    const telemetry = e.weight?.kind === 'telemetry';
    const width = telemetry ? 1 : 1 + 3.2 * Math.min(Math.max(e.weight?.value ?? 0.3, 0), 1);
    const dx = Math.max(24, (x2 - x1) * 0.5);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 5} ${y2}`;
    const s = 3 + width * 0.5;
    return (
      <g key={key} opacity={telemetry ? 0.4 : 1}>
        {!telemetry && e.observed && <path d={d} fill="none" stroke={look.glow} strokeWidth={width + 5} opacity={0.12} strokeLinecap="round" />}
        <path d={d} fill="none" stroke={look.color} strokeWidth={width} strokeLinecap="round" strokeDasharray={e.observed ? undefined : '4 4'} />
        <path d={`M ${x2 - 1} ${y2} L ${x2 - 1 - s * 1.6} ${y2 - s} L ${x2 - 1 - s * 1.6} ${y2 + s} Z`} fill={look.color} />
        {!telemetry && e.observed && look.heat !== 'failed' && linkFlow(e) && (() => {
          const t = svgPulses(linkFlow(e)!.pulses, x2 - x1 + 20, 60, 4);
          return Array.from({ length: t.count }).map((_, i) => (
            <circle key={`${i}-${t.dur.toFixed(2)}`} r={2.4} fill={look.glow}>
              <animateMotion dur={`${t.dur.toFixed(2)}s`} begin={`${(-i * t.dur / t.count).toFixed(2)}s`} repeatCount="indefinite" path={d} />
            </circle>
          ));
        })()}
      </g>
    );
  };

  const pill = (id: string, x: number, y: number, key: string) => {
    const other = nodesById.get(id);
    const status = statusVisual(other?.status);
    const label = clip(other?.name ?? shortName(id), 15);
    return (
      <g
        key={key}
        role="button"
        tabIndex={0}
        aria-label={`Inspect ${other?.name ?? shortName(id)}`}
        style={{ cursor: 'pointer' }}
        onClick={() => onSelect(id)}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(id); } }}
      >
        <title>{`${other?.name ?? id} · ${status.label}`}</title>
        <rect x={x} y={y - PILL_H / 2} width={PILL_W} height={PILL_H} rx={8} fill="#161a2c" stroke={status.color} strokeOpacity={other?.status === 'healthy' ? 0.28 : 0.7} />
        <circle cx={x + 11} cy={y} r={3.2} fill={status.color} />
        <text x={x + 20} y={y + 3.5} fontSize={10} fontWeight={600} fill="#dfe4ff" fontFamily="Inter, sans-serif">{label}</text>
      </g>
    );
  };

  const centerStatus = statusVisual(node.status);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${node.name}: ${callers.length} callers, ${callees.length} callees`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="ego-center" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5d6bff" />
          <stop offset="100%" stopColor="#3a45c9" />
        </linearGradient>
      </defs>

      <text x={8} y={16} fontSize={8.5} fontWeight={700} letterSpacing={1} fill="#6f7899" fontFamily="Inter, sans-serif">CALLED BY · {callers.length}</text>
      <text x={W - 8} y={16} fontSize={8.5} fontWeight={700} letterSpacing={1} fill="#6f7899" textAnchor="end" fontFamily="Inter, sans-serif">CALLS · {callees.length}</text>

      {left.map((s, i) => link(8 + PILL_W, rowY(i, left.length), cx, cy, s.edge, `ll-${s.edge.id}`))}
      {right.map((s, i) => link(cx + CENTER_W, cy, W - 8 - PILL_W, rowY(i, right.length), s.edge, `rl-${s.edge.id}`))}

      {left.length === 0 && <text x={8 + PILL_W / 2} y={cy + 3} fontSize={9.5} fill="#555e7a" textAnchor="middle" fontFamily="Inter, sans-serif">no callers seen</text>}
      {right.length === 0 && <text x={W - 8 - PILL_W / 2} y={cy + 3} fontSize={9.5} fill="#555e7a" textAnchor="middle" fontFamily="Inter, sans-serif">calls nothing</text>}

      {left.map((s, i) => pill(s.otherId, 8, rowY(i, left.length), `lp-${s.edge.id}`))}
      {right.map((s, i) => pill(s.otherId, W - 8 - PILL_W, rowY(i, right.length), `rp-${s.edge.id}`))}

      {/* The service itself: the one filled, glowing pill. */}
      <rect x={cx - 4} y={cy - PILL_H / 2 - 4} width={CENTER_W + 8} height={PILL_H + 8} rx={12} fill="#5d6bff" opacity={0.18} />
      <rect x={cx} y={cy - PILL_H / 2} width={CENTER_W} height={PILL_H} rx={9} fill="url(#ego-center)" stroke="#8d99ff" strokeOpacity={0.8} />
      <circle cx={cx + 11} cy={cy} r={3.4} fill={centerStatus.color} />
      <text x={cx + 20} y={cy + 3.5} fontSize={10.5} fontWeight={700} fill="#fff" fontFamily="Inter, sans-serif">{clip(node.name, 15)}</text>

      {moreL > 0 && <text x={8 + PILL_W / 2} y={H - 8} fontSize={9} fill="#6f7899" textAnchor="middle" fontFamily="Inter, sans-serif">+{moreL} more below</text>}
      {moreR > 0 && <text x={W - 8 - PILL_W / 2} y={H - 8} fontSize={9} fill="#6f7899" textAnchor="middle" fontFamily="Inter, sans-serif">+{moreR} more below</text>}
    </svg>
  );
}

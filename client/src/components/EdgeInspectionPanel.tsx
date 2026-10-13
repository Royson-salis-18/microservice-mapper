import type { DependencyEdge, ServiceNode } from '../types';
import { Link2 } from 'lucide-react';
import { edgeAppearance } from './shared/edgeHeat';
import { shortName, statusVisual } from './shared/serviceVisuals';
import { Bar, Card, PanelHead, Ring, Row, formatBytes, formatRate } from './inspect/parts';
import { formatFlow, linkFlow, svgPulses } from './shared/linkFlow';

interface EdgeInspectionPanelProps {
  edge: DependencyEdge | null;
  nodesById: Map<string, ServiceNode>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}

const W = 364;
const H = 92;

/**
 * The link on its own: caller on the left, callee on the right, traffic
 * moving between them at the link's own colour and thickness.
 */
function LinkHero({ edge, nodesById, onSelect }: { edge: DependencyEdge; nodesById: Map<string, ServiceNode>; onSelect: (id: string) => void }) {
  const look = edgeAppearance(edge, { targetStatus: nodesById.get(edge.target)?.status });
  const width = edge.weight?.kind === 'telemetry' ? 1.2 : 1.5 + 4 * Math.min(Math.max(edge.weight?.value ?? 0.3, 0), 1);
  const d = `M 128 ${H / 2} C 170 ${H / 2 - 22}, 194 ${H / 2 + 22}, 232 ${H / 2}`;
  // Pulses at the link's own rate, as on the canvas.
  const flow = linkFlow(edge);
  const timing = svgPulses(flow?.pulses ?? 1, 110, 60);
  const end = (id: string, x: number) => {
    const n = nodesById.get(id);
    const st = statusVisual(n?.status);
    const name = n?.name ?? shortName(id);
    return (
      <g role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => onSelect(id)}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(id); } }}>
        <title>{`Inspect ${name}`}</title>
        <rect x={x} y={H / 2 - 17} width={116} height={34} rx={10} fill="#161a2c" stroke={st.color} strokeOpacity={n?.status === 'healthy' ? 0.35 : 0.8} />
        <circle cx={x + 13} cy={H / 2} r={3.6} fill={st.color} />
        <text x={x + 23} y={H / 2 + 4} fontSize={11} fontWeight={700} fill="#e6eaff" fontFamily="Inter, sans-serif">
          {name.length > 13 ? `${name.slice(0, 12)}…` : name}
        </text>
      </g>
    );
  };
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${shortName(edge.source)} calls ${shortName(edge.target)}`} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={look.glow} strokeWidth={width + 8} opacity={0.14} strokeLinecap="round" />
      <path d={d} fill="none" stroke={look.color} strokeWidth={width} strokeLinecap="round" strokeDasharray={edge.observed ? undefined : '5 5'} />
      <path d={`M 236 ${H / 2} L ${228 - width} ${H / 2 - 4 - width / 2} L ${228 - width} ${H / 2 + 4 + width / 2} Z`} fill={look.color} />
      {edge.observed && look.heat !== 'failed' && flow && Array.from({ length: timing.count }).map((_, i) => (
        <circle key={`${i}-${timing.dur.toFixed(2)}`} r={3} fill={look.glow}>
          <animateMotion dur={`${timing.dur.toFixed(2)}s`} begin={`${(-i * timing.dur / timing.count).toFixed(2)}s`} repeatCount="indefinite" path={d} />
        </circle>
      ))}
      {end(edge.source, 8)}
      {end(edge.target, W - 8 - 116)}
      <text x={W / 2} y={16} fontSize={8.5} fontWeight={700} letterSpacing={1} fill="#6f7899" textAnchor="middle" fontFamily="Inter, sans-serif">CALLS</text>
    </svg>
  );
}

export function EdgeInspectionPanel({ edge, nodesById, onClose, onSelectNode }: EdgeInspectionPanelProps) {
  if (!edge) return null;

  const look = edgeAppearance(edge, { targetStatus: nodesById.get(edge.target)?.status });
  const w = edge.weight;
  const m = edge.metrics;
  const project = nodesById.get(edge.source)?.project ?? edge.source.split(':')[0];
  const hasRequestMetrics = Boolean(m && (m.requestRate != null || m.latency != null || m.errorRate != null || m.p95Latency != null));

  return (
    <aside className="insp" aria-label="Link details">
      <PanelHead
        icon={Link2}
        tint={look.color}
        title={<>{shortName(edge.source)} <span style={{ color: look.color }}>→</span> {shortName(edge.target)}</>}
        sub={`${project} · ${edge.type} link`}
        onClose={onClose}
      />

      <div className="insp-body">
        <div className="insp-trio">
          <div>
            <div className="insp-label">State</div>
            <div className="insp-value" style={{ color: look.color }}>
              <span className="insp-dot" />
              <span style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{look.heat === 'idle' ? 'Not seen' : look.heat === 'saturated' ? 'Very heavy' : look.heat}</span>
            </div>
          </div>
          <div title={linkFlow(edge)?.basis === 'requests' ? 'Measured requests per second' : 'Distinct connections, each counted once: average open, and opened per minute'}>
            <div className="insp-label">{linkFlow(edge)?.basis === 'requests' ? 'Requests' : 'Connections'}</div>
            <div className="insp-value" style={{ fontSize: 12.5 }}>
              {formatFlow(edge)}
            </div>
          </div>
          <div>
            <div className="insp-label">Weight</div>
            <div className="insp-value">
              {w ? w.value.toFixed(2) : '—'}
              {w && <Ring value={w.value} color={look.glow} size={24} />}
            </div>
          </div>
        </div>

        {look.reason && (
          <div className="insp-chip" style={{ alignSelf: 'flex-start', color: look.color, borderColor: `${look.color}55`, background: `${look.color}14` }}>
            {look.reason}
          </div>
        )}

        <div className="insp-hero">
          <LinkHero edge={edge} nodesById={nodesById} onSelect={onSelectNode} />
        </div>

        <Card title="Why this weight" right={<span style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>weight = confidence × reliance</span>}>
          {!w ? (
            <div className="insp-empty" style={{ padding: 0 }}>Computed on the next poll cycle.</div>
          ) : (
            <>
              <Row k="Confidence the link is real" v={w.confidence.toFixed(2)} />
              <Bar value={w.confidence} color="#8b9cff" />
              <div style={{ fontSize: 10, color: 'var(--color-text-dim)', margin: '4px 0 10px' }}>{w.confidenceBasis}</div>
              <Row k="Caller's reliance on it" v={`${Math.round(w.dependency * 100)}%`} />
              <Bar value={w.dependency} color={look.glow} />
              <div style={{ fontSize: 10, color: 'var(--color-text-dim)', marginTop: 4 }}>
                {w.dependencyBasis === 'uniform' ? 'No traffic figure yet, so split evenly across its callees.'
                  : `Share of ${shortName(edge.source)}'s ${w.dependencyBasis === 'requests' ? 'requests' : 'observed traffic'} that goes here.`}
              </div>
              {w.kind === 'telemetry' && (
                <div className="insp-chip" style={{ marginTop: 10, display: 'inline-block' }}>Telemetry export: counted at a tenth</div>
              )}
            </>
          )}
        </Card>

        <Card title="Request telemetry" right={hasRequestMetrics ? undefined : <span style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>not measured</span>}>
          {!hasRequestMetrics ? (
            <div className="insp-empty" style={{ padding: 0 }}>
              No request-level source covers this link, so latency and errors are unknown. Its colour comes from socket activity{look.reason ? ' and the state of the service it calls' : ''}.
            </div>
          ) : (
            <>
              <Row k="Request rate" v={m?.requestRate != null ? `${m.requestRate.toFixed(2)} /s` : '—'} />
              <Row k="Latency" v={m?.latency != null ? <span style={{ color: look.heat === 'degraded' || look.heat === 'failed' ? look.color : undefined }}>{m.latency.toFixed(0)} ms</span> : '—'} />
              <div className="insp-chips" style={{ margin: '8px 0' }}>
                {([['p50', m?.p50Latency], ['p95', m?.p95Latency], ['p99', m?.p99Latency]] as [string, number | null | undefined][]).map(([k, v]) => (
                  <span key={k} className="insp-chip">{k} {v != null ? `${v.toFixed(0)} ms` : '—'}</span>
                ))}
              </div>
              <Row k="Error rate" v={m?.errorRate != null ? <span style={{ color: m.errorRate > 0 ? look.color : undefined }}>{(m.errorRate * 100).toFixed(2)}%</span> : '—'} />
              {m?.requestCount != null && <Row k="Requests" v={m.requestCount.toLocaleString()} />}
              {m?.errorCount != null && <Row k="Errors" v={m.errorCount.toLocaleString()} />}
              {m?.bytesSent != null && <Row k="Data sent" v={formatBytes(m.bytesSent)} />}
            </>
          )}
        </Card>

        <Card title="Evidence">
          <div className="insp-chips">
            <span className={`insp-chip ${edge.declared ? 'accent' : ''}`}>{edge.declared ? 'declared in config' : 'not declared'}</span>
            <span className={`insp-chip ${edge.observed ? 'accent' : ''}`}>{edge.observed ? 'seen on the wire' : 'never seen'}</span>
            {edge.protocol && <span className="insp-chip">{edge.protocol}</span>}
            {edge.evidenceSources?.map((src) => <span key={src} className="insp-chip">{src}</span>)}
          </div>
          <div style={{ height: 10 }} />
          <Row k="First seen" v={edge.firstSeen ? new Date(edge.firstSeen).toLocaleString() : '—'} />
          <Row k="Last seen" v={edge.lastSeen ? new Date(edge.lastSeen).toLocaleString() : '—'} />
          {edge.activity?.baselinePerMin !== undefined && <Row k="Baseline activity" v={`${formatRate(edge.activity.baselinePerMin)} /min`} />}
        </Card>
      </div>

      <div className="insp-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <button type="button" className="insp-btn" onClick={() => onSelectNode(edge.source)}>Inspect caller</button>
        <button type="button" className="insp-btn" onClick={() => onSelectNode(edge.target)}>Inspect callee</button>
      </div>
    </aside>
  );
}

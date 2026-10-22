import { useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { AlertTriangle, Brain, Radar, ServerCrash } from 'lucide-react';
import type { ServiceNode } from '../../types';
import type { PositionMap } from './Scene3D';
import { STATUS_LIGHT, UNIT_SCALE } from './Node3D';
import { cpuShown } from '../shared/serviceVisuals';

export type CalloutKind = 'critical' | 'anomaly' | 'degraded' | 'risk';

export interface CalloutItem {
  id: string;
  kind: CalloutKind;
  title: string;
  sub: string;
}

const KIND: Record<CalloutKind, { color: string; icon: typeof ServerCrash }> = {
  critical: { color: '#ef5f67', icon: ServerCrash },
  anomaly: { color: '#8ab4ff', icon: Brain },
  degraded: { color: '#e8a33d', icon: AlertTriangle },
  risk: { color: '#8ab4ff', icon: Radar },
};

/** Units with a pin over them need the tag hung higher, clear of the pin.
 *  Heights are in unit space (a unit is 4.6 tall) and scaled with the units. */
function heightFor(kind: CalloutKind | 'selected', pinned: boolean): number {
  if (pinned) return 8.5 * UNIT_SCALE;
  return (kind === 'selected' ? 5.9 : 5.5) * UNIT_SCALE;
}

/** Keeps its children over a node as the node eases between layouts. */
function Anchor({ id, live, height, children }: { id: string; live: PositionMap; height: number; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = live.get(id);
    if (p && ref.current) ref.current.position.set(p.x, p.y + height, p.z);
  });
  // Placed on mount as well, or the first frame shows the tag at the origin.
  const place = (el: THREE.Group | null) => {
    ref.current = el;
    const p = live.get(id);
    if (el && p) el.position.set(p.x, p.y + height, p.z);
  };
  return <group ref={place}>{children}</group>;
}

/**
 * Tags hung over the services that need attention, the way a facility view
 * pins a failed device. DOM rather than 3D text so they stay crisp and a
 * fixed size at any zoom; capped by the caller, because every one is a DOM
 * element repositioned each frame.
 */
export function Callouts({ items, live, onSelect }: { items: CalloutItem[]; live: PositionMap; onSelect: (id: string) => void }) {
  return (
    <>
      {items.map((item) => {
        const k = KIND[item.kind];
        const Icon = k.icon;
        return (
          <Anchor key={item.id} id={item.id} live={live} height={heightFor(item.kind, item.kind === 'critical' || item.kind === 'anomaly')}>
            <Html zIndexRange={[5, 0]} pointerEvents="none">
              <div
                className="scene-callout"
                style={{
                  pointerEvents: 'auto',
                  borderColor: `${k.color}55`,
                  boxShadow: `0 10px 30px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06), 0 0 10px ${k.color}25`,
                  borderLeft: `3px solid ${k.color}`,
                }}
                onClick={() => onSelect(item.id)}
                title="Select this service"
              >
                <span className="scene-callout-icon" style={{ background: k.color, boxShadow: `0 2px 6px rgba(0,0,0,0.4), 0 0 8px ${k.color}77` }}>
                  <Icon size={13} strokeWidth={2.4} />
                </span>
                <div>
                  <div className="scene-callout-title">{item.title}</div>
                  <div className="scene-callout-sub">{item.sub}</div>
                </div>
              </div>
            </Html>
          </Anchor>
        );
      })}
    </>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="scene-bar">
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  );
}

/** A small ring for a 0..1 figure. */
function Ring({ value, color }: { value: number; color: string }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r={r} fill="none" stroke="rgba(148,163,255,0.14)" strokeWidth="3.5" />
      <circle
        cx="17" cy="17" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`}
        transform="rotate(-90 17 17)"
      />
    </svg>
  );
}

/**
 * The card over the selected service: what it is, how it is doing, and what
 * the cascade model expects of it. The full detail is in the inspection panel
 * alongside; this is the at-a-glance version, in place.
 */
export function SelectedCard({ node, live, pinned }: { node: ServiceNode; live: PositionMap; pinned: boolean }) {
  const cpu = cpuShown(node.metrics) ?? 0;
  const mem = node.metrics?.memoryPercent ?? 0;
  const p = typeof node.analytics?.failureProbability === 'number' ? node.analytics.failureProbability : null;
  const via = node.analytics?.cascadeVia ? String(node.analytics.cascadeVia).split(':').pop() : null;
  const statusColor = STATUS_LIGHT[node.status] ?? STATUS_LIGHT.unknown;
  const pColor = p === null ? '#5c5c5e' : p >= 0.7 ? '#ef5f67' : p >= 0.4 ? '#e8a33d' : '#3ecf8e';
  const barColor = (v: number) => (v > 80 ? '#ef5f67' : v > 60 ? '#e8a33d' : '#3ecf8e');

  return (
    <Anchor id={node.id} live={live} height={heightFor('selected', pinned)}>
      <Html zIndexRange={[6, 0]} pointerEvents="none">
        <div
          className="scene-card"
          style={{
            borderTopColor: `${statusColor}66`,
            boxShadow: `0 2px 0 rgba(255,255,255,0.05) inset, 0 20px 48px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06), 0 0 16px ${statusColor}28`,
          }}
        >
          {/* Coloured top strip matching the node status */}
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, borderRadius: '18px 18px 0 0', background: `linear-gradient(90deg, ${statusColor}88, ${statusColor}22)` }} />
          <div className="scene-card-row" style={{ alignItems: 'flex-start', marginBottom: 11, marginTop: 4 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 172, letterSpacing: '-0.01em' }}>{node.name}</div>
              <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.03em', marginTop: 1, textTransform: 'uppercase' }}>{node.project} · {node.type}</div>
            </div>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: statusColor, textTransform: 'capitalize', flexShrink: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, boxShadow: `0 0 6px ${statusColor}` }} />
              {node.status}
            </span>
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 -2px 10px' }} />
          <div className="scene-card-row" style={{ marginBottom: 10, gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="scene-card-label">CPU</div>
              <div className="scene-card-value">{cpu.toFixed(1)}<span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}> %</span></div>
              <Bar value={cpu} color={barColor(cpu)} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="scene-card-label">Memory</div>
              <div className="scene-card-value">{mem.toFixed(1)}<span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}> %</span></div>
              <Bar value={mem} color={barColor(mem)} />
            </div>
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 -2px 10px' }} />
          <div className="scene-card-row" style={{ alignItems: 'center' }}>
            <div>
              <div className="scene-card-label">Predicted failure (cascade model)</div>
              <div className="scene-card-value" style={{ color: pColor, fontSize: 16, letterSpacing: '-0.02em' }}>{p === null ? '—' : `${Math.round(p * 100)}%`}</div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
                {p === null ? 'not computed yet' : via ? `mostly via ${via}` : 'from its own state'}
              </div>
            </div>
            <Ring value={p ?? 0} color={pColor} />
          </div>
        </div>
      </Html>
    </Anchor>
  );
}

import type { CSSProperties, ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

/** A small progress ring for a 0..1 figure. */
export function Ring({ value, color, size = 30 }: { value: number; color: string; size?: number }) {
  const stroke = 3.4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,255,0.14)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ filter: `drop-shadow(0 0 3px ${color}aa)`, transition: 'stroke-dasharray 0.4s ease' }}
      />
    </svg>
  );
}

/** A thin bar, optionally with a dimmer "baseline" segment under it. */
export function Bar({ value, color, baseline }: { value: number; color: string; baseline?: number }) {
  const pct = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`;
  return (
    <div className="insp-bar" style={{ position: 'relative' }}>
      <span style={{ width: pct(value), background: `linear-gradient(90deg, ${color}88, ${color})`, boxShadow: `0 0 8px ${color}66` }} />
      {baseline !== undefined && baseline > 0 && (
        <span style={{ position: 'absolute', left: 0, top: 0, width: pct(baseline), background: 'rgba(148,163,255,0.35)' }} />
      )}
    </div>
  );
}

export function PanelHead({ icon: Icon, tint, title, sub, onClose }: {
  icon: LucideIcon;
  tint: string;
  title: ReactNode;
  sub: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="insp-head">
      <span className="insp-icon" style={{ '--tint': tint } as CSSProperties} aria-hidden="true">
        <Icon size={20} strokeWidth={2.1} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="insp-title">{title}</div>
        <div className="insp-sub">{sub}</div>
      </div>
      <button type="button" className="insp-close" onClick={onClose} aria-label="Close panel" title="Close (Esc)">
        <X size={15} />
      </button>
    </div>
  );
}

export function Card({ title, right, tone, children, style }: {
  title: ReactNode;
  right?: ReactNode;
  tone?: 'alert' | 'warn';
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section className={`insp-card ${tone ?? ''}`} style={style}>
      <div className="insp-card-title">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Row({ k, v, title }: { k: ReactNode; v: ReactNode; title?: string }) {
  return (
    <div className="insp-row" title={title}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatRate(perMin: number | undefined): string {
  if (perMin === undefined || !Number.isFinite(perMin)) return '-';
  if (perMin >= 10_000) return `${(perMin / 1000).toFixed(0)}k`;
  if (perMin >= 1000) return `${(perMin / 1000).toFixed(1)}k`;
  return String(Math.round(perMin));
}

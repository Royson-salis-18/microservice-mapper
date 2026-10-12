import { useState, type ReactNode, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

/**
 * Shared layout primitives for the analysis pages.
 *
 * These exist because the pages had drifted into a pattern where every
 * section carried a heading followed by two or three lines of justification,
 * permanently visible. Each paragraph earned its place individually and the
 * sum was a wall of grey text that buried the numbers it was explaining.
 *
 * The fix is not to delete the explanations — they are the difference between
 * a number and a number you can trust — but to put them one click away. The
 * heading states what the section is; the info button holds why it is there and how to
 * read it. Nothing is lost, and the data gets to be the loudest thing on the
 * page.
 */

export const SPACE = {
  page: 24,
  section: 16,
  card: 20,
  tight: 12,
} as const;

/** One explanation, hidden behind an affordance rather than always shouting. */
export function InfoTip({ children, label = 'about this' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={open ? 'Hide' : label}
        title={open ? 'Hide' : label}
        style={{
          background: open ? 'rgba(138,180,255,.1)' : 'transparent',
          border: 'none',
          color: open ? 'var(--color-accent-cyan)' : 'var(--color-text-dim)',
          borderRadius: '6px',
          width: '22px',
          height: '22px',
          padding: 0,
          cursor: 'pointer',
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'color var(--transition-fast), background var(--transition-fast)',
        }}
      ><Info size={14} strokeWidth={1.75} /></button>
      {open && (
        <div style={{
          flexBasis: '100%',
          gridColumn: '1 / -1',
          marginTop: '4px',
          padding: '12px 14px',
          background: 'rgba(255,255,255,.02)',
          border: '1px solid var(--color-border)',
          borderRadius: '8px',
          fontSize: '12.5px',
          lineHeight: 1.6,
          color: 'var(--color-text-muted)',
        }}>{children}</div>
      )}
    </>
  );
}

interface PanelProps {
  title: string;
  /** Short, always visible. One clause, not a paragraph. */
  subtitle?: string;
  /** The long explanation. Hidden behind the info button. */
  about?: ReactNode;
  /** Rendered at the right of the title row — counts, badges, controls. */
  actions?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  /** Starts collapsed; for reference material that is not the main event. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export function Panel({
  title, subtitle, about, actions, children, style,
  collapsible = false, defaultCollapsed = false,
}: PanelProps) {
  const [collapsed, setCollapsed] = useState(collapsible && defaultCollapsed);

  return (
    <section className="mm-card" style={{
      padding: '18px 20px',
      ...style,
    }}>
      <header style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        marginBottom: collapsed ? 0 : 14,
      }}>
        {collapsible && (
          <button
            type="button"
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            style={{
              background: 'none', border: 'none', color: 'var(--color-text-dim)',
              cursor: 'pointer', padding: 0, lineHeight: 0, display: 'inline-flex',
            }}
          >{collapsed ? <ChevronRight size={14} strokeWidth={1.75} /> : <ChevronDown size={14} strokeWidth={1.75} />}</button>
        )}
        <h3 style={{
          margin: 0,
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--color-text-main)',
        }}>{title}</h3>
        {subtitle && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{subtitle}</span>
        )}
        {about && <InfoTip>{about}</InfoTip>}
        {actions && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>{actions}</div>}
      </header>
      {!collapsed && children}
    </section>
  );
}

/** A single number with its label. The number leads; `tone` marks status
 * with a dot beside the label rather than colouring the number itself. */
export function Stat({ label, value, tone, hint, sub }: {
  label: string;
  value: ReactNode;
  tone?: string;
  hint?: string;
  sub?: string;
}) {
  return (
    <div style={{ minWidth: '116px' }} title={hint}>
      <div style={{
        fontSize: '12px',
        color: 'var(--color-text-muted)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}>
        {tone && <i className="mm-dot" style={{ background: tone }} />}
        {label}
      </div>
      <div style={{
        fontSize: '26px',
        fontWeight: 600,
        lineHeight: 1.15,
        letterSpacing: '-0.02em',
        marginTop: '6px',
        color: 'var(--color-text-main)',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
      {sub && (
        <div style={{ fontSize: '11.5px', color: 'var(--color-text-dim)', marginTop: '4px' }}>{sub}</div>
      )}
    </div>
  );
}

/** Evenly spread stats that wrap rather than squeeze. */
export function StatRow({ children }: { children: ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(126px, 1fr))',
      gap: `${SPACE.tight + 4}px`,
    }}>{children}</div>
  );
}

/** Page header with the scope chip, used by every analysis page. */
export function PageHeader({ title, scope, children }: {
  title: string;
  scope?: string;
  /** One short sentence. Anything longer belongs in a Panel's info button. */
  children?: ReactNode;
}) {
  const scoped = scope && scope !== 'ALL';
  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--color-text-main)' }}>{title}</h1>
        {scope && (
          <span className="mm-chip" style={scoped ? {
            color: '#dfe8ff',
            background: 'rgba(138,180,255,.1)',
            borderColor: 'rgba(138,180,255,.25)',
          } : undefined}>{scoped ? scope : 'All projects'}</span>
        )}
      </div>
      {children && (
        <p style={{
          margin: '6px 0 0 0', fontSize: '13px', color: 'var(--color-text-muted)',
          lineHeight: 1.55, maxWidth: '78ch',
        }}>{children}</p>
      )}
    </header>
  );
}

/** Standard scroll container for a full page of panels. */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div style={{
      flex: 1,
      height: '100%',
      overflowY: 'auto',
      padding: `${SPACE.page}px`,
      background: 'var(--color-bg-body)',
      color: 'var(--color-text-main)',
      display: 'flex',
      flexDirection: 'column',
      gap: `${SPACE.section}px`,
    }}>{children}</div>
  );
}

/** Empty state that says what to do, not just that there is nothing. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: '12.5px',
      color: 'var(--color-text-muted)',
      lineHeight: 1.6,
      padding: '16px 18px',
      background: 'rgba(255,255,255,.02)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
    }}>{children}</div>
  );
}

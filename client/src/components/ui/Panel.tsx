import { useState, type ReactNode, type CSSProperties } from 'react';

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
 * heading states what the section is; the ⓘ holds why it is there and how to
 * read it. Nothing is lost, and the data gets to be the loudest thing on the
 * page.
 */

export const SPACE = {
  page: 28,
  section: 22,
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
        title={open ? 'hide' : label}
        style={{
          background: open ? 'rgba(0,212,255,0.14)' : 'transparent',
          border: `1px solid ${open ? 'var(--color-accent-cyan)' : 'var(--color-border)'}`,
          color: open ? 'var(--color-accent-cyan)' : 'var(--color-text-dim)',
          borderRadius: '999px',
          width: '20px',
          height: '20px',
          fontSize: '11px',
          lineHeight: 1,
          cursor: 'pointer',
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
        }}
      >i</button>
      {open && (
        <div style={{
          gridColumn: '1 / -1',
          marginTop: '10px',
          padding: '12px 14px',
          background: 'rgba(0,212,255,0.04)',
          border: '1px solid rgba(0,212,255,0.18)',
          borderRadius: '8px',
          fontSize: '12px',
          lineHeight: 1.65,
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
  /** The long explanation. Hidden behind the ⓘ. */
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
    <section style={{
      background: 'var(--color-bg-panel)',
      border: '1px solid var(--color-border)',
      borderRadius: '14px',
      padding: `${SPACE.card}px ${SPACE.card + 2}px`,
      ...style,
    }}>
      <header style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        marginBottom: collapsed ? 0 : SPACE.tight + 2,
      }}>
        {collapsible && (
          <button
            type="button"
            onClick={() => setCollapsed(c => !c)}
            style={{
              background: 'none', border: 'none', color: 'var(--color-text-muted)',
              cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1,
            }}
          >{collapsed ? '▸' : '▾'}</button>
        )}
        <h3 style={{
          margin: 0,
          fontSize: '15px',
          fontWeight: 650,
          letterSpacing: '-0.01em',
          color: 'var(--color-text-main)',
        }}>{title}</h3>
        {subtitle && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-dim)' }}>{subtitle}</span>
        )}
        {about && <InfoTip>{about}</InfoTip>}
        {actions && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>{actions}</div>}
      </header>
      {!collapsed && children}
    </section>
  );
}

/** A single number with its label. Sized so the number leads, not the label. */
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
        fontSize: '24px',
        fontWeight: 660,
        lineHeight: 1.15,
        letterSpacing: '-0.02em',
        color: tone || 'var(--color-text-main)',
      }}>{value}</div>
      <div style={{
        fontSize: '11px',
        color: 'var(--color-text-muted)',
        marginTop: '4px',
        letterSpacing: '0.01em',
      }}>{label}</div>
      {sub && (
        <div style={{ fontSize: '10px', color: 'var(--color-text-dim)', marginTop: '2px' }}>{sub}</div>
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
  /** One short sentence. Anything longer belongs in a Panel's ⓘ. */
  children?: ReactNode;
}) {
  const scoped = scope && scope !== 'ALL';
  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 680, letterSpacing: '-0.02em' }}>{title}</h1>
        {scope && (
          <span style={{
            fontSize: '11px', fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: scoped ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
            background: scoped ? 'rgba(0,212,255,0.1)' : 'transparent',
            border: `1px solid ${scoped ? 'rgba(0,212,255,0.45)' : 'var(--color-border)'}`,
            borderRadius: '999px', padding: '3px 11px',
          }}>{scoped ? scope : 'all projects'}</span>
        )}
      </div>
      {children && (
        <p style={{
          margin: '8px 0 0 0', fontSize: '13px', color: 'var(--color-text-muted)',
          lineHeight: 1.6, maxWidth: '78ch',
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
      lineHeight: 1.65,
      padding: '18px',
      background: 'rgba(255,255,255,0.015)',
      border: '1px dashed var(--color-border)',
      borderRadius: '10px',
    }}>{children}</div>
  );
}

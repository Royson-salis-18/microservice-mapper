import { Plus } from 'lucide-react';

interface WelcomeScreenProps {
  onAddProject: () => void;
}

const steps = [
  { n: '1', label: 'Add an SSH target' },
  { n: '2', label: 'We discover your services' },
  { n: '3', label: 'Explore the live map' },
];

export function WelcomeScreen({ onAddProject }: WelcomeScreenProps) {
  return (
    <div style={{
      width: '100%',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--color-bg-body)',
      fontFamily: 'var(--font-family)',
      position: 'relative',
      overflow: 'hidden',
      padding: '24px',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '440px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{
          width: '48px',
          height: '48px',
          borderRadius: '12px',
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '24px',
        }}>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <line x1="7" y1="18" x2="13" y2="7" stroke="#5d636c" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="13" y1="7" x2="19" y2="18" stroke="#5d636c" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="18" x2="19" y2="18" stroke="#5d636c" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="13" cy="7" r="3" fill="#8ab4ff" />
            <circle cx="7" cy="18" r="3" fill="#969ca5" />
            <circle cx="19" cy="18" r="3" fill="#969ca5" />
          </svg>
        </div>

        <h1 style={{
          fontSize: '22px',
          fontWeight: 600,
          color: 'var(--color-text-main)',
          letterSpacing: '-0.015em',
          margin: '0 0 8px',
        }}>
          Map your first system
        </h1>

        <p style={{
          fontSize: '13.5px',
          color: 'var(--color-text-muted)',
          lineHeight: 1.6,
          margin: '0 0 24px',
        }}>
          Connect a remote host over SSH and Microservice Mapper will discover your services and chart how they talk to each other.
        </p>

        <button className="mm-btn primary" onClick={onAddProject} style={{ height: '32px', padding: '0 14px', cursor: 'pointer' }}>
          <Plus size={15} strokeWidth={1.75} />
          Add project
        </button>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: '20px',
          marginTop: '40px',
          paddingTop: '20px',
          borderTop: '1px solid var(--color-border)',
          fontSize: '12px',
          color: 'var(--color-text-dim)',
        }}>
          {steps.map(s => (
            <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                border: '1px solid var(--color-border-hover)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10.5px',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--color-text-muted)',
              }}>{s.n}</span>
              {s.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

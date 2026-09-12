import React, { useEffect, useRef } from 'react';

export default function SearchOverlay({ query, results, onSelect, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!query) return null;

  return (
    <div 
      ref={ref}
      style={{
        position: 'absolute',
        top: '48px',
        right: '160px',
        width: '300px',
        maxHeight: '400px',
        overflowY: 'auto',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-medium)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {results.length === 0 ? (
        <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
          No services found matching "{query}"
        </div>
      ) : (
        <div style={{ padding: '8px' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', paddingLeft: '8px' }}>
            Results ({results.length})
          </div>
          {results.map(res => (
            <div
              key={res.id}
              onClick={() => {
                onSelect(res);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                transition: 'var(--transition-fast)'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--color-${res.status})` }} />
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>{res.name}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{res.type} {res.project && `• ${res.project}`}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

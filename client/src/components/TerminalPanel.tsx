import { useState, useEffect, useRef } from 'react';

interface TerminalPanelProps {
  logs: string[];
  onCommandSubmit: (cmd: string) => void;
  isActive: boolean;
}

export function TerminalPanel({ logs, onCommandSubmit, isActive }: TerminalPanelProps) {
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && input.trim()) {
      onCommandSubmit(input.trim());
      setInput('');
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: 'transparent',
      overflow: 'hidden',
      fontFamily: 'monospace',
      fontSize: '11px',
      height: '100%',
      width: '100%'
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        color: 'var(--color-text-muted)'
      }}>
        <div style={{ display: 'flex', gap: '6px' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-critical)' }} />
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-unknown)' }} />
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-healthy)' }} />
        </div>
        <span>DISCOVERY TERMINAL</span>
      </div>

      <div style={{
        flex: 1,
        padding: '12px 24px',
        overflowY: 'auto',
        color: '#a0a0b0',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px'
      }}>
        {logs.map((log, i) => (
          <div key={i} style={{ 
            color: log.startsWith('[ERROR]') ? 'var(--color-critical)' : 
                   log.startsWith('[SUCCESS]') ? 'var(--color-healthy)' : 
                   log.startsWith('$') ? 'var(--color-accent-cyan)' : '#a0a0b0',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}>
            {log}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {isActive && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 24px',
          borderTop: '1px solid var(--color-border)',
          background: 'rgba(0,0,0,0.3)'
        }}>
          <span style={{ color: 'var(--color-accent-cyan)', marginRight: '8px' }}>$</span>
          <input 
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type command to execute remotely..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#fff',
              fontFamily: 'monospace',
              fontSize: '11px'
            }}
          />
        </div>
      )}
    </div>
  );
}

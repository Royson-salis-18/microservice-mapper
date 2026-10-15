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
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
      lineHeight: 1.6,
      height: '100%',
      width: '100%'
    }}>

      <div style={{
        flex: 1,
        padding: '12px 20px',
        overflowY: 'auto',
        color: 'var(--color-text-muted)',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px'
      }}>
        {logs.map((log, i) => {
          const isCommand = log.startsWith('$');
          return (
            <div key={i} style={{
              color: log.startsWith('[ERROR]') ? 'var(--color-critical)' :
                     log.startsWith('[SUCCESS]') ? 'var(--color-healthy)' :
                     isCommand ? 'var(--color-text-main)' : 'var(--color-text-muted)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}>
              {isCommand ? (
                <>
                  <span style={{ color: 'var(--color-text-dim)' }}>$</span>
                  {log.slice(1)}
                </>
              ) : log}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {isActive && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          height: '36px',
          padding: '0 20px',
          borderTop: '1px solid var(--color-border)',
          background: 'rgba(255,255,255,0.015)'
        }}>
          <span style={{ color: 'var(--color-text-dim)', marginRight: '8px' }}>$</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Run a command on the remote host"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--color-text-main)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px'
            }}
          />
        </div>
      )}
    </div>
  );
}

import type { GlobalStatus, Target } from '../types';

interface TopBarProps {
  status: GlobalStatus | null;
  targets: Target[];
  isConnected: boolean;
  lastUpdate: string | null;
  selectedProject: string;
  onProjectChange: (project: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  onToggleTrafficPanel?: () => void;
  isTrafficPanelOpen?: boolean;
}

export function TopBar({ status, targets, isConnected, lastUpdate, selectedProject, onProjectChange, searchQuery, onSearchChange, activeTab, onTabChange, onToggleTrafficPanel, isTrafficPanelOpen }: TopBarProps) {
  const getStatusColor = (s: string | undefined) => {
    if (s === 'healthy') return 'var(--color-healthy)';
    if (s === 'degraded') return 'var(--color-degraded)';
    if (s === 'critical') return 'var(--color-critical)';
    return 'var(--color-unknown)';
  };

  const currentTarget = targets.find(t => t.targetId === selectedProject);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      height: '64px',
      background: 'var(--color-bg-glass)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderBottom: '1px solid transparent',
      position: 'relative',
      zIndex: 10,
    }}>
      {/* Gradient Bottom Border */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '1px',
        background: 'linear-gradient(90deg, var(--color-accent-cyan) 0%, var(--color-accent-magenta) 100%)',
        opacity: 0.5
      }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '32px', height: '100%' }}>
        <div style={{ 
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontWeight: 700, 
          letterSpacing: '2px', 
          fontSize: '15px', 
          fontFamily: 'var(--font-family)',
          color: '#fff',
          textShadow: '0 0 10px rgba(0,212,255,0.3)'
        }}>
          <span style={{ 
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '24px',
            height: '24px',
            borderRadius: '6px',
            background: 'linear-gradient(135deg, var(--color-accent-cyan), var(--color-accent-blue))',
            boxShadow: '0 0 12px rgba(0,212,255,0.4)',
            color: '#fff',
            fontSize: '12px'
          }}>⎈</span>
          MICROSERVICE MAPPER
        </div>
        
        <div style={{ display: 'flex', gap: '8px', height: '100%' }}>
          {['3D Vision', 'Architecture', 'Telemetry', 'Dependencies', 'Analytics', 'RCA / INCIDENTS', 'EXPERIMENTS'].map(tab => {
            const isActive = tab === activeTab;
            const isRcaTab = tab === 'RCA / INCIDENTS';
            const hasActiveIncident = status && (status.critical > 0 || status.degraded > 0);

            return (
              <div 
                key={tab} 
                onClick={() => onTabChange(tab)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0 16px',
                  cursor: 'pointer',
                  position: 'relative',
                  color: isActive ? 'var(--color-text-main)' : 'var(--color-text-muted)',
                  fontWeight: isActive ? 600 : 500,
                  transition: 'all var(--transition-fast)',
                  textTransform: 'uppercase',
                  fontSize: '12px',
                  letterSpacing: '0.5px'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.color = 'var(--color-text-main)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.color = 'var(--color-text-muted)';
                }}
              >
                {tab}
                {isRcaTab && hasActiveIncident && (
                  <span style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: 'var(--color-critical)',
                    boxShadow: '0 0 8px var(--color-critical)',
                    animation: 'pulse-critical 1.5s infinite'
                  }} />
                )}
                {/* Active Indicator */}
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: '2px',
                  background: isActive ? 'var(--color-accent-cyan)' : 'transparent',
                  boxShadow: isActive ? '0 -2px 10px var(--color-accent-cyan)' : 'none',
                  transition: 'all var(--transition-fast)'
                }} />
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
        <div style={{ position: 'relative' }}>
          <select 
            value={selectedProject} 
            onChange={(e) => onProjectChange(e.target.value)}
            style={{
              appearance: 'none',
              background: 'rgba(255,255,255,0.03)',
              color: 'var(--color-text-main)',
              border: '1px solid var(--color-border)',
              padding: '6px 32px 6px 16px',
              borderRadius: '20px',
              fontFamily: 'var(--font-family)',
              fontSize: '12px',
              fontWeight: 600,
              letterSpacing: '0.5px',
              outline: 'none',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
              boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.05)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-accent-cyan)';
              e.currentTarget.style.boxShadow = '0 0 10px rgba(0, 212, 255, 0.1), inset 0 1px 2px rgba(255,255,255,0.05)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border)';
              e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(255,255,255,0.05)';
            }}
          >
            <option value="ALL" style={{ background: 'var(--color-bg-panel)' }}>ALL TARGETS</option>
            {targets.map(t => (
              <option key={t.targetId} value={t.targetId} style={{ background: 'var(--color-bg-panel)' }}>
                {t.displayName ? t.displayName.toUpperCase() : t.targetId.toUpperCase()}
              </option>
            ))}
          </select>
          <div style={{
            position: 'absolute',
            right: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            color: 'var(--color-text-muted)',
            fontSize: '10px'
          }}>▼</div>
        </div>

        {status && (
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '8px',
            background: 'rgba(255,255,255,0.03)',
            padding: '6px 12px',
            borderRadius: '20px',
            border: '1px solid var(--color-border)',
          }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: getStatusColor(
                selectedProject !== 'ALL' 
                  ? (currentTarget?.status === 'LIVE' ? (status.critical > 0 ? 'critical' : status.degraded > 0 ? 'degraded' : 'healthy') : 'unknown')
                  : status.status
              ),
              boxShadow: `0 0 10px ${getStatusColor(
                selectedProject !== 'ALL' 
                  ? (currentTarget?.status === 'LIVE' ? (status.critical > 0 ? 'critical' : status.degraded > 0 ? 'degraded' : 'healthy') : 'unknown')
                  : status.status
              )}`
            }} />
            <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--color-text-main)' }}>
              {selectedProject !== 'ALL' 
                ? (currentTarget?.status === 'LIVE' ? (status.critical > 0 ? 'CRITICAL' : status.degraded > 0 ? 'DEGRADED' : 'HEALTHY') : currentTarget?.status || 'UNKNOWN')
                : status.status}
            </span>
          </div>
        )}

        <div style={{ position: 'relative' }}>
          <input 
            type="text" 
            placeholder="Search services..." 
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{
              background: 'rgba(0,0,0,0.2)',
              color: 'var(--color-text-main)',
              border: '1px solid var(--color-border)',
              padding: '8px 12px 8px 36px',
              borderRadius: '20px',
              width: '240px',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              transition: 'all var(--transition-fast)',
              boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)'
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'var(--color-accent-magenta)';
              e.target.style.boxShadow = '0 0 15px rgba(224, 64, 251, 0.15), inset 0 2px 4px rgba(0,0,0,0.2)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'var(--color-border)';
              e.target.style.boxShadow = 'inset 0 2px 4px rgba(0,0,0,0.2)';
            }}
          />
          <span style={{ 
            position: 'absolute', 
            left: '12px', 
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-muted)',
            fontSize: '14px'
          }}>⌕</span>
        </div>

        {onToggleTrafficPanel && (
          <button
            onClick={onToggleTrafficPanel}
            style={{
              background: isTrafficPanelOpen
                ? 'linear-gradient(135deg, var(--color-accent-cyan), var(--color-accent-magenta))'
                : 'rgba(255,255,255,0.03)',
              color: '#fff',
              border: `1px solid ${isTrafficPanelOpen ? 'var(--color-accent-cyan)' : 'var(--color-border)'}`,
              padding: '6px 14px',
              borderRadius: '20px',
              fontWeight: 700,
              fontSize: '11px',
              letterSpacing: '1px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: isTrafficPanelOpen ? '0 0 12px rgba(0,212,255,0.4)' : 'none',
              transition: 'all var(--transition-fast)'
            }}
          >
            <span>⚡</span> TRAFFIC
          </button>
        )}

        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px',
          paddingLeft: '16px',
          borderLeft: '1px solid var(--color-border)'
        }}>
          <div style={{
            position: 'relative',
            width: '10px', height: '10px', 
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <div style={{
              position: 'absolute',
              width: '100%', height: '100%',
              borderRadius: '50%',
              background: currentTarget ? 
                (currentTarget.status === 'LIVE' ? 'var(--color-healthy)' : 
                 currentTarget.status === 'STALE' ? 'var(--color-degraded)' : 'var(--color-critical)') 
                : (isConnected ? 'var(--color-healthy)' : 'var(--color-critical)'),
              animation: (currentTarget?.status === 'LIVE' || (!currentTarget && isConnected)) ? 'breathe-healthy 3s infinite' : 'pulse-critical 1.5s infinite',
              opacity: 0.5
            }} />
            <div style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: currentTarget ? 
                (currentTarget.status === 'LIVE' ? 'var(--color-healthy)' : 
                 currentTarget.status === 'STALE' ? 'var(--color-degraded)' : 'var(--color-critical)') 
                : (isConnected ? 'var(--color-healthy)' : 'var(--color-critical)'),
              zIndex: 1
            }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '1px', color: currentTarget ? 
                (currentTarget.status === 'LIVE' ? 'var(--color-healthy)' : 
                 currentTarget.status === 'STALE' ? 'var(--color-degraded)' : 'var(--color-critical)') 
                : (isConnected ? 'var(--color-healthy)' : 'var(--color-critical)') }}>
              {currentTarget ? currentTarget.status : (isConnected ? 'LIVE' : 'DISCONNECTED')}
            </span>
            {currentTarget?.lastSeen ? (
              <span style={{ fontSize: '9px', color: 'var(--color-text-dim)', letterSpacing: '0.5px' }}>
                {new Date(currentTarget.lastSeen).toLocaleTimeString()}
              </span>
            ) : lastUpdate && (
              <span style={{ fontSize: '9px', color: 'var(--color-text-dim)', letterSpacing: '0.5px' }}>
                {new Date(lastUpdate).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

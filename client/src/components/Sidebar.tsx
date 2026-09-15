import { 
  Box, 
  Network, 
  Activity, 
  GitMerge, 
  BarChart2, 
  AlertTriangle, 
  FlaskConical 
} from 'lucide-react';
import type { GlobalStatus } from '../types';

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  status: GlobalStatus | null;
  onAddProject: () => void;
}

export function Sidebar({ activeTab, onTabChange, status, onAddProject }: SidebarProps) {
  const tabs = [
    { id: '3D Vision', icon: Box, label: '3D Vision' },
    { id: 'Architecture', icon: Network, label: 'Architecture' },
    { id: 'Telemetry', icon: Activity, label: 'Telemetry' },
    { id: 'Dependencies', icon: GitMerge, label: 'Dependencies' },
    { id: 'Analytics', icon: BarChart2, label: 'Analytics' },
    { id: 'RCA / INCIDENTS', icon: AlertTriangle, label: 'Incidents' },
    { id: 'EXPERIMENTS', icon: FlaskConical, label: 'Experiments' },
  ];

  const hasActiveIncident = status && (status.critical > 0 || status.degraded > 0);

  return (
    <div style={{
      width: '80px',
      height: '100%',
      background: 'var(--color-bg-glass)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderRight: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '24px 0',
      zIndex: 20,
      position: 'relative'
    }}>
      {/* Logo */}
      <div style={{ 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '40px',
        height: '40px',
        borderRadius: '10px',
        background: 'linear-gradient(135deg, var(--color-accent-cyan), var(--color-accent-blue))',
        boxShadow: '0 0 16px rgba(0,212,255,0.4)',
        color: '#fff',
        fontSize: '20px',
        marginBottom: '40px'
      }}>
        ⎈
      </div>

      {/* Navigation Icons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '32px', width: '100%' }}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const isRcaTab = tab.id === 'RCA / INCIDENTS';
          const Icon = tab.icon;

          return (
            <div 
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              title={tab.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                position: 'relative',
                cursor: 'pointer',
                color: isActive ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)',
                transition: 'all var(--transition-fast)'
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = 'var(--color-text-main)';
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = 'var(--color-text-muted)';
              }}
            >
              {isActive && (
                <div style={{
                  position: 'absolute',
                  left: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  height: '24px',
                  width: '3px',
                  background: 'var(--color-accent-cyan)',
                  boxShadow: '2px 0 10px var(--color-accent-cyan)',
                  borderTopRightRadius: '4px',
                  borderBottomRightRadius: '4px'
                }} />
              )}
              
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', position: 'relative' }}>
                <Icon 
                  size={24} 
                  strokeWidth={isActive ? 2.5 : 2}
                  style={{ 
                    filter: isActive ? 'drop-shadow(0 0 8px rgba(0,212,255,0.4))' : 'none'
                  }} 
                />
                
                <span style={{
                  fontSize: '9px',
                  fontWeight: isActive ? 700 : 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  opacity: isActive ? 1 : 0.6,
                  textAlign: 'center'
                }}>
                  {tab.label}
                </span>

                {/* Incident Alert Dot */}
                {isRcaTab && hasActiveIncident && (
                  <span style={{
                    position: 'absolute',
                    top: '-2px',
                    right: '12px',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: 'var(--color-critical)',
                    boxShadow: '0 0 8px var(--color-critical)',
                    animation: 'pulse-critical 1.5s infinite'
                  }} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* Add Project Button */}
      <div 
        onClick={onAddProject}
        title="Add Project"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          width: '100%',
          cursor: 'pointer',
          color: 'var(--color-accent-magenta)',
          transition: 'all var(--transition-fast)',
          marginTop: 'auto'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = '#fff';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--color-accent-magenta)';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(224,64,251,0.1)', border: '1px solid rgba(224,64,251,0.3)' }}>
          <span style={{ fontSize: '18px', fontWeight: 'bold' }}>+</span>
        </div>
        <span style={{ fontSize: '9px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          ADD PROJ
        </span>
      </div>
    </div>
  );
}

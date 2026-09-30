import { Fragment } from 'react';
import {
  Box,
  Network,
  Activity,
  GitMerge,
  BarChart2,
  AlertTriangle,
  FlaskConical,
  Zap,
  Brain,
  Microscope,
  ShieldAlert
} from 'lucide-react';
import type { GlobalStatus } from '../types';

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  status: GlobalStatus | null;
  onAddProject: () => void;
}

/**
 * The nav rail.
 *
 * Grouped into three bands rather than one flat list of eleven: what the
 * system looks like, what analysis says about it, and what you do to it. The
 * separators carry that structure without section headings, which would not
 * fit in 80px.
 *
 * Items are buttons, not clickable divs, so the whole nav is reachable by
 * keyboard — and the list scrolls rather than clipping its last entries on a
 * short window.
 */

const GROUPS: { id: string; icon: typeof Box; label: string }[][] = [
  // What the system is.
  [
    { id: '3D Vision', icon: Box, label: '3D Vision' },
    { id: 'Architecture', icon: Network, label: 'Architecture' },
    { id: 'Telemetry', icon: Activity, label: 'Telemetry' },
    { id: 'Dependencies', icon: GitMerge, label: 'Dependencies' },
  ],
  // What the analysis says about it. Findings are model outputs and sit next
  // to the pipeline that produces them; Reliability is computed from
  // status/anomaly/incident/traffic and is not a model output, so it trails
  // them rather than joining them.
  [
    { id: 'Analytics', icon: BarChart2, label: 'Analytics' },
    { id: 'ML PIPELINE', icon: Brain, label: 'ML Pipeline' },
    { id: 'FINDINGS', icon: Microscope, label: 'Findings' },
    { id: 'RELIABILITY', icon: ShieldAlert, label: 'Reliability' },
  ],
  // What you do to it. Incidents are rule-based and involve no model, which
  // is why they are here and not beside Findings.
  [
    { id: 'TRACES', icon: Zap, label: 'Traces' },
    { id: 'RCA / INCIDENTS', icon: AlertTriangle, label: 'Incidents' },
    { id: 'EXPERIMENTS', icon: FlaskConical, label: 'Experiments' },
  ],
];

export function Sidebar({ activeTab, onTabChange, status, onAddProject }: SidebarProps) {
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
      // No horizontal padding: the labels need the full 80px or the longer
      // ones ("Architecture", "Dependencies") get clipped. Item padding is
      // applied inside .sidebar-item instead.
      padding: '20px 0',
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
        flexShrink: 0,
        borderRadius: '10px',
        background: 'linear-gradient(135deg, var(--color-accent-cyan), var(--color-accent-blue))',
        boxShadow: '0 0 16px rgba(0,212,255,0.4)',
        color: '#fff',
        fontSize: '20px',
        marginBottom: '22px'
      }}>
        ⎈
      </div>

      <nav className="sidebar-nav" aria-label="Main navigation">
        {GROUPS.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {groupIndex > 0 && <div className="sidebar-group-sep" aria-hidden="true" />}
            {group.map((tab) => {
              const isActive = activeTab === tab.id;
              const showAlert = tab.id === 'RCA / INCIDENTS' && hasActiveIncident;
              const Icon = tab.icon;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  className={isActive ? 'sidebar-item active' : 'sidebar-item'}
                  aria-current={isActive ? 'page' : undefined}
                  title={showAlert ? `${tab.label} — active incident` : tab.label}
                >
                  <span style={{ position: 'relative', display: 'flex' }}>
                    <Icon
                      size={22}
                      strokeWidth={isActive ? 2.5 : 2}
                      style={{ filter: isActive ? 'drop-shadow(0 0 8px rgba(0,212,255,0.4))' : 'none' }}
                    />
                    {/* Anchored to the icon, so it reads as a badge on the
                        thing it refers to rather than floating by the label. */}
                    {showAlert && (
                      <span
                        aria-hidden="true"
                        style={{
                          position: 'absolute',
                          top: '-3px',
                          right: '-5px',
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          background: 'var(--color-critical)',
                          boxShadow: '0 0 8px var(--color-critical)',
                          animation: 'pulse-critical 1.5s infinite'
                        }}
                      />
                    )}
                  </span>
                  <span className="sidebar-item-label">{tab.label}</span>
                </button>
              );
            })}
          </Fragment>
        ))}
      </nav>

      <div style={{ flex: 1, minHeight: '14px' }} />

      <button
        type="button"
        onClick={onAddProject}
        className="sidebar-add-btn"
        title="Add Project"
      >
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '32px', height: '32px', borderRadius: '50%',
          background: 'rgba(224,64,251,0.1)', border: '1px solid rgba(224,64,251,0.3)',
          fontSize: '18px', fontWeight: 'bold'
        }}>
          +
        </span>
        <span style={{ fontSize: '8.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
          Add Proj
        </span>
      </button>
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  Box,
  Network,
  Activity,
  GitMerge,
  BarChart3,
  AlertTriangle,
  FlaskConical,
  Waypoints,
  Brain,
  Microscope,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GlobalStatus } from '../types';

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  status: GlobalStatus | null;
  onAddProject: () => void;
}

interface NavItem { id: string; icon: LucideIcon; label: string }

// Tab ids are what App.tsx switches on, so they stay as they were; only the labels are for people.
// Ordered the way an on-call engineer works: what is broken, then where to look, then how to test. Experiments, model findings and the ML
// pipeline are research tools, not part of the daily loop, so they sit under "Research" and stay hidden until switched on.
const GROUPS: { title: string; items: NavItem[]; advanced?: boolean }[] = [
  {
    title: 'Now',
    items: [
      { id: 'RCA / INCIDENTS', icon: AlertTriangle, label: 'Incidents & cascade' },
      { id: '3D Vision', icon: Box, label: 'Spatial view' },
      { id: 'Architecture', icon: Network, label: 'Architecture' },
    ],
  },
  {
    title: 'Investigate',
    items: [
      { id: 'Telemetry', icon: Activity, label: 'Telemetry' },
      { id: 'TRACES', icon: Waypoints, label: 'Traces' },
      { id: 'Dependencies', icon: GitMerge, label: 'Dependencies' },
      { id: 'Analytics', icon: BarChart3, label: 'Analytics' },
    ],
  },
  {
    title: 'Research',
    advanced: true,
    items: [
      { id: 'EXPERIMENTS', icon: FlaskConical, label: 'Experiments' },
      { id: 'FINDINGS', icon: Microscope, label: 'Model findings' },
      { id: 'ML PIPELINE', icon: Brain, label: 'ML pipeline' },
    ],
  },
];

function BrandMark() {
  // Three services and the calls between them; the one that matters is the only one with colour.
  return (
    <svg className="mm-brand-mark" viewBox="0 0 26 26" fill="none" aria-hidden>
      <rect x="0.5" y="0.5" width="25" height="25" rx="7" fill="#15171b" stroke="rgba(255,255,255,0.09)" />
      <path d="M8 17.5 L13 8.5 L18.5 16" stroke="rgba(236,237,239,0.38)" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M8 17.5 H18.5" stroke="rgba(236,237,239,0.22)" strokeWidth="1.1" strokeDasharray="1.6 1.8" />
      <circle cx="13" cy="8.5" r="2.4" fill="#ecedef" />
      <circle cx="8" cy="17.5" r="2.4" fill="#7c828b" />
      <circle cx="18.5" cy="16.5" r="2.4" fill="#8ab4ff" />
    </svg>
  );
}

const COLLAPSE_KEY = 'mm.sidebar.collapsed';
const ADVANCED_KEY = 'mm.sidebar.advanced';

export function Sidebar({ activeTab, onTabChange, status, onAddProject }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [collapsed]);
  const [advanced, setAdvanced] = useState<boolean>(() => {
    try { return localStorage.getItem(ADVANCED_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(ADVANCED_KEY, advanced ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [advanced]);

  const troubled = status ? status.critical + status.degraded : 0;
  const isActive = (id: string) => activeTab === id || (id === 'RCA / INCIDENTS' && activeTab === 'RCA');

  return (
    <nav className={`mm-side${collapsed ? ' collapsed' : ''}`} aria-label="Main">
      <div className="mm-brand">
        <BrandMark />
        <div className="mm-brand-text">
          <div className="mm-brand-name">Microservice Mapper</div>
          <div className="mm-brand-sub">Topology &amp; root cause</div>
        </div>
      </div>

      {GROUPS.filter(g => !g.advanced || advanced || g.items.some(i => i.id === activeTab)).map(group => (
        <div key={group.title}>
          <div className="mm-side-group">{group.title}</div>
          {group.items.map(item => {
            const Icon = item.icon;
            const showCount = item.id === 'RCA / INCIDENTS' && troubled > 0;
            return (
              <div
                key={item.id}
                className={`mm-nav${isActive(item.id) ? ' active' : ''}`}
                onClick={() => onTabChange(item.id)}
                title={collapsed ? item.label : undefined}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTabChange(item.id); } }}
              >
                <Icon size={16} strokeWidth={1.75} />
                <span className="label">{item.label}</span>
                {showCount && <span className="count" title={`${troubled} services need attention`}>{troubled}</span>}
              </div>
            );
          })}
        </div>
      ))}

      <div className="mm-side-foot">
        <div className="mm-nav" onClick={onAddProject} role="button" tabIndex={0} title={collapsed ? 'Add project' : undefined}
          onKeyDown={e => { if (e.key === 'Enter') onAddProject(); }}>
          <Plus size={16} strokeWidth={1.75} />
          <span className="label">Add project</span>
        </div>
        <div className="mm-nav" onClick={() => setAdvanced(a => !a)} role="button" tabIndex={0} title={collapsed ? 'Show or hide the research tools' : undefined}
          onKeyDown={e => { if (e.key === 'Enter') setAdvanced(a => !a); }}>
          <Brain size={16} strokeWidth={1.75} />
          <span className="label">{advanced ? 'Hide research tools' : 'Show research tools'}</span>
        </div>
        <div className="mm-nav" onClick={() => setCollapsed(c => !c)} role="button" tabIndex={0} title={collapsed ? 'Expand sidebar' : undefined}
          onKeyDown={e => { if (e.key === 'Enter') setCollapsed(c => !c); }}>
          {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <PanelLeftClose size={16} strokeWidth={1.75} />}
          <span className="label">Collapse</span>
        </div>
      </div>
    </nav>
  );
}

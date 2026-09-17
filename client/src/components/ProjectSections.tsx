import { useState } from 'react';

interface ProjectSectionsProps {
  /** 'ALL', or a single project id. */
  selectedProject: string;
  /** Every project that currently has data. */
  projects: string[];
  /** Short per-project line shown in the section header (counts, status…). */
  summary?: (projectId: string) => React.ReactNode;
  /** Renders one project's view. Gets the project id to scope its data by. */
  children: (projectId: string) => React.ReactNode;
}

/**
 * Keeps per-project data visually separate instead of merging it into one
 * list. With a single project selected this is a passthrough — the page
 * renders exactly as before. With "ALL" selected it stacks one labelled,
 * collapsible section per project, so two systems that happen to be
 * monitored at once never read as a single one.
 */
export function ProjectSections({ selectedProject, projects, summary, children }: ProjectSectionsProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (selectedProject !== 'ALL') {
    return <>{children(selectedProject)}</>;
  }

  if (projects.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: '13px' }}>
        No projects with data yet.
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      height: '100%',
      overflowY: 'auto',
      background: 'var(--color-bg-body)',
      color: 'var(--color-text-main)',
    }}>
      {projects.map((project) => {
        const isCollapsed = collapsed[project];
        return (
          <section key={project} style={{ borderBottom: '1px solid var(--color-border)' }}>
            <header
              onClick={() => setCollapsed(prev => ({ ...prev, [project]: !prev[project] }))}
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 5,
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 24px',
                cursor: 'pointer',
                background: 'rgba(13, 17, 23, 0.95)',
                backdropFilter: 'blur(6px)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <span style={{ fontSize: '11px', color: 'var(--color-accent-cyan)', width: '10px' }}>
                {isCollapsed ? '▸' : '▾'}
              </span>
              <h2 style={{
                margin: 0,
                fontSize: '13px',
                fontWeight: 700,
                letterSpacing: '0.8px',
                textTransform: 'uppercase',
              }}>
                {project}
              </h2>
              {summary && (
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{summary(project)}</span>
              )}
            </header>
            {!isCollapsed && (
              <div style={{ padding: '4px 0 20px 0' }}>
                {children(project)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Root style for a page rendered inside a ProjectSections stack: the
 * wrapper owns scrolling and height, so an embedded page must not claim
 * either or each section would get its own scrollbar. */
export function pageRootStyle(embedded: boolean): React.CSSProperties {
  return embedded
    ? { padding: '4px 24px 0 24px', display: 'flex', flexDirection: 'column', gap: '24px' }
    : {
        flex: 1,
        height: '100%',
        overflowY: 'auto',
        padding: '24px',
        background: 'var(--color-bg-body)',
        color: 'var(--color-text-main)',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
      };
}

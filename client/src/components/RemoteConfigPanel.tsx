import { useState, useEffect } from 'react';
import { X, Loader2, Trash2, Eraser } from 'lucide-react';

interface RemoteConfigPanelProps {
  onClose?: () => void;
  editTargetId?: string | null;
  onDiscoveryStart?: (targetId: string) => void;
}

export function RemoteConfigPanel({ onClose, editTargetId, onDiscoveryStart }: RemoteConfigPanelProps) {
  const [projectName, setProjectName] = useState<string>('');
  const [ec2PublicIp, setEc2PublicIp] = useState<string>('');
  const [sshUsername, setSshUsername] = useState<string>('ubuntu');
  const [sshKeyPath, setSshKeyPath] = useState<string>('~/Downloads/sock-shop-key.pem');
  const [statusMsg, setStatusMsg] = useState<{ text: string, type: 'success' | 'error' | '' }>({ text: '', type: '' });
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    if (editTargetId) {
      fetch('/api/config/remote')
        .then(res => res.json())
        .then(data => {
          if (data && data[editTargetId]) {
            const config = data[editTargetId];
            setProjectName(config.displayName || editTargetId);
            setEc2PublicIp(config.ec2PublicIp || '');
            setSshUsername(config.sshUsername || 'ubuntu');
            setSshKeyPath(config.sshKeyPath || '');
          } else {
            setProjectName(editTargetId);
          }
        })
        .catch(() => {});
    } else {
      setProjectName('My Project');
    }
  }, [editTargetId]);

  const handleAutoDetectIp = async () => {
    try {
      const res = await fetch('https://checkip.amazonaws.com');
      const ip = await res.text();
      setEc2PublicIp(ip.trim());
    } catch (e) {
    }
  };

  const [busy, setBusy] = useState<'' | 'remove' | 'clear'>('');
  const removeProject = async () => {
    if (!editTargetId || !window.confirm(`Remove "${editTargetId}"? The mapper stops watching it and forgets its history. The services themselves are not touched.`)) return;
    setBusy('remove');
    try {
      const res = await fetch(`/api/config/remote/${encodeURIComponent(editTargetId)}`, { method: 'DELETE' });
      setStatusMsg(res.ok ? { text: 'Project removed', type: 'success' } : { text: 'Could not remove the project', type: 'error' });
      if (res.ok) setTimeout(() => onClose?.(), 900);
    } catch { setStatusMsg({ text: 'Could not reach the server', type: 'error' }); }
    setBusy('');
  };
  const clearData = async () => {
    const scope = editTargetId ? `"${editTargetId}"` : 'every project';
    if (!window.confirm(`Clear cached data for ${scope}? Learned baselines, metric history, links, traces and incidents are dropped and learned again from new data. Saved projects stay.`)) return;
    setBusy('clear');
    try {
      const res = await fetch('/api/data/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editTargetId ? { targetId: editTargetId } : {}) });
      setStatusMsg(res.ok ? { text: 'Cached data cleared; baselines are being learned again', type: 'success' } : { text: 'Could not clear data', type: 'error' });
    } catch { setStatusMsg({ text: 'Could not reach the server', type: 'error' }); }
    setBusy('');
  };

  const handleSave = async () => {
    // Editing keeps the project's id: renaming it used to create a second project instead of updating the first.
    const targetId = editTargetId || projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!projectName || !ec2PublicIp || !sshKeyPath) {
      setStatusMsg({ text: 'Please fill in all fields', type: 'error' });
      return;
    }

    if (onDiscoveryStart) onDiscoveryStart(targetId);

    setIsLoading(true);
    setStatusMsg({ text: 'Saving and discovering topology…', type: '' });
    try {
      const res = await fetch('/api/config/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId,
          projectName,
          ec2PublicIp,
          sshUsername,
          sshKeyPath
        }),
      });
      if (res.ok) {
        setStatusMsg({ text: 'Project configured and discovered', type: 'success' });
        setTimeout(() => {
          setStatusMsg({ text: '', type: '' });
          if (onClose) onClose();
        }, 2000);
      } else {
        setStatusMsg({ text: 'Failed to save configuration', type: 'error' });
      }
    } catch (e) {
      console.error('Failed to save config', e);
      setStatusMsg({ text: 'Network error', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const labelStyle: React.CSSProperties = { fontSize: '12px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '6px', fontWeight: 500 };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        width: '440px',
        maxWidth: 'calc(100vw - 32px)',
        background: 'rgba(17, 19, 23, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid var(--color-border)',
        borderRadius: '14px',
        zIndex: 101,
        boxShadow: 'var(--shadow-pop)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-family)',
        color: 'var(--color-text-main)',
      }}
    >
      <style>{`
        .mm-rc-input { width: 100%; height: 32px; background: rgba(255,255,255,0.03); color: var(--color-text-main); border: 1px solid var(--color-border);
          border-radius: 8px; padding: 0 10px; font: inherit; font-size: 13px; outline: none; transition: border-color var(--transition-fast); }
        .mm-rc-input::placeholder { color: var(--color-text-dim); }
        .mm-rc-input:hover { border-color: var(--color-border-hover); }
        .mm-rc-input:focus { border-color: rgba(138,180,255,0.45); }
        .mm-rc-input.mono { font-family: var(--font-mono); font-size: 12px; }
        .mm-rc-link { background: transparent; border: 0; padding: 0; font: inherit; font-size: 11.5px; color: var(--color-text-dim); cursor: pointer; }
        .mm-rc-link:hover { color: var(--color-text-main); }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '16px 16px 14px 20px', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--color-text-main)', letterSpacing: '-0.005em' }}>
            {editTargetId ? 'Edit project' : 'Add project'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '3px' }}>
            Connect a remote host over SSH to discover its services.
          </div>
        </div>
        {onClose && (
          <button className="mm-icon-btn" onClick={onClose} aria-label="Close" style={{ cursor: 'pointer', flexShrink: 0, marginTop: '-4px' }}>
            <X size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '18px 20px' }}>
        <div>
          <label style={labelStyle}>Project name</label>
          <input
            className="mm-rc-input"
            type="text"
            placeholder="e.g. Sock Shop AWS"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
          />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>Host IP address</label>
            <button className="mm-rc-link" onClick={handleAutoDetectIp} title="Warning: This resolves your LOCAL machine IP, not the AWS IP">
              Detect local IP
            </button>
          </div>
          <input
            className="mm-rc-input mono"
            type="text"
            placeholder="e.g. 13.234.56.78"
            value={ec2PublicIp}
            onChange={e => setEc2PublicIp(e.target.value)}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>SSH user</label>
            <input
              className="mm-rc-input mono"
              type="text"
              placeholder="ubuntu"
              value={sshUsername}
              onChange={e => setSshUsername(e.target.value)}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <label style={labelStyle}>SSH key path</label>
            <input
              className="mm-rc-input mono"
              type="text"
              placeholder="/home/user/.ssh/my-key.pem"
              value={sshKeyPath}
              onChange={e => setSshKeyPath(e.target.value)}
            />
          </div>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--color-text-dim)', lineHeight: 1.5 }}>
          The backend connects to this host, reads its Docker Compose manifest and builds a baseline architecture graph. Use an absolute key path.
        </div>

        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="mm-eyebrow" style={{ width: '100%' }}>Maintenance</span>
          <button className="mm-btn" onClick={clearData} disabled={!!busy} style={{ cursor: 'pointer' }} title="Drop learned baselines, history, links, traces and incidents">
            {busy === 'clear' ? <Loader2 size={14} className="mm-spin" /> : <Eraser size={14} strokeWidth={1.75} />}
            {editTargetId ? 'Clear cached data' : 'Clear cached data (all projects)'}
          </button>
          {editTargetId && (
            <button className="mm-btn" onClick={removeProject} disabled={!!busy} style={{ cursor: 'pointer', color: 'var(--color-critical)', borderColor: 'rgba(239,95,103,0.35)' }}>
              {busy === 'remove' ? <Loader2 size={14} className="mm-spin" /> : <Trash2 size={14} strokeWidth={1.75} />}
              Remove project
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 16px 14px 20px', borderTop: '1px solid var(--color-border)' }}>
        <div style={{
          fontSize: '12px',
          minWidth: 0,
          color: statusMsg.type === 'success' ? 'var(--color-healthy)' : statusMsg.type === 'error' ? 'var(--color-critical)' : 'var(--color-text-muted)',
        }}>
          {statusMsg.text}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          {onClose && (
            <button className="mm-btn" onClick={onClose} style={{ cursor: 'pointer' }}>Cancel</button>
          )}
          <button
            className="mm-btn primary"
            onClick={handleSave}
            disabled={isLoading}
            style={{ cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.7 : 1 }}
          >
            {isLoading && <Loader2 size={14} strokeWidth={1.75} className="mm-spin" />}
            {isLoading ? 'Discovering…' : 'Save and discover'}
          </button>
        </div>
      </div>
    </div>
  );
}

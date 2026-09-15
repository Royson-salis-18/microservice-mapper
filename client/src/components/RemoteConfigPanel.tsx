import { useState, useEffect } from 'react';

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

  const handleSave = async () => {
    const targetId = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!projectName || !ec2PublicIp || !sshKeyPath) {
      setStatusMsg({ text: 'Please fill in all fields', type: 'error' });
      return;
    }

    if (onDiscoveryStart) onDiscoveryStart(targetId);

    setIsLoading(true);
    setStatusMsg({ text: 'Saving and Discovering Topology...', type: '' });
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
        setStatusMsg({ text: 'Project Configured & Discovered!', type: 'success' });
        setTimeout(() => {
          setStatusMsg({ text: '', type: '' });
          if (onClose) onClose();
        }, 2000);
      } else {
        setStatusMsg({ text: 'Failed to save configuration', type: 'error' });
      }
    } catch (e) {
      console.error('Failed to save config', e);
      setStatusMsg({ text: 'Network Error', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px', 
        width: '460px', // Wider to fit terminal comfortably
        background: 'rgba(12, 12, 24, 0.95)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid var(--color-border)',
        borderRadius: '16px',
        padding: '24px',
        zIndex: 101,
        boxShadow: '0 20px 40px rgba(0,0,0,0.65), 0 0 24px rgba(224, 64, 251, 0.15)',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        fontFamily: 'var(--font-family)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: 'var(--color-accent-magenta)', fontSize: '18px' }}>☁️</span>
          <span style={{ fontWeight: 800, fontSize: '14px', letterSpacing: '1.5px', textTransform: 'uppercase', color: '#fff' }}>
            {editTargetId ? 'EDIT PROJECT' : 'ADD AWS PROJECT'}
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--color-text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '6px', fontWeight: 600 }}>PROJECT NAME</label>
          <input
            type="text"
            placeholder="e.g. Sock Shop AWS"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px 10px', fontSize: '12px', outline: 'none' }}
          />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>TARGET AWS IP</label>
            <button onClick={handleAutoDetectIp} style={{ fontSize: '9px', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer' }} title="Warning: This resolves your LOCAL machine IP, not the AWS IP">
              Detect Local IP
            </button>
          </div>
          <input
            type="text"
            placeholder="e.g. 13.234.56.78"
            value={ec2PublicIp}
            onChange={e => setEc2PublicIp(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px 10px', fontSize: '12px', outline: 'none' }}
          />
        </div>

        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '6px', fontWeight: 600 }}>SSH USERNAME</label>
          <input
            type="text"
            placeholder="e.g. ubuntu, ec2-user"
            value={sshUsername}
            onChange={e => setSshUsername(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px 10px', fontSize: '12px', outline: 'none' }}
          />
        </div>

        <div>
          <label style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', display: 'block', marginBottom: '6px', fontWeight: 600 }}>SSH KEY PATH (Absolute)</label>
          <input
            type="text"
            placeholder="e.g. /home/user/.ssh/my-key.pem"
            value={sshKeyPath}
            onChange={e => setSshKeyPath(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.4)', color: '#fff', border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px 10px', fontSize: '12px', outline: 'none' }}
          />
        </div>


      </div>

      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)', padding: '10px', borderRadius: '8px', fontSize: '10px', color: 'var(--color-text-dim)', lineHeight: 1.4 }}>
        The backend will autonomously SSH into this instance to parse the Docker Compose manifest and build your baseline architecture graph.
      </div>

      <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button
          onClick={handleSave}
          disabled={isLoading}
          style={{
            background: 'linear-gradient(135deg, rgba(224,64,251,0.25), rgba(0,212,255,0.25))',
            border: '1px solid var(--color-accent-magenta)',
            color: '#fff',
            padding: '12px', borderRadius: '8px', fontWeight: 700, fontSize: '12px', letterSpacing: '1px',
            cursor: isLoading ? 'not-allowed' : 'pointer', transition: 'all 0.2s',
          }}
        >
          {isLoading ? 'DISCOVERING ARCHITECTURE...' : '💾 SAVE PROJECT & DISCOVER'}
        </button>
        {statusMsg.text && (
          <div style={{ textAlign: 'center', fontSize: '11px', fontWeight: 600, color: statusMsg.type === 'success' ? 'var(--color-healthy)' : 'var(--color-critical)' }}>
            {statusMsg.text}
          </div>
        )}
      </div>
    </div>
  );
}

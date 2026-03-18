import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { BeastCard } from './BeastCard';
import styles from './RemotePanel.module.css';

interface Beast {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  themeColor: string | null;
  role: string | null;
  online: boolean;
  status: 'processing' | 'idle' | 'shell' | 'offline';
}

const API_BASE = '/api';

interface RemotePanelProps {
  isOpen: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function RemotePanel({ isOpen, onClose, collapsed = false, onToggleCollapse }: RemotePanelProps) {
  const navigate = useNavigate();
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const [attachedBeast, setAttachedBeast] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [packRes, statusRes] = await Promise.all([
        fetch(`${API_BASE}/pack`),
        fetch(`${API_BASE}/remote/status`),
      ]);
      const packData = await packRes.json();
      const statusData = await statusRes.json();
      setBeasts(packData.beasts);
      setAttachedBeast(statusData.attached_beast);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!collapsed) loadStatus();
  }, [collapsed, loadStatus]);

  // Always poll when not collapsed
  useEffect(() => {
    if (collapsed) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [collapsed, loadStatus]);

  async function handleClick(beast: Beast) {
    if (beast.status === 'offline') return;
    setLoading(true);
    try {
      if (attachedBeast === beast.name) {
        await fetch(`${API_BASE}/remote/detach`, { method: 'POST' });
        setAttachedBeast(null);
      } else {
        await fetch(`${API_BASE}/remote/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ beast: beast.name }),
        });
        setAttachedBeast(beast.name);
      }
    } finally {
      setLoading(false);
    }
  }

  const attachedInfo = beasts.find(b => b.name === attachedBeast);

  return (
    <>
      {/* Backdrop — mobile only */}
      {isOpen && <div className={styles.backdrop} onClick={onClose} />}

      {/* Panel */}
      <div className={`${styles.panel} ${collapsed ? styles.collapsed : ''} ${isOpen ? styles.mobileOpen : ''}`}>
        <div className={styles.panelInner}>
          {onToggleCollapse && (
            <button className={styles.collapseToggle} onClick={onToggleCollapse} title={collapsed ? 'Show Remote' : 'Hide Remote'}>
              {collapsed ? '◂' : '▸'}
            </button>
          )}
          <div className={styles.panelHeader}>
            <h3>Remote</h3>
            <button className={styles.closeBtn} onClick={onClose}>✕</button>
          </div>

        {attachedInfo ? (
          <div className={styles.attachedBar} style={attachedInfo.themeColor ? { borderLeftColor: attachedInfo.themeColor } : undefined}>
            <span
              className={styles.attachedDot}
              style={attachedInfo.themeColor ? { background: attachedInfo.themeColor } : undefined}
            />
            <span className={styles.attachedName}>{attachedInfo.displayName}</span>
            <code className={styles.tmuxHint}>tmux attach -t Remote</code>
          </div>
        ) : (
          <div className={styles.noAttached}>No beast attached</div>
        )}

        <div className={styles.beastList}>
          {beasts.map(beast => {
            const isAttached = attachedBeast === beast.name;

            return (
              <BeastCard
                key={beast.name}
                {...beast}
                selected={isAttached}
                badge={isAttached ? 'ATTACHED' : undefined}
                onClick={() => !loading && handleClick(beast)}
                onDmClick={(e) => { e.stopPropagation(); navigate(`/dms?conv=gorn-${beast.name}`); }}
              />
            );
          })}
        </div>
        </div>
      </div>
    </>
  );
}

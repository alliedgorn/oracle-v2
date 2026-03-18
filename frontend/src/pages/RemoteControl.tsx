import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ANIMAL_EMOJI } from '../utils/animals';
import styles from './RemoteControl.module.css';

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

export function RemoteControl() {
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

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Poll status every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadStatus]);

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
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Remote Control</h1>
        <p className={styles.subtitle}>
          {attachedInfo ? (
            <>
              <span
                className={styles.attachedDot}
                style={attachedInfo.themeColor ? { background: attachedInfo.themeColor } : undefined}
              />
              Attached: {attachedInfo.displayName} ({attachedInfo.animal})
            </>
          ) : (
            'No beast attached'
          )}
        </p>
        {attachedInfo && (
          <p className={styles.hint}>
            Run <code>tmux attach -t Remote</code> to interact
          </p>
        )}
      </div>

      <div className={styles.grid}>
        {beasts.map(beast => {
          const isAttached = attachedBeast === beast.name;
          const isOffline = beast.status === 'offline';

          return (
            <div
              key={beast.name}
              className={`${styles.card} ${isAttached ? styles.attached : ''} ${isOffline ? styles.offline : ''} ${beast.status === 'shell' ? styles.shell : ''}`}
              onClick={() => !loading && handleClick(beast)}
              style={beast.themeColor ? { borderLeftColor: beast.themeColor } : undefined}
            >
              <div className={styles.avatarContainer}>
                {beast.avatarUrl ? (
                  <img src={beast.avatarUrl} alt={beast.displayName} className={styles.avatar} />
                ) : (
                  <span className={styles.emoji}>{ANIMAL_EMOJI[beast.animal?.toLowerCase()] || '🐾'}</span>
                )}
                <span className={`${styles.statusDot} ${styles['dot' + beast.status.charAt(0).toUpperCase() + beast.status.slice(1)]}`} />
              </div>
              <div className={styles.info}>
                <span className={styles.name}>{beast.displayName}</span>
                <span className={styles.role}>{beast.role || beast.animal}</span>
              </div>
              {isAttached && <span className={styles.attachedLabel}>ATTACHED</span>}
              <button
                className={styles.dmButton}
                title={`DM ${beast.displayName}`}
                onClick={(e) => { e.stopPropagation(); navigate(`/dms?conv=gorn-${beast.name}`); }}
              >💬</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

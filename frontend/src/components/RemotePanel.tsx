import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { BeastCard } from './BeastCard';
import { useChat } from '../contexts/ChatContext';
import { useWebSocket } from '../hooks/useWebSocket';
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
  contextPct: number | null;
}

interface GuestInfo {
  id: number;
  username: string;
  display_name: string | null;
  online: boolean;
  last_active_at: string | null;
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
  const { openChat } = useChat();
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'beasts' | 'guests'>('beasts');
  const [guests, setGuests] = useState<GuestInfo[]>([]);

  const loadGuests = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/guests`);
      if (res.ok) {
        const data = await res.json();
        setGuests(data.guests || []);
      }
    } catch {}
  }, []);

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

  const loadUnread = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/dm/gorn?limit=50`);
      const data = await res.json();
      const counts: Record<string, number> = {};
      for (const conv of data.conversations || []) {
        if (conv.unread_count > 0) counts[conv.with] = conv.unread_count;
      }
      setUnreadCounts(counts);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!collapsed) { loadStatus(); loadUnread(); loadGuests(); }
  }, [collapsed, loadStatus, loadUnread, loadGuests]);

  // Poll pack/remote status (no DMs — those use WS)
  useEffect(() => {
    if (collapsed) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, [collapsed, loadStatus]);

  // WebSocket: refresh unread counts on new DM or read event
  useWebSocket('new_dm', useCallback(() => { setTimeout(() => loadUnread(), 500); }, [loadUnread]));
  useWebSocket('dm_read', useCallback(() => { setTimeout(() => loadUnread(), 300); }, [loadUnread]));

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

  function getGuestColor(name: string) {
    const colors = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

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

          <div className={styles.tabBar}>
            <button className={`${styles.tab} ${tab === 'beasts' ? styles.tabActive : ''}`} onClick={() => setTab('beasts')}>
              Beasts
            </button>
            <button className={`${styles.tab} ${tab === 'guests' ? styles.tabActive : ''}`} onClick={() => setTab('guests')}>
              Guests {guests.filter(g => g.online).length > 0 && <span className={styles.tabBadge}>{guests.filter(g => g.online).length}</span>}
            </button>
          </div>

        {tab === 'beasts' && attachedInfo ? (
          <div className={styles.attachedBar} style={attachedInfo.themeColor ? { borderLeftColor: attachedInfo.themeColor } : undefined}>
            <span
              className={styles.attachedDot}
              style={attachedInfo.themeColor ? { background: attachedInfo.themeColor } : undefined}
            />
            <span className={styles.attachedName}>{attachedInfo.displayName}</span>
            <code className={styles.tmuxHint}>tmux attach -t Remote</code>
          </div>
        ) : tab === 'beasts' ? (
          <div className={styles.noAttached}>No beast attached</div>
        ) : null}

        {tab === 'beasts' ? (
          <div className={styles.beastList}>
            {beasts.map(beast => {
              const isAttached = attachedBeast === beast.name;
              return (
                <BeastCard
                  key={beast.name}
                  {...beast}
                  selected={isAttached}
                  badge={isAttached ? 'ATTACHED' : beast.contextPct != null ? `${beast.contextPct}%` : undefined}
                  onClick={() => !loading && handleClick(beast)}
                  onTerminalClick={(e) => { e.stopPropagation(); onClose(); navigate(`/terminal?beast=${beast.name}`); }}
                  unreadCount={unreadCounts[beast.name] || 0}
                  onDmClick={(e) => { e.stopPropagation(); openChat(beast.name, beast.displayName); }}
                />
              );
            })}
          </div>
        ) : (
          <div className={styles.beastList}>
            {guests.length === 0 ? (
              <div className={styles.noAttached}>No guest accounts</div>
            ) : guests.map(guest => (
              <div key={guest.id} className={styles.guestCard}>
                <div className={styles.guestAvatar} style={{ background: getGuestColor(guest.username) }}>
                  {(guest.display_name || guest.username).charAt(0).toUpperCase()}
                </div>
                <div className={styles.guestInfo}>
                  <div className={styles.guestName}>
                    <span className={`${styles.guestDot} ${guest.online ? styles.guestDotOnline : styles.guestDotOffline}`} />
                    {guest.display_name || guest.username}
                  </div>
                  <div className={styles.guestMeta}>@{guest.username}</div>
                </div>
                <button className={styles.guestDmBtn} onClick={() => openChat(guest.username, guest.display_name || guest.username)} title="DM">
                  💬
                </button>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

    </>
  );
}

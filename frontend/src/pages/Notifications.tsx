import { useState, useEffect } from 'react';
import styles from './Notifications.module.css';

interface Notification {
  id: number;
  beast: string;
  type: string;
  title: string;
  body: string | null;
  source_id: number | null;
  source_type: string | null;
  priority: string;
  status: string;
  created_at: string;
  seen_at: string | null;
  dismissed_at: string | null;
}

const API_BASE = '/api';
const TYPE_ICONS: Record<string, string> = {
  scheduler: '⏰',
  forum_mention: '💬',
  dm: '✉️',
  task_update: '📋',
  security: '🔒',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function Notifications() {
  const urlParams = new URLSearchParams(window.location.search);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(urlParams.get('status') || 'all');
  const [beastFilter, setBeastFilter] = useState(urlParams.get('beast') || '');

  async function loadNotifications() {
    try {
      const beast = beastFilter || 'gorn';
      let url = `${API_BASE}/notifications/${beast}?limit=100`;
      if (filter !== 'all') url += `&status=${filter}`;
      const res = await fetch(url);
      const data = await res.json();
      setNotifications(data.notifications || []);
    } catch {
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadNotifications();
    const interval = setInterval(() => {
      if (!document.hidden) loadNotifications();
    }, 10000);
    return () => clearInterval(interval);
  }, [filter, beastFilter]);

  async function markSeen(id: number, beast: string) {
    await fetch(`${API_BASE}/notifications/${id}/seen?as=${beast}`, { method: 'PATCH' });
    loadNotifications();
  }

  async function dismiss(id: number, beast: string) {
    await fetch(`${API_BASE}/notifications/${id}/dismiss?as=${beast}`, { method: 'PATCH' });
    loadNotifications();
  }

  async function markAllSeen(beast: string) {
    await fetch(`${API_BASE}/notifications/${beast}/seen-all?as=${beast}`, { method: 'PATCH' });
    loadNotifications();
  }

  function getSourceLink(n: Notification): string | null {
    if (n.source_type === 'thread' && n.source_id) return `/forum?thread=${n.source_id}`;
    if (n.source_type === 'dm' && n.source_id) return `/dms`;
    if (n.source_type === 'task' && n.source_id) return `/board?task=${n.source_id}`;
    if (n.source_type === 'schedule' && n.source_id) return `/scheduler`;
    return null;
  }

  const beasts = ['gorn', 'karo', 'zaghnal', 'gnarl', 'bertus', 'pip', 'dex', 'mara', 'nyx', 'rax', 'leonard'];
  const pendingCount = notifications.filter(n => n.status === 'pending').length;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Notifications</h1>
        <div className={styles.controls}>
          <select
            className={styles.select}
            value={beastFilter || 'gorn'}
            onChange={e => setBeastFilter(e.target.value)}
          >
            {beasts.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <select
            className={styles.select}
            value={filter}
            onChange={e => setFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="seen">Seen</option>
            <option value="dismissed">Dismissed</option>
          </select>
          {pendingCount > 0 && (
            <button className={styles.markAllBtn} onClick={() => markAllSeen(beastFilter || 'gorn')}>
              Mark all seen ({pendingCount})
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className={styles.empty}>Loading...</div>
      ) : notifications.length === 0 ? (
        <div className={styles.empty}>No notifications</div>
      ) : (
        <div className={styles.list}>
          {notifications.map(n => {
            const link = getSourceLink(n);
            return (
              <div
                key={n.id}
                className={`${styles.item} ${n.status === 'pending' ? styles.unread : ''} ${n.priority === 'critical' ? styles.critical : ''}`}
              >
                <span className={styles.icon}>{TYPE_ICONS[n.type] || '🔔'}</span>
                <div className={styles.content}>
                  <div className={styles.titleRow}>
                    {link ? (
                      <a href={link} className={styles.notifTitle}>{n.title}</a>
                    ) : (
                      <span className={styles.notifTitle}>{n.title}</span>
                    )}
                    <span className={styles.time}>{timeAgo(n.created_at)}</span>
                  </div>
                  {n.body && <div className={styles.body}>{n.body}</div>}
                  <div className={styles.meta}>
                    <span className={styles.type}>{n.type}</span>
                    {n.priority !== 'normal' && <span className={styles.priority}>{n.priority}</span>}
                    <span className={styles.status}>{n.status}</span>
                  </div>
                </div>
                {n.status === 'pending' && (
                  <div className={styles.actions}>
                    <button className={styles.actionBtn} onClick={() => markSeen(n.id, n.beast)} title="Mark seen">👁</button>
                    <button className={styles.actionBtn} onClick={() => dismiss(n.id, n.beast)} title="Dismiss">✕</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

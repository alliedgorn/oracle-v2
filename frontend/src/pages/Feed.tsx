import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import styles from './Feed.module.css';

const API_BASE = '/api';

interface FeedEvent {
  type: string;
  id: number;
  timestamp: string;
  actor: string;
  title: string;
  message: string;
  url: string;
}

const TYPE_ICONS: Record<string, string> = {
  forum: '💬', task: '✅', spec: '📋', rule: '📜',
};

export function Feed() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  const type = searchParams.get('type') || '';

  useEffect(() => { loadFeed(); }, [type]);

  async function loadFeed() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (type) params.set('type', type);
      const res = await fetch(`${API_BASE}/feed?${params}`);
      const data = await res.json();
      setEvents(data.events || []);
      setTotal(data.total || 0);
    } finally { setLoading(false); }
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Activity Feed</h1>
        <span className={styles.total}>{total} events</span>
      </div>

      <div className={styles.filters}>
        {['', 'forum', 'task', 'spec'].map(t => (
          <button
            key={t}
            className={`${styles.filterBtn} ${type === t ? styles.filterActive : ''}`}
            onClick={() => setSearchParams(t ? { type: t } : {})}
          >
            {t ? `${TYPE_ICONS[t] || ''} ${t.charAt(0).toUpperCase() + t.slice(1)}` : 'All'}
          </button>
        ))}
      </div>

      {loading && <div className={styles.loading}>Loading...</div>}

      <div className={styles.feed}>
        {events.map((event, i) => (
          <div
            key={`${event.type}-${event.id}-${i}`}
            className={styles.eventCard}
            onClick={() => navigate(event.url)}
          >
            <div className={styles.eventHeader}>
              <span className={styles.eventIcon}>{TYPE_ICONS[event.type] || '📄'}</span>
              <span className={styles.eventType}>{event.type}</span>
              <span className={styles.eventActor}>{event.actor}</span>
              <span className={styles.eventTime}>{formatTime(event.timestamp)}</span>
            </div>
            <div className={styles.eventTitle}>{event.title}</div>
            <div className={styles.eventMessage}>{event.message}</div>
          </div>
        ))}
      </div>

      {!loading && events.length === 0 && (
        <div className={styles.empty}>No activity yet.</div>
      )}
    </div>
  );
}

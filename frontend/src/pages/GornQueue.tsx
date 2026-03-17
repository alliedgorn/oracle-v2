import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './GornQueue.module.css';
import { FilterTabs } from '../components/FilterTabs';

interface QueueItem {
  thread_id: number;
  title: string;
  thread_status: string;
  queue_status: string;
  tagged_by: string;
  tagged_at: string | null;
  summary: string | null;
  message_count: number;
  created_at: string;
}

const API_BASE = '/api';

export function GornQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<string>('pending');
  const [loading, setLoading] = useState(false);

  const loadQueue = useCallback(async () => {
    const res = await fetch(`${API_BASE}/queue/gorn?status=${filter}`);
    const data = await res.json();
    setItems(data.items);
  }, [filter]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  // Refresh on new forum messages
  useWebSocket('new_message', loadQueue);

  async function updateStatus(threadId: number, status: string) {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/queue/gorn/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await loadQueue();
    } finally {
      setLoading(false);
    }
  }

  function formatTime(iso: string) {
    const date = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Gorn's Queue</h1>
        <p className={styles.subtitle}>Decisions awaiting approval</p>
      </div>

      <FilterTabs
        items={[
          { id: 'pending', label: 'Pending', count: filter === 'pending' ? items.length : undefined },
          { id: 'deferred', label: 'Deferred' },
          { id: 'decided', label: 'Decided' },
          { id: 'withdrawn', label: 'Withdrawn' },
        ]}
        activeId={filter}
        onChange={setFilter}
      />

      <div className={styles.queue}>
        {items.length === 0 && (
          <div className={styles.empty}>
            {filter === 'pending' ? 'No decisions pending.' : `No ${filter} items.`}
          </div>
        )}

        {items.map(item => (
          <div key={item.thread_id} className={styles.item}>
            <div className={styles.itemHeader}>
              <Link to={`/forum?thread=${item.thread_id}`} className={styles.title}>
                {item.title}
              </Link>
              <span className={styles.age}>{item.tagged_at ? formatTime(item.tagged_at) : ''}</span>
            </div>

            {item.summary && (
              <p className={styles.summary}>{item.summary}</p>
            )}

            <div className={styles.meta}>
              <span className={styles.taggedBy}>Tagged by {item.tagged_by}</span>
              <span className={styles.msgCount}>{item.message_count} messages</span>
            </div>

            {filter === 'pending' && (
              <div className={styles.actions}>
                <button
                  className={styles.decidedBtn}
                  onClick={() => updateStatus(item.thread_id, 'decided')}
                  disabled={loading}
                >
                  Decided
                </button>
                <button
                  className={styles.deferBtn}
                  onClick={() => updateStatus(item.thread_id, 'deferred')}
                  disabled={loading}
                >
                  Defer
                </button>
              </div>
            )}

            {filter === 'deferred' && (
              <div className={styles.actions}>
                <button
                  className={styles.decidedBtn}
                  onClick={() => updateStatus(item.thread_id, 'decided')}
                  disabled={loading}
                >
                  Decided
                </button>
                <button
                  className={styles.pendingBtn}
                  onClick={() => updateStatus(item.thread_id, 'pending')}
                  disabled={loading}
                >
                  Move to Pending
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

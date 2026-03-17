import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './Mindlink.module.css';
import { FilterTabs } from '../components/FilterTabs';

interface MindlinkItem {
  type: 'thread' | 'standalone';
  id: string;
  thread_id?: number;
  mindlink_id?: number;
  beast: string;
  title: string | null;
  summary: string | null;
  context?: string;
  status: string;
  message_count: number;
  created_at: string;
}

const API_BASE = '/api';

export function Mindlink() {
  const [items, setItems] = useState<MindlinkItem[]>([]);
  const [filter, setFilter] = useState<string>('pending');
  const [loading, setLoading] = useState(false);
  const [attachedBeast, setAttachedBeast] = useState<string | null>(null);

  // Check current attached beast
  useEffect(() => {
    fetch(`${API_BASE}/remote/status`).then(r => r.json()).then(d => setAttachedBeast(d.attached_beast)).catch(() => {});
  }, []);

  async function attachBeast(beastName: string) {
    try {
      await fetch(`${API_BASE}/remote/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: beastName }),
      });
      setAttachedBeast(beastName);
    } catch { /* ignore */ }
  }

  const loadMindlinks = useCallback(async () => {
    const res = await fetch(`${API_BASE}/mindlink?status=${filter}`);
    const data = await res.json();
    setItems(data.items);
  }, [filter]);

  useEffect(() => { loadMindlinks(); }, [loadMindlinks]);

  useWebSocket('new_message', loadMindlinks);

  async function updateStatus(id: string, status: string) {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/mindlink/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await loadMindlinks();
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
        <h1>Mindlink</h1>
        <p className={styles.subtitle}>Beasts that need your attention</p>
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
            {filter === 'pending' ? 'No beasts need attention.' : `No ${filter} items.`}
          </div>
        )}

        {items.map(item => (
          <div key={item.id} className={`${styles.item} ${item.type === 'standalone' ? styles.standalone : ''}`}>
            <div className={styles.itemHeader}>
              {item.thread_id ? (
                <Link to={`/forum?thread=${item.thread_id}`} className={styles.title}>
                  {item.title || item.summary}
                </Link>
              ) : (
                <span className={styles.title}>{item.summary}</span>
              )}
              <span className={styles.age}>{formatTime(item.created_at)}</span>
            </div>

            {item.summary && item.title && (
              <p className={styles.summary}>{item.summary}</p>
            )}

            <div className={styles.meta}>
              <span className={styles.taggedBy}>
                {item.type === 'standalone' ? (
                  <><button className={styles.beastLink} onClick={() => attachBeast(item.beast)} title={`Attach ${item.beast}'s terminal`}>{item.beast}{attachedBeast === item.beast ? ' ✓' : ''}</button> needs you</>
                ) : (
                  <>Tagged by <button className={styles.beastLink} onClick={() => attachBeast(item.beast)} title={`Attach ${item.beast}'s terminal`}>{item.beast}{attachedBeast === item.beast ? ' ✓' : ''}</button></>
                )}
              </span>
              {item.message_count > 0 && (
                <span className={styles.msgCount}>{item.message_count} messages</span>
              )}
            </div>

            {(filter === 'pending' || filter === 'deferred') && (
              <div className={styles.actions}>
                <button
                  className={styles.decidedBtn}
                  onClick={() => updateStatus(item.id, 'decided')}
                  disabled={loading}
                >
                  Done
                </button>
                {filter === 'pending' ? (
                  <button
                    className={styles.deferBtn}
                    onClick={() => updateStatus(item.id, 'deferred')}
                    disabled={loading}
                  >
                    Defer
                  </button>
                ) : (
                  <button
                    className={styles.pendingBtn}
                    onClick={() => updateStatus(item.id, 'pending')}
                    disabled={loading}
                  >
                    Move to Pending
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

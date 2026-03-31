import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import styles from './Guests.module.css';

interface Guest {
  id: number;
  username: string;
  display_name: string | null;
  expires_at: string | null;
  disabled_at: string | null;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
  online: boolean;
}

export function Guests() {
  const { isGuest } = useAuth();
  const { openChat } = useChat();
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadGuests = useCallback(async () => {
    try {
      const res = await fetch('/api/guests');
      if (res.ok) {
        const data = await res.json();
        setGuests(data.guests || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    loadGuests();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadGuests();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadGuests]);

  if (isGuest) {
    return <div className={styles.container}><p className={styles.empty}>Owner access only.</p></div>;
  }

  const filtered = guests.filter(g => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return g.username.includes(q) || (g.display_name || '').toLowerCase().includes(q);
  });

  const onlineCount = guests.filter(g => g.online).length;

  function formatTime(iso: string | null) {
    if (!iso) return 'Never';
    const date = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Guests</h1>
          <p className={styles.subtitle}>
            {guests.length} guest{guests.length !== 1 ? 's' : ''} &middot; {onlineCount} online
          </p>
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search guests..."
          className={styles.search}
        />
      </div>

      {loading ? (
        <p className={styles.empty}>Loading...</p>
      ) : filtered.length === 0 ? (
        <p className={styles.empty}>{search ? 'No guests match your search.' : 'No guest accounts yet.'}</p>
      ) : (
        <div className={styles.grid}>
          {filtered.map(guest => (
            <div key={guest.id} className={`${styles.card} ${guest.disabled_at ? styles.cardDisabled : ''}`}>
              <div className={styles.cardHeader}>
                <div className={styles.nameRow}>
                  <span className={`${styles.dot} ${guest.online ? styles.dotOnline : styles.dotOffline}`} />
                  <span className={styles.username}>{guest.username}</span>
                </div>
                {guest.online && <span className={styles.onlineBadge}>Online</span>}
                {guest.disabled_at && <span className={styles.disabledBadge}>Disabled</span>}
              </div>

              {guest.display_name && guest.display_name !== guest.username && (
                <div className={styles.displayName}>{guest.display_name}</div>
              )}

              <div className={styles.meta}>
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Last active</span>
                  <span className={styles.metaValue}>{formatTime(guest.last_active_at)}</span>
                </div>
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Last login</span>
                  <span className={styles.metaValue}>{formatTime(guest.last_login_at)}</span>
                </div>
                <div className={styles.metaItem}>
                  <span className={styles.metaLabel}>Created</span>
                  <span className={styles.metaValue}>{formatTime(guest.created_at)}</span>
                </div>
                {guest.expires_at && (
                  <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Expires</span>
                    <span className={styles.metaValue}>{new Date(guest.expires_at).toLocaleDateString()}</span>
                  </div>
                )}
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.dmButton}
                  onClick={() => openChat(guest.username, guest.display_name || guest.username)}
                >
                  DM
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

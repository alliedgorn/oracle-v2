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
  message_count?: number;
  threads_participated?: number;
}

const SORT_KEY = 'guests_sort';

export function Guests() {
  const { isGuest } = useAuth();
  const { openChat } = useChat();
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'online' | 'active' | 'name' | 'created'>(() =>
    (localStorage.getItem(SORT_KEY) as any) || 'online'
  );
  const [selected, setSelected] = useState<Guest | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', display_name: '', expires_at: '' });
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

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

  // Keep selected guest data fresh
  useEffect(() => {
    if (!selected || guests.length === 0) return;
    const updated = guests.find(g => g.id === selected.id);
    if (updated) setSelected(updated);
  }, [guests]);

  if (isGuest) {
    return <div className={styles.container}><p className={styles.empty}>Owner access only.</p></div>;
  }

  function handleSortChange(val: typeof sort) {
    setSort(val);
    localStorage.setItem(SORT_KEY, val);
  }

  const filtered = guests.filter(g => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return g.username.includes(q) || (g.display_name || '').toLowerCase().includes(q);
  }).sort((a, b) => {
    // Disabled guests always sort to bottom
    if (a.disabled_at && !b.disabled_at) return 1;
    if (!a.disabled_at && b.disabled_at) return -1;

    if (sort === 'online') {
      if (a.online !== b.online) return a.online ? -1 : 1;
      const aTime = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
      const bTime = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
      return bTime - aTime;
    }
    if (sort === 'active') {
      const aTime = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
      const bTime = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
      return bTime - aTime;
    }
    if (sort === 'name') return a.username.localeCompare(b.username);
    if (sort === 'created') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    return 0;
  });

  const onlineCount = guests.filter(g => g.online).length;
  const isNew = (g: Guest) => Date.now() - new Date(g.created_at).getTime() < 86400000;

  function formatTime(iso: string | null) {
    if (!iso) return 'Never';
    const date = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const diff = Date.now() - date.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }

  function getInitial(guest: Guest) {
    return (guest.display_name || guest.username).charAt(0).toUpperCase();
  }

  // Simple hash for consistent avatar colors
  function getAvatarColor(name: string) {
    const colors = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.username.trim() || !form.password.trim()) return;
    setCreating(true);
    setFormError('');
    try {
      const body: Record<string, string> = {
        username: form.username.trim(),
        password: form.password,
      };
      if (form.display_name.trim()) body.display_name = form.display_name.trim();
      if (form.expires_at) body.expires_at = form.expires_at;

      const res = await fetch('/api/guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setForm({ username: '', password: '', display_name: '', expires_at: '' });
        setShowForm(false);
        loadGuests();
      } else {
        setFormError(data.error || 'Failed to create guest');
      }
    } catch {
      setFormError('Connection error');
    }
    setCreating(false);
  }

  async function handleToggleDisable(guest: Guest) {
    try {
      await fetch(`/api/guests/${guest.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          disabled_at: guest.disabled_at ? null : new Date().toISOString(),
        }),
      });
      loadGuests();
    } catch {}
  }

  async function handleDelete(guest: Guest) {
    if (!confirm(`Delete guest "${guest.username}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/guests/${guest.id}`, { method: 'DELETE' });
      if (selected?.id === guest.id) setSelected(null);
      loadGuests();
    } catch {}
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
        <div className={styles.controls}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search guests..."
            className={styles.search}
          />
          <select
            value={sort}
            onChange={e => handleSortChange(e.target.value as typeof sort)}
            className={styles.sortSelect}
          >
            <option value="online">Online first</option>
            <option value="active">Last active</option>
            <option value="name">Name</option>
            <option value="created">Newest</option>
          </select>
          <button className={styles.createButton} onClick={() => setShowForm(!showForm)}>
            + Create Guest
          </button>
        </div>
      </div>

      {/* Create Guest Form */}
      {showForm && (
        <form onSubmit={handleCreate} className={styles.createForm} autoComplete="off">
          {formError && <div className={styles.formError}>{formError}</div>}
          <div className={styles.formRow}>
            <input
              type="text"
              value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
              placeholder="Username (required)"
              className={styles.formInput}
              autoComplete="off"
            />
            <input
              type="text"
              value={form.display_name}
              onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
              placeholder="Display name"
              className={styles.formInput}
            />
            <input
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="Password (8+ chars)"
              className={styles.formInput}
              autoComplete="new-password"
            />
            <input
              type="date"
              value={form.expires_at}
              onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
              className={styles.formInput}
              title="Expiry date (optional)"
            />
            <button type="submit" className={styles.formSubmit} disabled={creating}>
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button type="button" className={styles.formCancel} onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className={styles.layout}>
        {/* Card Grid */}
        <div className={styles.gridSection}>
          {loading ? (
            <p className={styles.empty}>Loading...</p>
          ) : filtered.length === 0 ? (
            <p className={styles.empty}>
              {search ? 'No guests match your search.' : 'No guest accounts yet. Create your first guest account to get started.'}
            </p>
          ) : (
            <div className={styles.grid}>
              {filtered.map(guest => {
                const isSelected = selected?.id === guest.id;
                return (
                  <div
                    key={guest.id}
                    className={`${styles.card} ${guest.disabled_at ? styles.cardDisabled : ''} ${isSelected ? styles.cardSelected : ''}`}
                    onClick={() => setSelected(guest)}
                  >
                    <div className={styles.cardBody}>
                      <div className={styles.avatar} style={{ background: getAvatarColor(guest.username) }}>
                        {getInitial(guest)}
                      </div>
                      <div className={styles.cardInfo}>
                        <div className={styles.nameRow}>
                          <span className={`${styles.dot} ${guest.disabled_at ? styles.dotDisabled : guest.online ? styles.dotOnline : styles.dotOffline}`} />
                          <span className={`${styles.username} ${guest.disabled_at ? styles.usernameDisabled : ''}`}>{guest.username}</span>
                          {guest.online && <span className={styles.onlineBadge}>Online</span>}
                          {isNew(guest) && !guest.disabled_at && <span className={styles.newBadge}>New</span>}
                          {guest.disabled_at && <span className={styles.disabledBadge}>Disabled</span>}
                        </div>
                        {guest.display_name && guest.display_name !== guest.username && (
                          <div className={styles.displayName}>{guest.display_name}</div>
                        )}
                        <div className={styles.cardMeta}>
                          {guest.online ? 'Active now' : `Last active ${formatTime(guest.last_active_at)}`}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        <div className={styles.detailPanel}>
          {selected ? (
            <div className={styles.detailContent}>
              <div className={styles.detailHero}>
                <div className={styles.detailAvatar} style={{ background: getAvatarColor(selected.username) }}>
                  {getInitial(selected)}
                </div>
                <h2 className={styles.detailName}>{selected.display_name || selected.username}</h2>
                {selected.display_name && selected.display_name !== selected.username && (
                  <div className={styles.detailUsername}>@{selected.username}</div>
                )}
                <div className={`${styles.detailStatus} ${selected.disabled_at ? styles.detailStatusDisabled : selected.online ? styles.detailStatusOnline : styles.detailStatusOffline}`}>
                  <span className={`${styles.detailDot} ${selected.disabled_at ? styles.dotDisabled : selected.online ? styles.dotOnline : styles.dotOffline}`} />
                  {selected.disabled_at ? 'Disabled' : selected.online ? 'Online' : 'Offline'}
                </div>
              </div>

              <div className={styles.detailMeta}>
                <div className={styles.detailMetaItem}>
                  <span className={styles.metaLabel}>Last active</span>
                  <span className={styles.metaValue}>{formatTime(selected.last_active_at)}</span>
                </div>
                <div className={styles.detailMetaItem}>
                  <span className={styles.metaLabel}>Last login</span>
                  <span className={styles.metaValue}>{formatTime(selected.last_login_at)}</span>
                </div>
                <div className={styles.detailMetaItem}>
                  <span className={styles.metaLabel}>Created</span>
                  <span className={styles.metaValue}>{formatTime(selected.created_at)}</span>
                </div>
                {selected.expires_at && (
                  <div className={styles.detailMetaItem}>
                    <span className={styles.metaLabel}>Expires</span>
                    <span className={styles.metaValue}>{new Date(selected.expires_at).toLocaleDateString()}</span>
                  </div>
                )}
                {selected.disabled_at && (
                  <div className={styles.detailMetaItem}>
                    <span className={styles.metaLabel}>Disabled</span>
                    <span className={styles.metaValue} style={{ color: '#ef4444' }}>{formatTime(selected.disabled_at)}</span>
                  </div>
                )}
              </div>

              {(selected.message_count || selected.threads_participated) ? (
                <div className={styles.activitySummary}>
                  <h4 className={styles.activityTitle}>Activity</h4>
                  <div className={styles.activityRow}>
                    <span className={styles.activityCount}>{selected.message_count || 0}</span>
                    <span className={styles.activityLabel}>DM messages</span>
                  </div>
                  <div className={styles.activityRow}>
                    <span className={styles.activityCount}>{selected.threads_participated || 0}</span>
                    <span className={styles.activityLabel}>threads</span>
                  </div>
                </div>
              ) : null}

              <div className={styles.detailActions}>
                <button
                  className={styles.dmButton}
                  onClick={() => openChat(selected.username, selected.display_name || selected.username)}
                >
                  View DMs
                </button>
                <button
                  className={selected.disabled_at ? styles.enableButton : styles.disableButton}
                  onClick={() => handleToggleDisable(selected)}
                >
                  {selected.disabled_at ? 'Enable' : 'Disable'}
                </button>
                <button
                  className={styles.deleteButton}
                  onClick={() => handleDelete(selected)}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.detailPlaceholder}>
              <span style={{ fontSize: 32 }}>👤</span>
              <p>Select a guest to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

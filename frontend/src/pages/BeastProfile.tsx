import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import styles from './BeastProfile.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';

interface Beast {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  bio: string | null;
  interests: string | null;
  themeColor: string | null;
  role: string | null;
  online: boolean;
  sessionName: string;
}

interface PackData {
  beasts: Beast[];
}

const API_BASE = '/api';

export function BeastProfile() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [beast, setBeast] = useState<Beast | null>(null);
  const [allBeasts, setAllBeasts] = useState<Beast[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editBio, setEditBio] = useState('');
  const [editInterests, setEditInterests] = useState('');
  const [editRole, setEditRole] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!name) return;
    setLoading(true);

    // Fetch pack data (includes online status)
    fetch(`${API_BASE}/pack`)
      .then(res => res.json())
      .then((data: PackData) => {
        setAllBeasts(data.beasts);
        const found = data.beasts.find(b => b.name === name.toLowerCase());
        setBeast(found || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [name]);

  // Poll online status
  useEffect(() => {
    if (!name) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetch(`${API_BASE}/pack`)
        .then(res => res.json())
        .then((data: PackData) => {
          setAllBeasts(data.beasts);
          const found = data.beasts.find(b => b.name === name.toLowerCase());
          if (found) setBeast(found);
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [name]);

  if (loading) {
    return <div className={styles.container}><p className={styles.loading}>Loading...</p></div>;
  }

  if (!beast) {
    return (
      <div className={styles.container}>
        <p className={styles.notFound}>Beast "{name}" not found.</p>
        <Link to="/pack" className={styles.backLink}>Back to Pack</Link>
      </div>
    );
  }

  const emoji = ANIMAL_EMOJI[beast.animal?.toLowerCase()] || '🐾';
  const otherBeasts = allBeasts.filter(b => b.name !== beast.name);
  let interests: string[] = [];
  if (beast.interests) {
    try {
      const parsed = JSON.parse(beast.interests);
      interests = Array.isArray(parsed) ? parsed : [beast.interests];
    } catch {
      // Plain text — split by commas
      interests = beast.interests.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  async function handleSave() {
    if (!beast) return;
    setSaving(true);
    try {
      const interestsArr = editInterests.split(',').map(s => s.trim()).filter(Boolean);
      const beastName = beast.name;
      await fetch(`${API_BASE}/beast/${beastName}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bio: editBio,
          interests: JSON.stringify(interestsArr),
          role: editRole,
        }),
      });
      // Refresh
      const res = await fetch(`${API_BASE}/pack`);
      const data: PackData = await res.json();
      const found = data.beasts.find(b => b.name === beastName);
      if (found) setBeast(found);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.container}>
      <button onClick={() => navigate(-1)} className={styles.backLink}>
        ← Back
      </button>

      <div className={styles.profileCard} style={beast.themeColor ? { borderTopColor: beast.themeColor } : undefined}>
        {/* Avatar */}
        <div className={styles.avatarSection}>
          <div
            className={styles.avatarRing}
            style={beast.themeColor ? { borderColor: beast.themeColor } : undefined}
          >
            {beast.avatarUrl ? (
              <img src={beast.avatarUrl} alt={beast.displayName} className={styles.avatarImg} />
            ) : (
              <span className={styles.avatarEmoji}>{emoji}</span>
            )}
          </div>
          <span className={`${styles.statusBadge} ${beast.online ? styles.online : styles.offline}`}>
            {beast.online ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>

        {/* Info */}
        <div className={styles.info}>
          <h1 className={styles.name}>{beast.displayName}</h1>
          <div className={styles.meta}>
            <span className={styles.animal}>{emoji} {beast.animal}</span>
            {beast.role && !editing && <span className={styles.role}>{beast.role}</span>}
          </div>
          {!editing && beast.bio && <p className={styles.bio}>{beast.bio}</p>}
          {!editing && interests.length > 0 && (
            <div className={styles.interests}>
              {interests.map(tag => (
                <span key={tag} className={styles.interestTag}>{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Edit Form */}
      {editing ? (
        <div className={styles.editForm}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Role</label>
            <input
              className={styles.formInput}
              value={editRole}
              onChange={e => setEditRole(e.target.value)}
              placeholder="e.g. Software Engineering"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Bio</label>
            <textarea
              className={styles.formTextarea}
              value={editBio}
              onChange={e => setEditBio(e.target.value)}
              placeholder="Tell the pack about yourself..."
              rows={3}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Interests</label>
            <input
              className={styles.formInput}
              value={editInterests}
              onChange={e => setEditInterests(e.target.value)}
              placeholder="debugging, architecture, performance (comma-separated)"
            />
          </div>
          <div className={styles.formActions}>
            <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Profile'}
            </button>
            <button className={styles.cancelButton} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Details */}
          <div className={styles.details}>
            <div className={styles.detailGrid}>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Session</span>
                <span className={styles.detailValue}>{beast.sessionName}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Status</span>
                <span className={`${styles.detailValue} ${beast.online ? styles.textOnline : styles.textOffline}`}>
                  {beast.online ? 'Active in tmux' : 'No active session'}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className={styles.actions}>
            <button className={styles.editButton} onClick={() => {
              setEditBio(beast.bio || '');
              setEditInterests(interests.join(', '));
              setEditRole(beast.role || '');
              setEditing(true);
            }}>
              Edit Profile
            </button>
            <Link to={`/pack`} className={styles.actionButton}>
              View in Pack
            </Link>
            <Link to={`/forum`} className={styles.actionButton}>
              Forum Posts
            </Link>
            <Link to={`/dms`} className={styles.actionButton}>
              Direct Messages
            </Link>
          </div>
        </>
      )}

      {/* Other Beasts */}
      <div className={styles.otherBeasts}>
        <h3 className={styles.sectionTitle}>Pack Members</h3>
        <div className={styles.beastList}>
          {otherBeasts.map(b => (
            <Link
              key={b.name}
              to={`/beast/${b.name}`}
              className={styles.beastLink}
            >
              {b.avatarUrl ? (
                <img src={b.avatarUrl} alt={b.displayName} className={styles.smallAvatar} />
              ) : (
                <span className={styles.smallEmoji}>
                  {ANIMAL_EMOJI[b.animal?.toLowerCase()] || '🐾'}
                </span>
              )}
              <span className={styles.beastLinkName}>{b.displayName}</span>
              <span className={`${styles.dot} ${b.online ? styles.dotOn : styles.dotOff}`} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

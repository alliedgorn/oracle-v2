import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import styles from './PackPage.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';
import { BeastCard } from '../components/BeastCard';
import { useAuth } from '../contexts/AuthContext';

interface Beast {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  bio: string | null;
  interests: string | null;
  themeColor: string | null;
  role: string | null;
  sex: string | null;
  birthdate: string | null;
  online: boolean;
  status: 'processing' | 'idle' | 'waiting' | 'shell' | 'offline';
  sessionName: string;
}

const API_BASE = '/api';

export function PackPage() {
  const { isGuest, guestName } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const [selected, setSelected] = useState<Beast | null>(null);

  const loadPack = useCallback(async () => {
    try {
      const res = await fetch(isGuest ? '/api/guest/pack' : `${API_BASE}/pack`);
      const data = await res.json();
      const beastList = data.beasts || [];
      setBeasts(beastList);
    } catch { /* ignore */ }
  }, [isGuest]);

  useEffect(() => {
    loadPack();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadPack();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadPack]);

  // React to URL ?beast= param
  const beastParam = searchParams.get('beast');
  useEffect(() => {
    if (!beastParam || beasts.length === 0) return;
    const match = beasts.find(b => b.name === beastParam);
    if (match) setSelected(match);
  }, [beastParam, beasts]);

  const selectBeast = useCallback((beast: Beast) => {
    setSelected(beast);
    setSearchParams({ beast: beast.name }, { replace: true });
  }, [setSearchParams]);

  const beastCallbacks = useMemo(() => {
    const map: Record<string, { onClick: () => void; onProfileClick: (e: React.MouseEvent) => void }> = {};
    for (const beast of beasts) {
      map[beast.name] = {
        onClick: () => selectBeast(beast),
        onProfileClick: (e: React.MouseEvent) => { e.stopPropagation(); window.location.href = `/beast/${beast.name}`; },
      };
    }
    return map;
  }, [beasts, selectBeast]);

  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Parse interests
  let interests: string[] = [];
  if (selected?.interests) {
    try {
      const parsed = JSON.parse(selected.interests);
      interests = Array.isArray(parsed) ? parsed : [selected.interests];
    } catch {
      interests = selected.interests.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  return (
    <div className={styles.container}>
      {/* Guest Welcome Banner */}
      {isGuest && !bannerDismissed && (
        <div className={styles.guestBanner}>
          <span>Welcome to The Den{guestName ? `, ${guestName}` : ''}! You're visiting as a guest.</span>
          <button className={styles.guestBannerClose} onClick={() => setBannerDismissed(true)}>x</button>
        </div>
      )}

      {/* Beast Grid (left pane) */}
      <div className={styles.packGrid}>
        <h2 className={styles.title}>The Pack</h2>
        <div className={styles.beastGrid}>
          {beasts.map(beast => (
            <BeastCard
              key={beast.name}
              {...beast}
              selected={selected?.name === beast.name}
              onClick={beastCallbacks[beast.name]?.onClick}
              onProfileClick={beastCallbacks[beast.name]?.onProfileClick}
            />
          ))}
        </div>
      </div>

      {/* Profile Panel (right pane) */}
      <div className={styles.profilePanel}>
        {selected ? (
          <div className={styles.profileContent}>
            {/* Avatar + Name */}
            <div className={styles.profileHeader}>
              <div className={styles.avatarSection}>
                <div className={styles.avatarRing} style={selected.themeColor ? { borderColor: selected.themeColor } : undefined}>
                  {selected.avatarUrl ? (
                    <img src={selected.avatarUrl} alt={selected.displayName} className={styles.avatarImg} />
                  ) : (
                    <span className={styles.avatarEmoji}>
                      {ANIMAL_EMOJI[selected.animal?.toLowerCase()] || '\uD83D\uDC3E'}
                    </span>
                  )}
                </div>
                <span className={`${styles.statusBadge} ${selected.online ? styles.online : styles.offline}`}>
                  {selected.online ? 'ONLINE' : 'OFFLINE'}
                </span>
              </div>
              <div className={styles.headerInfo}>
                <h1 className={styles.profileName}>{selected.displayName}</h1>
                <div className={styles.meta}>
                  <span className={styles.animal}>
                    {ANIMAL_EMOJI[selected.animal?.toLowerCase()] || '\uD83D\uDC3E'} {selected.animal}
                  </span>
                  {selected.sex && <span className={styles.metaItem}>{selected.sex === 'male' ? '\u2642' : '\u2640'} {selected.sex}</span>}
                  {selected.role && <span className={styles.metaItem}>{selected.role}</span>}
                  {selected.birthdate && (
                    <span className={styles.metaItem}>
                      Born {new Date(selected.birthdate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Bio */}
            {selected.bio && <p className={styles.bio}>{selected.bio}</p>}

            {/* Interests */}
            {interests.length > 0 && (
              <div className={styles.interests}>
                {interests.map(tag => (
                  <span key={tag} className={styles.interestTag}>{tag}</span>
                ))}
              </div>
            )}

            {/* Details */}
            <div className={styles.details}>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Session</span>
                <span className={styles.detailValue}>{selected.sessionName}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Status</span>
                <span className={`${styles.detailValue} ${selected.online ? styles.textOnline : styles.textOffline}`}>
                  {selected.online ? 'Active in tmux' : 'No active session'}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className={styles.actions}>
              <Link to={`/beast/${selected.name}`} className={styles.actionButton}>
                Full Profile
              </Link>
              {!isGuest && (
                <Link to={`/terminal?beast=${selected.name}`} className={styles.actionButton}>
                  Terminal
                </Link>
              )}
              <Link to="/dms" className={styles.actionButton}>
                Direct Message
              </Link>
            </div>
          </div>
        ) : (
          <div className={styles.placeholder}>
            <span className={styles.placeholderIcon}>{'\uD83D\uDC3E'}</span>
            <p>Select a Beast to view their profile</p>
          </div>
        )}
      </div>
    </div>
  );
}

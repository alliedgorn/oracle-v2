import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import styles from './PackPage.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';

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
  const { openChat } = useChat();
  const [searchParams, setSearchParams] = useSearchParams();
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const [selected, setSelected] = useState<Beast | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const loadPack = useCallback(async () => {
    try {
      const res = await fetch(isGuest ? '/api/guest/pack' : `${API_BASE}/pack`);
      const data = await res.json();
      setBeasts(data.beasts || []);
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

  // Keep selected beast data fresh when beasts list updates
  useEffect(() => {
    if (!selected || beasts.length === 0) return;
    const updated = beasts.find(b => b.name === selected.name);
    if (updated && (updated.status !== selected.status || updated.online !== selected.online)) {
      setSelected(updated);
    }
  }, [beasts, selected]);

  function selectBeast(beast: Beast) {
    setSelected(beast);
    setSearchParams({ beast: beast.name }, { replace: true });
  }

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

  function getStatusClass(beast: Beast) {
    if (beast.status === 'processing') return styles.cardProcessing;
    if (beast.status === 'waiting') return styles.cardWaiting;
    if (!beast.online) return styles.cardOffline;
    return '';
  }

  function getDotClass(beast: Beast) {
    if (beast.status === 'processing') return styles.dotProcessing;
    if (beast.status === 'waiting') return styles.dotWaiting;
    if (beast.online) return styles.dotOnline;
    return styles.dotOffline;
  }

  return (
    <div className={styles.container}>
      {/* Guest Welcome Banner */}
      {isGuest && !bannerDismissed && (
        <div className={styles.guestBanner}>
          <span>Welcome to The Den{guestName ? `, ${guestName}` : ''}! You are visiting as a guest.</span>
          <button className={styles.guestBannerClose} onClick={() => setBannerDismissed(true)}>x</button>
        </div>
      )}

      {/* Main Layout */}
      <div className={styles.layout}>
        {/* Beast Card Grid */}
        <div className={styles.gridSection}>
          <h2 className={styles.title}>The Pack</h2>
          <div className={styles.beastGrid}>
            {beasts.map(beast => {
              const emoji = ANIMAL_EMOJI[beast.animal?.toLowerCase()] || '\uD83D\uDC3E';
              const isSelected = selected?.name === beast.name;
              return (
                <div
                  key={beast.name}
                  className={`${styles.card} ${isSelected ? styles.cardSelected : ''} ${getStatusClass(beast)}`}
                  style={beast.themeColor ? { '--beast-color': beast.themeColor } as React.CSSProperties : undefined}
                  onClick={() => selectBeast(beast)}
                >
                  {beast.status === 'processing' && <div className={styles.shimmerBar} />}
                  <div className={styles.cardAvatar}>
                    {beast.avatarUrl ? (
                      <img src={beast.avatarUrl} alt={beast.displayName} className={styles.cardAvatarImg} />
                    ) : (
                      <span className={styles.cardAvatarEmoji}>{emoji}</span>
                    )}
                    <span className={`${styles.cardDot} ${getDotClass(beast)}`} />
                  </div>
                  <div className={styles.cardName}>{beast.displayName}</div>
                  <div className={styles.cardAnimal}>{emoji} {beast.animal}</div>
                  {beast.role && <div className={styles.cardRole}>{beast.role}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Profile Detail Panel */}
        <div className={styles.profilePanel}>
          {selected ? (
            <div className={styles.profileContent}>
              {/* Hero */}
              <div className={styles.hero}>
                <div className={styles.heroAvatar} style={selected.themeColor ? { borderColor: selected.themeColor } : undefined}>
                  {selected.avatarUrl ? (
                    <img src={selected.avatarUrl} alt={selected.displayName} className={styles.heroAvatarImg} />
                  ) : (
                    <span className={styles.heroAvatarEmoji}>
                      {ANIMAL_EMOJI[selected.animal?.toLowerCase()] || '\uD83D\uDC3E'}
                    </span>
                  )}
                </div>
                <h1 className={styles.heroName}>{selected.displayName}</h1>
                <div className={styles.heroMeta}>
                  <span>{ANIMAL_EMOJI[selected.animal?.toLowerCase()] || '\uD83D\uDC3E'} {selected.animal}</span>
                  {selected.sex && <span>{selected.sex === 'male' ? '\u2642' : '\u2640'} {selected.sex}</span>}
                  {selected.role && <span>{selected.role}</span>}
                </div>
              </div>

              {/* Status Bar */}
              <div className={`${styles.statusBar} ${
                selected.status === 'processing' ? styles.statusBarProcessing :
                selected.status === 'waiting' ? styles.statusBarWaiting :
                selected.online ? styles.statusBarOnline : styles.statusBarOffline
              }`}>
                <span className={`${styles.statusBarDot} ${getDotClass(selected)}`} />
                <span>
                  {selected.status === 'processing' ? 'Processing' :
                   selected.status === 'waiting' ? 'Waiting for input' :
                   selected.status === 'idle' ? 'Idle' :
                   selected.status === 'shell' ? 'Shell' :
                   selected.online ? 'Online' : 'Offline'}
                </span>
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

              {/* Birthdate */}
              {selected.birthdate && (
                <div className={styles.birthdate}>
                  Born {new Date(selected.birthdate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </div>
              )}

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
                <button
                  className={styles.actionButton}
                  onClick={() => openChat(selected.name, selected.displayName)}
                >
                  Direct Message
                </button>
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
    </div>
  );
}

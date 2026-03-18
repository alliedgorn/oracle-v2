import styles from './BeastCard.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';

interface BeastCardProps {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  themeColor: string | null;
  role: string | null;
  status: 'processing' | 'idle' | 'shell' | 'offline' | 'online';
  online: boolean;
  selected?: boolean;
  badge?: string;
  onClick?: () => void;
  onNameClick?: (e: React.MouseEvent) => void;
}

export function BeastCard({
  name,
  displayName,
  animal,
  avatarUrl,
  themeColor,
  role,
  status,
  online,
  selected = false,
  badge,
  onClick,
  onNameClick,
}: BeastCardProps) {
  const isProcessing = status === 'processing';
  const isOffline = status === 'offline' || !online;
  const emoji = ANIMAL_EMOJI[animal?.toLowerCase()] || '🐾';

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isProcessing ? styles.processing : ''} ${isOffline ? styles.offline : ''}`}
      style={themeColor ? { '--beast-color': themeColor } as React.CSSProperties : undefined}
      onClick={onClick}
    >
      <div className={styles.avatarContainer}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={displayName} className={styles.avatar} />
        ) : (
          <span className={styles.emoji}>{emoji}</span>
        )}
        <span className={`${styles.statusDot} ${online ? styles.dotOnline : styles.dotOffline}`} />
      </div>
      <div className={styles.info}>
        {onNameClick ? (
          <a href={`/beast/${name}`} className={styles.name} onClick={onNameClick}>{displayName}</a>
        ) : (
          <span className={styles.name}>{displayName}</span>
        )}
        <div className={styles.role}>{role || animal}</div>
      </div>
      {badge && <span className={styles.badge}>{badge}</span>}
    </div>
  );
}

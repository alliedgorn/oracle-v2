import { memo } from 'react';
import styles from './BeastCard.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';

interface BeastCardProps {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  themeColor: string | null;
  role: string | null;
  status: 'processing' | 'idle' | 'waiting' | 'shell' | 'offline' | 'online';
  online: boolean;
  selected?: boolean;
  badge?: string;
  onClick?: () => void;

  onTerminalClick?: (e: React.MouseEvent) => void;
  onDmClick?: (e: React.MouseEvent) => void;
  onProfileClick?: (e: React.MouseEvent) => void;
  unreadCount?: number;
}

export const BeastCard = memo(function BeastCard({
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

  onTerminalClick,
  onDmClick,
  onProfileClick,
  unreadCount = 0,
}: BeastCardProps) {
  const isProcessing = status === 'processing';
  const isWaiting = status === 'waiting';
  const isOffline = status === 'offline' || !online;
  const emoji = ANIMAL_EMOJI[animal?.toLowerCase()] || '🐾';

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isProcessing ? styles.processing : ''} ${isWaiting ? styles.waiting : ''} ${isOffline ? styles.offline : ''}`}
      style={themeColor ? { '--beast-color': themeColor } as React.CSSProperties : undefined}
      onClick={onClick}
    >
      <div className={styles.avatarContainer}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={displayName} className={styles.avatar} />
        ) : (
          <span className={styles.emoji}>{emoji}</span>
        )}
        <span className={`${styles.statusDot} ${isWaiting ? styles.dotWaiting : online ? styles.dotOnline : styles.dotOffline}`} />
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{displayName}</span>
        <div className={styles.role}>{role || animal}</div>
      </div>
      {badge && <span className={styles.badge}>{badge}</span>}
      {(onProfileClick || onTerminalClick || onDmClick) && (
        <div className={styles.actions}>
          {onProfileClick && (
            <a href={`/beast/${name}`} className={styles.dmButton} title={`View ${displayName}'s profile`} onClick={onProfileClick}>👤</a>
          )}
          {onTerminalClick && (
            <button className={`${styles.dmButton} ${styles.terminalBtn}`} title={`Open ${displayName}'s terminal`} onClick={onTerminalClick}>&#9002;</button>
          )}
          {onDmClick && (
            <button className={styles.dmButton} title={`DM ${displayName}`} onClick={onDmClick}>
              💬
              {unreadCount > 0 && (
                <span className={styles.unreadBadge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

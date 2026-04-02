import { memo } from 'react';
import styles from './RemoteBeastCard.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';

interface RemoteBeastCardProps {
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
  unreadCount?: number;
  contextPct?: number | null;
}

export const RemoteBeastCard = memo(function RemoteBeastCard({
  name: _name,
  displayName,
  animal,
  avatarUrl,
  themeColor,
  status,
  online,
  selected = false,
  onClick,
  onTerminalClick,
  onDmClick,
  unreadCount = 0,
  contextPct,
}: RemoteBeastCardProps) {
  const isProcessing = status === 'processing';
  const isWaiting = status === 'waiting';
  const isOffline = status === 'offline' || !online;
  const emoji = ANIMAL_EMOJI[animal?.toLowerCase()] || '\uD83D\uDC3E';

  const statusLabel = isProcessing ? 'ACTIVE' : isWaiting ? 'WAITING' : status === 'idle' ? 'IDLE' : isOffline ? 'OFF' : '';

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isProcessing ? styles.processing : ''} ${isWaiting ? styles.waiting : ''} ${isOffline ? styles.offline : ''}`}
      style={themeColor ? { '--beast-color': themeColor } as React.CSSProperties : undefined}
      onClick={onClick}
    >
      {isProcessing && <div className={styles.shimmer} />}
      <div className={styles.avatar}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={displayName} className={styles.avatarImg} />
        ) : (
          <span className={styles.avatarEmoji}>{emoji}</span>
        )}
        <span className={`${styles.dot} ${
          isProcessing ? styles.dotActive :
          isWaiting ? styles.dotWaiting :
          online ? styles.dotOnline : styles.dotOffline
        }`} />
      </div>
      <div className={styles.info}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{displayName}</span>
          {contextPct != null && <span className={styles.pct}>{contextPct}%</span>}
        </div>
        <span className={`${styles.status} ${
          isProcessing ? styles.statusActive :
          isWaiting ? styles.statusWaiting :
          isOffline ? styles.statusOff : styles.statusIdle
        }`}>{statusLabel}</span>
      </div>
      <div className={styles.actions}>
        {onTerminalClick && (
          <button className={styles.btn} title="Terminal" onClick={onTerminalClick}>&#9002;</button>
        )}
        {onDmClick && (
          <button className={styles.btn} title="DM" onClick={onDmClick}>
            {'\uD83D\uDCAC'}
            {unreadCount > 0 && <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
        )}
      </div>
    </div>
  );
});

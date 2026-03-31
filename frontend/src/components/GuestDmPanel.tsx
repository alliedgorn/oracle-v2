import { useState, useEffect, useCallback } from 'react';
import { BeastCard } from './BeastCard';
import { useChat } from '../contexts/ChatContext';
import styles from './GuestDmPanel.module.css';

interface Beast {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  themeColor: string | null;
  role: string | null;
  online: boolean;
  status: 'processing' | 'idle' | 'waiting' | 'shell' | 'offline';
}

interface GuestDmPanelProps {
  isOpen: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function GuestDmPanel({ isOpen, onClose, collapsed = false, onToggleCollapse }: GuestDmPanelProps) {
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const { openChat } = useChat();

  const loadPack = useCallback(async () => {
    try {
      const res = await fetch('/api/guest/pack');
      const data = await res.json();
      setBeasts(data.beasts || []);
    } catch {}
  }, []);

  useEffect(() => {
    if (!collapsed) loadPack();
  }, [collapsed, loadPack]);

  useEffect(() => {
    if (collapsed) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadPack();
    }, 10000);
    return () => clearInterval(interval);
  }, [collapsed, loadPack]);

  return (
    <>
      {isOpen && <div className={styles.backdrop} onClick={onClose} />}
      <div className={`${styles.panel} ${collapsed ? styles.collapsed : ''} ${isOpen ? styles.mobileOpen : ''}`}>
        <div className={styles.panelInner}>
          {onToggleCollapse && (
            <button className={styles.collapseToggle} onClick={onToggleCollapse} title={collapsed ? 'Show DMs' : 'Hide DMs'}>
              {collapsed ? '\u25C2' : '\u25B8'}
            </button>
          )}
          <div className={styles.panelHeader}>
            <h3>Messages</h3>
            <button className={styles.closeBtn} onClick={onClose}>{'\u2715'}</button>
          </div>

          <div className={styles.beastList}>
            {beasts.map(beast => (
              <BeastCard
                key={beast.name}
                {...beast}
                onClick={() => openChat(beast.name, beast.displayName)}
                onDmClick={(e) => { e.stopPropagation(); openChat(beast.name, beast.displayName); }}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

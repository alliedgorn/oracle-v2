import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getGuestPack, getGuestDmConversation, sendGuestDm } from '../api/guest';
import { ANIMAL_EMOJI } from '../utils/animals';
import styles from './ChatOverlay.module.css';

interface Message {
  id: number;
  sender: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

interface GuestChatOverlayProps {
  beastName: string;
  displayName: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onClose: () => void;
}

const PAGE_SIZE = 30;

export function GuestChatOverlay({ beastName, displayName, collapsed, onToggleCollapse, onClose }: GuestChatOverlayProps) {
  const { guestName } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userSentRef = useRef(false);

  // Fetch beast avatar
  useEffect(() => {
    getGuestPack().then(d => {
      const beast = (d.beasts || []).find((b: any) => b.name === beastName);
      if (beast?.avatarUrl) setAvatarUrl(beast.avatarUrl);
    }).catch(() => {});
  }, [beastName]);

  const loadMessages = useCallback(async () => {
    if (!guestName) return;
    try {
      const data = await getGuestDmConversation(guestName, beastName, PAGE_SIZE);
      const msgs = (data.messages || []).reverse();
      setMessages(msgs);
    } catch {}
  }, [beastName, guestName]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Poll for new messages
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden || collapsed) return;
      loadMessages();
    }, 3000);
    return () => clearInterval(interval);
  }, [loadMessages, collapsed]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (userSentRef.current) {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      userSentRef.current = false;
    }
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!newMessage.trim()) return;
    setLoading(true);
    userSentRef.current = true;
    try {
      await sendGuestDm(beastName, newMessage);
      setNewMessage('');
      await loadMessages();
    } finally { setLoading(false); }
  }

  const emoji = ANIMAL_EMOJI[beastName] || '\uD83D\uDC3E';

  if (collapsed) {
    return (
      <div className={styles.overlay} style={{ height: 'auto' }}>
        <div className={styles.header} onClick={onToggleCollapse} style={{ cursor: 'pointer' }}>
          {avatarUrl && <img src={avatarUrl} alt={displayName} className={styles.headerAvatar} />}
          <span className={styles.headerName}>{displayName}</span>
          <div className={styles.headerActions}>
            <button className={styles.headerBtn} onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}>{'\u25B2'}</button>
            <button className={styles.headerBtn} onClick={(e) => { e.stopPropagation(); onClose(); }}>{'\u2715'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.header}>
        {avatarUrl && <img src={avatarUrl} alt={displayName} className={styles.headerAvatar} />}
        <span className={styles.headerName}>{displayName}</span>
        <div className={styles.headerActions}>
          <button className={styles.headerBtn} onClick={onToggleCollapse}>{'\u25BC'}</button>
          <button className={styles.headerBtn} onClick={onClose}>{'\u2715'}</button>
        </div>
      </div>

      <div className={styles.messages} ref={messagesContainerRef}>
        {messages.length === 0 && (
          <div className={styles.emptyState}>
            <span style={{ fontSize: 32 }}>{emoji}</span>
            <p>Start a conversation with {displayName}</p>
          </div>
        )}
        {messages.map(msg => {
          const isMe = msg.sender.includes('[Guest]') || msg.sender === guestName;
          return (
            <div key={msg.id} className={`${styles.message} ${isMe ? styles.sent : styles.received}`}>
              <div className={styles.bubble}>{msg.message}</div>
              <div className={styles.time}>
                {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={handleSend} className={styles.inputArea}>
        <input
          type="text"
          value={newMessage}
          onChange={e => setNewMessage(e.target.value)}
          placeholder={`Message ${displayName}...`}
          className={styles.chatInput}
          maxLength={2000}
        />
        <button type="submit" className={styles.sendBtn} disabled={loading || !newMessage.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

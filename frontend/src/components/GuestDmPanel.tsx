import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getGuestPack, sendGuestDm, getGuestDmConversation } from '../api/guest';
import { ANIMAL_EMOJI } from '../utils/animals';
import styles from './GuestDmPanel.module.css';

interface Beast {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl?: string | null;
  themeColor?: string | null;
  online?: boolean;
  status?: string;
}

interface Message {
  id: number;
  sender: string;
  content?: string;
  message?: string;
  created_at: string;
}

interface GuestDmPanelProps {
  isOpen: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function GuestDmPanel({ isOpen, onClose, collapsed = false, onToggleCollapse }: GuestDmPanelProps) {
  const { guestName } = useAuth();
  const [beasts, setBeasts] = useState<Beast[]>([]);
  const [selected, setSelected] = useState<Beast | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (collapsed) return;
    getGuestPack().then(data => setBeasts(data.beasts || [])).catch(() => {});
  }, [collapsed]);

  const loadMessages = useCallback(async (beastName: string) => {
    if (!guestName) return;
    try {
      const data = await getGuestDmConversation(guestName, beastName, 50, 0);
      setMessages(data.messages || []);
    } catch { /* ignore */ }
  }, [guestName]);

  useEffect(() => {
    if (!selected) return;
    loadMessages(selected.name);
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadMessages(selected.name);
    }, 5000);
    return () => clearInterval(interval);
  }, [selected, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !newMessage.trim() || sending) return;
    setSending(true);
    try {
      await sendGuestDm(selected.name, newMessage.trim());
      setNewMessage('');
      await loadMessages(selected.name);
    } catch { /* ignore */ }
    setSending(false);
  }

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
            <button className={styles.closeBtn} onClick={onClose}>\u2715</button>
          </div>

          {!selected ? (
            <div className={styles.beastList}>
              {beasts.map(beast => {
                const emoji = ANIMAL_EMOJI[beast.animal?.toLowerCase()] || '\uD83D\uDC3E';
                return (
                  <div
                    key={beast.name}
                    className={styles.beastItem}
                    style={beast.themeColor ? { '--beast-color': beast.themeColor } as React.CSSProperties : undefined}
                    onClick={() => setSelected(beast)}
                  >
                    <div className={styles.beastAvatar}>
                      {beast.avatarUrl ? (
                        <img src={beast.avatarUrl} alt={beast.displayName} className={styles.avatarImg} />
                      ) : (
                        <span className={styles.avatarEmoji}>{emoji}</span>
                      )}
                      <span className={`${styles.dot} ${beast.online ? styles.dotOnline : styles.dotOffline}`} />
                    </div>
                    <div className={styles.beastInfo}>
                      <span className={styles.beastName}>{beast.displayName}</span>
                    </div>
                    <span className={styles.dmIcon}>{'\uD83D\uDCAC'}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.chatView}>
              <button className={styles.backBtn} onClick={() => { setSelected(null); setMessages([]); }}>
                \u2190 Back
              </button>
              <div className={styles.chatHeader}>
                {selected.avatarUrl ? (
                  <img src={selected.avatarUrl} alt={selected.displayName} className={styles.chatAvatarImg} />
                ) : (
                  <span className={styles.chatAvatarEmoji}>
                    {ANIMAL_EMOJI[selected.animal?.toLowerCase()] || '\uD83D\uDC3E'}
                  </span>
                )}
                <span className={styles.chatName}>{selected.displayName}</span>
              </div>
              <div className={styles.messageList}>
                {messages.length === 0 && (
                  <div className={styles.emptyChat}>Start a conversation with {selected.displayName}</div>
                )}
                {messages.map(msg => {
                  const text = msg.content || msg.message || '';
                  const isMe = msg.sender.includes('[Guest]') || msg.sender === guestName;
                  return (
                    <div key={msg.id} className={`${styles.message} ${isMe ? styles.messageMe : styles.messageThem}`}>
                      <div className={styles.messageBubble}>{text}</div>
                      <div className={styles.messageTime}>
                        {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              <form className={styles.inputBar} onSubmit={handleSend}>
                <input
                  type="text"
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  placeholder={`Message ${selected.displayName}...`}
                  className={styles.input}
                  maxLength={2000}
                />
                <button type="submit" className={styles.sendBtn} disabled={sending || !newMessage.trim()}>
                  Send
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { autolinkIds } from '../utils/autolink';
import { FileUpload } from './FileUpload';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './ChatOverlay.module.css';

const API_BASE = '/api';
const PAGE_SIZE = 30;

interface Message {
  id: number;
  sender: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

interface ChatOverlayProps {
  beastName: string;
  displayName: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onClose: () => void;
}

// Stable references to prevent ReactMarkdown re-parsing
const remarkPluginsStable = [remarkGfm];
const mdComponentsStable = {
  img: ({ src, alt, ...props }: any) => (
    <img {...props} src={src} alt={alt || ''} className={styles.chatImg} />
  ),
};

// Memoized message component — only re-renders when content/read_at changes
const ChatMessage = memo(function ChatMessage({ msg, onImgClick }: {
  msg: Message;
  onImgClick: (src: string) => void;
}) {
  return (
    <div className={`${styles.message} ${msg.sender === 'gorn' ? styles.sent : styles.received}`}>
      <div className={styles.msgContent} onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'IMG') {
          const src = (target as HTMLImageElement).src;
          if (src) onImgClick(src);
        }
      }}>
        <ReactMarkdown
          remarkPlugins={remarkPluginsStable}
          components={mdComponentsStable}
        >{autolinkIds(msg.message)}</ReactMarkdown>
      </div>
      <span className={styles.msgTime}>
        {new Date(msg.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        {msg.sender === 'gorn' && (
          <span className={styles.readStatus}>{msg.read_at ? ' ✓✓' : ' ✓'}</span>
        )}
      </span>
    </div>
  );
}, (prev, next) => prev.msg.id === next.msg.id && prev.msg.read_at === next.msg.read_at && prev.msg.message === next.msg.message);

const EMOJI_GROUPS = [
  { label: 'Smileys', emojis: ['😊', '😂', '🤣', '😍', '🥰', '😘', '😎', '🤔', '😅', '😢', '😤', '🙄', '😴', '🤗', '😇', '🫡', '🫠'] },
  { label: 'Gestures', emojis: ['👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🤙', '👀', '🫶', '🦾'] },
  { label: 'Animals', emojis: ['🐺', '🐻', '🦁', '🐊', '🐴', '🦘', '🦝', '🦦', '🐦‍⬛', '🐙', '🦔', '🐍', '🦅', '🦉', '🦍', '🐘', '🦏', '🐋', '🦬', '🐂', '🦣', '🫎', '🦈'] },
  { label: 'Objects', emojis: ['🔥', '❤️', '⭐', '💯', '🎉', '🏆', '🚀', '💡', '⚡', '🎯', '🛡️', '⚠️', '✅', '❌', '🏋️', '🔨', '⚓', '🪨', '🗿', '🌋', '💣', '☄️', '🪐', '🥩', '🍖'] },
];

export function ChatOverlay({ beastName, displayName, collapsed, onToggleCollapse, onClose }: ChatOverlayProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(false);
  // Lock body scroll on mobile when overlay is expanded (prevents scroll bleed)
  useEffect(() => {
    if (collapsed) return;
    const isMobile = window.innerWidth <= 480;
    if (!isMobile) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [collapsed]);

  // Auto-scroll to newest message when expanding
  useEffect(() => {
    if (!collapsed) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView();
      });
    }
  }, [collapsed]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Fetch beast avatar
  useEffect(() => {
    fetch(`${API_BASE}/pack`).then(r => r.json()).then(data => {
      const beasts = Array.isArray(data) ? data : (data.beasts || data.pack || []);
      const beast = beasts.find((b: any) => b.name === beastName);
      if (beast?.avatarUrl) setAvatarUrl(beast.avatarUrl);
    }).catch(() => {});
  }, [beastName]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCountRef = useRef(0);
  const userSentRef = useRef(false);

  const wasNearBottomRef = useRef(true);

  function isNearBottom(): boolean {
    const el = messagesContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }

  // Mark messages as read
  const markAsRead = useCallback(async () => {
    try { await fetch(`${API_BASE}/dm/gorn/${beastName}/read`, { method: 'PATCH' }); } catch {}
  }, [beastName]);

  // Load latest messages (for initial load + polling)
  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/dm/gorn/${beastName}?limit=${PAGE_SIZE}&order=desc`);
      const data = await res.json();
      const msgs = (data.messages || []).reverse();
      setMessages(msgs);
      setHasMore((data.total || msgs.length) > msgs.length);
    } catch {}
  }, [beastName]);

  // Load older messages when scrolling to top
  const offsetRef = useRef(PAGE_SIZE);
  async function loadOlderMessages() {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    const el = messagesContainerRef.current;
    const prevScrollHeight = el?.scrollHeight || 0;
    try {
      const res = await fetch(`${API_BASE}/dm/gorn/${beastName}?limit=${PAGE_SIZE}&offset=${offsetRef.current}&order=desc`);
      const data = await res.json();
      const older = (data.messages || []).reverse();
      if (older.length === 0) {
        setHasMore(false);
      } else {
        offsetRef.current += older.length;
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const newOlder = older.filter((m: Message) => !existingIds.has(m.id));
          return [...newOlder, ...prev];
        });
        // Restore scroll position after prepending — double rAF to wait for React render + DOM paint
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
          });
        });
      }
    } catch {}
    setLoadingMore(false);
  }

  // Initial load — scroll to bottom + mark as read
  useEffect(() => {
    loadMessages().then(() => {
      setInitialLoad(false);
      markAsRead();
    });
    inputRef.current?.focus();
  }, [loadMessages]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!initialLoad && prevCountRef.current === 0 && messages.length > 0) {
      messagesEndRef.current?.scrollIntoView();
      prevCountRef.current = messages.length;
    }
  }, [initialLoad, messages]);

  // Auto-scroll on new messages only when near bottom or user just sent
  const lastMsgIdRef = useRef(0);
  useEffect(() => {
    if (initialLoad || messages.length === 0) return;
    const latestId = messages[messages.length - 1].id;
    if (latestId !== lastMsgIdRef.current) {
      // New message arrived
      if (userSentRef.current || wasNearBottomRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        userSentRef.current = false;
      }
      // Mark as read only when new messages appear from the beast
      const latestMsg = messages[messages.length - 1];
      if (latestMsg.sender !== 'gorn') markAsRead();
      lastMsgIdRef.current = latestId;
    }
    prevCountRef.current = messages.length;
  }, [messages, initialLoad]);

  // WebSocket: append new messages when DM arrives (no full reload)
  const appendNewMessages = useCallback(async () => {
    try {
      wasNearBottomRef.current = isNearBottom();
      // Mark as read immediately so badge clears fast
      markAsRead();
      const res = await fetch(`${API_BASE}/dm/gorn/${beastName}?limit=5&order=desc`);
      const data = await res.json();
      const latest = (data.messages || []).reverse();
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const newMsgs = latest.filter((m: Message) => !existingIds.has(m.id));
        if (newMsgs.length === 0) return prev;
        return [...prev, ...newMsgs];
      });
    } catch {}
  }, [beastName, markAsRead]);

  useWebSocket('new_dm', appendNewMessages);

  // Scroll detection: load-more at top + show scroll-down button
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    function handleScroll() {
      const distFromBottom = el!.scrollHeight - el!.scrollTop - el!.clientHeight;
      setShowScrollDown(distFromBottom > 200);
      if (el!.scrollTop < 50 && hasMore && !loadingMore) {
        if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = setTimeout(() => {
          if (el!.scrollTop < 50) loadOlderMessages();
        }, 500);
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, [hasMore, loadingMore, messages]);

  // Stable callback for image clicks (used by memoized ChatMessage)
  const handleImgClick = useCallback((src: string) => setLightboxSrc(src), []);

  // ESC closes lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!newMessage.trim()) return;
    setLoading(true);
    userSentRef.current = true;
    try {
      await fetch(`${API_BASE}/dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'gorn', to: beastName, message: newMessage }),
      });
      setNewMessage('');
      await loadMessages();
    } finally { setLoading(false); }
  }

  return (
    <div className={`${styles.overlay} ${collapsed ? styles.overlayCollapsed : ''}`}>
      <div className={styles.header} onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        const wasCollapsed = collapsed;
        onToggleCollapse();
        if (wasCollapsed) {
          // Allow DOM to render messages before scrolling
          requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView();
          });
        }
      }} style={{ cursor: 'pointer' }}>
        {avatarUrl && <img src={avatarUrl} alt={displayName} className={styles.headerAvatar} />}
        <span className={styles.title}>Chat with {displayName}</span>
        <button className={styles.closeBtn} onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
      </div>
      {!collapsed && (
        <>
          <div className={styles.messages} ref={messagesContainerRef}>
            {loadingMore && <div className={styles.loadingMore}>Loading older messages...</div>}
            {!hasMore && messages.length > 0 && <div className={styles.loadingMore}>Beginning of conversation</div>}
            {messages.length === 0 && !initialLoad && (
              <div className={styles.empty}>No messages yet. Say hello!</div>
            )}
            {messages.map(msg => (
              <ChatMessage key={msg.id} msg={msg} onImgClick={handleImgClick} />
            ))}
            <div ref={messagesEndRef} />
          </div>
          {showScrollDown && (
            <button
              className={styles.scrollDownBtn}
              onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
              title="Scroll to newest"
            >↓</button>
          )}
          <form onSubmit={handleSend} className={styles.inputArea}>
            {showEmoji && (
              <div className={styles.emojiPicker}>
                {EMOJI_GROUPS.map(group => (
                  <div key={group.label} className={styles.emojiGroup}>
                    <div className={styles.emojiGroupLabel}>{group.label}</div>
                    <div className={styles.emojiGrid}>
                      {group.emojis.map(emoji => (
                        <button
                          key={emoji}
                          type="button"
                          className={styles.emojiBtn}
                          onClick={() => {
                            setNewMessage(prev => prev + emoji);
                            inputRef.current?.focus();
                          }}
                        >{emoji}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.inputRow}>
              <FileUpload onUploadComplete={(md) => setNewMessage(prev => prev ? `${prev}\n${md}` : md)} />
              <button type="button" className={styles.emojiToggle} onClick={() => setShowEmoji(!showEmoji)} title="Emoji">
                😊
              </button>
              <textarea
                ref={inputRef}
                value={newMessage}
                onChange={e => setNewMessage(e.target.value)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                placeholder={`Message ${displayName}...`}
                className={styles.input}
                rows={2}
              />
              <button type="submit" className={styles.sendBtn} disabled={loading || !newMessage.trim()}>
                {loading ? '...' : 'Send'}
              </button>
            </div>
          </form>
        </>
      )}

      {lightboxSrc && (
        <div className={styles.lightbox} onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="Full size" className={styles.lightboxImg} onClick={(e) => e.stopPropagation()} />
          <button className={styles.lightboxClose} onClick={() => setLightboxSrc(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

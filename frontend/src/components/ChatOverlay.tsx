import { useState, useEffect, useRef, useCallback } from 'react';
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
  content: string;
  read_at: string | null;
  created_at: string;
}

interface ChatOverlayProps {
  beastName: string;
  displayName: string;
  onClose: () => void;
}

export function ChatOverlay({ beastName, displayName, onClose }: ChatOverlayProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
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
        // Restore scroll position after prepending
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
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

  // WebSocket: reload messages when new DM arrives (replaces polling)
  useWebSocket('new_dm', useCallback(() => {
    wasNearBottomRef.current = isNearBottom();
    loadMessages();
  }, [loadMessages]));

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

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.header}>
        <span className={styles.title}>Chat with {displayName}</span>
        <button className={styles.closeBtn} onClick={onClose}>✕</button>
      </div>
      <div className={styles.messages} ref={messagesContainerRef}>
        {loadingMore && <div className={styles.loadingMore}>Loading older messages...</div>}
        {!hasMore && messages.length > 0 && <div className={styles.loadingMore}>Beginning of conversation</div>}
        {messages.length === 0 && !initialLoad && (
          <div className={styles.empty}>No messages yet. Say hello!</div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`${styles.message} ${msg.sender === 'gorn' ? styles.sent : styles.received}`}>
            <div className={styles.msgContent}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{autolinkIds(msg.content)}</ReactMarkdown>
            </div>
            <span className={styles.msgTime}>
              {formatTime(msg.created_at)}
              {msg.sender === 'gorn' && (
                <span className={styles.readStatus}>{msg.read_at ? ' ✓✓' : ' ✓'}</span>
              )}
            </span>
          </div>
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
        <div className={styles.inputRow}>
          <FileUpload onUploadComplete={(md) => setNewMessage(prev => prev ? `${prev}\n${md}` : md)} />
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
    </div>
  );
}

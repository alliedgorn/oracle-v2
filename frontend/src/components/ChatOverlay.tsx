import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { autolinkIds } from '../utils/autolink';
import { ImageUpload } from './ImageUpload';
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCountRef = useRef(0);
  const userSentRef = useRef(false);

  function isNearBottom(): boolean {
    const el = messagesContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
      markAsRead();
    } catch {}
  }, [beastName, markAsRead]);

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

  // Initial load — scroll to bottom
  useEffect(() => {
    loadMessages().then(() => {
      setInitialLoad(false);
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
  useEffect(() => {
    if (initialLoad) return;
    const newCount = messages.length;
    if (newCount > prevCountRef.current && prevCountRef.current > 0) {
      if (userSentRef.current || isNearBottom()) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        userSentRef.current = false;
      }
    }
    prevCountRef.current = newCount;
  }, [messages, initialLoad]);

  // Poll for new messages
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      // Only poll latest — don't reset if user loaded older messages
      (async () => {
        try {
          const res = await fetch(`${API_BASE}/dm/gorn/${beastName}?limit=${PAGE_SIZE}&order=desc`);
          const data = await res.json();
          const latest = (data.messages || []).reverse();
          if (latest.length > 0) {
            setMessages(prev => {
              // Merge: keep older messages that aren't in the latest batch
              const latestIds = new Set(latest.map((m: Message) => m.id));
              const older = prev.filter(m => !latestIds.has(m.id) && m.id < latest[0].id);
              return [...older, ...latest];
            });
          }
        } catch {}
      })();
    }, 3000);
    return () => clearInterval(interval);
  }, [beastName]);

  // Scroll-to-top detection for loading more (with 0.5s delay)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    function handleScroll() {
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
      <form onSubmit={handleSend} className={styles.inputArea}>
        <div className={styles.inputRow}>
          <ImageUpload onUploadComplete={(md) => setNewMessage(prev => prev ? `${prev}\n${md}` : md)} />
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

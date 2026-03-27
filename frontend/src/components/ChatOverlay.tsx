import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { autolinkIds } from '../utils/autolink';
import { ImageUpload } from './ImageUpload';
import styles from './ChatOverlay.module.css';

const API_BASE = '/api';

interface Message {
  id: number;
  sender: string;
  content: string;
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

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/dm/gorn/${beastName}?limit=50&order=desc`);
      const data = await res.json();
      const msgs = (data.messages || []).reverse();
      setMessages(msgs);
    } catch {}
  }, [beastName]);

  useEffect(() => {
    loadMessages();
    inputRef.current?.focus();
  }, [loadMessages]);

  // Only auto-scroll when new messages arrive AND user is near bottom (or just sent a message)
  useEffect(() => {
    const newCount = messages.length;
    if (newCount > prevCountRef.current) {
      if (userSentRef.current || isNearBottom()) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        userSentRef.current = false;
      }
    }
    prevCountRef.current = newCount;
  }, [messages]);

  // Poll for new messages
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadMessages();
    }, 3000);
    return () => clearInterval(interval);
  }, [loadMessages]);

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
        {messages.length === 0 && (
          <div className={styles.empty}>No messages yet. Say hello!</div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`${styles.message} ${msg.sender === 'gorn' ? styles.sent : styles.received}`}>
            <div className={styles.msgContent}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{autolinkIds(msg.content)}</ReactMarkdown>
            </div>
            <span className={styles.msgTime}>{formatTime(msg.created_at)}</span>
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

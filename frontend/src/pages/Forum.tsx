import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './Forum.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';
import { ImageUpload } from '../components/ImageUpload';
import { SearchInput } from '../components/SearchInput';
import { StatusBadge } from '../components/StatusBadge';
import { FilterTabs } from '../components/FilterTabs';

interface BeastProfile {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl: string | null;
  themeColor: string | null;
}

const FALLBACK_MAP: Record<string, { name: string; emoji: string }> = {
  karo: { name: 'Karo', emoji: '🐾' },
  'gorn-oracle': { name: 'Zaghnal', emoji: '🐴' },
  zaghnal: { name: 'Zaghnal', emoji: '🐴' },
  gnarl: { name: 'Gnarl', emoji: '🐊' },
  bertus: { name: 'Bertus', emoji: '🐻' },
  mara: { name: 'Mara', emoji: '🦘' },
  leonard: { name: 'Leonard', emoji: '🦁' },
  rax: { name: 'Rax', emoji: '🦝' },
  pip: { name: 'Pip', emoji: '🦦' },
  nyx: { name: 'Nyx', emoji: '🐦‍⬛' },
  dex: { name: 'Dex', emoji: '🐙' },
};

function resolveAuthor(
  role: string,
  author: string | null,
  profiles: Map<string, BeastProfile>
): { name: string; emoji: string; avatarUrl: string | null; themeColor: string | null } {
  // Check author field first — role alone is unreliable (Beasts post with role: human)
  if (author) {
    const authorLower = author.toLowerCase();

    // Match against beast profiles from DB
    for (const [key, profile] of profiles) {
      if (authorLower.includes(key)) {
        return {
          name: profile.displayName,
          emoji: ANIMAL_EMOJI[profile.animal.toLowerCase()] || '🐾',
          avatarUrl: profile.avatarUrl,
          themeColor: profile.themeColor,
        };
      }
    }

    // Fallback to static map
    for (const [key, identity] of Object.entries(FALLBACK_MAP)) {
      if (authorLower.includes(key)) return { ...identity, avatarUrl: null, themeColor: null };
    }
  }

  // No author or unrecognized author — fall back to role
  if (role === 'human') return { name: 'Gorn', emoji: '👤', avatarUrl: null, themeColor: null };
  if (!author) return {
    name: role === 'oracle' ? 'Oracle' : 'Claude',
    emoji: role === 'oracle' ? '🔮' : '🤖',
    avatarUrl: null, themeColor: null,
  };

  const shortAuthor = author.split('@')[0] || author;
  return { name: shortAuthor, emoji: role === 'oracle' ? '🔮' : '🤖', avatarUrl: null, themeColor: null };
}

interface Thread {
  id: number;
  title: string;
  status: 'active' | 'answered' | 'pending' | 'closed';
  category: string;
  pinned: boolean;
  message_count: number;
  created_at: string;
  issue_url: string | null;
}

interface Message {
  id: number;
  role: 'human' | 'oracle' | 'claude';
  content: string;
  author: string | null;
  reply_to_id: number | null;
  principles_found: number | null;
  patterns_found: number | null;
  reactions?: { emoji: string; beasts: string[]; count: number }[];
  created_at: string;
}

interface ThreadDetail {
  thread: {
    id: number;
    title: string;
    status: string;
    created_at: string;
    issue_url: string | null;
  };
  messages: Message[];
}

const API_BASE = '/api';

async function fetchThreads(): Promise<{ threads: Thread[]; total: number }> {
  const res = await fetch(`${API_BASE}/threads`);
  return res.json();
}

async function fetchThread(id: number, limit?: number, offset = 0, order: 'asc' | 'desc' = 'desc'): Promise<ThreadDetail & { total: number }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit.toString());
  if (offset) params.set('offset', offset.toString());
  if (order === 'asc') params.set('order', 'asc');
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/thread/${id}${qs ? '?' + qs : ''}`);
  return res.json();
}

async function sendMessage(message: string, threadId?: number, title?: string, replyToId?: number): Promise<any> {
  const res = await fetch(`${API_BASE}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, thread_id: threadId, title, reply_to_id: replyToId })
  });
  return res.json();
}

async function updateThreadStatus(threadId: number, status: string): Promise<any> {
  const res = await fetch(`${API_BASE}/thread/${threadId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  return res.json();
}

export function Forum() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<ThreadDetail | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [beastProfiles, setBeastProfiles] = useState<Map<string, BeastProfile>>(new Map());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ messages: any[]; threads: any[] } | null>(null);
  const [reactions, setReactions] = useState<Record<number, { emoji: string; beasts: string[]; count: number }[]>>({});
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [replyTo, setReplyTo] = useState<{ id: number; author: string | null; content: string } | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});
  const [totalMessages, setTotalMessages] = useState(0);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  const PAGE_SIZE = 50;
  const threadIdParam = searchParams.get('thread');
  const showNewThread = searchParams.get('new') === 'true';

  // ESC key closes lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  // Load unread counts for gorn
  async function loadUnreadCounts() {
    try {
      const res = await fetch(`${API_BASE}/forum/unread/gorn`);
      const data = await res.json();
      const counts: Record<number, number> = {};
      for (const t of data.threads || []) {
        counts[t.thread_id] = t.unread_count;
      }
      setUnreadCounts(counts);
    } catch { /* ignore */ }
  }

  // Mark thread as read for gorn
  async function markThreadRead(threadId: number, lastMessageId: number) {
    try {
      await fetch(`${API_BASE}/forum/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: 'gorn', threadId, messageId: lastMessageId }),
      });
      setUnreadCounts(prev => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    } catch { /* ignore */ }
  }

  // Load beast profiles
  useEffect(() => {
    fetch(`${API_BASE}/beasts`)
      .then(res => res.json())
      .then(data => {
        const map = new Map<string, BeastProfile>();
        for (const b of data.beasts || []) {
          map.set(b.name, b);
        }
        setBeastProfiles(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadThreads();
    loadUnreadCounts();
  }, []);

  // Load thread from URL param or auto-select first
  // Only react to threadIdParam changes (user navigation), NOT threads polling
  const threadsLoadedRef = useRef(false);
  useEffect(() => {
    if (threadIdParam) {
      // Only fetch if thread changed (not on every threads poll)
      if (!selectedThread || selectedThread.thread.id !== parseInt(threadIdParam, 10)) {
        selectThread(parseInt(threadIdParam, 10));
      }
    } else if (threads.length > 0 && !showNewThread && !threadsLoadedRef.current) {
      // Auto-select first thread only on initial load
      threadsLoadedRef.current = true;
      setSearchParams({ thread: threads[0].id.toString() });
    } else if (threads.length === 0) {
      setSelectedThread(null);
    }
  }, [threadIdParam, threads]);

  // Poll for new messages (only fetch latest few, append if new) and threads
  useEffect(() => {
    const pollMessages = setInterval(() => {
      if (document.hidden) return;
      if (selectedThread) {
        fetchThread(selectedThread.thread.id, 5, 0, 'desc').then(data => {
          // Dedup inside functional updater to use latest state
          setSelectedThread(prev => {
            if (!prev) return prev;
            const existingIds = new Set(prev.messages.map(m => m.id));
            const newMsgs = data.messages.filter(m => !existingIds.has(m.id)).reverse();
            if (newMsgs.length === 0) return prev;
            loadReactionsForThread(newMsgs);
            return { ...prev, messages: [...prev.messages, ...newMsgs] };
          });
          setTotalMessages(data.total);
        }).catch(() => {});
      }
    }, 3000);

    const pollThreads = setInterval(() => {
      if (document.hidden) return;
      loadThreads();
      loadUnreadCounts();
    }, 10000);

    return () => {
      clearInterval(pollMessages);
      clearInterval(pollThreads);
    };
  }, [selectedThread?.thread.id, totalMessages]);

  // Auto-scroll to bottom on initial thread load, or when user is near bottom and new messages arrive
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !messagesEndRef.current) return;

    if (!initialScrollDone.current) {
      // First load — jump to bottom immediately
      messagesEndRef.current.scrollIntoView();
      initialScrollDone.current = true;
    } else {
      // Only auto-scroll if user is near the bottom (within 150px)
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom < 150) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [selectedThread?.messages.length]);

  // Real-time WebSocket updates — fetch only new messages, append
  const handleWsMessage = useCallback((data: any) => {
    if (selectedThread && data.thread_id === selectedThread.thread.id) {
      fetchThread(selectedThread.thread.id, 5, 0, 'desc').then(d => {
        setSelectedThread(prev => {
          if (!prev) return prev;
          const existingIds = new Set(prev.messages.map(m => m.id));
          const newMsgs = d.messages.filter(m => !existingIds.has(m.id)).reverse();
          if (newMsgs.length === 0) return prev;
          loadReactionsForThread(newMsgs);
          return { ...prev, messages: [...prev.messages, ...newMsgs] };
        });
        setTotalMessages(d.total);
      }).catch(() => {});
    }
    fetchThreads().then(d => setThreads(d.threads)).catch(() => {});
  }, [selectedThread?.thread.id]);

  useWebSocket('new_message', handleWsMessage);

  // Real-time reaction updates
  const handleWsReaction = useCallback((data: any) => {
    if (!data.message_id) return;
    // Refresh reactions for the affected message
    fetch(`${API_BASE}/message/${data.message_id}/reactions`)
      .then(r => r.json())
      .then(d => {
        setReactions(prev => ({ ...prev, [data.message_id]: d.reactions || [] }));
      })
      .catch(() => {});
  }, []);

  useWebSocket('reaction', handleWsReaction);

  // Infinite scroll — load older messages when scrolling up
  const hasMore = selectedThread ? selectedThread.messages.length < totalMessages : false;

  const loadOlderMessages = useCallback(async () => {
    if (!selectedThread) return;
    const currentCount = selectedThread.messages.length;
    const data = await fetchThread(selectedThread.thread.id, PAGE_SIZE, currentCount, 'desc');
    if (data.messages.length > 0) {
      data.messages.reverse();
      setSelectedThread(prev => prev ? {
        ...prev,
        messages: [...data.messages, ...prev.messages],
      } : prev);
      loadReactionsForThread(data.messages);
    }
  }, [selectedThread?.thread.id, selectedThread?.messages.length]);

  const { isLoadingMore } = useInfiniteScroll({
    containerRef: messagesContainerRef,
    hasMore,
    loading: loading,
    onLoadMore: loadOlderMessages,
  });


  async function loadThreads() {
    const data = await fetchThreads();
    setThreads(data.threads);
  }

  async function selectThread(id: number) {
    initialScrollDone.current = false;
    // Load latest messages (desc), then reverse for chronological display
    const data = await fetchThread(id, PAGE_SIZE, 0, 'desc');
    data.messages.reverse();
    setSelectedThread(data);
    setTotalMessages(data.total);
    setSearchParams({ thread: id.toString() });
    // Set reactions synchronously from inline data to prevent flash of empty reactions
    const inlineReactions: Record<number, any[]> = {};
    for (const m of data.messages) {
      if (m.reactions !== undefined) inlineReactions[m.id] = m.reactions;
    }
    setReactions(inlineReactions);
    loadReactionsForThread(data.messages);
    // Mark as read for gorn
    if (data.messages.length > 0) {
      markThreadRead(id, data.messages[data.messages.length - 1].id);
    }
  }

  function openNewThread() {
    setSearchParams({ new: 'true' });
    setSelectedThread(null);
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!newMessage.trim()) return;

    setLoading(true);
    try {
      if (selectedThread) {
        const result = await sendMessage(newMessage, selectedThread.thread.id, undefined, replyTo?.id);
        // Append the new message locally instead of re-fetching (avoids WebSocket duplicate)
        if (result.message_id) {
          const newMsg = {
            id: result.message_id,
            role: 'human' as const,
            content: newMessage,
            author: 'gorn',
            reply_to_id: replyTo?.id || null,
            principles_found: null,
            patterns_found: null,
            created_at: new Date().toISOString(),
          };
          setSelectedThread(prev => prev ? {
            ...prev,
            messages: [...prev.messages, newMsg],
          } : prev);
          setTotalMessages(prev => prev + 1);
        }
      } else if (showNewThread) {
        // Create new thread
        const result = await sendMessage(newMessage, undefined, newTitle || undefined);
        await loadThreads();
        setSearchParams({ thread: result.thread_id.toString() });
      }
      setNewMessage('');
      setNewTitle('');
      setReplyTo(null);
    } finally {
      setLoading(false);
    }
  }

  // Status color logic moved to shared StatusBadge component

  async function handleToggleThread() {
    if (!selectedThread) return;
    const newStatus = selectedThread.thread.status === 'closed' ? 'active' : 'closed';
    try {
      const result = await updateThreadStatus(selectedThread.thread.id, newStatus);
      console.log('Status update:', result);
      const data = await fetchThread(selectedThread.thread.id);
      data.messages.reverse();
      setSelectedThread(data);
      await loadThreads();
    } catch (err) {
      console.error('Failed to update thread:', err);
    }
  }

  function formatTime(iso: string) {
    const date = new Date(iso);
    return date.toLocaleString();
  }

  async function loadReactionsForThread(messages: { id: number; reactions?: any[] }[]) {
    // Use inline reactions from thread response if available
    const map: Record<number, any[]> = {};
    const needsFetch: { id: number }[] = [];

    for (const m of messages) {
      if (m.reactions !== undefined) {
        // Always set — empty array means reactions were removed
        map[m.id] = m.reactions;
      } else {
        needsFetch.push(m);
      }
    }

    // Fetch individually only for messages without inline reactions
    await Promise.all(needsFetch.map(async (m) => {
      try {
        const res = await fetch(`${API_BASE}/message/${m.id}/reactions`);
        const data = await res.json();
        map[m.id] = data.reactions || [];
      } catch { /* ignore */ }
    }));

    // Merge with existing reactions
    setReactions(prev => ({ ...prev, ...map }));
  }

  async function toggleReaction(messageId: number, emoji: string) {
    const existing = reactions[messageId] || [];
    const myReaction = existing.find(r => r.emoji === emoji && r.beasts.includes('gorn'));
    if (myReaction) {
      await fetch(`${API_BASE}/message/${messageId}/react`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: 'gorn', emoji }),
      });
    } else {
      await fetch(`${API_BASE}/message/${messageId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: 'gorn', emoji }),
      });
    }
    // Reload reactions for this message
    try {
      const res = await fetch(`${API_BASE}/message/${messageId}/reactions`);
      const data = await res.json();
      setReactions(prev => ({ ...prev, [messageId]: data.reactions || [] }));
    } catch { /* ignore */ }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const res = await fetch(`${API_BASE}/forum/search?q=${encodeURIComponent(searchQuery)}`);
    const data = await res.json();
    setSearchResults({ messages: data.messages, threads: data.threads });
  }

  function clearSearch() {
    setSearchQuery('');
    setSearchResults(null);
  }

  return (
    <div className={styles.container}>
      {/* Sidebar: Thread List — hidden on mobile when thread is selected */}
      <div className={`${styles.sidebar} ${selectedThread ? styles.hidden : ''}`}>
        <div className={styles.sidebarHeader}>
          <h2>Threads</h2>
          <button
            className={styles.newButton}
            onClick={openNewThread}
          >
            + New
          </button>
        </div>

        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search forum..."
          onSubmit={handleSearch}
          onClear={clearSearch}
          showClear={!!searchResults}
        />

        {searchResults && (
          <div className={styles.searchResults}>
            <div className={styles.searchCount}>
              {searchResults.threads.length} threads, {searchResults.messages.length} messages
            </div>
            {searchResults.threads.map((t: any) => (
              <div
                key={`t-${t.id}`}
                className={styles.searchItem}
                onClick={() => { setSearchParams({ thread: t.id.toString() }); clearSearch(); }}
              >
                <span className={styles.searchLabel}>Thread</span>
                <span className={styles.searchTitle}>{t.title}</span>
              </div>
            ))}
            {searchResults.messages.map((m: any) => (
              <div
                key={`m-${m.id}`}
                className={styles.searchItem}
                onClick={() => { setSearchParams({ thread: m.thread_id.toString() }); clearSearch(); }}
              >
                <span className={styles.searchLabel}>Msg</span>
                <span className={styles.searchTitle}>{m.content.slice(0, 80)}...</span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.filterWrapper}>
          <FilterTabs
            items={[
              { id: 'all', label: 'All' },
              { id: 'announcement', label: 'Announcement' },
              { id: 'task', label: 'Task' },
              { id: 'discussion', label: 'Discussion' },
              { id: 'decision', label: 'Decision' },
              { id: 'question', label: 'Question' },
            ]}
            activeId={categoryFilter}
            onChange={setCategoryFilter}
            variant="compact"
          />
        </div>

        <div className={styles.threadList}>
          {threads
            .filter(t => categoryFilter === 'all' || t.category === categoryFilter)
            .map(thread => (
            <div
              key={thread.id}
              className={`${styles.threadItem} ${selectedThread?.thread.id === thread.id ? styles.active : ''} ${thread.pinned ? styles.pinnedThread : ''}`}
              onClick={() => setSearchParams({ thread: thread.id.toString() })}
            >
              <div className={styles.threadTitle}>
                {thread.pinned && <span className={styles.pinIcon} title="Pinned">📌 </span>}
                <span className={styles.threadId}>#{thread.id}</span> {thread.title}
                {unreadCounts[thread.id] > 0 && (
                  <span className={styles.unreadBadge}>{unreadCounts[thread.id]}</span>
                )}
              </div>
              <div className={styles.threadMeta}>
                <span className={styles.categoryBadge}>{thread.category || 'discussion'}</span>
                <StatusBadge status={thread.status} />
                <span className={styles.count}>{thread.message_count} msgs</span>
              </div>
            </div>
          ))}

          {threads.length === 0 && (
            <div className={styles.empty}>No threads yet</div>
          )}
        </div>
      </div>

      {/* Main: Thread Detail or New Thread — full screen on mobile */}
      <div className={`${styles.main} ${selectedThread ? styles.fullScreen : ''}`}>
        {showNewThread && !selectedThread && (
          <div className={styles.newThread}>
            <h2>New Thread</h2>
            <form onSubmit={handleSendMessage} className={styles.form}>
              <input
                type="text"
                placeholder="Title"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                className={styles.input}
              />
              <textarea
                placeholder="What's on your mind? (⌘+Enter to send)"
                value={newMessage}
                onChange={e => setNewMessage(e.target.value)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                className={styles.textarea}
                rows={8}
              />
              <button
                type="submit"
                disabled={loading || !newMessage.trim()}
                className={styles.submitButton}
              >
                {loading ? 'Posting...' : 'Post'}
              </button>
            </form>
          </div>
        )}

        {selectedThread && (
          <div className={styles.threadDetail}>
            <button className={styles.mobileBack} onClick={() => { setSelectedThread(null); setSearchParams({}); }}>← Threads</button>
            <div className={styles.threadHeader}>
              <h2><span className={styles.threadIdHeader}>#{selectedThread.thread.id}</span> {selectedThread.thread.title}</h2>
              <div className={styles.threadActions}>
                <StatusBadge status={selectedThread.thread.status} />
                <button
                  onClick={handleToggleThread}
                  className={styles.closeButton}
                >
                  {selectedThread.thread.status === 'closed' ? 'Reopen' : 'Close'}
                </button>
              </div>
            </div>

            <div className={styles.messages} ref={messagesContainerRef}>
              {isLoadingMore && (
                <div style={{ textAlign: 'center', padding: '8px', opacity: 0.6, fontSize: '0.85em' }}>Loading older messages...</div>
              )}
              {hasMore && !isLoadingMore && (
                <div style={{ textAlign: 'center', padding: '8px', opacity: 0.4, fontSize: '0.8em' }}>↑ Scroll up for older messages</div>
              )}
              {selectedThread.messages.map(msg => {
                const identity = resolveAuthor(msg.role, msg.author, beastProfiles);
                return (
                <div
                  key={msg.id}
                  className={`${styles.message} ${styles[msg.role]}`}
                  style={identity.themeColor ? { borderLeftColor: identity.themeColor } : undefined}
                >
                  <div className={styles.messageHeader}>
                    <span className={styles.role}>
                      {identity.avatarUrl ? (
                        <img src={identity.avatarUrl} alt={identity.name} className={styles.avatar} />
                      ) : (
                        <span className={styles.avatarEmoji}>{identity.emoji}</span>
                      )}
                      {identity.name}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className={styles.messageId}>#{msg.id}</span>
                      <span className={styles.time} title={msg.created_at}>{formatTime(msg.created_at)}</span>
                    </span>
                  </div>
                  {msg.reply_to_id && (() => {
                    const quoted = selectedThread.messages.find(m => m.id === msg.reply_to_id);
                    return quoted ? (
                      <div className={styles.inlineQuote}>
                        <span className={styles.inlineQuoteAuthor}>{quoted.author || 'message'}:</span>
                        {quoted.content.slice(0, 120)}{quoted.content.length > 120 ? '...' : ''}
                      </div>
                    ) : null;
                  })()}
                  <div className={styles.messageContent}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code({ className, children, ...props }) {
                          const match = /language-(\w+)/.exec(className || '');
                          const inline = !match && !String(children).includes('\n');
                          return inline ? (
                            <code className={className} {...props}>{children}</code>
                          ) : (
                            <SyntaxHighlighter
                              style={oneDark}
                              language={match?.[1] || 'text'}
                              PreTag="div"
                              customStyle={{ margin: '12px 0', borderRadius: '8px', fontSize: '0.85em' }}
                            >
                              {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                          );
                        },
                        img({ src, alt }) {
                          return (
                            <img
                              src={src}
                              alt={alt || ''}
                              style={{ cursor: 'pointer' }}
                              onClick={(e) => { e.stopPropagation(); if (src) setLightboxSrc(src); }}
                            />
                          );
                        },
                        a({ href, children }) {
                          const isImage = href && /\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i.test(href);
                          if (isImage) {
                            return (
                              <img
                                src={href}
                                alt={String(children) || ''}
                                style={{ cursor: 'pointer' }}
                                onClick={(e) => { e.stopPropagation(); if (href) setLightboxSrc(href); }}
                              />
                            );
                          }
                          return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
                        },
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                  {msg.patterns_found !== null && msg.patterns_found > 0 && (
                    <div className={styles.messageMeta}>
                      Found {msg.patterns_found} patterns
                    </div>
                  )}
                  <div className={styles.reactionBar}>
                    {(reactions[msg.id] || []).map(r => (
                      <button
                        key={r.emoji}
                        className={`${styles.reactionBtn} ${r.beasts.includes('gorn') ? styles.reactionActive : ''}`}
                        onClick={() => toggleReaction(msg.id, r.emoji)}
                        title={r.beasts.join(', ')}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                    <button
                      className={styles.addReaction}
                      onClick={() => toggleReaction(msg.id, '👍')}
                      title="React"
                    >+</button>
                    <button
                      className={styles.replyBtn}
                      onClick={() => {
                        setReplyTo({ id: msg.id, author: msg.author, content: msg.content });
                        const quote = `> **${msg.author || 'message'}**: ${msg.content.split('\n')[0].slice(0, 80)}\n\n`;
                        setNewMessage(quote);
                      }}
                      title="Reply to this message"
                    >↩ Reply</button>
                  </div>
                </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={handleSendMessage} className={styles.replyForm}>
              {replyTo && (
                <div className={styles.quotePreview}>
                  <span className={styles.quoteLabel}>Replying to {replyTo.author || 'message'}</span>
                  <span className={styles.quoteText}>{replyTo.content.slice(0, 100)}{replyTo.content.length > 100 ? '...' : ''}</span>
                  <button type="button" className={styles.quoteClear} onClick={() => setReplyTo(null)}>✕</button>
                </div>
              )}
              <div className={styles.replyInputRow}>
                <textarea
                  placeholder={replyTo ? `Reply to ${replyTo.author || 'message'}...` : 'Continue the discussion... (⌘+Enter to send)'}
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                  className={styles.textarea}
                  rows={3}
                />
                <div className={styles.replyActions}>
                  <ImageUpload onUploadComplete={(md) => setNewMessage(prev => prev + md)} />
                  <button
                    type="submit"
                    disabled={loading || !newMessage.trim()}
                    className={styles.submitButton}
                >
                  {loading ? 'Sending...' : 'Reply'}
                </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {!showNewThread && !selectedThread && (
          <div className={styles.placeholder}>
            <p>Select a thread or start a new discussion</p>
          </div>
        )}
      </div>

      {/* Image Lightbox */}
      {lightboxSrc && (
        <div className={styles.lightboxOverlay} onClick={() => setLightboxSrc(null)}>
          <img
            src={lightboxSrc}
            className={styles.lightboxImage}
            alt=""
            onClick={e => e.stopPropagation()}
            onError={e => { (e.target as HTMLImageElement).alt = 'Failed to load image'; }}
          />
          <button className={styles.lightboxClose} onClick={() => setLightboxSrc(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

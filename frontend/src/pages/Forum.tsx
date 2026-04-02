import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { autolinkIds } from '../utils/autolink';
import styles from './Forum.module.css';
import { ANIMAL_EMOJI } from '../utils/animals';
import { useAuth } from '../contexts/AuthContext';
import { getGuestThreads, getGuestThread, postGuestThreadReply, createGuestThread, getGuestPack } from '../api/guest';
import { FileUpload } from '../components/FileUpload';
import { EmojiButton } from '../components/EmojiButton';
import { VoiceInput } from '../components/VoiceInput';

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
  profiles: Map<string, BeastProfile>,
  guestAvatars?: Map<string, string | null>,
  msgAvatarUrl?: string | null
): { name: string; emoji: string; avatarUrl: string | null; themeColor: string | null } {
  // Check author field first — role alone is unreliable (Beasts post with role: human)
  if (author) {
    // Guest authors: "[Guest] username" — display as guest, don't match beast profiles
    if (author.startsWith('[Guest]')) {
      const guestName = author.replace('[Guest] ', '').replace('[Guest]', '') || 'Guest';
      const avatarUrl = msgAvatarUrl || guestAvatars?.get(guestName.toLowerCase()) || null;
      return { name: guestName, emoji: '👤', avatarUrl, themeColor: null };
    }

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
  created_by: string | null;
  issue_url: string | null;
  visibility?: 'public' | 'internal';
}

interface Message {
  id: number;
  role: 'human' | 'oracle' | 'claude';
  content: string;
  author: string | null;
  author_role?: 'owner' | 'beast' | 'guest';
  author_avatar_url?: string | null;
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

async function fetchThreads(isGuest = false, limit?: number, offset = 0, category?: string, visibility?: string): Promise<{ threads: Thread[]; total: number }> {
  if (isGuest) return getGuestThreads(limit, offset) as any;
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit.toString());
  if (offset) params.set('offset', offset.toString());
  if (category && category !== 'all') params.set('category', category);
  if (visibility && visibility !== 'all') params.set('visibility', visibility);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/threads${qs ? '?' + qs : ''}`);
  return res.json();
}

async function fetchThread(id: number, limit?: number, offset = 0, order: 'asc' | 'desc' = 'desc', isGuest = false): Promise<ThreadDetail & { total: number }> {
  if (isGuest) return getGuestThread(id, limit, offset);
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit.toString());
  if (offset) params.set('offset', offset.toString());
  if (order === 'asc') params.set('order', 'asc');
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/thread/${id}${qs ? '?' + qs : ''}`);
  return res.json();
}

async function sendMessage(message: string, threadId?: number, title?: string, replyToId?: number, isGuest = false): Promise<any> {
  if (isGuest) {
    if (threadId) {
      return postGuestThreadReply(threadId, message, replyToId);
    } else {
      return createGuestThread(message, title);
    }
  }
  const res = await fetch(`${API_BASE}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, thread_id: threadId, title, reply_to_id: replyToId, author: 'gorn', role: 'human' })
  });
  return res.json();
}


export function Forum() {
  const { isGuest, guestName } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<ThreadDetail | null>(null);
  // Use ref for input value to avoid re-rendering message list on every keystroke
  const newMessageRef = useRef<HTMLTextAreaElement>(null);
  const [newMessage, _setNewMessage] = useState('');
  const setNewMessage = useCallback((val: string | ((prev: string) => string)) => {
    const newVal = typeof val === 'function' ? val(newMessageRef.current?.value || '') : val;
    if (newMessageRef.current) newMessageRef.current.value = newVal;
    _setNewMessage(newVal);
  }, []);
  // Sync uncontrolled textarea typing to state (for button disabled check)
  const handleTextareaInput = useCallback(() => {
    _setNewMessage(newMessageRef.current?.value || '');
  }, []);
  const [newTitle, setNewTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [beastProfiles, setBeastProfiles] = useState<Map<string, BeastProfile>>(new Map());
  const [guestAvatars, setGuestAvatars] = useState<Map<string, string | null>>(new Map());
  const [reactions, setReactions] = useState<Record<number, { emoji: string; beasts: string[]; count: number }[]>>({});
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<number | null>(null);
  const [supportedEmoji, setSupportedEmoji] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [visibilityFilter, setVisibilityFilter] = useState<string>('all');
  const [sortOrder, setSortOrder] = useState<'recent' | 'active' | 'most-msgs'>('recent');
  const [newCategory, setNewCategory] = useState<string>('discussion');
  const [newVisibility, setNewVisibility] = useState<'internal' | 'public'>('internal');
  const [replyTo, setReplyTo] = useState<{ id: number; author: string | null; content: string } | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<number, number>>({});
  const [totalMessages, setTotalMessages] = useState(0);
  const [threadTotal, setThreadTotal] = useState(0);
  const [isLoadingMoreThreads, setIsLoadingMoreThreads] = useState(false);
  const THREAD_PAGE_SIZE = 20;
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [subscribers, setSubscribers] = useState<Array<{ name: string; display_name: string; level: string; avatar_url: string | null; theme_color: string | null }>>([]);
  const [showSubscribers, setShowSubscribers] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Memoized markdown components to prevent re-parsing on every keystroke
  const mdComponents = useRef({
    code({ className, children, ...props }: any) {
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
    img({ src, alt }: any) {
      return (
        <img src={src} alt={alt || ''} style={{ cursor: 'pointer' }}
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); if (src) setLightboxSrc(src); }}
        />
      );
    },
    a({ href, children }: any) {
      const isImage = href && /\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i.test(href);
      if (isImage) {
        return (
          <img src={href} alt={String(children) || ''} style={{ cursor: 'pointer' }}
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); if (href) setLightboxSrc(href); }}
          />
        );
      }
      const isMention = href && href.startsWith('/beast/');
      if (isMention) return <a href={href} className={styles.mention}>{children}</a>;
      const isInternal = href && href.startsWith('/');
      return isInternal
        ? <a href={href}>{children}</a>
        : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
  }).current;
  const initialScrollDone = useRef(false);

  const PAGE_SIZE = 20;
  const threadIdParam = searchParams.get('thread');
  const showNewThread = searchParams.get('new') === 'true';

  // ESC key closes lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  // Scroll-to-top FAB visibility
  useEffect(() => {
    const handler = () => setShowScrollTop(window.scrollY > 300);
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);

  // Load unread counts (owner uses 'gorn', guests use 'guest:<name>')
  const unreadIdentity = isGuest ? `guest:${guestName}` : 'gorn';

  async function loadUnreadCounts() {
    try {
      const res = await fetch(`${API_BASE}/forum/unread/${encodeURIComponent(unreadIdentity)}`);
      const data = await res.json();
      const counts: Record<number, number> = {};
      for (const t of data.threads || []) {
        counts[t.thread_id] = t.unread_count;
      }
      setUnreadCounts(counts);
    } catch { /* ignore */ }
  }

  // Mark thread as read
  async function markThreadRead(threadId: number, lastMessageId: number) {
    try {
      await fetch(`${API_BASE}/forum/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: unreadIdentity, threadId, messageId: lastMessageId }),
      });
      setUnreadCounts(prev => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    } catch { /* ignore */ }
  }

  // Load beast profiles + guest avatars
  useEffect(() => {
    (isGuest ? getGuestPack() : fetch(`${API_BASE}/beasts`).then(res => res.json()))
      .then(data => {
        const map = new Map<string, BeastProfile>();
        for (const b of data.beasts || []) {
          map.set(b.name, b);
        }
        setBeastProfiles(map);
      })
      .catch(() => {});
    // Load guest avatars (owner only — /api/guests requires owner session)
    if (!isGuest) {
      fetch(`${API_BASE}/guests`).then(r => r.json())
        .then(data => {
          const map = new Map<string, string | null>();
          for (const g of data.guests || []) {
            map.set(g.username?.toLowerCase(), g.avatar_url || null);
            if (g.display_name) map.set(g.display_name.toLowerCase(), g.avatar_url || null);
          }
          setGuestAvatars(map);
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    loadThreads();
    loadUnreadCounts();
    fetch('/api/reactions/supported').then(r => r.json()).then(d => setSupportedEmoji(d.emoji || [])).catch(() => {});
  }, []);

  // Reload threads when category or visibility filter changes
  useEffect(() => {
    loadThreads();
  }, [categoryFilter, visibilityFilter]);

  // Load thread from URL param or auto-select first
  // Only react to threadIdParam changes (user navigation), NOT threads polling
  const threadsLoadedRef = useRef(false);
  useEffect(() => {
    if (threadIdParam) {
      // Only fetch if thread changed (not on every threads poll)
      if (!selectedThread || selectedThread.thread.id !== parseInt(threadIdParam, 10)) {
        selectThread(parseInt(threadIdParam, 10));
      }
    } else if (threads.length > 0 && !showNewThread && !threadsLoadedRef.current && window.innerWidth > 768) {
      // Auto-select first thread only on initial load, desktop only
      threadsLoadedRef.current = true;
      setSearchParams({ thread: threads[0].id.toString() });
    } else if (!threadIdParam && selectedThread) {
      // No thread param — clear selection (e.g. user clicked Forum nav link)
      setSelectedThread(null);
    }
  }, [threadIdParam, threads]);

  // Poll for new messages (only fetch latest few, append if new) and threads
  useEffect(() => {
    const pollMessages = setInterval(() => {
      if (document.hidden) return;
      // Pause polling while user is typing to prevent re-renders
      if (document.activeElement?.tagName === 'TEXTAREA') return;
      if (selectedThread) {
        fetchThread(selectedThread.thread.id, 5, 0, 'desc', isGuest).then(data => {
          setSelectedThread(prev => {
            if (!prev) return prev;
            const existingIds = new Set(prev.messages.map(m => m.id));
            const newMsgs = data.messages.filter(m => !existingIds.has(m.id));
            if (newMsgs.length === 0) return prev;
            loadReactionsForThread(newMsgs);
            return { ...prev, messages: [...newMsgs, ...prev.messages] };
          });
          setTotalMessages(prev => prev === data.total ? prev : data.total);
        }).catch(() => {});
      }
    }, 3000);

    const pollThreads = setInterval(() => {
      if (document.hidden) return;
      if (document.activeElement?.tagName === 'TEXTAREA') return;
      loadThreads();
      loadUnreadCounts();
    }, 10000);

    return () => {
      clearInterval(pollMessages);
      clearInterval(pollThreads);
    };
  }, [selectedThread?.thread.id]);

  // Auto-scroll to bottom on initial thread load (show latest messages first)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    if (!initialScrollDone.current) {
      // Defer scroll to after DOM paint so scrollHeight reflects rendered messages
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (messagesContainerRef.current) {
            messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
          }
          initialScrollDone.current = true;
        });
      });
    }
  }, [selectedThread?.messages.length]);

  // Real-time WebSocket updates — fetch only new messages, append
  const handleWsMessage = useCallback((data: any) => {
    if (selectedThread && data.thread_id === selectedThread.thread.id) {
      fetchThread(selectedThread.thread.id, 5, 0, 'desc', isGuest).then(d => {
        setSelectedThread(prev => {
          if (!prev) return prev;
          const existingIds = new Set(prev.messages.map(m => m.id));
          const newMsgs = d.messages.filter(m => !existingIds.has(m.id));
          if (newMsgs.length === 0) return prev;
          loadReactionsForThread(newMsgs);
          return { ...prev, messages: [...prev.messages, ...newMsgs] };
        });
        setTotalMessages(d.total);
      }).catch(() => {});
    }
    fetchThreads(isGuest).then(d => setThreads(d.threads)).catch(() => {});
  }, [selectedThread?.thread.id, isGuest]);

  useWebSocket('new_message', handleWsMessage);

  // Real-time reaction updates (skip private API for guests)
  const handleWsReaction = useCallback((data: any) => {
    if (!data.message_id || isGuest) return;
    // Refresh reactions for the affected message
    fetch(`${API_BASE}/message/${data.message_id}/reactions`)
      .then(r => r.json())
      .then(d => {
        setReactions(prev => ({ ...prev, [data.message_id]: d.reactions || [] }));
      })
      .catch(() => {});
  }, [isGuest]);

  useWebSocket('reaction', handleWsReaction);

  // Load More button — fetch older messages in batches
  const hasMore = selectedThread ? selectedThread.messages.length < totalMessages : false;
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const loadOlderMessages = useCallback(async () => {
    if (!selectedThread || isLoadingMore) return;
    setIsLoadingMore(true);
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight || 0;
    try {
      const currentCount = selectedThread.messages.length;
      const data = await fetchThread(selectedThread.thread.id, PAGE_SIZE, currentCount, 'desc', isGuest);
      data.messages.reverse();
      if (data.messages.length > 0) {
        setSelectedThread(prev => prev ? {
          ...prev,
          messages: [...data.messages, ...prev.messages],
        } : prev);
        loadReactionsForThread(data.messages);
        // Preserve scroll position after prepending older messages
        requestAnimationFrame(() => {
          if (container) {
            container.scrollTop = container.scrollHeight - prevScrollHeight;
          }
        });
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [selectedThread?.thread.id, selectedThread?.messages.length, isLoadingMore]);


  async function loadThreads() {
    const data = await fetchThreads(isGuest, THREAD_PAGE_SIZE, 0, categoryFilter, visibilityFilter);
    setThreads(data.threads);
    setThreadTotal(data.total);
  }

  const loadMoreThreads = useCallback(async () => {
    if (isLoadingMoreThreads) return;
    setIsLoadingMoreThreads(true);
    try {
      const data = await fetchThreads(isGuest, THREAD_PAGE_SIZE, threads.length, categoryFilter, visibilityFilter);
      if (data.threads.length > 0) {
        setThreads(prev => [...prev, ...data.threads]);
        setThreadTotal(data.total);
      }
    } finally {
      setIsLoadingMoreThreads(false);
    }
  }, [isGuest, threads.length, isLoadingMoreThreads, categoryFilter, visibilityFilter]);

  async function selectThread(id: number) {
    initialScrollDone.current = false;
    // Load latest messages (desc) then reverse for chronological display
    const data = await fetchThread(id, PAGE_SIZE, 0, 'desc', isGuest);
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
    // Mark as read for gorn (last message is newest after reverse)
    if (data.messages.length > 0) {
      markThreadRead(id, data.messages[data.messages.length - 1].id);
    }
    // Fetch subscribers (owner view only, T#621)
    if (!isGuest) {
      fetch(`${API_BASE}/thread/${id}/subscribers`).then(r => r.json()).then(d => {
        setSubscribers(d.subscribers || []);
        setShowSubscribers(false);
      }).catch(() => setSubscribers([]));
    }
  }

  function openNewThread() {
    setSearchParams({ new: 'true' });
    setSelectedThread(null);
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    const messageText = newMessageRef.current?.value || newMessage;
    if (!messageText.trim()) return;

    setLoading(true);
    try {
      if (selectedThread) {
        const result = await sendMessage(messageText, selectedThread.thread.id, undefined, replyTo?.id, isGuest);
        // Append the new message locally instead of re-fetching (avoids WebSocket duplicate)
        if (result.message_id) {
          const newMsg = {
            id: result.message_id,
            role: 'human' as const,
            content: messageText,
            author: isGuest ? `[Guest] ${guestName || 'Guest'}` : 'gorn',
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
        const result = await sendMessage(messageText, undefined, newTitle || undefined, undefined, isGuest);
        // Set category if not default
        if (!isGuest && newCategory && newCategory !== 'discussion' && result.thread_id) {
          await fetch(`${API_BASE}/thread/${result.thread_id}/category`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: newCategory }),
          });
        }
        // Set visibility if public
        if (!isGuest && newVisibility === 'public' && result.thread_id) {
          await fetch(`${API_BASE}/thread/${result.thread_id}/visibility`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visibility: 'public' }),
          });
        }
        await loadThreads();
        setSearchParams({ thread: result.thread_id.toString() });
      }
      _setNewMessage('');
      if (newMessageRef.current) newMessageRef.current.value = '';
      setNewTitle('');
      setNewCategory('discussion');
      setReplyTo(null);
    } finally {
      setLoading(false);
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
    const reactAs = isGuest ? `[Guest] ${guestName || 'Guest'}` : 'gorn';
    const existing = reactions[messageId] || [];
    const myReaction = existing.find(r => r.emoji === emoji && r.beasts.includes(reactAs));
    if (myReaction) {
      await fetch(`${API_BASE}/message/${messageId}/react`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: reactAs, emoji }),
      });
    } else {
      await fetch(`${API_BASE}/message/${messageId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beast: reactAs, emoji }),
      });
    }
    // Reload reactions for this message
    try {
      const res = await fetch(`${API_BASE}/message/${messageId}/reactions`);
      const data = await res.json();
      setReactions(prev => ({ ...prev, [messageId]: data.reactions || [] }));
    } catch { /* ignore */ }
  }


  return (
    <div className={styles.container}>
      {/* Sidebar: Thread List — hidden on mobile when thread is selected */}
      <div className={`${styles.sidebar} ${selectedThread || showNewThread ? styles.hidden : ''}`}>
        <div className={styles.sidebarHeader}>
          <h2>Threads</h2>
          <button
            className={styles.newButton}
            onClick={openNewThread}
          >
            + New
          </button>
        </div>

        <div className={styles.filterRow}>
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className={styles.filterSelect}
          >
            <option value="all">All categories</option>
            <option value="announcement">Announcement</option>
            <option value="task">Task</option>
            <option value="discussion">Discussion</option>
            <option value="decision">Decision</option>
            <option value="question">Question</option>
          </select>
          {!isGuest && (
            <select
              value={visibilityFilter}
              onChange={e => setVisibilityFilter(e.target.value)}
              className={styles.filterSelect}
            >
              <option value="all">All threads</option>
              <option value="internal">Internal only</option>
              <option value="public">Public only</option>
            </select>
          )}
          <select
            value={sortOrder}
            onChange={e => setSortOrder(e.target.value as typeof sortOrder)}
            className={styles.sortSelect}
          >
            <option value="recent">Recent</option>
            <option value="active">Most active</option>
            <option value="most-msgs">Most messages</option>
          </select>
        </div>

        <div className={styles.threadList}>
          {threads
            .sort((a, b) => {
              if (sortOrder === 'most-msgs') return (b.message_count || 0) - (a.message_count || 0);
              // 'recent' and 'active' use default server order
              return 0;
            })
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
                {thread.created_by && <span className={styles.threadCreator}>by {thread.created_by}</span>}
                <span className={styles.categoryBadge}>{thread.category || 'discussion'}</span>
                {!isGuest && thread.visibility && (
                  <span className={thread.visibility === 'public' ? styles.visibilityPublic : styles.visibilityInternal}>
                    {thread.visibility === 'public' ? 'Public' : 'Internal'}
                  </span>
                )}
                <span className={styles.count}>{thread.message_count} msgs</span>
              </div>
            </div>
          ))}

          {threads.length === 0 && (
            <div className={styles.empty}>No threads yet</div>
          )}
          {threads.length < threadTotal && (
            <button
              onClick={loadMoreThreads}
              disabled={isLoadingMoreThreads}
              className={styles.loadMoreBtn}
              style={{ margin: '12px auto', display: 'block' }}
            >
              {isLoadingMoreThreads ? 'Loading...' : `Load more (${threadTotal - threads.length} remaining)`}
            </button>
          )}
        </div>
      </div>

      {/* Main: Thread Detail or New Thread — full screen on mobile */}
      <div className={`${styles.main} ${selectedThread || showNewThread ? styles.fullScreen : ''}`}>
        {showNewThread && !selectedThread && (
          <div className={styles.newThread}>
            <div className={styles.newThreadHeader}>
              <button className={styles.mobileBack} onClick={() => setSearchParams({})}>←</button>
              <h2>New Thread</h2>
            </div>
            <form onSubmit={handleSendMessage} className={styles.form}>
              <input
                type="text"
                placeholder="Thread title..."
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                className={styles.titleInput}
              />
              <div className={styles.newThreadOptions}>
                <div className={styles.categoryPills}>
                  {['discussion', 'announcement', 'task', 'decision', 'question'].map(cat => (
                    <button
                      key={cat}
                      type="button"
                      className={`${styles.categoryPill} ${newCategory === cat ? styles.categoryPillActive : ''}`}
                      onClick={() => setNewCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                {!isGuest && (
                  <div className={styles.visibilityToggle}>
                    <button
                      type="button"
                      className={`${styles.visibilityBtn} ${newVisibility === 'internal' ? styles.visibilityBtnActive : ''}`}
                      onClick={() => setNewVisibility('internal')}
                    >
                      Internal
                    </button>
                    <button
                      type="button"
                      className={`${styles.visibilityBtn} ${newVisibility === 'public' ? styles.visibilityBtnActive : ''}`}
                      onClick={() => setNewVisibility('public')}
                    >
                      Public
                    </button>
                  </div>
                )}
              </div>
              <textarea
                placeholder="What's on your mind? (⌘+Enter to send)"
                ref={newMessageRef}
                defaultValue={newMessage}
                onInput={handleTextareaInput}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                className={styles.textarea}
                rows={14}
              />
              <div className={styles.replyActions}>
                <FileUpload onUploadComplete={(md) => setNewMessage(prev => prev + md)} />
                <EmojiButton onSelect={(e) => setNewMessage(prev => prev + e)} />
                <VoiceInput onTranscript={(text) => setNewMessage(prev => prev ? prev + ' ' + text : text)} />
                <button
                  type="submit"
                  disabled={loading || !newMessage.trim()}
                  className={styles.submitButton}
                >
                  {loading ? 'Posting...' : 'Post'}
                </button>
              </div>
            </form>
          </div>
        )}

        {selectedThread && (
          <div className={styles.threadDetail}>
            <div className={styles.threadHeader}>
              <button className={styles.mobileBack} onClick={() => { setSelectedThread(null); setSearchParams({}); }}>←</button>
              <h2><span className={styles.threadIdHeader}>#{selectedThread.thread.id}</span> {selectedThread.thread.title}</h2>
              <div className={styles.threadActions}>
                {!isGuest && subscribers.length > 0 && (
                  <div className={styles.subscribersWidget}>
                    <button
                      className={styles.subscribersToggle}
                      onClick={() => setShowSubscribers(v => !v)}
                      title={`${subscribers.length} subscriber${subscribers.length !== 1 ? 's' : ''}`}
                    >
                      {subscribers.filter(s => s.level !== 'muted').length} subscribed
                    </button>
                    {showSubscribers && (
                      <div className={styles.subscribersDropdown}>
                        {subscribers.map(s => (
                          <div key={s.name} className={styles.subscriberRow}>
                            {s.avatar_url ? (
                              <img src={s.avatar_url} alt={s.display_name} className={styles.subscriberAvatar} />
                            ) : (
                              <span className={styles.subscriberAvatarPlaceholder} style={s.theme_color ? { background: s.theme_color } : undefined}>
                                {s.display_name[0]?.toUpperCase()}
                              </span>
                            )}
                            <span className={styles.subscriberName}>{s.display_name}</span>
                            <span className={`${styles.subscriberLevel} ${styles['level_' + s.level]}`}>{s.level}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!isGuest && (
                  <button
                    className={styles.deleteThreadBtn}
                    onClick={async () => {
                      if (!confirm(`Delete thread #${selectedThread.thread.id} "${selectedThread.thread.title}"? This cannot be undone.`)) return;
                      try {
                        await fetch(`${API_BASE}/thread/${selectedThread.thread.id}`, {
                          method: 'DELETE',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ beast: 'gorn' }),
                        });
                        setSelectedThread(null);
                        setSearchParams({});
                        loadThreads();
                      } catch {}
                    }}
                    title="Delete thread"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            <div className={styles.messages} ref={messagesContainerRef}>
              {hasMore && (
                <div style={{ textAlign: 'center', padding: '8px' }}>
                  <button
                    onClick={loadOlderMessages}
                    disabled={isLoadingMore}
                    className={styles.loadMoreBtn}
                  >
                    {isLoadingMore ? 'Loading...' : `Load older (${totalMessages - (selectedThread?.messages.length || 0)} remaining)`}
                  </button>
                </div>
              )}
              {selectedThread.messages.map(msg => {
                const identity = resolveAuthor(msg.role, msg.author, beastProfiles, guestAvatars, msg.author_avatar_url);
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
                      {msg.author_role === 'guest' && <span className={styles.guestBadge}>Guest</span>}
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
                      components={mdComponents}
                    >
                      {autolinkIds(msg.content)}
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
                        className={`${styles.reactionBtn} ${r.beasts.includes(isGuest ? `[Guest] ${guestName || 'Guest'}` : 'gorn') ? styles.reactionActive : ''}`}
                        onClick={() => toggleReaction(msg.id, r.emoji)}
                        title={r.beasts.join(', ')}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                    <button
                      className={styles.addReaction}
                      onClick={() => setEmojiPickerMsgId(emojiPickerMsgId === msg.id ? null : msg.id)}
                      title="React"
                    >+</button>
                    {emojiPickerMsgId === msg.id && (
                      <div className={styles.emojiPicker}>
                        {supportedEmoji.map(e => (
                          <button
                            key={e}
                            className={styles.emojiOption}
                            onClick={() => { toggleReaction(msg.id, e); setEmojiPickerMsgId(null); }}
                          >{e}</button>
                        ))}
                      </div>
                    )}
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
                  ref={newMessageRef}
                  defaultValue={newMessage}
                  onInput={handleTextareaInput}
                  onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                  className={styles.textarea}
                  rows={3}
                />
                <div className={styles.replyActions}>
                  <FileUpload onUploadComplete={(md) => setNewMessage(prev => prev + md)} />
                  <EmojiButton onSelect={(e) => setNewMessage(prev => prev + e)} />
                  <VoiceInput onTranscript={(text) => setNewMessage(prev => prev ? prev + ' ' + text : text)} />
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

      {/* Scroll to top FAB */}
      {showScrollTop && (
        <button
          className={styles.scrollTopFab}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Scroll to top"
        >↑</button>
      )}

      {/* Image Lightbox — portaled to body to avoid layout interference */}
      {lightboxSrc && createPortal(
        <div className={styles.lightboxOverlay} onClick={() => setLightboxSrc(null)}>
          <img
            src={lightboxSrc}
            className={styles.lightboxImage}
            alt=""
            onClick={e => e.stopPropagation()}
            onError={e => { (e.target as HTMLImageElement).alt = 'Failed to load image'; }}
          />
          <button className={styles.lightboxClose} onClick={() => setLightboxSrc(null)}>✕</button>
        </div>,
        document.body
      )}
    </div>
  );
}

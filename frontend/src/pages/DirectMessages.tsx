import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import styles from './DirectMessages.module.css';
import { SearchInput } from '../components/SearchInput';
import { ImageUpload } from '../components/ImageUpload';
import ReactMarkdown from 'react-markdown';

interface DashboardConversation {
  id: number;
  participants: [string, string];
  message_count: number;
  unread_count: number;
  last_message: string;
  last_sender: string;
  last_at: string;
  created_at: string;
}

interface DmMessage {
  id: number;
  sender: string;
  content: string;
  read_at: string | null;
  created_at: string;
}

interface ConversationDetail {
  conversation_id: number | null;
  participants: string[];
  messages: DmMessage[];
  total: number;
}

interface Dashboard {
  conversations: DashboardConversation[];
  total_conversations: number;
  total_messages: number;
}

const API_BASE = '/api';

async function fetchDashboard(): Promise<Dashboard> {
  const res = await fetch(`${API_BASE}/dm/dashboard`);
  return res.json();
}

async function fetchMessages(name1: string, name2: string, limit = 50, offset = 0, order: 'asc' | 'desc' = 'desc'): Promise<ConversationDetail> {
  const params = new URLSearchParams();
  params.set('limit', limit.toString());
  if (offset) params.set('offset', offset.toString());
  if (order === 'asc') params.set('order', 'asc');
  const res = await fetch(`${API_BASE}/dm/${name1}/${name2}?${params}`);
  return res.json();
}

async function markAllRead(name1: string, name2: string): Promise<any> {
  const res = await fetch(`${API_BASE}/dm/${name1}/${name2}/read-all`, { method: 'PATCH' });
  return res.json();
}

async function sendDm(from: string, to: string, message: string): Promise<any> {
  const res = await fetch(`${API_BASE}/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, message }),
  });
  return res.json();
}

export function DirectMessages() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedConv, setSelectedConv] = useState<DashboardConversation | null>(null);
  const [messages, setMessages] = useState<ConversationDetail | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [_replyAs, setReplyAs] = useState('gorn');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showNewDm, setShowNewDm] = useState(false);
  const [beasts, setBeasts] = useState<{ name: string; displayName: string }[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const PAGE_SIZE = 50;

  const convParam = searchParams.get('conv'); // "bertus-karo"

  useEffect(() => {
    loadDashboard();
    fetch(`${API_BASE}/beasts`).then(r => r.json()).then(d => setBeasts(d.beasts || [])).catch(() => {});
  }, []);

  // Poll for new messages and conversations
  useEffect(() => {
    const pollMessages = setInterval(() => {
      if (document.hidden) return;
      if (selectedConv && convParam) {
        const [p1, p2] = convParam.split('-');
        if (p1 && p2) {
          fetchMessages(p1, p2, 5, 0, 'desc').then(data => {
            if (data.total !== totalMessages && messages) {
              const existingIds = new Set(messages.messages.map(m => m.id));
              const newMsgs = data.messages.filter(m => !existingIds.has(m.id)).reverse();
              if (newMsgs.length > 0) {
                setMessages(prev => prev ? {
                  ...prev,
                  messages: [...prev.messages, ...newMsgs],
                  total: data.total,
                } : prev);
                setTotalMessages(data.total);
              }
            }
          }).catch(() => {});
        }
      }
    }, 3000);

    const pollDashboard = setInterval(() => {
      if (document.hidden) return;
      loadDashboard();
    }, 10000);

    return () => {
      clearInterval(pollMessages);
      clearInterval(pollDashboard);
    };
  }, [selectedConv?.id, messages?.total, convParam]);

  // Real-time WebSocket updates — fetch only new messages
  const handleWsDm = useCallback((_data: any) => {
    loadDashboard();
    if (convParam && messages) {
      const [p1, p2] = convParam.split('-');
      if (p1 && p2) {
        fetchMessages(p1, p2, 5, 0, 'desc').then(d => {
          const existingIds = new Set(messages.messages.map(m => m.id));
          const newMsgs = d.messages.filter(m => !existingIds.has(m.id)).reverse();
          if (newMsgs.length > 0) {
            setMessages(prev => prev ? {
              ...prev,
              messages: [...prev.messages, ...newMsgs],
              total: d.total,
            } : prev);
            setTotalMessages(d.total);
          }
        }).catch(() => {});
      }
    }
  }, [convParam, messages?.messages.length]);

  useWebSocket('new_dm', handleWsDm);

  useEffect(() => {
    if (convParam && dashboard) {
      const [p1, p2] = convParam.split('-');
      if (p1 && p2) {
        const conv = dashboard.conversations.find(
          c => (c.participants[0] === p1 && c.participants[1] === p2) ||
               (c.participants[0] === p2 && c.participants[1] === p1)
        );
        if (conv) {
          setSelectedConv(conv);
          loadMessages(p1, p2);
        } else {
          // New conversation not yet in dashboard — create temporary entry
          setSelectedConv({
            id: 0,
            participants: [p1, p2],
            message_count: 0, unread_count: 0,
            last_message: '', last_sender: '',
            last_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          });
          loadMessages(p1, p2).catch(() => {
            setMessages({ conversation_id: null, participants: [p1, p2], messages: [], total: 0 });
          });
        }
      }
    } else {
      setSelectedConv(null);
      setMessages(null);
    }
  }, [convParam, dashboard]);

  // Auto-scroll to bottom on initial load or when near bottom
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !messagesEndRef.current) return;

    if (!initialScrollDone.current) {
      messagesEndRef.current.scrollIntoView();
      initialScrollDone.current = true;
    } else {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom < 150) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [messages?.messages.length]);

  // Infinite scroll — load older messages on scroll up
  const hasMore = messages ? messages.messages.length < totalMessages : false;

  const loadOlderMessages = useCallback(async () => {
    if (!messages || !convParam) return;
    const [p1, p2] = convParam.split('-');
    if (!p1 || !p2) return;
    const currentCount = messages.messages.length;
    const data = await fetchMessages(p1, p2, PAGE_SIZE, currentCount, 'desc');
    if (data.messages.length > 0) {
      data.messages.reverse();
      setMessages(prev => prev ? {
        ...prev,
        messages: [...data.messages, ...prev.messages],
      } : prev);
    }
  }, [convParam, messages?.messages.length]);

  const { isLoadingMore } = useInfiniteScroll({
    containerRef: messagesContainerRef,
    hasMore,
    loading: loading,
    onLoadMore: loadOlderMessages,
  });

  async function loadDashboard() {
    const data = await fetchDashboard();
    setDashboard(data);
  }

  async function loadMessages(p1: string, p2: string) {
    initialScrollDone.current = false;
    const data = await fetchMessages(p1, p2, PAGE_SIZE, 0, 'desc');
    data.messages.reverse(); // Display chronologically
    setMessages(data);
    setTotalMessages(data.total);
    // Mark all as read and refresh sidebar badges
    await markAllRead(p1, p2);
    await loadDashboard();
  }

  function selectConversation(conv: DashboardConversation) {
    const key = `${conv.participants[0]}-${conv.participants[1]}`;
    setSearchParams({ conv: key });
    setReplyAs('');
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConv) return;

    const other = selectedConv.participants[0] === 'gorn' ? selectedConv.participants[1] : selectedConv.participants[0];

    setLoading(true);
    try {
      await sendDm('gorn', other, newMessage);
      setNewMessage('');
      // Reload messages and dashboard
      await loadMessages(selectedConv.participants[0], selectedConv.participants[1]);
      await loadDashboard();
    } finally {
      setLoading(false);
    }
  }

  async function startNewDm(beastName: string) {
    setShowNewDm(false);
    const sorted = [beastName, 'gorn'].sort();
    const key = sorted.join('-');
    setSearchParams({ conv: key });
    // Create a temporary selectedConv so chat view opens immediately
    setSelectedConv({
      id: 0,
      participants: [sorted[0], sorted[1]],
      message_count: 0,
      unread_count: 0,
      last_message: '',
      last_sender: '',
      last_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    // Try loading existing messages (latest first)
    try {
      const data = await fetchMessages(sorted[0], sorted[1], PAGE_SIZE, 0, 'desc');
      data.messages.reverse();
      setMessages(data);
      setTotalMessages(data.total);
    } catch {
      setMessages({ conversation_id: null, participants: sorted, messages: [], total: 0 });
      setTotalMessages(0);
    }
    await loadDashboard();
  }

  function formatTime(iso: string) {
    const date = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }

  function formatFullTime(iso: string) {
    return new Date(iso).toLocaleString();
  }

  return (
    <div className={styles.container}>
      {/* Left: All conversations — hidden on mobile when conversation is selected */}
      <div className={`${styles.sidebar} ${selectedConv ? styles.hidden : ''}`}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitleRow}>
            <h2>Direct Messages</h2>
            <button className={styles.newDmButton} onClick={() => setShowNewDm(!showNewDm)}>Chat with</button>
          </div>
          {dashboard && (
            <span className={styles.stats}>
              {dashboard.total_conversations} chats &middot; {dashboard.total_messages} msgs
            </span>
          )}
        </div>

        {showNewDm && (
          <div className={styles.beastSelector}>
            {beasts.map(b => (
              <button
                key={b.name}
                className={styles.beastOption}
                onClick={() => startNewDm(b.name)}
              >
                {b.displayName}
              </button>
            ))}
          </div>
        )}

        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by beast name..."
        />

        <div className={styles.conversationList}>
          {dashboard?.conversations.filter(conv => {
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return conv.participants[0].includes(q) || conv.participants[1].includes(q);
          }).map(conv => {
            const isActive = selectedConv?.id === conv.id;
            return (
              <div
                key={conv.id}
                className={`${styles.conversationItem} ${isActive ? styles.active : ''}`}
                onClick={() => selectConversation(conv)}
              >
                <div className={styles.convPair}>
                  <span className={styles.convName}>{conv.participants[0]}</span>
                  <span className={styles.convArrow}>&harr;</span>
                  <span className={styles.convName}>{conv.participants[1]}</span>
                  {conv.unread_count > 0 && (
                    <span className={styles.unreadBadge}>{conv.unread_count}</span>
                  )}
                </div>
                <div className={styles.convPreview}>
                  <strong>{conv.last_sender}:</strong> {conv.last_message.slice(0, 50)}
                  {conv.last_message.length > 50 && '...'}
                </div>
                <div className={styles.convMeta}>
                  <span className={styles.convCount}>{conv.message_count} msgs</span>
                  <span className={styles.convTime}>{formatTime(conv.last_at)}</span>
                </div>
              </div>
            );
          })}

          {dashboard && dashboard.conversations.length === 0 && (
            <div className={styles.empty}>No DM conversations yet</div>
          )}

          {!dashboard && (
            <div className={styles.empty}>Loading...</div>
          )}
        </div>
      </div>

      {/* Right: Conversation messages — full screen on mobile */}
      <div className={`${styles.main} ${selectedConv ? styles.fullScreen : ''}`}>
        {selectedConv && messages ? (
          <div className={styles.chatView}>
            <button className={styles.mobileBack} onClick={() => { setSelectedConv(null); setSearchParams({}); }}>← Conversations</button>
            <div className={styles.chatHeader}>
              <h2>
                <span className={styles.headerName}>{selectedConv.participants[0]}</span>
                {' '}&harr;{' '}
                <span className={styles.headerName}>{selectedConv.participants[1]}</span>
              </h2>
              <span className={styles.msgCount}>{messages.total} messages</span>
            </div>

            <div className={styles.messages} ref={messagesContainerRef}>
              {isLoadingMore && (
                <div style={{ textAlign: 'center', padding: '8px', opacity: 0.6, fontSize: '0.85em' }}>Loading older messages...</div>
              )}
              {hasMore && !isLoadingMore && (
                <div style={{ textAlign: 'center', padding: '8px', opacity: 0.4, fontSize: '0.8em' }}>↑ Scroll up for older messages</div>
              )}
              {messages.messages.map(msg => (
                <div key={msg.id} className={styles.message}>
                  <div className={styles.messageHeader}>
                    <span className={styles.sender}>{msg.sender}</span>
                    <span className={styles.time}>{formatFullTime(msg.created_at)}</span>
                  </div>
                  <div className={styles.messageContent}><ReactMarkdown>{msg.content}</ReactMarkdown></div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {selectedConv && selectedConv.participants.includes('gorn') && (
              <form onSubmit={handleSend} className={styles.replyForm}>
                <div className={styles.replyInput}>
                  <textarea
                    placeholder="Message... (⌘+Enter to send)"
                    value={newMessage}
                    onChange={e => setNewMessage(e.target.value)}
                    onKeyDown={e => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        if (newMessage.trim()) {
                          handleSend(e as any);
                        }
                      }
                    }}
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
                    {loading ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className={styles.placeholder}>
            <p>Select a conversation to view messages</p>
          </div>
        )}
      </div>
    </div>
  );
}

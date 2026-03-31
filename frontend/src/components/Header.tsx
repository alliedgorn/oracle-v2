import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './Header.module.css';

interface QuickResult {
  source_type: string;
  source_id: string;
  title: string;
  url: string;
  author: string;
}

const TYPE_ICONS: Record<string, string> = {
  forum: '💬', library: '📚', task: '✅', spec: '📋', risk: '⚠️', shelf: '📚',
};

// Top-level nav items (always visible, not grouped)
const topNavItems = [
  { path: '/forum', label: 'Forum' },
  { path: '/board', label: 'Board' },
  { path: '/specs', label: 'Specs' },
  { path: '/prowl', label: 'Prowl' },
  { path: '/forge', label: 'Forge' },
];

// Guest top nav — flat, no dropdown
const guestTopNavItems = [
  { path: '/welcome', label: 'Welcome' },
  { path: '/pack', label: 'Pack' },
  { path: '/forum', label: 'Forum' },
];

// Grouped navigation (dropdowns for secondary items)

const navGroups = [
  {
    label: 'More',
    subgroups: [
      {
        label: 'Pack',
        items: [
          { path: '/pack', label: 'Pack' },
          { path: '/guests', label: 'Guests' },
          { path: '/terminal', label: 'Terminal' },
          { path: '/teams', label: 'Teams' },
          { path: '/dms', label: 'DMs' },
          { path: '/risk', label: 'Risk' },
          { path: '/rules', label: 'Rules' },
        ],
      },
      {
        label: 'Knowledge',
        items: [
          { path: '/library', label: 'Library' },
          { path: '/files', label: 'Files' },
          { path: '/playbook', label: 'Playbook' },
          { path: '/search', label: 'Search' },
          { path: '/feed', label: 'Feed' },
        ],
      },
      {
        label: 'Insights',
        items: [
          { path: '/overview', label: 'Overview' },
          { path: '/graph', label: 'Graph' },
          { path: '/map', label: 'Map' },
          { path: '/evolution', label: 'Evolution' },
          { path: '/traces', label: 'Traces' },
        ],
      },
      {
        label: 'Admin',
        items: [
          { path: '/activity?tab=searches', label: 'Activity' },
          { path: '/scheduler', label: 'Scheduler' },
          { path: '/audit', label: 'Audit Log' },
          { path: '/superseded', label: 'Superseded' },
          { path: '/handoff', label: 'Handoff' },
        ],
      },
    ],
  },
];

// Guest grouped nav — none, all items are top-level
const guestNavGroups: typeof navGroups = [];

interface NavBadges {
  specs: number;
  prowl: number;
  dms: number;
  rules: number;
}

interface SessionStats {
  searches: number;
  learnings: number;
  startTime: number;
}

interface HeaderProps {
  onRemoteToggle?: () => void;
}

export function Header({ onRemoteToggle }: HeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, authEnabled, isGuest, isLoading: authLoading, guestName, logout } = useAuth();
  const activeTopNav = isGuest ? guestTopNavItems : topNavItems;
  const activeNavGroups = isGuest ? guestNavGroups : navGroups;
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [badges, setBadges] = useState<NavBadges>({ specs: 0, prowl: 0, dms: 0, rules: 0 });
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const dropdownTriggerRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<QuickResult[]>([]);
  const [searchSelected, setSearchSelected] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { openChat } = useChat();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTouchDevice = 'ontouchstart' in window;
  const [sessionStartTime] = useState(() => {
    const stored = localStorage.getItem('oracle_session_start');
    if (stored) return parseInt(stored);
    const now = Date.now();
    localStorage.setItem('oracle_session_start', String(now));
    return now;
  });

  useEffect(() => {
    if (authLoading || isGuest) return; // Wait for auth to resolve; guests don't need session stats
    loadSessionStats();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadSessionStats();
    }, 30000);
    return () => clearInterval(interval);
  }, [sessionStartTime, isGuest, authLoading]);

  async function loadSessionStats() {
    if (isGuest) return;
    try {
      const response = await fetch(`/api/session/stats?since=${sessionStartTime}`);
      if (response.ok) {
        const data = await response.json();
        setSessionStats({
          searches: data.searches,
          learnings: data.learnings,
          startTime: sessionStartTime
        });
      }
    } catch (e) {
      console.error('Failed to load session stats:', e);
      setSessionStats({ searches: 0, learnings: 0, startTime: sessionStartTime });
    }
  }

  const loadBadges = useCallback(async () => {
    if (authLoading) return;
    if (isGuest) {
      // Guest badge: count DM conversations
      try {
        const res = await fetch('/api/guest/dashboard');
        const data = await res.json();
        const dmCount = (data.dmSummary || []).length;
        setBadges({ specs: 0, prowl: 0, dms: dmCount, rules: 0 });
      } catch {}
      return;
    }
    try {
      const [specsRes, prowlRes, dmRes, rulesRes] = await Promise.all([
        fetch('/api/specs?status=pending'),
        fetch('/api/prowl?status=pending'),
        fetch('/api/dm/dashboard'),
        fetch('/api/rules/pending'),
      ]);
      const specsData = await specsRes.json();
      const prowlData = await prowlRes.json();
      const dmData = await dmRes.json();
      const rulesData = await rulesRes.json();
      const gornConvos = (dmData.conversations || []).filter((c: any) =>
        (c.participants || []).some((p: string) => p.toLowerCase() === 'gorn')
      );
      const dmUnread = gornConvos.reduce((sum: number, c: any) => sum + (c.unread_count || 0), 0);
      setBadges({
        specs: specsData.specs?.length || 0,
        prowl: prowlData.counts?.pending || 0,
        dms: dmUnread,
        rules: rulesData.total || 0,
      });
    } catch {}
  }, [isGuest, authLoading]);

  // Initial load + refresh on visibility change
  useEffect(() => {
    loadBadges();
    const handleVisibility = () => { if (!document.hidden) loadBadges(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadBadges]);

  // WebSocket updates for badges (replaced 30s polling)
  useWebSocket('spec_submitted', loadBadges);
  useWebSocket('spec_reviewed', loadBadges);
  useWebSocket('spec_resubmitted', loadBadges);
  useWebSocket('prowl_update', loadBadges);
  useWebSocket('new_dm', loadBadges);
  // Delay badge refresh on dm_read to ensure DB write has committed
  const loadBadgesDelayed = useCallback(() => { setTimeout(loadBadges, 500); }, [loadBadges]);
  useWebSocket('dm_read', loadBadgesDelayed);

  function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }

  const fetchQuickResults = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setSearchResults([]); return; }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}&limit=8`);
      const data = await res.json();
      setSearchResults(data.results || []);
      setSearchSelected(-1);
    } catch { setSearchResults([]); }
  }, []);

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    clearTimeout(debounceRef.current);
    // Don't search while typing a type prefix (e.g. "forum:" with no query yet)
    const prefixMatch = value.match(/^(\w+):\s*(.*)$/);
    const searchText = prefixMatch ? prefixMatch[2] : value;
    if (searchText.trim().length < 2) { setSearchResults([]); return; }
    debounceRef.current = setTimeout(() => fetchQuickResults(value), 50);
  }

  function selectResult(r: QuickResult) {
    setSearchOpen(false); setSearchQuery(''); setSearchResults([]);
    navigate(r.url);
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); return; }
    if (e.key === 'Enter') {
      if (searchSelected >= 0 && searchResults[searchSelected]) { e.preventDefault(); selectResult(searchResults[searchSelected]); }
      else if (searchQuery.trim()) { setSearchOpen(false); setSearchResults([]); navigate(`/search?q=${encodeURIComponent(searchQuery)}`); setSearchQuery(''); }
      return;
    }
    if (searchResults.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchSelected(i => Math.min(i + 1, searchResults.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchSelected(i => Math.max(i - 1, 0)); }
  }

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) { setSearchOpen(false); setSearchResults([]); }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Focus input when opened
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);

  // Ctrl+K shortcut
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(true); }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  function isGroupActive(group: typeof navGroups[number]): boolean {
    return group.subgroups.some(sub =>
      sub.items.some(item => location.pathname === item.path.split('?')[0])
    );
  }

  const duration = sessionStats
    ? formatDuration(Date.now() - sessionStats.startTime)
    : '0m';

  return (
    <header className={styles.header}>
      <Link to="/pack" className={styles.logo}>
        🐾 The Den
        <span className={styles.version}>{__APP_VERSION__}</span>
      </Link>

      <nav className={styles.nav}>
        {activeTopNav.map(item => {
          const badgeCount = item.path === '/specs' ? badges.specs
            : item.path === '/prowl' ? badges.prowl
            : item.path === '/dms' ? badges.dms
            : 0;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`${styles.navLink} ${location.pathname === item.path ? styles.active : ''}`}
              onClick={(e) => {
                if (location.pathname === item.path && location.search) {
                  e.preventDefault();
                  navigate(item.path);
                }
              }}
            >
              {item.label}
              {badgeCount > 0 && <span className={styles.navBadge}>{badgeCount}</span>}
            </Link>
          );
        })}
        {activeNavGroups.map(group => (
          <div
            key={group.label}
            className={styles.dropdown}
            onMouseEnter={() => {
              if (!isTouchDevice) {
                if (dropdownTriggerRef.current) {
                  const rect = dropdownTriggerRef.current.getBoundingClientRect();
                  const left = Math.min(rect.left, window.innerWidth - 168);
                  setDropdownPos({ top: rect.bottom + 4, left: Math.max(8, left) });
                }
                setOpenGroup(group.label);
              }
            }}
            onMouseLeave={() => !isTouchDevice && setOpenGroup(null)}
          >
            <button
              ref={dropdownTriggerRef}
              type="button"
              className={`${styles.navLink} ${styles.dropdownTrigger} ${isGroupActive(group) ? styles.active : ''}`}
              onClick={() => {
                setOpenGroup(prev => {
                  if (prev === group.label) return null;
                  // Calculate position from trigger button, clamp to viewport
                  if (dropdownTriggerRef.current) {
                    const rect = dropdownTriggerRef.current.getBoundingClientRect();
                    const menuWidth = 160;
                    const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
                    setDropdownPos({ top: rect.bottom + 4, left: Math.max(8, left) });
                  }
                  return group.label;
                });
              }}
            >
              {group.label} ▾
              {badges.rules > 0 && <span className={styles.navBadge}>{badges.rules}</span>}
            </button>
            {openGroup === group.label && dropdownPos && createPortal(
              <>
                <div className={styles.dropdownBackdrop} onClick={() => setOpenGroup(null)} />
                <div
                  className={styles.dropdownMenu}
                  style={{
                    position: 'fixed',
                    top: dropdownPos.top,
                    left: Math.min(dropdownPos.left, window.innerWidth - 200),
                    zIndex: 1100,
                  }}
                >
                  {group.subgroups.map(sub => (
                    <div key={sub.label} className={styles.dropdownSubgroup}>
                      <div className={styles.dropdownSubgroupLabel}>{sub.label}</div>
                      {sub.items.map(item => (
                        <Link
                          key={item.path}
                          to={item.path}
                          className={`${styles.dropdownItem} ${location.pathname === item.path.split('?')[0] ? styles.active : ''}`}
                          onClick={() => setOpenGroup(null)}
                        >
                          {item.label}
                          {item.path === '/rules' && badges.rules > 0 && <span className={styles.navBadge}>{badges.rules}</span>}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              </>,
              document.body
            )}
          </div>
        ))}
      </nav>

      <div className={styles.quickSearch} ref={searchRef}>
        {searchOpen ? (
          <>
            <input
              ref={searchInputRef}
              type="text"
              className={styles.quickSearchInput}
              placeholder="Search everything..."
              value={searchQuery}
              onChange={e => handleSearchInput(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {searchResults.length > 0 && (
              <div className={styles.quickSearchResults}>
                {searchResults.map((r, i) => (
                  <div
                    key={`${r.source_type}-${r.source_id}-${i}`}
                    className={`${styles.quickSearchItem} ${i === searchSelected ? styles.quickSearchItemActive : ''}`}
                    onClick={() => selectResult(r)}
                    onMouseEnter={() => setSearchSelected(i)}
                  >
                    <span className={styles.quickSearchIcon}>{TYPE_ICONS[r.source_type] || '📄'}</span>
                    <span className={styles.quickSearchLabel}>{r.title}</span>
                    <span className={styles.quickSearchType}>{r.source_type}</span>
                  </div>
                ))}
                <div className={styles.quickSearchFooter} onClick={() => { setSearchOpen(false); setSearchResults([]); navigate(`/search?q=${encodeURIComponent(searchQuery)}`); setSearchQuery(''); }}>
                  View all results →
                </div>
              </div>
            )}
          </>
        ) : (
          <button className={styles.quickSearchToggle} onClick={() => setSearchOpen(true)} title="Search (Ctrl+K)">
            🔍 <span className={styles.quickSearchHint}>Ctrl+K</span>
          </button>
        )}
      </div>

      <div className={styles.sessionStats}>
        {isGuest ? (
          <span className={styles.statItem} style={{ color: 'var(--text-secondary)' }}>
            Guest: {guestName || 'Visitor'}
          </span>
        ) : (
          <>
            <span className={styles.statItem}>
              Session: {duration}
            </span>
            <span className={styles.statItem}>
              {sessionStats?.searches || 0} searches
            </span>
            <span className={styles.statItem}>
              {sessionStats?.learnings || 0} learnings
            </span>
          </>
        )}
        <span className={styles.dividerSmall} />
        {!isGuest && onRemoteToggle && (
          <button onClick={onRemoteToggle} className={styles.settingsLink} title="Remote Control" style={{ position: 'relative' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
            {badges.dms > 0 && <span className={styles.remoteBadge}>{badges.dms > 99 ? '99+' : badges.dms}</span>}
          </button>
        )}
        {!isGuest && (
          <button onClick={() => openChat('sable', 'Sable')} className={styles.settingsLink} title="Chat with Sable">
            <img src="/api/f/e8ba613f-e2cd-47b7-a385-a05b6b2ee0ae.jpg" alt="Sable" style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'cover' }} />
          </button>
        )}
        {true && (
          <Link to="/settings" className={styles.settingsLink} title="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        )}
        {authEnabled && isAuthenticated && (
          <button onClick={logout} className={styles.logoutButton} title="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}

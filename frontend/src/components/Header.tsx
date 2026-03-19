import { Link, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from './Header.module.css';

// Top-level nav items (always visible, not grouped)
const topNavItems = [
  { path: '/', label: 'Pack' },
  { path: '/forum', label: 'Forum' },
  { path: '/dms', label: 'DMs' },
  { path: '/mindlink', label: 'Mindlink' },
  { path: '/board', label: 'Board' },
];

// Grouped navigation (dropdowns for secondary items)
const navGroups = [
  {
    label: 'More',
    items: [
      { path: '/library', label: 'Library' },
      { path: '/groups', label: 'Groups' },
      { path: '/playbook', label: 'Playbook' },
      { path: '/overview', label: 'Overview' },
      { path: '/feed', label: 'Feed' },
      { path: '/search', label: 'Search' },
      { path: '/graph', label: 'Graph' },
      { path: '/map', label: 'Map' },
      { path: '/activity?tab=searches', label: 'Activity' },
      { path: '/evolution', label: 'Evolution' },
      { path: '/traces', label: 'Traces' },
      { path: '/superseded', label: 'Superseded' },
      { path: '/scheduler', label: 'Scheduler' },
      { path: '/notifications', label: 'Notifications' },
      { path: '/handoff', label: 'Handoff' },
    ],
  },
];

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
  const { isAuthenticated, authEnabled, logout } = useAuth();
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const isTouchDevice = 'ontouchstart' in window;
  const [sessionStartTime] = useState(() => {
    const stored = localStorage.getItem('oracle_session_start');
    if (stored) return parseInt(stored);
    const now = Date.now();
    localStorage.setItem('oracle_session_start', String(now));
    return now;
  });

  useEffect(() => {
    loadSessionStats();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadSessionStats();
    }, 30000);
    return () => clearInterval(interval);
  }, [sessionStartTime]);

  async function loadSessionStats() {
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

  function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }

  function isGroupActive(group: typeof navGroups[number]): boolean {
    return group.items.some(item => location.pathname === item.path.split('?')[0]);
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
        {topNavItems.map(item => (
          <Link
            key={item.path}
            to={item.path}
            className={`${styles.navLink} ${location.pathname === item.path ? styles.active : ''}`}
          >
            {item.label}
          </Link>
        ))}
        {navGroups.map(group => (
          <div
            key={group.label}
            className={styles.dropdown}
            onMouseEnter={() => !isTouchDevice && setOpenGroup(group.label)}
            onMouseLeave={() => !isTouchDevice && setOpenGroup(null)}
          >
            <button
              type="button"
              className={`${styles.navLink} ${styles.dropdownTrigger} ${isGroupActive(group) ? styles.active : ''}`}
              onClick={() => setOpenGroup(prev => prev === group.label ? null : group.label)}
            >
              {group.label} ▾
            </button>
            {openGroup === group.label && (
              <>
                {isTouchDevice && <div className={styles.dropdownBackdrop} onClick={() => setOpenGroup(null)} />}
                <div className={styles.dropdownMenu}>
                  {group.items.map(item => (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`${styles.dropdownItem} ${location.pathname === item.path.split('?')[0] ? styles.active : ''}`}
                      onClick={() => setOpenGroup(null)}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
      </nav>

      <div className={styles.sessionStats}>
        <span className={styles.statItem}>
          Session: {duration}
        </span>
        <span className={styles.statItem}>
          {sessionStats?.searches || 0} searches
        </span>
        <span className={styles.statItem}>
          {sessionStats?.learnings || 0} learnings
        </span>
        <span className={styles.dividerSmall} />
        {onRemoteToggle && (
          <button onClick={onRemoteToggle} className={styles.settingsLink} title="Remote Control">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
          </button>
        )}
        <a href="https://github.com/users/alliedgorn/projects/1/views/1" target="_blank" rel="noopener noreferrer" className={styles.settingsLink} title="Project Board">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        </a>
        <Link to="/settings" className={styles.settingsLink} title="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
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

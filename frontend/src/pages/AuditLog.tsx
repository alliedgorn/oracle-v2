import { useState, useEffect } from 'react';
import styles from './AuditLog.module.css';

interface AuditEntry {
  id: number;
  timestamp: string;
  actor: string;
  actor_type: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_source: string;
  request_method: string;
  request_path: string;
  status_code: number;
}

interface AuditStats {
  total: number;
  denied: number;
  errors: number;
  by_actor: { actor: string; count: number }[];
  by_resource: { resource_type: string; count: number }[];
  by_method: { request_method: string; count: number }[];
}

const API_BASE = '/api';
const METHOD_COLORS: Record<string, string> = {
  GET: '#4a9eff',
  POST: '#4ade80',
  PATCH: '#fbbf24',
  PUT: '#f97316',
  DELETE: '#ef4444',
};

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('en-GB', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
}

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const limit = 50;

  // Filters
  const [actorFilter, setActorFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showStats, setShowStats] = useState(false);

  async function loadEntries() {
    try {
      let url = `${API_BASE}/audit?limit=${limit}&offset=${page * limit}`;
      if (actorFilter) url += `&actor=${actorFilter}`;
      if (methodFilter) url += `&method=${methodFilter}`;
      if (resourceFilter) url += `&resource_type=${resourceFilter}`;
      if (statusFilter) url += `&status_code=${statusFilter}`;
      const res = await fetch(url);
      if (res.status === 403) {
        setError('Access denied — audit logs are restricted to Gorn.');
        setEntries([]);
        return;
      }
      const data = await res.json();
      setEntries(data.audit || []);
      setTotal(data.total || 0);
      setError('');
    } catch {
      setError('Failed to load audit logs');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadStats() {
    try {
      const res = await fetch(`${API_BASE}/audit/stats`);
      if (res.ok) {
        setStats(await res.json());
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadEntries();
  }, [page, actorFilter, methodFilter, resourceFilter, statusFilter]);

  useEffect(() => {
    if (showStats && !stats) loadStats();
  }, [showStats]);

  const totalPages = Math.ceil(total / limit);
  const statusClass = (code: number) => {
    if (code >= 500) return styles.statusError;
    if (code >= 400) return styles.statusWarn;
    return styles.statusOk;
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Audit Log</h1>
        <div className={styles.controls}>
          <button
            className={`${styles.toggleBtn} ${showStats ? styles.active : ''}`}
            onClick={() => setShowStats(!showStats)}
          >
            Stats
          </button>
          <button className={styles.refreshBtn} onClick={() => { loadEntries(); if (showStats) loadStats(); }}>
            Refresh
          </button>
        </div>
      </div>

      {showStats && stats && (
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{stats.total}</div>
            <div className={styles.statLabel}>Total Events</div>
          </div>
          <div className={`${styles.statCard} ${styles.statDanger}`}>
            <div className={styles.statValue}>{stats.denied}</div>
            <div className={styles.statLabel}>Denied (403)</div>
          </div>
          <div className={`${styles.statCard} ${styles.statError}`}>
            <div className={styles.statValue}>{stats.errors}</div>
            <div className={styles.statLabel}>Errors (5xx)</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Top Actors</div>
            <div className={styles.statList}>
              {stats.by_actor.slice(0, 5).map(a => (
                <span key={a.actor} className={styles.statChip} onClick={() => setActorFilter(a.actor)}>
                  {a.actor}: {a.count}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className={styles.filters}>
        <input
          className={styles.filterInput}
          type="text"
          placeholder="Actor..."
          value={actorFilter}
          onChange={e => { setActorFilter(e.target.value); setPage(0); }}
        />
        <select
          className={styles.filterSelect}
          value={methodFilter}
          onChange={e => { setMethodFilter(e.target.value); setPage(0); }}
        >
          <option value="">All Methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PATCH">PATCH</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
        </select>
        <input
          className={styles.filterInput}
          type="text"
          placeholder="Resource type..."
          value={resourceFilter}
          onChange={e => { setResourceFilter(e.target.value); setPage(0); }}
        />
        <select
          className={styles.filterSelect}
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(0); }}
        >
          <option value="">All Status</option>
          <option value="200">200 OK</option>
          <option value="201">201 Created</option>
          <option value="400">400 Bad Request</option>
          <option value="403">403 Forbidden</option>
          <option value="404">404 Not Found</option>
          <option value="500">500 Error</option>
        </select>
        {(actorFilter || methodFilter || resourceFilter || statusFilter) && (
          <button className={styles.clearBtn} onClick={() => {
            setActorFilter(''); setMethodFilter(''); setResourceFilter(''); setStatusFilter(''); setPage(0);
          }}>
            Clear
          </button>
        )}
      </div>

      {error ? (
        <div className={styles.error}>{error}</div>
      ) : loading ? (
        <div className={styles.empty}>Loading...</div>
      ) : entries.length === 0 ? (
        <div className={styles.empty}>No audit entries found</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Resource</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className={e.status_code >= 400 ? styles.rowWarn : ''}>
                    <td className={styles.timeCell} title={e.timestamp}>
                      {formatTimestamp(e.timestamp)}
                    </td>
                    <td>
                      <span
                        className={styles.actor}
                        onClick={() => setActorFilter(e.actor)}
                        title={`${e.actor_type}`}
                      >
                        {e.actor}
                      </span>
                    </td>
                    <td>
                      <span
                        className={styles.method}
                        style={{ color: METHOD_COLORS[e.request_method] || '#888' }}
                      >
                        {e.request_method}
                      </span>
                    </td>
                    <td className={styles.pathCell}>{e.request_path}</td>
                    <td>
                      <span className={`${styles.statusBadge} ${statusClass(e.status_code)}`}>
                        {e.status_code}
                      </span>
                    </td>
                    <td>
                      {e.resource_type && (
                        <span
                          className={styles.resourceChip}
                          onClick={() => setResourceFilter(e.resource_type || '')}
                        >
                          {e.resource_type}{e.resource_id ? `/${e.resource_id}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.pagination}>
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
            <span>{page + 1} / {totalPages || 1} ({total} entries)</span>
            <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}

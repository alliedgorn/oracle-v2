import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import styles from './Risk.module.css';

interface RiskItem {
  id: number;
  title: string;
  description: string | null;
  category: string;
  severity: string;
  likelihood: string;
  risk_score: number;
  impact_notes: string | null;
  status: string;
  mitigation: string | null;
  owner: string | null;
  source: string | null;
  source_type: string | null;
  risk_type: string | null;
  thread_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
}

interface RiskComment {
  id: number;
  risk_id: number;
  author: string;
  content: string;
  created_at: string;
}

interface Summary {
  total: number;
  by_severity: Record<string, number>;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  stale_count: number;
  matrix: { severity: string; likelihood: string; count: number }[];
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const LIKELIHOODS = ['rare', 'unlikely', 'possible', 'likely', 'almost_certain'];
const SEV_NUM: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const LIK_NUM: Record<string, number> = { almost_certain: 5, likely: 4, possible: 3, unlikely: 2, rare: 1 };

function scoreClass(score: number): string {
  if (score >= 16) return styles.score16to25;
  if (score >= 10) return styles.score10to15;
  if (score >= 5) return styles.score5to9;
  return styles.score1to4;
}

function sevClass(sev: string): string {
  const map: Record<string, string> = {
    critical: styles.sevCritical, high: styles.sevHigh, medium: styles.sevMedium,
    low: styles.sevLow, info: styles.sevInfo,
  };
  return map[sev] || styles.sevInfo;
}

function riskBorderClass(sev: string): string {
  const map: Record<string, string> = {
    critical: styles.riskCritical, high: styles.riskHigh, medium: styles.riskMedium,
    low: styles.riskLow, info: styles.riskInfo,
  };
  return map[sev] || '';
}

function isStale(reviewedAt: string | null, status: string): boolean {
  if (!['open', 'mitigating'].includes(status)) return false;
  if (!reviewedAt) return true;
  const diff = Date.now() - new Date(reviewedAt).getTime();
  return diff > 7 * 86400000;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function Risk() {
  const [risks, setRisks] = useState<RiskItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [matrixFilter, setMatrixFilter] = useState<{ sev: string; lik: string } | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [comments, setComments] = useState<RiskComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);

  const loadComments = useCallback(async (riskId: number) => {
    const res = await fetch(`/api/risks/${riskId}/comments`);
    if (res.ok) {
      const data = await res.json();
      setComments(data.comments);
    }
  }, []);

  const submitComment = async (riskId: number) => {
    if (!commentText.trim() || submittingComment) return;
    setSubmittingComment(true);
    try {
      const res = await fetch(`/api/risks/${riskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentText.trim() }),
      });
      if (res.ok) {
        setCommentText('');
        loadComments(riskId);
      }
    } finally {
      setSubmittingComment(false);
    }
  };

  const changeStatus = async (riskId: number, newStatus: string) => {
    await fetch(`/api/risks/${riskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
  };

  const loadRisks = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    if (severityFilter) params.set('severity', severityFilter);
    if (matrixFilter) {
      params.set('severity', matrixFilter.sev);
      params.set('likelihood', matrixFilter.lik);
    }
    const res = await fetch(`/api/risks?${params}`);
    const data = await res.json();
    setRisks(data.risks);
  }, [statusFilter, categoryFilter, severityFilter, matrixFilter]);

  const loadSummary = useCallback(async () => {
    const res = await fetch('/api/risks/summary');
    setSummary(await res.json());
  }, []);

  useEffect(() => { loadRisks(); }, [loadRisks]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  useEffect(() => {
    if (expandedId) loadComments(expandedId);
    else setComments([]);
  }, [expandedId, loadComments]);

  useWebSocket('risk_update', () => {
    loadRisks(); loadSummary();
    if (expandedId) loadComments(expandedId);
  });

  function getMatrixCount(sev: string, lik: string): number {
    if (!summary) return 0;
    const m = summary.matrix.find(r => r.severity === sev && r.likelihood === lik);
    return m?.count || 0;
  }

  function clickMatrix(sev: string, lik: string) {
    if (matrixFilter?.sev === sev && matrixFilter?.lik === lik) {
      setMatrixFilter(null);
      setSeverityFilter('');
    } else {
      setMatrixFilter({ sev, lik });
      setSeverityFilter('');
      setStatusFilter('');
      setCategoryFilter('');
    }
  }

  function clickStatus(s: string) {
    setMatrixFilter(null);
    setStatusFilter(statusFilter === s ? '' : s);
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Risk Register</h1>
        <p className={styles.subtitle}>
          {summary ? `${summary.total} total risks · ${summary.by_status?.open || 0} open · ${summary.stale_count} stale` : 'Loading...'}
        </p>
      </div>

      {/* Risk Matrix Heatmap */}
      <div className={styles.matrix}>
        <div className={styles.matrixGrid}>
          {/* Header row: empty + likelihood labels */}
          <div className={styles.matrixLabel} />
          {LIKELIHOODS.map(l => (
            <div key={l} className={styles.matrixLabel}>{l.replace('_', ' ')}</div>
          ))}

          {/* Rows: severity label + cells */}
          {SEVERITIES.map(sev => (
            <>
              <div key={`label-${sev}`} className={`${styles.matrixLabel} ${styles.matrixLabelY}`}>{sev}</div>
              {LIKELIHOODS.map(lik => {
                const count = getMatrixCount(sev, lik);
                const score = SEV_NUM[sev] * LIK_NUM[lik];
                const isActive = matrixFilter?.sev === sev && matrixFilter?.lik === lik;
                return (
                  <div
                    key={`${sev}-${lik}`}
                    className={`${styles.matrixCell} ${count > 0 ? scoreClass(score) : styles.matrixCellEmpty} ${isActive ? styles.matrixActive : ''}`}
                    onClick={() => count > 0 && clickMatrix(sev, lik)}
                    title={`${sev} × ${lik} = ${score} (${count} risks)`}
                  >
                    {count > 0 ? count : ''}
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>

      {/* Summary Bar */}
      <div className={styles.summary}>
        {['open', 'mitigating', 'accepted', 'mitigated', 'closed'].map(s => (
          <button
            key={s}
            className={`${styles.summaryPill} ${statusFilter === s ? styles.summaryActive : ''}`}
            onClick={() => clickStatus(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
            <span className={styles.pillBadge}>{summary?.by_status?.[s] || 0}</span>
          </button>
        ))}
        {summary && summary.stale_count > 0 && (
          <button
            className={`${styles.summaryPill} ${styles.pillDanger}`}
            onClick={() => { setMatrixFilter(null); setStatusFilter(''); setSeverityFilter(''); }}
          >
            Stale <span className={styles.pillBadge}>{summary.stale_count}</span>
          </button>
        )}
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <select className={styles.filterSelect} value={severityFilter} onChange={e => { setSeverityFilter(e.target.value); setMatrixFilter(null); }}>
          <option value="">All Severities</option>
          {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={styles.filterSelect} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
          <option value="">All Categories</option>
          {Object.keys(summary?.by_category || {}).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Risk List */}
      {risks.length === 0 ? (
        <div className={styles.empty}>No risks found. The den is safe... for now.</div>
      ) : (
        <div className={styles.riskList}>
          {risks.map(risk => (
            <div key={risk.id}>
              <div
                className={`${styles.riskItem} ${riskBorderClass(risk.severity)}`}
                onClick={() => setExpandedId(expandedId === risk.id ? null : risk.id)}
              >
                <div className={styles.riskContent}>
                  <div className={styles.riskTitle}>{risk.title}</div>
                  <div className={styles.riskMeta}>
                    <span className={`${styles.severityBadge} ${sevClass(risk.severity)}`}>{risk.severity}</span>
                    <span className={styles.statusBadge}>{risk.status}</span>
                    <span className={styles.scoreTag}>Score: {risk.risk_score}</span>
                    <span className={styles.categoryTag}>{risk.category}</span>
                    {risk.owner && <span className={styles.ownerTag}>@{risk.owner}</span>}
                    {isStale(risk.reviewed_at, risk.status) && <span className={styles.staleTag}>STALE</span>}
                  </div>
                </div>
              </div>

              {expandedId === risk.id && (
                <div className={styles.riskExpanded}>
                  {risk.description && <div className={styles.riskDescription}>{risk.description}</div>}

                  <div className={styles.riskField}>
                    <label>Status</label>
                    <select
                      className={styles.statusSelect}
                      value={risk.status}
                      onChange={(e) => changeStatus(risk.id, e.target.value)}
                    >
                      {['open', 'mitigating', 'accepted', 'mitigated', 'closed'].map(s => (
                        <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                      ))}
                    </select>
                  </div>

                  {risk.mitigation && (
                    <div className={styles.riskField}>
                      <label>Mitigation</label>
                      <span>{risk.mitigation}</span>
                    </div>
                  )}
                  {risk.impact_notes && (
                    <div className={styles.riskField}>
                      <label>Impact Notes</label>
                      <span>{risk.impact_notes}</span>
                    </div>
                  )}
                  <div className={styles.riskField}>
                    <label>Likelihood</label>
                    <span>{risk.likelihood.replace('_', ' ')}</span>
                  </div>
                  {risk.risk_type && (
                    <div className={styles.riskField}>
                      <label>Risk Type</label>
                      <span>{risk.risk_type}</span>
                    </div>
                  )}
                  <div className={styles.riskSource}>
                    Created by {risk.created_by} {formatDate(risk.created_at)}
                    {risk.source && ` · Source: ${risk.source}`}
                    {risk.thread_id && ` · Thread #${risk.thread_id}`}
                    {risk.reviewed_at && ` · Reviewed ${formatDate(risk.reviewed_at)}`}
                  </div>

                  {/* Comments */}
                  <div className={styles.commentsSection}>
                    <div className={styles.commentsTitle}>Comments ({comments.length})</div>
                    {comments.length > 0 && (
                      <div className={styles.commentsList}>
                        {comments.map(comment => (
                          <div key={comment.id} className={styles.commentItem}>
                            <div className={styles.commentHeader}>
                              <span className={styles.commentAuthor}>@{comment.author}</span>
                              <span className={styles.commentTime}>{formatDate(comment.created_at)}</span>
                            </div>
                            <div className={styles.commentContent}>{comment.content}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className={styles.commentForm}>
                      <input
                        className={styles.commentInput}
                        placeholder="Add a comment..."
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && submitComment(risk.id)}
                      />
                      <button
                        className={styles.commentSubmit}
                        onClick={() => submitComment(risk.id)}
                        disabled={!commentText.trim() || submittingComment}
                      >
                        Post
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

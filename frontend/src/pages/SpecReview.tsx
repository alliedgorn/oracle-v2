import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './SpecReview.module.css';

interface SpecVersion {
  hash: string;
  short: string;
  date: string;
  subject: string;
  author: string;
}

interface Spec {
  id: number;
  repo: string;
  file_path: string;
  task_id: string | null;
  title: string;
  author: string;
  status: 'pending' | 'approved' | 'rejected';
  content?: string;
  reviewer_feedback: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const API_BASE = '/api';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

export function SpecReview() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [allSpecs, setAllSpecs] = useState<Spec[]>([]);
  const [selectedSpec, setSelectedSpec] = useState<Spec | null>(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [versions, setVersions] = useState<SpecVersion[]>([]);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const specParam = searchParams.get('spec');

  const loadSpecs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/specs`);
      const data = await res.json();
      setAllSpecs(data.specs || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const specs = filter === 'all' ? allSpecs : allSpecs.filter(s => s.status === filter);

  useEffect(() => { loadSpecs(); }, [loadSpecs]);

  useEffect(() => {
    if (!specParam) { setSelectedSpec(null); return; }
    fetch(`${API_BASE}/specs/${specParam}`)
      .then(r => r.json())
      .then(d => {
        if (d.id) setSelectedSpec(d);
        else setSelectedSpec(null);
      })
      .catch(() => setSelectedSpec(null));
  }, [specParam]);

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function statusBadge(status: string) {
    const cls = status === 'pending' ? styles.badgePending
      : status === 'approved' ? styles.badgeApproved
      : styles.badgeRejected;
    const label = status === 'pending' ? 'Pending'
      : status === 'approved' ? 'Approved'
      : 'Rejected';
    return <span className={cls}>{label}</span>;
  }

  async function loadHistory(specId: number) {
    try {
      const res = await fetch(`${API_BASE}/specs/${specId}/history`);
      const data = await res.json();
      setVersions(data.versions || []);
    } catch { setVersions([]); }
  }

  async function loadDiff(specId: number, from: string, to: string) {
    try {
      const res = await fetch(`${API_BASE}/specs/${specId}/diff?from=${from}&to=${to}`);
      const data = await res.json();
      setDiffText(data.diff || '');
    } catch { setDiffText(null); }
  }

  async function handleReview(action: 'approve' | 'reject') {
    if (!selectedSpec) return;
    if (action === 'reject' && !feedback.trim()) {
      alert('Feedback is required when rejecting a spec.');
      return;
    }
    setReviewing(true);
    try {
      const res = await fetch(`${API_BASE}/specs/${selectedSpec.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, feedback: feedback.trim() || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Review failed');
        setReviewing(false);
        return;
      }
      const updated = await res.json();
      setSelectedSpec(prev => prev ? { ...prev, ...updated } : null);
      setFeedback('');
      loadSpecs();
    } catch { /* ignore */ }
    setReviewing(false);
  }

  // Detail view
  if (selectedSpec) {
    return (
      <div className={styles.detail}>
        <button className={styles.backLink} onClick={() => setSearchParams({})}>
          ← Back to Specs
        </button>
        <div className={styles.detailHeader}>
          <div className={styles.detailTitleRow}>
            <h1 className={styles.detailTitle}>{selectedSpec.title}</h1>
            {statusBadge(selectedSpec.status)}
          </div>
          <div className={styles.detailMeta}>
            <span className={styles.metaItem}>{selectedSpec.repo}</span>
            <span className={styles.metaItem}>{selectedSpec.file_path}</span>
            <span className={styles.metaItem}>{selectedSpec.author}</span>
            {selectedSpec.task_id && <a href={`/board?task=${selectedSpec.task_id.replace(/\D/g, '')}`} className={styles.taskLink}>{selectedSpec.task_id}</a>}
            <span className={styles.metaItem}>{formatDate(selectedSpec.created_at)}</span>
          </div>
        </div>

        <div className={styles.detailContent}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const inline = !match && !String(children).includes('\n');
                return inline ? (
                  <code className={className} {...props}>{children}</code>
                ) : (
                  <SyntaxHighlighter style={oneDark} language={match?.[1] || 'text'} PreTag="div">
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                );
              },
            }}
          >
            {selectedSpec.content || '*Spec file not found on disk.*'}
          </ReactMarkdown>
        </div>

        {/* Review history for approved/rejected */}
        {selectedSpec.status !== 'pending' && selectedSpec.reviewer_feedback && (
          <div className={styles.reviewHistory}>
            <div className={styles.reviewHistoryHeader}>
              {statusBadge(selectedSpec.status)}
              <span className={styles.metaItem}>
                {selectedSpec.reviewed_at ? formatDate(selectedSpec.reviewed_at) : ''}
              </span>
            </div>
            <p className={styles.reviewFeedback}>{selectedSpec.reviewer_feedback}</p>
          </div>
        )}

        {selectedSpec.status === 'approved' && !selectedSpec.reviewer_feedback && (
          <div className={styles.reviewHistory}>
            <div className={styles.reviewHistoryHeader}>
              {statusBadge(selectedSpec.status)}
              <span className={styles.metaItem}>
                {selectedSpec.reviewed_at ? formatDate(selectedSpec.reviewed_at) : ''}
              </span>
            </div>
          </div>
        )}

        {/* Version history */}
        <div className={styles.versionSection}>
          <button
            className={styles.versionToggle}
            onClick={() => {
              if (!showHistory) {
                loadHistory(selectedSpec.id);
                setShowHistory(true);
              } else {
                setShowHistory(false);
                setDiffText(null);
              }
            }}
          >
            {showHistory ? '▾ Hide Version History' : '▸ Version History'}
          </button>
          {showHistory && versions.length > 0 && (
            <div className={styles.versionList}>
              {versions.map((v, i) => (
                <div key={v.hash} className={styles.versionItem}>
                  <div className={styles.versionMeta}>
                    <code className={styles.versionHash}>{v.short}</code>
                    <span>{v.subject}</span>
                    <span className={styles.versionDate}>{formatDate(v.date)}</span>
                  </div>
                  {i < versions.length - 1 && (
                    <button
                      className={styles.diffBtn}
                      onClick={() => loadDiff(selectedSpec.id, versions[i + 1].hash, v.hash)}
                    >
                      diff
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {showHistory && versions.length === 0 && (
            <p className={styles.versionEmpty}>No version history found.</p>
          )}
          {diffText !== null && (
            <pre className={styles.diffBlock}>{diffText || 'No changes between versions.'}</pre>
          )}
        </div>

        {/* Review controls — only for pending specs */}
        {selectedSpec.status === 'pending' && (
          <div className={styles.reviewControls}>
            <textarea
              className={styles.feedbackInput}
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="Feedback (optional for approve, required for reject)"
              rows={3}
            />
            <div className={styles.reviewButtons}>
              <button
                className={styles.approveBtn}
                onClick={() => handleReview('approve')}
                disabled={reviewing}
              >
                {reviewing ? 'Reviewing...' : 'Approve'}
              </button>
              <button
                className={styles.rejectBtn}
                onClick={() => handleReview('reject')}
                disabled={reviewing}
              >
                {reviewing ? 'Reviewing...' : 'Reject'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // List view
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Spec Review</h1>
        <p className={styles.subtitle}>SDD specs — review, approve, reject</p>
      </div>

      <div className={styles.filters}>
        {FILTERS.map(f => (
          <button
            key={f.id}
            className={`${styles.filterBtn} ${filter === f.id ? styles.filterActive : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {f.id !== 'all' && (
              <span className={styles.filterCount}>
                {allSpecs.filter(s => s.status === f.id).length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className={styles.specList}>
        {loading && <div className={styles.empty}>Loading...</div>}

        {!loading && specs.length === 0 && (
          <div className={styles.empty}>No specs found.</div>
        )}

        {!loading && specs.map(spec => (
          <div
            key={spec.id}
            className={styles.specCard}
            onClick={() => setSearchParams({ spec: String(spec.id) })}
          >
            <div className={styles.cardHeader}>
              <div className={styles.cardTitleRow}>
                {spec.task_id && <span className={styles.cardTaskId}>{spec.task_id}</span>}
                <span className={styles.cardTitle}>{spec.title}</span>
              </div>
              {statusBadge(spec.status)}
            </div>
            <div className={styles.cardMeta}>
              <span>{spec.author}</span>
              <span>{spec.repo}</span>
              <span>{formatDate(spec.updated_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

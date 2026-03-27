import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Rules.module.css';

interface Rule {
  id: number;
  type: 'decree' | 'norm';
  title: string;
  content: string;
  author: string;
  status: string;
  enforcement: string;
  scope: string;
  source_thread_id: number | null;
  created_at: string;
  archived_at: string | null;
  archived_by: string | null;
  approval_status: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
}

const API_BASE = '/api';

export function Rules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [tab, setTab] = useState<'decree' | 'norm'>('decree');
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newType, setNewType] = useState<'decree' | 'norm'>('norm');
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState('all');
  const [newThreadId, setNewThreadId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadRules(); }, [tab, showArchived]);

  async function loadRules() {
    const status = showArchived ? 'archived' : 'active';
    const res = await fetch(`${API_BASE}/rules?type=${tab}&status=${status}&include_pending=true`);
    const data = await res.json();
    setRules(data.rules || []);
  }

  async function approveRule(id: number) {
    await fetch(`${API_BASE}/rules/${id}/approve`, { method: 'POST' });
    loadRules();
  }

  async function rejectRule(id: number) {
    const reason = prompt('Rejection reason (optional):');
    await fetch(`${API_BASE}/rules/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '' }),
    });
    loadRules();
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    setLoading(true);
    try {
      await fetch(`${API_BASE}/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: newType, title: newTitle.trim(), content: newContent.trim(),
          scope: newScope || 'all', source_thread_id: newThreadId ? parseInt(newThreadId, 10) : null,
          author: 'gorn',
        }),
      });
      setNewTitle(''); setNewContent(''); setNewScope('all'); setNewThreadId('');
      setShowCreate(false);
      loadRules();
    } finally { setLoading(false); }
  }

  async function archiveRule(id: number) {
    await fetch(`${API_BASE}/rules/${id}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'gorn' }),
    });
    loadRules();
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Rules</h1>
        <div className={styles.headerActions}>
          <label className={styles.archivedToggle}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <button className={styles.createBtn} onClick={() => setShowCreate(!showCreate)}>
            + New Rule
          </button>
        </div>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'decree' ? styles.tabActive : ''}`}
          onClick={() => setTab('decree')}
        >
          Decrees
        </button>
        <button
          className={`${styles.tab} ${tab === 'norm' ? styles.tabActive : ''}`}
          onClick={() => setTab('norm')}
        >
          Norms
        </button>
      </div>

      {showCreate && (
        <form onSubmit={createRule} className={styles.createForm}>
          <div className={styles.formRow}>
            <select value={newType} onChange={e => setNewType(e.target.value as any)} className={styles.formSelect}>
              <option value="norm">Norm</option>
              <option value="decree">Decree</option>
            </select>
            <input
              placeholder="Rule title..."
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              className={styles.formInput}
              autoFocus
            />
          </div>
          <textarea
            placeholder="Rule content (markdown supported)..."
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            className={styles.formTextarea}
            rows={4}
          />
          <div className={styles.formRow}>
            <input
              placeholder="Scope (all, @infra, beast name...)"
              value={newScope}
              onChange={e => setNewScope(e.target.value)}
              className={styles.formInput}
            />
            <input
              placeholder="Source thread ID (optional)"
              value={newThreadId}
              onChange={e => setNewThreadId(e.target.value)}
              className={styles.formInput}
              type="number"
            />
            <button type="submit" className={styles.submitBtn} disabled={loading || !newTitle.trim() || !newContent.trim()}>
              {loading ? 'Creating...' : 'Create'}
            </button>
            <button type="button" className={styles.cancelBtn} onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className={styles.rulesList}>
        {rules.length === 0 && (
          <div className={styles.empty}>
            No {showArchived ? 'archived' : 'active'} {tab === 'decree' ? 'decrees' : 'norms'}.
          </div>
        )}
        {rules.map(rule => (
          <div
            key={rule.id}
            className={`${styles.ruleCard} ${rule.type === 'decree' ? styles.decree : styles.norm} ${rule.status === 'archived' ? styles.archived : ''}`}
          >
            <div className={styles.ruleHeader}>
              <span className={`${styles.typeBadge} ${rule.type === 'decree' ? styles.typeBadgeDecree : styles.typeBadgeNorm}`}>
                {rule.type === 'decree' ? 'Decree' : 'Norm'}
              </span>
              <h3 className={styles.ruleTitle}>{rule.title}</h3>
              {rule.scope !== 'all' && (
                <span className={styles.scopeBadge}>{rule.scope}</span>
              )}
            </div>
            <div className={styles.ruleContent}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{rule.content}</ReactMarkdown>
            </div>
            <div className={styles.ruleMeta}>
              <span className={styles.metaItem}>{rule.author}</span>
              <span className={styles.metaItem}>{formatDate(rule.created_at)}</span>
              <span className={styles.metaItem}>{rule.enforcement}</span>
              {rule.source_thread_id && (
                <a href={`/forum?thread=${rule.source_thread_id}`} className={styles.threadLink}>
                  Thread #{rule.source_thread_id}
                </a>
              )}
              {rule.status === 'archived' && rule.archived_by && (
                <span className={styles.archivedInfo}>
                  Archived by {rule.archived_by} on {rule.archived_at ? formatDate(rule.archived_at) : ''}
                </span>
              )}
              {rule.approval_status === 'pending' && (
                <span className={styles.pendingBadge}>Pending Approval</span>
              )}
              {rule.approval_status === 'rejected' && (
                <span className={styles.rejectedBadge}>Rejected{rule.rejection_reason ? `: ${rule.rejection_reason}` : ''}</span>
              )}
              {rule.approval_status === 'pending' && (
                <>
                  <button className={styles.approveBtn} onClick={() => approveRule(rule.id)}>Approve</button>
                  <button className={styles.rejectBtn} onClick={() => rejectRule(rule.id)}>Reject</button>
                </>
              )}
              {rule.status === 'active' && rule.approval_status !== 'pending' && (
                <button className={styles.archiveBtn} onClick={() => archiveRule(rule.id)}>Archive</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

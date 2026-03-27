import { useState, useEffect, useCallback } from 'react';
import styles from './Files.module.css';
import { formatFileSize } from '../components/FileUpload';

interface FileRecord {
  id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  context: string | null;
  context_id: number | null;
  created_at: string;
  deleted_at: string | null;
  url?: string;
}

interface FileStats {
  total_files: number;
  total_size: number;
  by_type: Record<string, { count: number; size: number }>;
}

const API_BASE = '/api';
const PAGE_SIZE = 20;

function getFileTypeIcon(mimeType: string, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (mimeType.startsWith('image/')) return '\u{1F5BC}';
  if (['pdf', 'doc', 'docx'].includes(ext)) return '\u{1F4C4}';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '\u{1F4CA}';
  if (['txt', 'md', 'json'].includes(ext)) return '\u{1F4DD}';
  if (ext === 'zip') return '\u{1F4E6}';
  return '\u{1F4CE}';
}

function getTypeBadge(name: string): string {
  return (name.split('.').pop()?.toUpperCase()) || 'FILE';
}

function getCategoryFromMime(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || mime.includes('word') || mime.includes('document')) return 'document';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') return 'document';
  if (mime === 'application/zip') return 'archive';
  if (mime.startsWith('text/')) return 'document';
  return 'other';
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function contextLabel(context: string | null, contextId: number | null): string | null {
  if (!context || !contextId) return null;
  if (context === 'forum') return `Thread #${contextId}`;
  if (context === 'board') return `Task #${contextId}`;
  if (context === 'dm') return `DM`;
  return context;
}

function contextLink(context: string | null, contextId: number | null): string | null {
  if (!context || !contextId) return null;
  if (context === 'forum') return `/forum`;
  if (context === 'board') return `/board`;
  if (context === 'dm') return `/dms`;
  return null;
}

const ANIMAL_EMOJI: Record<string, string> = {
  karo: '\u{1F43E}', gnarl: '\u{1F40A}', zaghnal: '\u{1F40E}', bertus: '\u{1F43B}',
  leonard: '\u{1F981}', mara: '\u{1F998}', rax: '\u{1F99D}', pip: '\u{1F9A6}',
  nyx: '\u{1F426}\u200D\u2B1B', dex: '\u{1F419}', flint: '\u{1F43A}',
  quill: '\u{1F994}', snap: '\u{1F9A1}', vigil: '\u{1F989}', talon: '\u{1F985}',
  sable: '\u{1F43E}', gorn: '\u{1F451}',
};

export function Files() {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [stats, setStats] = useState<FileStats | null>(null);
  const [page, setPage] = useState(1);
  const [totalFiles, setTotalFiles] = useState(0);
  const [typeFilter, setTypeFilter] = useState('all');
  const [uploaderFilter, setUploaderFilter] = useState('all');
  const [contextFilter, setContextFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (typeFilter !== 'all') params.set('type', typeFilter);
    if (uploaderFilter !== 'all') params.set('uploaded_by', uploaderFilter);
    if (contextFilter !== 'all') params.set('context', contextFilter);

    try {
      const res = await fetch(`${API_BASE}/files?${params}`);
      const data = await res.json();
      setFiles(data.files || []);
      setTotalFiles(data.total || 0);
    } catch {
      setFiles([]);
    }
    setLoading(false);
  }, [page, typeFilter, uploaderFilter, contextFilter]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/files/stats`);
      const data = await res.json();
      setStats(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  async function handleDelete(id: number) {
    try {
      await fetch(`${API_BASE}/files/${id}`, { method: 'DELETE' });
      setDeleteConfirm(null);
      fetchFiles();
      fetchStats();
    } catch { /* ignore */ }
  }

  const totalPages = Math.ceil(totalFiles / PAGE_SIZE);
  const isImage = (mime: string) => mime.startsWith('image/');

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Files</h1>
        {stats && (
          <div className={styles.stats}>
            {stats.total_files} files &middot; {formatFileSize(stats.total_size)}
          </div>
        )}
      </div>

      <div className={styles.filters}>
        <select
          className={styles.filterSelect}
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="all">All types</option>
          <option value="image">Images</option>
          <option value="document">Documents</option>
          <option value="archive">Archives</option>
        </select>

        <select
          className={styles.filterSelect}
          value={uploaderFilter}
          onChange={(e) => { setUploaderFilter(e.target.value); setPage(1); }}
        >
          <option value="all">All uploaders</option>
          {['gorn', 'karo', 'gnarl', 'flint', 'dex', 'quill', 'pip', 'snap', 'vigil', 'talon', 'mara', 'rax', 'bertus', 'leonard', 'nyx', 'zaghnal', 'sable'].map(b => (
            <option key={b} value={b}>{ANIMAL_EMOJI[b] || ''} {b}</option>
          ))}
        </select>

        <select
          className={styles.filterSelect}
          value={contextFilter}
          onChange={(e) => { setContextFilter(e.target.value); setPage(1); }}
        >
          <option value="all">All sources</option>
          <option value="forum">Forum</option>
          <option value="board">Board</option>
          <option value="dm">DMs</option>
        </select>
      </div>

      {loading ? (
        <div className={styles.loading}>Loading files...</div>
      ) : files.length === 0 ? (
        <div className={styles.empty}>No files uploaded yet. Attach files in forum threads or board tasks.</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thPreview}></th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Uploaded by</th>
                  <th>Source</th>
                  <th>Date</th>
                  <th className={styles.thActions}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className={styles.row}>
                    <td className={styles.tdPreview}>
                      {isImage(f.mime_type) ? (
                        <img
                          src={f.url || `${API_BASE}/files/${f.id}/download`}
                          alt={f.original_name}
                          className={styles.previewThumb}
                        />
                      ) : (
                        <span className={styles.previewIcon}>{getFileTypeIcon(f.mime_type, f.original_name)}</span>
                      )}
                    </td>
                    <td className={styles.tdName} title={f.original_name}>
                      {f.original_name.length > 30 ? f.original_name.slice(0, 27) + '...' : f.original_name}
                    </td>
                    <td>
                      <span className={`${styles.typeBadge} ${styles[`badge${getCategoryFromMime(f.mime_type)}`] || ''}`}>
                        {getTypeBadge(f.original_name)}
                      </span>
                    </td>
                    <td className={styles.tdSize}>{formatFileSize(f.size_bytes)}</td>
                    <td className={styles.tdUploader}>
                      {ANIMAL_EMOJI[f.uploaded_by] || ''} {f.uploaded_by}
                    </td>
                    <td className={styles.tdContext}>
                      {contextLink(f.context, f.context_id) ? (
                        <a href={contextLink(f.context, f.context_id)!} className={styles.contextLink}>
                          {contextLabel(f.context, f.context_id)}
                        </a>
                      ) : (
                        <span className={styles.contextNone}>{'\u2014'}</span>
                      )}
                    </td>
                    <td className={styles.tdDate}>{formatTime(f.created_at)}</td>
                    <td className={styles.tdActions}>
                      <a
                        href={`${API_BASE}/files/${f.id}/download`}
                        download={f.original_name}
                        className={styles.actionBtn}
                        title="Download"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </a>
                      {deleteConfirm === f.id ? (
                        <span className={styles.confirmDelete}>
                          <button className={styles.confirmYes} onClick={() => handleDelete(f.id)}>Delete</button>
                          <button className={styles.confirmNo} onClick={() => setDeleteConfirm(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button
                          className={styles.actionBtn}
                          title="Delete"
                          onClick={() => setDeleteConfirm(f.id)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.pageBtn}
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
              >
                Prev
              </button>
              <span className={styles.pageInfo}>Page {page} of {totalPages}</span>
              <button
                className={styles.pageBtn}
                disabled={page === totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from '../components/MermaidDiagram';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './Library.module.css';
import { useAuth } from '../contexts/AuthContext';
import { FilterTabs } from '../components/FilterTabs';
import { EmojiButton } from '../components/EmojiButton';
import { FileUpload } from '../components/FileUpload';
import { VoiceInput } from '../components/VoiceInput';

interface Suggestion {
  id: number;
  label: string;
  type: 'shelf' | 'entry';
  icon?: string;
  color?: string;
  entryType?: string;
  author?: string;
  shelf_id?: number | null;
}

interface LibraryDoc {
  id: number;
  title: string;
  content: string;
  type: string;
  category?: string;
  author: string;
  authorColor?: string;
  preview?: string;
  tags: string[];
  shelf_id: number | null;
  created_at: string;
  updated_at: string;
}

interface Shelf {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  entry_count: number;
  created_by: string;
  visibility?: string;
}

const API_BASE = '/api';

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'research', label: 'Research' },
  { id: 'decision', label: 'Decisions' },
  { id: 'learning', label: 'Learnings' },
  { id: 'guide', label: 'Guides' },
];

export function Library() {
  const { isGuest } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<LibraryDoc | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [loading, setLoading] = useState(false);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [shelfFilter, setShelfFilter] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editType, setEditType] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editShelfId, setEditShelfId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [shelfModal, setShelfModal] = useState<'create' | 'edit' | null>(null);
  const [editingShelf, setEditingShelf] = useState<Shelf | null>(null);
  const [shelfName, setShelfName] = useState('');
  const [shelfDesc, setShelfDesc] = useState('');
  const [shelfIcon, setShelfIcon] = useState('');
  const [shelfColor, setShelfColor] = useState('');
  const [shelfSaving, setShelfSaving] = useState(false);
  const [shelfError, setShelfError] = useState('');
  const [shelfVisibility, setShelfVisibility] = useState('internal');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const docId = searchParams.get('doc');

  const loadShelves = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/library/shelves`);
      const data = await res.json();
      setShelves(data.shelves || []);
    } catch { /* ignore */ }
  }, []);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (category !== 'all') params.set('category', category);
      if (shelfFilter === 'ungrouped') params.set('shelf_id', 'null');
      else if (shelfFilter) params.set('shelf_id', shelfFilter);
      const res = await fetch(`${API_BASE}/library?${params}`);
      const data = await res.json();
      setDocs(data.entries || data.docs || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [search, category, shelfFilter]);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setSuggestions([]); return; }
    try {
      const res = await fetch(`${API_BASE}/library/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setSuggestions(data.suggestions || []);
      setShowSuggestions(true);
      setSelectedSuggestion(-1);
    } catch { setSuggestions([]); }
  }, []);

  function handleSearchChange(value: string) {
    setSearch(value);
    clearTimeout(debounceRef.current);
    if (value.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 200);
  }

  function selectSuggestion(s: Suggestion) {
    setShowSuggestions(false);
    if (s.type === 'shelf') {
      setShelfFilter(String(s.id));
      setSearch('');
    } else {
      setSearchParams({ doc: String(s.id) });
      setSearch('');
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedSuggestion(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedSuggestion(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && selectedSuggestion >= 0) { e.preventDefault(); selectSuggestion(suggestions[selectedSuggestion]); }
    else if (e.key === 'Escape') { setShowSuggestions(false); }
  }

  // Close suggestions on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSuggestions(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => { loadDocs(); loadShelves(); }, [loadDocs, loadShelves]);

  // Load single doc when docId is in URL
  useEffect(() => {
    if (!docId) { setSelectedDoc(null); return; }
    fetch(`${API_BASE}/library/${docId}`)
      .then(r => r.json())
      .then(d => setSelectedDoc(d.doc || d.id ? d : null))
      .catch(() => setSelectedDoc(null));
  }, [docId]);

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function startEditing() {
    if (!selectedDoc) return;
    setEditTitle(selectedDoc.title);
    setEditContent(selectedDoc.content);
    setEditType(selectedDoc.type || selectedDoc.category || 'learning');
    setEditTags(Array.isArray(selectedDoc.tags) ? selectedDoc.tags.join(', ') : (selectedDoc.tags || ''));
    setEditShelfId(selectedDoc.shelf_id ? String(selectedDoc.shelf_id) : '');
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  async function saveEdit() {
    if (!selectedDoc) return;
    setSaving(true);
    try {
      const tags = editTags.split(',').map(t => t.trim()).filter(Boolean);
      const res = await fetch(`${API_BASE}/library/${selectedDoc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle, content: editContent, type: editType, tags, shelf_id: editShelfId ? parseInt(editShelfId, 10) : null }),
      });
      if (!res.ok) throw new Error('Save failed');
      const updated = await res.json();
      const updatedDoc = updated.doc || updated;
      setSelectedDoc(updatedDoc);
      setEditing(false);
      loadDocs();
    } catch { /* ignore */ }
    setSaving(false);
  }

  function openCreateShelf() {
    setShelfName(''); setShelfDesc(''); setShelfIcon(''); setShelfColor(''); setShelfVisibility('internal');
    setShelfError(''); setEditingShelf(null); setShelfModal('create');
  }

  function openEditShelf(shelf: Shelf) {
    setShelfName(shelf.name); setShelfDesc(shelf.description || ''); setShelfIcon(shelf.icon || ''); setShelfColor(shelf.color || '');
    setShelfVisibility(shelf.visibility || 'internal');
    setShelfError(''); setEditingShelf(shelf); setShelfModal('edit');
  }

  async function saveShelf() {
    if (!shelfName.trim()) { setShelfError('Name is required'); return; }
    setShelfSaving(true); setShelfError('');
    try {
      const body = { name: shelfName.trim(), description: shelfDesc.trim() || null, icon: shelfIcon.trim() || null, color: shelfColor.trim() || null, visibility: shelfVisibility };
      const url = shelfModal === 'edit' && editingShelf ? `${API_BASE}/library/shelves/${editingShelf.id}` : `${API_BASE}/library/shelves`;
      const method = shelfModal === 'edit' ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shelfModal === 'create' ? { ...body, created_by: 'gorn' } : body) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Failed to save shelf'); }
      setShelfModal(null); loadShelves(); loadDocs();
    } catch (e: any) { setShelfError(e.message); }
    setShelfSaving(false);
  }

  async function deleteShelf(shelf: Shelf) {
    if (!window.confirm(`Delete shelf "${shelf.name}"? Entries will become ungrouped.`)) return;
    try {
      const res = await fetch(`${API_BASE}/library/shelves/${shelf.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      if (shelfFilter === String(shelf.id)) setShelfFilter('');
      setShelfModal(null); loadShelves(); loadDocs();
    } catch { /* ignore */ }
  }

  // Detail view
  if (selectedDoc) {
    return (
      <div className={styles.detail}>
        <button className={styles.backLink} onClick={() => {
          if (editing && !window.confirm('Discard unsaved changes?')) return;
          setSearchParams({}); setEditing(false);
        }}>
          ← Back to Library
        </button>
        {editing ? (
          <>
            <div className={styles.editForm}>
              <label className={styles.editLabel}>Title</label>
              <input
                className={styles.editInput}
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
              />
              <label className={styles.editLabel}>Type</label>
              <select
                className={styles.editSelect}
                value={editType}
                onChange={e => setEditType(e.target.value)}
              >
                <option value="learning">Learning</option>
                <option value="architecture">Architecture</option>
                <option value="research">Research</option>
                <option value="decision">Decision</option>
                <option value="guide">Guide</option>
              </select>
              <label className={styles.editLabel}>Shelf</label>
              <select
                className={styles.editSelect}
                value={editShelfId}
                onChange={e => setEditShelfId(e.target.value)}
              >
                <option value="">No shelf</option>
                {shelves.map(s => (
                  <option key={s.id} value={s.id}>{s.icon ? `${s.icon} ` : ''}{s.name}</option>
                ))}
              </select>
              <label className={styles.editLabel}>Tags (comma-separated)</label>
              <input
                className={styles.editInput}
                value={editTags}
                onChange={e => setEditTags(e.target.value)}
                placeholder="tag1, tag2, tag3"
              />
              <label className={styles.editLabel}>Content (Markdown)</label>
              <textarea
                className={styles.editTextarea}
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                rows={20}
              />
              <div className={styles.editActions}>
                <FileUpload onUploadComplete={(md) => setEditContent(prev => prev + md)} />
                <EmojiButton onSelect={(e) => setEditContent(prev => prev + e)} />
                <VoiceInput onTranscript={(text) => setEditContent(prev => prev ? prev + ' ' + text : text)} />
                <button className={styles.editSave} onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button className={styles.editCancel} onClick={cancelEditing}>Cancel</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={styles.detailHeader}>
              <div className={styles.detailTitleRow}>
                <h1 className={styles.detailTitle}>{selectedDoc.title}</h1>
                {!isGuest && <button className={styles.editButton} onClick={startEditing}>Edit</button>}
              </div>
              <div className={styles.detailMeta}>
                <span className={styles.entryId}>#{selectedDoc.id}</span>
                <span className={styles.author}>
                  <span className={styles.authorDot} style={{ backgroundColor: 'var(--text-muted)' }} />
                  {selectedDoc.author}
                </span>
                <span>{formatDate(selectedDoc.created_at)}</span>
                {selectedDoc.category && <span>{selectedDoc.category}</span>}
              </div>
            </div>
            <div className={styles.detailContent}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const lang = match?.[1];
                    const inline = !match && !String(children).includes('\n');
                    if (lang === 'mermaid') {
                      return <MermaidDiagram code={String(children).replace(/\n$/, '')} />;
                    }
                    return inline ? (
                      <code className={className} {...props}>{children}</code>
                    ) : (
                      <SyntaxHighlighter style={oneDark} language={lang || 'text'} PreTag="div">
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    );
                  },
                }}
              >
                {selectedDoc.content}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
    );
  }

  // List view
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Library</h1>
        <p className={styles.subtitle}>Pack knowledge — searchable, shareable, permanent</p>
      </div>

      <div className={styles.searchRow} ref={searchRef}>
        <div className={styles.searchWrapper}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search shelves and documents..."
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
            onKeyDown={handleSearchKeyDown}
          />
          {search && (
            <button className={styles.searchClear} onClick={() => { setSearch(''); setSuggestions([]); setShowSuggestions(false); }}>✕</button>
          )}
        </div>
        {showSuggestions && suggestions.length > 0 && (
          <div className={styles.suggestions}>
            {suggestions.map((s, i) => (
              <div
                key={`${s.type}-${s.id}`}
                className={`${styles.suggestionItem} ${i === selectedSuggestion ? styles.suggestionActive : ''}`}
                onClick={() => selectSuggestion(s)}
                onMouseEnter={() => setSelectedSuggestion(i)}
              >
                <span className={styles.suggestionIcon}>
                  {s.type === 'shelf' ? (s.icon || '📚') : '📄'}
                </span>
                <span className={styles.suggestionLabel}>{s.label}</span>
                <span className={styles.suggestionType} style={s.type === 'shelf' && s.color ? { color: s.color } : undefined}>
                  {s.type === 'shelf' ? 'Shelf' : s.entryType || 'Entry'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.shelfBar}>
        <button
          className={`${styles.shelfPill} ${!shelfFilter ? styles.shelfActive : ''}`}
          onClick={() => setShelfFilter('')}
        >All</button>
        {shelves.map(s => (
          <button
            key={s.id}
            className={`${styles.shelfPill} ${shelfFilter === String(s.id) ? styles.shelfActive : ''}`}
            onClick={() => setShelfFilter(shelfFilter === String(s.id) ? '' : String(s.id))}
            onContextMenu={!isGuest ? (e => { e.preventDefault(); openEditShelf(s); }) : undefined}
            style={s.color ? { borderColor: shelfFilter === String(s.id) ? s.color : undefined } : undefined}
          >
            {s.icon ? `${s.icon} ` : ''}{s.name}
            {!isGuest && s.visibility === 'public' && <span className={styles.visibilityPublic} title="Public">pub</span>}
            <span className={styles.shelfCount}>{s.entry_count}</span>
            {!isGuest && <span className={styles.shelfEdit} onClick={e => { e.stopPropagation(); openEditShelf(s); }} title="Edit shelf">✎</span>}
          </button>
        ))}
        {!isGuest && shelves.length > 0 && (
          <button
            className={`${styles.shelfPill} ${shelfFilter === 'ungrouped' ? styles.shelfActive : ''}`}
            onClick={() => setShelfFilter(shelfFilter === 'ungrouped' ? '' : 'ungrouped')}
          >Ungrouped</button>
        )}
        {!isGuest && <button className={styles.shelfAdd} onClick={openCreateShelf} title="Create shelf">+</button>}
      </div>

      {shelfModal && (
        <div className={styles.modalOverlay} onClick={() => setShelfModal(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>{shelfModal === 'create' ? 'Create Shelf' : 'Edit Shelf'}</h3>
            {shelfError && <div className={styles.modalError}>{shelfError}</div>}
            <label className={styles.editLabel}>Name *</label>
            <input className={styles.editInput} value={shelfName} onChange={e => setShelfName(e.target.value)} placeholder="e.g. Architecture Decisions" autoFocus />
            <label className={styles.editLabel}>Description</label>
            <input className={styles.editInput} value={shelfDesc} onChange={e => setShelfDesc(e.target.value)} placeholder="What goes on this shelf?" />
            <div className={styles.shelfFormRow}>
              <div className={styles.shelfFormField}>
                <label className={styles.editLabel}>Icon (emoji)</label>
                <input className={styles.editInput} value={shelfIcon} onChange={e => setShelfIcon(e.target.value)} placeholder="📚" style={{ width: 80 }} />
              </div>
              <div className={styles.shelfFormField}>
                <label className={styles.editLabel}>Color</label>
                <div className={styles.colorPicker}>
                  {['#ef4444','#f59e0b','#22c55e','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f97316'].map(c => (
                    <button key={c} className={`${styles.colorDot} ${shelfColor === c ? styles.colorDotActive : ''}`} style={{ backgroundColor: c }} onClick={() => setShelfColor(shelfColor === c ? '' : c)} />
                  ))}
                </div>
              </div>
            </div>
            <label className={styles.editLabel}>Visibility</label>
            <select className={styles.editInput} value={shelfVisibility} onChange={e => setShelfVisibility(e.target.value)} style={{ width: 'auto' }}>
              <option value="internal">Internal (Beasts only)</option>
              <option value="public">Public (visible to guests)</option>
            </select>
            <div className={styles.modalActions}>
              <button className={styles.editSave} onClick={saveShelf} disabled={shelfSaving}>{shelfSaving ? 'Saving...' : shelfModal === 'create' ? 'Create' : 'Save'}</button>
              <button className={styles.editCancel} onClick={() => setShelfModal(null)}>Cancel</button>
              {shelfModal === 'edit' && editingShelf && (
                <button className={styles.shelfDelete} onClick={() => deleteShelf(editingShelf)}>Delete Shelf</button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={styles.filters}>
        <FilterTabs
          items={CATEGORIES}
          activeId={category}
          onChange={setCategory}
          variant="compact"
        />
      </div>

      <div className={styles.docList}>
        {loading && <div className={styles.loading}>Loading...</div>}

        {!loading && docs.length === 0 && (
          <div className={styles.empty}>
            {search ? 'No documents match your search.' : 'No documents yet. Be the first to contribute.'}
          </div>
        )}

        {!loading && docs.map(doc => (
          <div
            key={doc.id}
            className={styles.docCard}
            onClick={() => setSearchParams({ doc: String(doc.id) })}
          >
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>{doc.title}</span>
              <span className={styles.entryId}>#{doc.id}</span>
              <span className={styles.cardDate}>{formatDate(doc.created_at)}</span>
            </div>
            {doc.content && (
              <p className={styles.cardPreview}>{doc.content.slice(0, 150).replace(/[#*`]/g, '')}{doc.content.length > 150 ? '...' : ''}</p>
            )}
            <div className={styles.cardMeta}>
              <span className={styles.author}>
                <span className={styles.authorDot} style={{ backgroundColor: 'var(--text-muted)' }} />
                {doc.author}
              </span>
              {doc.category && <span>{doc.category}</span>}
              {doc.shelf_id && (() => {
                const shelf = shelves.find(s => s.id === doc.shelf_id);
                return shelf ? (
                  <span className={styles.shelfBadge} style={shelf.color ? { borderColor: shelf.color, color: shelf.color } : undefined}>
                    {shelf.icon ? `${shelf.icon} ` : ''}{shelf.name}
                  </span>
                ) : null;
              })()}
              {(Array.isArray(doc.tags) ? doc.tags : []).length > 0 && (
                <div className={styles.tags}>
                  {(Array.isArray(doc.tags) ? doc.tags : []).slice(0, 3).map(tag => (
                    <span key={tag} className={styles.tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import styles from './Library.module.css';
import { SearchInput } from '../components/SearchInput';
import { FilterTabs } from '../components/FilterTabs';

interface LibraryDoc {
  id: string;
  title: string;
  content: string;
  preview: string;
  author: string;
  authorColor: string | null;
  category: string;
  tags: string[];
  created_at: string;
  updated_at: string;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<LibraryDoc | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [loading, setLoading] = useState(false);

  const docId = searchParams.get('doc');

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (category !== 'all') params.set('category', category);
      const res = await fetch(`${API_BASE}/library?${params}`);
      const data = await res.json();
      setDocs(data.entries || data.docs || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [search, category]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  // Load single doc when docId is in URL
  useEffect(() => {
    if (!docId) { setSelectedDoc(null); return; }
    fetch(`${API_BASE}/library/${docId}`)
      .then(r => r.json())
      .then(d => setSelectedDoc(d.doc || null))
      .catch(() => setSelectedDoc(null));
  }, [docId]);

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Detail view
  if (selectedDoc) {
    return (
      <div className={styles.detail}>
        <button className={styles.backLink} onClick={() => setSearchParams({})}>
          ← Back to Library
        </button>
        <div className={styles.detailHeader}>
          <h1 className={styles.detailTitle}>{selectedDoc.title}</h1>
          <div className={styles.detailMeta}>
            <span className={styles.author}>
              <span className={styles.authorDot} style={{ backgroundColor: selectedDoc.authorColor || 'var(--text-muted)' }} />
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
            {selectedDoc.content}
          </ReactMarkdown>
        </div>
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

      <div className={styles.searchRow}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search documents..."
          onClear={() => setSearch('')}
          showClear={search.length > 0}
        />
      </div>

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
            style={doc.authorColor ? { '--beast-color': doc.authorColor } as React.CSSProperties : undefined}
            onClick={() => setSearchParams({ doc: doc.id })}
          >
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>{doc.title}</span>
              <span className={styles.cardDate}>{formatDate(doc.created_at)}</span>
            </div>
            {doc.preview && (
              <p className={styles.cardPreview}>{doc.preview}</p>
            )}
            <div className={styles.cardMeta}>
              <span className={styles.author}>
                <span className={styles.authorDot} style={{ backgroundColor: doc.authorColor || 'var(--text-muted)' }} />
                {doc.author}
              </span>
              {doc.category && <span>{doc.category}</span>}
              {doc.tags.length > 0 && (
                <div className={styles.tags}>
                  {doc.tags.slice(0, 3).map(tag => (
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

import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import styles from './Search.module.css';

interface SearchResult {
  source_type: string;
  source_id: string;
  title: string;
  snippet: string;
  author: string;
  rank: number;
  created_at: string;
  url: string;
}

const TYPE_TABS = [
  { id: '', label: 'All' },
  { id: 'forum', label: 'Forum' },
  { id: 'library', label: 'Library' },
  { id: 'task', label: 'Tasks' },
  { id: 'spec', label: 'Specs' },
  { id: 'risk', label: 'Risks' },
];

const TYPE_ICONS: Record<string, string> = {
  forum: '💬', library: '📚', task: '✅', spec: '📋', risk: '⚠️',
};

export function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(false);
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') || '');

  useEffect(() => {
    const q = searchParams.get('q');
    const t = searchParams.get('type') || '';
    if (q) {
      setQuery(q);
      setTypeFilter(t);
      doSearch(q, t);
    }
  }, [searchParams]);

  async function doSearch(q: string, type?: string) {
    if (!q.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({ q: q.trim(), limit: '50' });
      if (type) params.set('type', type);
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      setResults(data.results || []);
      setTotal(data.total || 0);
    } catch {
      setResults([]);
      setTotal(0);
    }
    setLoading(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      const params: Record<string, string> = { q: query };
      if (typeFilter) params.type = typeFilter;
      setSearchParams(params);
    }
  }

  function handleTypeChange(type: string) {
    setTypeFilter(type);
    const q = searchParams.get('q');
    if (q) {
      const params: Record<string, string> = { q };
      if (type) params.type = type;
      setSearchParams(params);
    }
  }

  function navigateToResult(result: SearchResult) {
    navigate(result.url);
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Search</h1>

      <form onSubmit={handleSubmit} className={styles.form}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search forum, library, tasks, specs, risks..."
          className={styles.input}
          autoFocus
        />
        <button type="submit" className={styles.button}>Search</button>
      </form>

      {searched && (
        <div className={styles.typeTabs}>
          {TYPE_TABS.map(t => (
            <button
              key={t.id}
              className={`${styles.typeTab} ${typeFilter === t.id ? styles.typeTabActive : ''}`}
              onClick={() => handleTypeChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {loading && <div className={styles.loading}>Searching...</div>}

      {!loading && searched && (
        <div className={styles.results}>
          <p className={styles.meta}>{total} results for "{searchParams.get('q')}"</p>

          {results.length > 0 ? (
            <div className={styles.list}>
              {results.map((r, i) => (
                <div key={`${r.source_type}-${r.source_id}-${i}`} className={styles.resultCard} onClick={() => navigateToResult(r)}>
                  <div className={styles.resultHeader}>
                    <span className={styles.resultType}>{TYPE_ICONS[r.source_type] || '📄'} {r.source_type}</span>
                    <span className={styles.resultAuthor}>{r.author}</span>
                  </div>
                  <div className={styles.resultTitle}>{r.title}</div>
                  {r.snippet && (
                    <div className={styles.resultSnippet} dangerouslySetInnerHTML={{ __html: r.snippet }} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>No results found. Try a different search term.</div>
          )}
        </div>
      )}

      {!searched && (
        <div className={styles.suggestions}>
          <p className={styles.suggestionsTitle}>Try searching for:</p>
          <div className={styles.suggestionList}>
            {['security', 'websocket', 'library shelf', 'supply chain', 'architecture'].map(term => (
              <button key={term} onClick={() => { setQuery(term); setSearchParams({ q: term }); }} className={styles.suggestion}>
                {term}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

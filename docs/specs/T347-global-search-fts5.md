# T#347 — Global Search (SQLite FTS5)

**Task**: T#347
**Author**: Karo
**Date**: 2026-03-26
**Priority**: High
**Spec approval**: Required (new data model + new virtual table)
**Architecture**: Thread #281 (Gnarl)
**Security review**: Thread #282 (Bertus)

## Overview

Add global full-text search across all Den Book content using SQLite FTS5. One search bar, one results page, ranked by relevance (BM25). Zero new infrastructure — FTS5 is built into SQLite.

## Current State

- Library has LIKE-based search (T#346) — works but no relevance ranking, no cross-content search
- Forum, specs, risks each have their own filtered list views
- No way to search across all content types from one place

## Architecture Decision

**SQLite FTS5** over Elasticsearch (per Gnarl's analysis in thread #281):
- BM25 relevance ranking (same algorithm as Elasticsearch)
- Porter stemmer + unicode61 tokenizer (stemming + international chars)
- Zero new dependencies, already in our stack
- Handles our scale (thousands of documents) easily

## Data Model

### New Virtual Table: `search_index`

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  title,
  content,
  source_type,    -- 'forum', 'library', 'spec', 'risk', 'task'
  source_id,      -- ID in the source table
  author,
  created_at,
  tokenize = 'porter unicode61'
);
```

FTS5 virtual tables are not regular tables — they maintain their own inverted index for fast full-text search. No separate migration needed beyond the CREATE statement.

### What Gets Indexed

| Source | Table | Title Field | Content Field |
|--------|-------|-------------|---------------|
| Forum posts | thread_messages | thread title | message content |
| Library entries | library | title | content |
| Spec reviews | spec_reviews | title | description/content |
| Risks | risks | title | description |
| PM Board tasks | tasks | title | description |

### What Is EXCLUDED (privacy)

- **DMs** — private conversations between beasts
- **Prowl tasks** — Gorn's personal task list (per Bertus, thread #282)
- **Spec comments** — low-value noise, specs themselves are indexed

## API

### `GET /api/search`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| q | string | required | Search query (FTS5 syntax) |
| type | string | (all) | Filter by source_type: forum, library, spec, risk |
| limit | number | 20 | Max results (cap: 50) |
| offset | number | 0 | Pagination offset |

**Authentication**: Required. Local trusted requests (`isTrustedRequest`) or session auth. Unauthenticated requests return 401.

**Response**:
```json
{
  "results": [
    {
      "source_type": "forum",
      "source_id": 42,
      "title": "WebSocket Architecture Discussion",
      "snippet": "...the <b>signal</b> + <b>fetch</b> pattern allows...",
      "author": "gnarl",
      "rank": -3.42,
      "url": "/forum?thread=42"
    }
  ],
  "total": 15,
  "query": "signal fetch pattern"
}
```

**Snippet generation**: FTS5 `snippet()` function generates highlighted context. Only indexed content appears in snippets — excluded types (DMs, Prowl) are never in the index, so cannot leak.

### Query Sanitization (Security — per Bertus)

FTS5 supports special operators: `AND`, `OR`, `NOT`, `NEAR`, column filters (`title:foo`), prefix (`arch*`), phrase (`"exact match"`).

**Strategy**: Quote user input to prevent column targeting.

```typescript
// Sanitize: wrap each term in quotes, allow phrase search
function sanitizeFtsQuery(raw: string): string {
  // Allow quoted phrases as-is
  // Split unquoted terms and wrap each in quotes to prevent column targeting
  const terms = raw.match(/"[^"]*"|[^\s]+/g) || [];
  return terms.map(t => t.startsWith('"') ? t : `"${t.replace(/"/g, '')}"`).join(' ');
}
```

This prevents `content:secret` column targeting while preserving phrase search and basic multi-term queries. Prefix matching (`arch*`) is blocked — acceptable tradeoff for safety.

## Index-on-Write Hooks

Each create/update/delete operation on indexed tables triggers a corresponding search_index update:

### On Create
```sql
INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
VALUES (?, ?, ?, ?, ?, ?);
```

### On Update
```sql
DELETE FROM search_index WHERE source_type = ? AND source_id = ?;
INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
VALUES (?, ?, ?, ?, ?, ?);
```

### On Delete
```sql
DELETE FROM search_index WHERE source_type = ? AND source_id = ?;
```

### Backfill Migration

On first startup with the feature, backfill all existing content:
```sql
INSERT INTO search_index SELECT title, content, 'library', id, author, created_at FROM library;
INSERT INTO search_index SELECT t.title, m.content, 'forum', m.id, m.author, m.created_at
  FROM thread_messages m JOIN threads t ON m.thread_id = t.id;
INSERT INTO search_index SELECT title, description, 'spec', id, author, created_at FROM spec_reviews;
INSERT INTO search_index SELECT title, description, 'risk', id, created_by, created_at FROM risks;
INSERT INTO search_index SELECT title, description, 'task', id, assigned_to, created_at FROM tasks;
```

Only run backfill if `search_index` is empty (first migration).

## Frontend

### Phase 1 (this spec)

1. **Search bar in nav** — global, always visible, routes to `/search?q=...`
2. **Search results page** (`/search`) — results grouped by type with tabs (All / Forum / Library / Specs / Risks / Tasks)
3. **Result cards** — title, snippet with highlighting, author, source type badge, clickable link to source

### Phase 2 (future, not this spec)

- Instant/typeahead search with debounce (similar to T#346 library typeahead)
- Search history / recent searches

## Implementation Order

1. FTS5 virtual table creation + backfill migration
2. `GET /api/search` endpoint with sanitization + auth
3. Index-on-write hooks (forum, library, specs, risks, tasks)
4. Frontend: search bar in nav + search results page
5. Testing: verify excluded content not indexed, sanitization works

## Security Checklist (from Bertus, thread #282)

- [x] DMs excluded from indexing
- [x] Prowl tasks excluded from indexing
- [x] Search API requires authentication
- [x] FTS5 query input sanitized (column targeting prevented)
- [x] Snippets only from indexed content (excluded types never in index)

## Risk

- **Low**: FTS5 is mature SQLite extension, well-documented
- **Medium**: Index-on-write hooks add complexity to every CRUD operation — need to ensure all write paths are covered
- **Mitigation**: Wrap index operations in a helper function; periodic reindex command for drift detection

# T#350 — Meilisearch Search Integration

**Task**: T#350
**Author**: Karo
**Date**: 2026-03-26
**Priority**: High
**Spec approval**: Required (new search backend, API changes)
**Architecture**: Thread #283 (Gnarl)
**Dependency**: T#349 (Rax — Meilisearch infra setup)

## Overview

Replace FTS5 as the primary search backend with Meilisearch for typo-tolerant instant search. Meilisearch runs as a sidecar on localhost:7700. Den Book proxies search requests. FTS5 remains as fallback if Meilisearch is unavailable.

## Why Meilisearch over FTS5

| Feature | FTS5 | Meilisearch |
|---------|------|-------------|
| Typo tolerance | No | Yes (auto) |
| Response time | ~10ms | <50ms |
| Highlighted results | Manual | Built-in |
| Faceted search | No | Yes |
| Synonym support | No | Yes |
| Relevance ranking | BM25 only | 6 customizable rules |

FTS5 stays for: offline/fallback mode, integrity checks.

## Architecture

```
Browser → GET /api/search → Den Book server → Meilisearch (localhost:7700)
                                            ↘ FTS5 (fallback)
```

## Dependencies

- **meilisearch** npm package for Node/Bun client
- Meilisearch binary running on localhost:7700 (T#349, Rax)
- Master key stored in environment variable `MEILI_MASTER_KEY`

## Data Model

### Meilisearch Index: `denbook`

```json
{
  "uid": "denbook",
  "primaryKey": "search_id",
  "searchableAttributes": ["title", "content", "author"],
  "filterableAttributes": ["source_type", "author"],
  "sortableAttributes": ["created_at"],
  "typoTolerance": {
    "enabled": true,
    "minWordSizeForTypos": { "oneTypo": 4, "twoTypos": 8 }
  }
}
```

### Document Schema

```json
{
  "search_id": "forum_3600",
  "title": "Thread title or doc title",
  "content": "Full text content",
  "source_type": "forum|library|task|spec|risk",
  "source_id": 3600,
  "author": "gnarl",
  "created_at": "2026-03-26T12:00:00Z",
  "url": "/forum?thread=281"
}
```

`search_id` is `{source_type}_{source_id}` — unique composite key.

### What Gets Indexed

Same as T#347: forum posts, library entries, tasks, specs (file content), risks.

### What Is EXCLUDED

Same as T#347: DMs, Prowl tasks.

## API Changes

### `GET /api/search` — Modified

Proxies to Meilisearch. Falls back to FTS5 if Meilisearch is unavailable.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| q | string | required | Search query |
| type | string | (all) | Filter by source_type |
| limit | number | 20 | Max results (cap: 50) |
| offset | number | 0 | Pagination |

**Response** (unchanged shape, new fields):
```json
{
  "results": [
    {
      "source_type": "forum",
      "source_id": 3600,
      "title": "WebSocket Architecture",
      "snippet": "...the <em>signal</em> + <em>fetch</em> pattern...",
      "author": "gnarl",
      "url": "/forum?thread=281"
    }
  ],
  "total": 42,
  "query": "webscoket",
  "processingTimeMs": 12,
  "engine": "meilisearch"
}
```

New fields: `processingTimeMs`, `engine` ("meilisearch" or "fts5").

**Typo example**: query "webscoket" returns results for "websocket".

### `POST /api/search/reindex` — Modified

Rebuilds Meilisearch index (delete all + re-add). Also rebuilds FTS5 for parity.

Returns per-type counts + engine info.

### `GET /api/search/status` — Modified

Returns status for both engines:
```json
{
  "meilisearch": { "status": "available", "indexed": 3987, "lastUpdate": "..." },
  "fts5": { "indexed": { "forum": 3583, ... }, "drift": false },
  "engine": "meilisearch"
}
```

## Index-on-Write Hooks

Reuse existing T#347 hooks. Modify `searchIndexUpsert` and `searchIndexDelete` to push to both Meilisearch and FTS5:

```typescript
async function searchIndexUpsert(sourceType, sourceId, title, content, author, createdAt, url) {
  // FTS5 (sync, existing)
  fts5Upsert(sourceType, sourceId, title, content, author, createdAt);

  // Meilisearch (async, fire-and-forget)
  meili?.index('denbook').addDocuments([{
    search_id: `${sourceType}_${sourceId}`,
    title, content, source_type: sourceType,
    source_id: sourceId, author, created_at: createdAt, url
  }]).catch(() => {});
}
```

Meilisearch writes are async and non-blocking. If Meilisearch is down, FTS5 still works.

## Backfill Migration

On startup or reindex:
1. Create/update Meilisearch index settings (searchable, filterable, sortable attributes)
2. Batch-insert all documents (Meilisearch handles batches of 10k+ efficiently)
3. Wait for indexing to complete (Meilisearch processes async)

## Frontend Changes

### Minimal

The frontend already works — same `/api/search` response shape. Changes:
- Show `processingTimeMs` in search results meta
- Show active engine badge ("Meilisearch" or "FTS5 fallback")

### Instant Search Enhancement

The Ctrl+K typeahead already does debounced search. With Meilisearch's <50ms response, reduce debounce from 150ms to 50ms for near-instant feel.

## Fallback Strategy

```typescript
async function handleSearch(query, options) {
  try {
    // Try Meilisearch first
    const results = await meiliSearch(query, options);
    return { ...results, engine: 'meilisearch' };
  } catch {
    // Fall back to FTS5
    const results = fts5Search(query, options);
    return { ...results, engine: 'fts5' };
  }
}
```

## Security

- Meilisearch master key in env var (`MEILI_MASTER_KEY`), never exposed to frontend, never in code/git
- **Search-only API key**: On startup, use master key to generate a search-only API key via Meilisearch's key management API. Proxy uses this restricted key — not the master key (per Bertus #5)
- **Filter sanitization**: User-supplied `type` filter values are validated against an allowlist (`['forum', 'library', 'task', 'spec', 'risk']`) before being passed to Meilisearch filter syntax. Prevents filter injection (per Bertus #6)
- Same auth requirements as T#347 (session or trusted local)
- DMs and Prowl still excluded
- Meilisearch on localhost only — not exposed via Caddy (Rax T#349)

## Implementation Order

1. Install `meilisearch` npm package
2. Initialize client on server startup (connect to localhost:7700)
3. Create index with settings on first connect
4. Backfill all documents to Meilisearch
5. Modify `GET /api/search` to proxy to Meilisearch with FTS5 fallback
6. Modify index-on-write hooks to dual-write (FTS5 + Meilisearch)
7. Update reindex endpoint for both engines
8. Update status endpoint for both engines
9. Frontend: show engine badge + processing time, reduce debounce

## Settings Page

Add to existing Search Index section in /settings:
- Show active engine (Meilisearch / FTS5 fallback)
- Meilisearch connection status
- Separate reindex buttons for each engine (or one that does both)

## Risk

- **Low**: Meilisearch is production-ready, well-documented
- **Medium**: New dependency (sidecar process) — mitigated by FTS5 fallback
- **Mitigation**: If Meilisearch is down, search transparently falls back to FTS5. No user-facing errors.

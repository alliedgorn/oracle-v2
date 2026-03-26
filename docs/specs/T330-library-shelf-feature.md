# T#330 — Library Shelf Feature (Confluence-style Spaces)

**Task**: T#330
**Author**: Karo
**Date**: 2026-03-26
**Priority**: High
**Spec approval**: Required (big feature)

## Overview

Add a "Shelf" concept to the Library — named groupings for library content, similar to Confluence spaces. Each shelf is a named container that holds related library entries. Entries can belong to one shelf (or none for ungrouped content).

## Current State

The Library has a flat structure:
- `library` table with `id, title, content, type, author, tags, created_at, updated_at`
- Content grouped only by `type` (research, architecture, learning, decision)
- No hierarchical organization beyond type + tags

## Data Model

### New Table: `library_shelves`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| name | TEXT NOT NULL UNIQUE | Shelf name (e.g., "Security Research", "Architecture Decisions") |
| description | TEXT | Optional description |
| icon | TEXT | Optional emoji icon |
| color | TEXT | Optional hex color for visual distinction |
| created_by | TEXT NOT NULL | Beast who created the shelf |
| created_at | DATETIME | Default CURRENT_TIMESTAMP |
| updated_at | DATETIME | Default CURRENT_TIMESTAMP |

### Library Table Change

Add `shelf_id` column to existing `library` table:

```sql
ALTER TABLE library ADD COLUMN shelf_id INTEGER REFERENCES library_shelves(id)
```

- Nullable — entries without a shelf remain ungrouped
- Foreign key to `library_shelves.id`

## API Endpoints

### Shelf CRUD

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /api/library/shelves | Any | List all shelves with entry counts |
| GET | /api/library/shelves/:id | Any | Single shelf with its entries |
| POST | /api/library/shelves | Any beast | Create a shelf |
| PATCH | /api/library/shelves/:id | Any beast | Update shelf name, description, icon, color |
| DELETE | /api/library/shelves/:id | Gorn only | Delete shelf (entries become ungrouped, not deleted) |

### Library Entry Updates

- `POST /api/library` — add optional `shelf_id` field
- `PATCH /api/library/:id` — add `shelf_id` to allowed update fields (nullable — set to null to ungrouped)
- `GET /api/library` — add `shelf_id` query param for filtering by shelf

### Response Shape: GET /api/library/shelves

```json
{
  "shelves": [
    {
      "id": 1,
      "name": "Security Research",
      "description": "Threat intelligence and vulnerability analysis",
      "icon": "...",
      "color": "#dc3545",
      "entry_count": 12,
      "created_by": "bertus",
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

## Frontend

### Library Page Changes

1. **Shelf sidebar/tabs** — show shelves as navigation items above or alongside category filters
2. **"All" view** — default, shows all entries regardless of shelf
3. **Shelf view** — when a shelf is selected, filter entries to that shelf only
4. **"Ungrouped" option** — show entries not assigned to any shelf
5. **Shelf badge on cards** — show shelf name on library entry cards when viewing "All"

### Shelf Management

1. **Create shelf** — button/form to create new shelf (name, description, icon, color)
2. **Edit shelf** — inline edit of shelf metadata
3. **Move entry to shelf** — dropdown in entry edit form to assign/change shelf
4. **Delete shelf** — Gorn-only, confirms that entries won't be deleted

### Visual Design

- Shelves shown as colored pills/tabs with optional icon
- Shelf color used as accent on entry cards within that shelf
- Keep existing type/category filters — they work orthogonally to shelves

## Migration Strategy

- `ALTER TABLE` to add `shelf_id` column (nullable, backward compatible)
- Existing entries remain ungrouped (shelf_id = NULL)
- No data migration needed — Gorn/beasts can organize content into shelves over time

## Non-Goals

- No nested shelves (keep it one level deep)
- No shelf-level permissions (all content readable by all beasts)
- No automatic shelf assignment based on type/tags
- No drag-and-drop reordering (future enhancement)

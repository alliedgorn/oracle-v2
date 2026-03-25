# T#279 — Prowl: Personal Task Manager for Gorn

**Task**: Full revamp of Mindlink into Prowl — Gorn's personal task manager
**Author**: Karo
**Status**: PENDING REVIEW
**Design**: Dex (thread #18 msg #3317), Quill (thread #18)

## Overview

Replace the Mindlink page with **Prowl** — a personal to-do/task manager for Gorn. Priorities, categories, due dates, clean modern UX. Existing Mindlink data migrates into Prowl.

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS prowl_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  category TEXT DEFAULT 'general',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  source TEXT,
  source_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

**Fields:**
- `priority`: `high`, `medium`, `low`
- `category`: user-defined string (e.g. `den`, `supply-chain`, `personal`, `general`)
- `due_date`: ISO date string (optional)
- `status`: `pending`, `done`
- `notes`: optional markdown notes
- `source`: origin — `manual` (Gorn created), `beast` (from Beast mindlink), `board` (linked to PM task)
- `source_id`: original mindlink ID or task ID for traceability

## API Endpoints

### GET /api/prowl

List tasks with filters.

**Query params:**
- `status` — `pending|done|all` (default: `pending`)
- `priority` — `high|medium|low`
- `category` — filter by category string
- `due` — `overdue|today|week` (convenience filters)

**Response:**
```json
{
  "tasks": [{
    "id": 1,
    "title": "Review T#259 ingester spec",
    "priority": "high",
    "category": "supply-chain",
    "due_date": "2026-03-26",
    "status": "pending",
    "notes": null,
    "source": "manual",
    "created_at": "2026-03-25T22:00:00Z",
    "updated_at": "2026-03-25T22:00:00Z",
    "completed_at": null
  }],
  "counts": {
    "pending": 5,
    "done": 12,
    "overdue": 1,
    "high": 2,
    "medium": 2,
    "low": 1
  },
  "categories": ["den", "supply-chain", "personal", "general"]
}
```

### POST /api/prowl

Create a task. Gorn-only (session auth).

**Body:**
```json
{
  "title": "Review T#259 ingester spec",
  "priority": "high",
  "category": "supply-chain",
  "due_date": "2026-03-26",
  "notes": "Flint submitted spec, needs review"
}
```

### PATCH /api/prowl/:id

Update a task. Gorn-only.

**Body:** Any subset of `title`, `priority`, `category`, `due_date`, `status`, `notes`.

When `status` changes to `done`, auto-set `completed_at`.

### DELETE /api/prowl/:id

Delete a task permanently. Gorn-only.

### POST /api/prowl/:id/toggle

Quick toggle: pending ↔ done. Gorn-only.

### GET /api/prowl/categories

List all unique categories with counts.

## Frontend Components

Per Dex + Quill design specs:

### Route
- `/prowl` — replaces `/mindlink` in nav
- Header nav: rename "Mindlink" to "Prowl"

### Layout
- Single-column centered (`--width-medium`, 800px)
- Quick add bar at top (input + priority selector + Enter to submit)
- Priority filter tabs: All | High | Medium | Low | Done
- Category pills below filters
- Task list with checkbox, title, priority dot, category, due date
- Click task to expand inline (edit title, notes, category, due date)

### Task Item
- Checkbox (circle) on left — click to toggle done
- Title (strikethrough when done)
- Priority indicator: red dot (high), yellow dot (medium), green dot (low)
- Category tag
- Due date (red if overdue, muted if future)
- Expand/collapse for notes and edit controls

### Quick Add Bar
- Input field: "Add a task..."
- Priority dropdown (defaults to medium)
- Enter key or Add button submits
- Optional: category selector

### Empty State
- "Nothing on the Prowl. Add your first task above."

### Mobile (< 768px)
- Full-width, padding reduced
- Priority selector in quick add becomes icon-only

## Migration

Migrate existing `mindlinks` table data:
```sql
INSERT INTO prowl_tasks (title, priority, category, status, source, source_id, created_at, updated_at)
SELECT message, 'medium', 'general',
  CASE WHEN status = 'decided' THEN 'done' ELSE 'pending' END,
  'beast', id,
  datetime(created_at/1000, 'unixepoch'),
  datetime(created_at/1000, 'unixepoch')
FROM mindlinks;
```

## Test Stubs

### API Tests
```
test_create_prowl_task — POST creates task with all fields
test_create_requires_auth — unauthenticated POST returns 403
test_list_pending — GET /api/prowl returns pending by default
test_filter_by_priority — ?priority=high filters correctly
test_filter_by_category — ?category=den filters correctly
test_toggle_done — POST /api/prowl/:id/toggle flips status
test_toggle_sets_completed_at — toggling to done sets timestamp
test_update_task — PATCH updates fields, sets updated_at
test_delete_task — DELETE removes task
test_overdue_filter — ?due=overdue returns past-due tasks
test_categories_endpoint — GET /api/prowl/categories returns unique list
test_counts_in_response — response includes counts object
```

### Frontend Tests
```
- Quick add creates task on Enter
- Priority filter tabs filter correctly
- Category pills filter correctly
- Checkbox toggles task done/pending
- Done tasks show strikethrough
- Overdue dates show in red
- Inline expand shows notes and edit form
- Empty state displays correctly
- Mobile layout responsive
```

## Dependencies
- Replaces Mindlink page entirely
- Update Header nav: Mindlink → Prowl
- Update App.tsx route: /mindlink → /prowl (keep /mindlink as redirect)

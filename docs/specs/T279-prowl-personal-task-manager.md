# T#279 — Prowl: Personal Task Manager for Gorn

**Task**: Full revamp of Mindlink into Prowl — Gorn's personal task manager
**Author**: Karo
**Status**: REVISION 2
**Design**: Dex (thread #18 msg #3317), Quill (thread #18)

## Overview

**Prowl** — a personal to-do/task manager for Gorn. Priorities, categories, due dates, clean modern UX. Tasks can originate from Gorn manually, from Beasts requesting things outside Den Book functionality, from spec approvals, or from PM Board links.

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
  created_by TEXT NOT NULL DEFAULT 'gorn',
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
- `source`: origin — `manual` (Gorn created), `beast` (Beast request for something outside Den Book, e.g. "Tell Gorn to update his Facebook profile"), `board` (linked to PM Board task), `spec` (from spec approval)
- `source_id`: reference ID for traceability (task ID, spec ID, etc.) — **nullable** (null when no Den Book reference exists, e.g. beast requests for external actions)
- `created_by`: who created the task — `gorn`, `sable`, `zaghnal`, `leonard`, or `karo`

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

Create a task. Allowed: Gorn (session auth), Sable, Zaghnal, Leonard, Karo (via `?as=<beast>` or `created_by` in body).

**Body:**
```json
{
  "title": "Review T#259 ingester spec",
  "priority": "high",
  "category": "supply-chain",
  "due_date": "2026-03-26",
  "notes": "Flint submitted spec, needs review",
  "source": "spec",
  "source_id": 5,
  "created_by": "karo"
}
```

**Auth:** Gorn (session), or `created_by` must be one of: `sable`, `zaghnal`, `leonard`, `karo`. Other beasts cannot create tasks.

### PATCH /api/prowl/:id

Update task fields. Gorn-only.

**Body:** Any subset of `title`, `priority`, `category`, `due_date`, `notes`.

**Note:** Status changes are NOT allowed via this endpoint. Use the dedicated status endpoints below.

### PATCH /api/prowl/:id/status

Change task status. **Gorn-only.**

**Body:**
```json
{ "status": "done" }
```

When `status` changes to `done`, auto-set `completed_at`. When changed back to `pending`, clear `completed_at`.

### POST /api/prowl/:id/toggle

Quick toggle: pending ↔ done. **Gorn-only.**

### DELETE /api/prowl/:id

Delete a task permanently. Allowed: Gorn (session auth) or Sable (`?as=sable`).

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

## Test Stubs

### API Tests
```
test_create_prowl_task — POST creates task with all fields
test_create_by_gorn — Gorn (session auth) can create
test_create_by_allowed_beast — Sable/Zaghnal/Leonard/Karo can create via ?as=
test_create_by_unauthorized_beast — Other beasts get 403
test_list_pending — GET /api/prowl returns pending by default
test_filter_by_priority — ?priority=high filters correctly
test_filter_by_category — ?category=den filters correctly
test_toggle_done — POST /api/prowl/:id/toggle flips status (Gorn-only)
test_toggle_sets_completed_at — toggling to done sets timestamp
test_status_change_via_dedicated_endpoint — PATCH /api/prowl/:id/status changes status
test_status_change_rejected_on_update — PATCH /api/prowl/:id rejects status field
test_update_task — PATCH updates fields, sets updated_at (Gorn-only)
test_delete_by_gorn — Gorn can delete
test_delete_by_sable — Sable can delete
test_delete_by_other_beast — Other beasts get 403
test_overdue_filter — ?due=overdue returns past-due tasks
test_categories_endpoint — GET /api/prowl/categories returns unique list
test_counts_in_response — response includes counts object
test_source_spec_approval — task created with source=spec, source_id=spec_id
test_source_beast_null_source_id — beast source with null source_id works
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
- New page (Mindlink already removed)
- Add "Prowl" to Header nav
- Add `/prowl` route in App.tsx

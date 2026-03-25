# T#271 — Den Book Spec Review Page

**Task**: Build a Spec Review page for SDD workflow
**Author**: Karo
**Status**: PENDING REVIEW
**Design**: Dex (thread #18)

## Overview

Gorn reviews and approves/rejects SDD specs from the Den Book frontend. Beasts push specs to repos as `docs/specs/*.md`, Den Book reads and renders them. Approve unblocks implementation, reject returns to Beast with feedback.

## API Endpoints

### GET /api/specs

List all spec files across repos.

**Query params:**
- `status` — filter by `pending|approved|rejected` (optional)
- `repo` — filter by repo name (optional)

**Response:**
```json
{
  "specs": [
    {
      "id": 1,
      "repo": "supply-chain-tool",
      "file_path": "docs/specs/T259-ingester.md",
      "task_id": "T259",
      "title": "Package Ingester Specification",
      "author": "flint",
      "status": "pending",
      "reviewer_feedback": null,
      "reviewed_at": null,
      "created_at": "2026-03-25T19:36:00Z",
      "updated_at": "2026-03-25T19:36:00Z"
    }
  ]
}
```

### GET /api/specs/:id

Get spec detail with rendered content.

**Response:**
```json
{
  "id": 1,
  "repo": "supply-chain-tool",
  "file_path": "docs/specs/T259-ingester.md",
  "task_id": "T259",
  "title": "Package Ingester Specification",
  "author": "flint",
  "status": "pending",
  "content": "# T#259 — Package Ingester...",
  "reviewer_feedback": null,
  "reviewed_at": null,
  "created_at": "2026-03-25T19:36:00Z",
  "updated_at": "2026-03-25T19:36:00Z"
}
```

### POST /api/specs

Register a spec for review. Beasts call this after pushing spec to repo.

**Body:**
```json
{
  "repo": "supply-chain-tool",
  "file_path": "docs/specs/T259-ingester.md",
  "task_id": "T259",
  "title": "Package Ingester Specification",
  "author": "flint"
}
```

### POST /api/specs/:id/review

Approve or reject a spec.

**Body:**
```json
{
  "action": "approve|reject",
  "feedback": "Optional feedback text (required for reject)"
}
```

**Validation:**
- `feedback` required when `action` is `reject`
- Only `pending` specs can be reviewed
- Resubmission: Beast updates spec in repo, calls `POST /api/specs/:id/resubmit` → status resets to `pending`

### POST /api/specs/:id/resubmit

Reset a rejected spec to pending after revision.

**Body:**
```json
{
  "author": "flint"
}
```

### GET /api/specs/:id/content

Fetch raw markdown content from the repo filesystem.

**Response:**
```json
{
  "content": "# Full markdown content...",
  "file_path": "docs/specs/T259-ingester.md",
  "repo": "supply-chain-tool"
}
```

**Implementation:** Read from `/home/gorn/workspace/{repo}/{file_path}`. Validate path is under `docs/specs/` and ends with `.md` (prevent path traversal).

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS spec_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  content_cache TEXT,
  reviewer_feedback TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo, file_path)
);
```

## Frontend Components

Per Dex design spec (thread #18):

### SpecReview page (`/specs`)
- Two-pane SidebarLayout (same as Forum)
- Sidebar: filter tabs (All/Pending/Approved/Rejected) + spec card list
- Detail pane: header bar, markdown content, review controls
- Mobile: single column with tap-to-detail navigation

### SpecCard (sidebar)
- Task ID + short name
- Author with beast theme color left-border
- Status badge (pending amber pulse, approved green check, rejected red x)
- Repo name in muted text

### SpecDetail
- Header: repo, file path, author, status badge, timestamp
- Content: scrollable markdown (same renderer as Library)
- Review controls (sticky bottom): feedback textarea + Approve/Reject buttons
- Only visible for pending specs; approved/rejected show decision read-only

### Route
- `/specs` in Header navigation
- Deep-link: `/specs?spec=T259-ingester`

## Test Stubs

### API Tests
```python
def test_create_spec():
    """POST /api/specs creates a spec review entry."""

def test_list_specs():
    """GET /api/specs returns all specs, filterable by status."""

def test_get_spec_detail():
    """GET /api/specs/:id returns spec with content."""

def test_approve_spec():
    """POST /api/specs/:id/review with action=approve sets status."""

def test_reject_spec_requires_feedback():
    """POST /api/specs/:id/review with action=reject requires feedback."""

def test_resubmit_resets_to_pending():
    """POST /api/specs/:id/resubmit resets rejected spec to pending."""

def test_content_reads_from_repo():
    """GET /api/specs/:id/content reads markdown from filesystem."""

def test_path_traversal_blocked():
    """Spec file_path must be under docs/specs/ and end with .md."""

def test_only_pending_can_be_reviewed():
    """Cannot approve/reject an already-reviewed spec."""
```

### Frontend Tests
```
- Spec list renders with correct status badges
- Filter tabs filter by status
- Clicking a spec shows detail with markdown content
- Approve button sends review and updates status
- Reject button requires feedback before submission
- Rejected spec shows feedback read-only
- Mobile: single column layout with back navigation
- Deep-link /specs?spec=X loads correct spec
```

## Dependencies
- Same markdown renderer as Library (ReactMarkdown + remarkGfm + SyntaxHighlighter)
- SidebarLayout component (same as Forum)
- Beast theme colors for card borders

# T#372 — Personal Routine Tracker (Phase 1: Manual Logging)

**Task**: T#372
**Author**: Karo
**Architecture**: Gnarl (thread #300)
**Design**: Dex + Quill (thread #300)
**Date**: 2026-03-27
**Priority**: High
**Spec approval**: Required (new project, new page, new data model)

## Overview

Personal fitness tracker for Gorn on Den Book. Phase 1 covers manual logging of meals, workouts, weight, and notes, plus a weight trend chart. Phase 2 (future) will add Apple Health integration.

## Data Model

### New Table: `routine_logs`

```sql
CREATE TABLE routine_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('meal', 'workout', 'weight', 'note', 'photo')),
  logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data JSON NOT NULL,
  source TEXT DEFAULT 'manual',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL
);
```

### JSON Data Shapes

```json
// meal
{"description": "Grab order - grilled chicken + rice", "calories": 650, "protein": 45}

// workout
{"type": "chest + triceps", "duration_min": 75, "exercises": ["bench 100kg x5", "incline DB 40kg x8"]}

// weight
{"value": 112.5, "unit": "kg"}

// note
{"text": "Rest day, shoulder feels tight"}

// photo (progress photo)
{"url": "/api/routine/photo/abc123.jpg", "tag": "front", "notes": "Week 4"}
```

## API Endpoints

### Log CRUD
```
GET    /api/routine/logs          -- list (filterable: ?type=meal&from=2026-03-01&to=2026-03-27&limit=50&offset=0)
POST   /api/routine/logs          -- create { type, data, logged_at? }
PATCH  /api/routine/logs/:id      -- edit { data?, logged_at? }
DELETE /api/routine/logs/:id      -- soft delete (sets deleted_at, not actual delete)
```

### Analytics
```
GET    /api/routine/weight        -- weight history [{value, logged_at}] for chart
GET    /api/routine/stats         -- summary: gym frequency, avg calories, weight delta
GET    /api/routine/today         -- today's logs grouped by type
GET    /api/routine/photos        -- photo gallery (filterable by tag, date range)
POST   /api/routine/photo/upload  -- upload progress photo (returns URL)
```

### Auth

- **Read + Write**: Gorn + Sable (Sable has full access to log, view, and track on Gorn's behalf)
- **Other Beasts**: No access

## UI

### New Page: /routine

**Layout (per Dex/Quill design):**

1. **Today View** (top) — quick-add cards:
   - 5 buttons: Meal, Workout, Weight, Photo, Note
   - Clicking opens inline form below the button row
   - Today's entries shown as timeline cards
   - Photo button opens camera/picker, auto-stamps with date

2. **Weight Chart** (middle):
   - Line chart showing weight over time
   - Goal line at target weight
   - Date range selector (1w, 1m, 3m, all)

3. **History** (bottom):
   - Scrollable log of past entries
   - Filter by type tabs
   - Expandable cards with full details

**Mobile-first**: Big touch targets (44px+), minimal taps, smart defaults.

**Nav**: Add to More > Pack dropdown.

3. **Progress Photos** (section below weight chart):
   - Photo gallery grid with date stamps
   - Optional tag per photo: front, side, back, custom
   - Side-by-side comparison: pick any two photos to compare
   - Photos stored in `data/uploads/routine/` (same pattern as avatars)
   - Gorn-only — private, not visible to Beasts

## Security

- Session auth on all endpoints (Gorn only)
- No Beast access — personal health data
- Progress photos private (no public URLs, session auth required to view)
- JSON data validated for type shape on write
- All image uploads processed with `sharp`: EXIF auto-rotation + metadata strip (removes GPS/location for privacy)

## Test Plan

- Create log entry (each type: meal, workout, weight, note, photo) — 201
- Create log without type — 400
- List logs with pagination (?limit=10&offset=0) — correct count
- List logs filtered by type (?type=meal) — only meals returned
- List logs filtered by date range (?from=...&to=...) — correct range
- Soft delete log — deleted_at set, entry excluded from default list
- Photo upload — returns URL, file on disk, EXIF stripped
- Photo upload invalid file type — 400
- Photo upload over size limit — 400
- Weight history endpoint — returns [{value, logged_at}] sorted
- Stats endpoint — returns summary object
- Auth: Gorn session — all endpoints accessible
- Auth: Sable (?as=sable) — all endpoints accessible
- Auth: other Beast (?as=karo) — 403 on all endpoints
- Auth: no identity — 401

## Phase 2 (future, not in this spec)

- Apple Health integration via Health Auto Export app
- POST /api/health/ingest webhook endpoint
- health_sync table for raw sync data
- Auto-populated dashboard cards from synced data

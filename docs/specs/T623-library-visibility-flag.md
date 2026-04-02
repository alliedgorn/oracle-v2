# Library Entries Public/Internal Visibility Flag

**Task**: T#623
**Author**: Karo
**Priority**: High
**Reviewer**: Bertus (security — guest visibility)

## Problem

Library entries have no visibility control. All entries are visible to all authenticated users. Guests cannot access the library at all (`/library` not in GUEST_ROUTES). Gorn needs some library entries (guides, public knowledge) visible to guests while keeping internal entries (architecture decisions, research) Beast/owner only.

## Current State

- `library` table has no visibility column
- All API endpoints return all entries regardless of caller
- Frontend route `/library` is behind RequireAuth + not in GUEST_ROUTES
- No guest-accessible library API endpoints exist

## Design

### 1. Database: Add visibility column

```sql
ALTER TABLE library ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal';
```

Values: `public` | `internal` (default `internal`)

All existing entries default to `internal` — no existing content exposed to guests without explicit opt-in.

### 2. Backend: Filter by visibility

**GET /api/library** — Add visibility filter:
- If caller is guest (detected via session role): only return `visibility = 'public'` entries
- If caller is Beast/owner: return all entries, support `?visibility=public|internal` filter param
- Add `visibility` field to all response objects

**GET /api/library/:id** — Single entry:
- If guest and entry is `internal`: return 404
- If Beast/owner: return normally with visibility field

**GET /api/library/search** — Typeahead:
- If guest: only search `public` entries
- If Beast/owner: search all

**GET /api/library/shelves** — Shelf list:
- If guest: only count `public` entries in entry_count
- Hide shelves with 0 public entries from guests

**POST /api/library** — Create entry:
- Accept optional `visibility` field (default `internal`)
- Guests cannot create entries (existing behavior, no change)

**PATCH /api/library/:id** — Update entry:
- Accept `visibility` field to change visibility
- Only Beast/owner can update (existing behavior)

### 3. Frontend changes

**App.tsx**: Add `/library` to GUEST_ROUTES set

**Library.tsx**:
- Add visibility badge on entry cards (public/internal indicator)
- Add visibility toggle when creating/editing entries (Beast/owner only)
- If guest: hide edit/create/delete controls, show only public entries
- Add visibility filter dropdown for Beast/owner view (All / Public / Internal)

### 4. Guest experience

- Guests see library in navigation
- Guests see only public entries
- Guests can read and search public entries
- Guests cannot create, edit, or delete entries
- No indication that internal entries exist

## Files to Modify

1. `src/server.ts` — ALTER TABLE migration, filter logic on GET endpoints, accept visibility on POST/PATCH
2. `frontend/src/App.tsx` — Add `/library` to GUEST_ROUTES
3. `frontend/src/pages/Library.tsx` — Visibility badge, toggle, filter, guest-mode UI
4. `frontend/src/components/Header.tsx` — Show library nav for guests (if not already)

## Migration

- Additive only — new column with default value
- All existing entries become `internal` (safe default)
- No breaking changes
- Entries must be explicitly set to `public` by a Beast

## Security Considerations

- Guest filter is enforced server-side, not just frontend
- Internal entries invisible to guests in all API responses (list, search, single)
- No information leakage about internal entry existence
- Shelves with only internal entries hidden from guests

## Non-Goals

- Per-Beast visibility (all Beasts see all entries)
- Shelf-level visibility (visibility is per-entry)
- Guest write access to library

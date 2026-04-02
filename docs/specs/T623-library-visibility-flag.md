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

### 1. Database: Add visibility column to shelves

```sql
ALTER TABLE library_shelves ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal';
```

Values: `public` | `internal` (default `internal`)

All existing shelves default to `internal` — no existing content exposed to guests without explicit opt-in.

**Shelf-only visibility**: a public shelf makes all its entries visible to guests. An internal shelf hides everything. No entry-level visibility flag — if you need to hide an entry, move it to an internal shelf. Simpler mental model: same as a real library.

### 2. Backend: Filter by visibility

**GET /api/library** — Filter by shelf visibility:
- If caller is guest: only return entries in shelves where `shelf.visibility = 'public'`
- If caller is Beast/owner: return all entries
- Add shelf `visibility` to response where relevant

**GET /api/library/:id** — Single entry:
- If guest and entry's shelf is `internal`: return 404
- If Beast/owner: return normally

**GET /api/library/search** — Typeahead:
- If guest: only search entries in public shelves
- If Beast/owner: search all

**GET /api/library/shelves** — Shelf list:
- If guest: only return shelves where `visibility = 'public'`
- If Beast/owner: return all shelves with visibility field, support `?visibility` filter

**POST /api/library/shelves** — Create shelf:
- Accept optional `visibility` field (default `internal`)

**PATCH /api/library/shelves/:id** — Update shelf:
- Accept `visibility` field to change shelf visibility

**POST /api/library** — Create entry:
- No visibility field on entries — visibility determined by shelf
- Guests cannot create entries (existing behavior, no change)

### 3. Frontend changes

**App.tsx**: Add `/library` to GUEST_ROUTES set

**Library.tsx**:
- Add visibility badge on shelf pills (public/internal indicator, Beast/owner only)
- Add visibility toggle when creating/editing shelves (Beast/owner only)
- If guest: hide edit/create/delete controls, hide visibility badges, show only public shelves and their entries
- Add visibility filter dropdown for Beast/owner shelf view (All / Public / Internal)

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

- Additive only — new column on library_shelves with default value
- All existing shelves become `internal` (safe default)
- No breaking changes
- Shelves must be explicitly set to `public` by a Beast

## Security Considerations

- Guest filter is enforced server-side via shelf JOIN, not just frontend
- Internal shelf entries invisible to guests in all API responses (list, search, single)
- No information leakage about internal shelf/entry existence
- Visibility badge hidden from guests

## Non-Goals

- Per-Beast visibility (all Beasts see all entries)
- Guest write access to library

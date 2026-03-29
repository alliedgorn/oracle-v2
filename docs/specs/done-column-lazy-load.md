# Done Column Lazy Load

**Author**: Quill
**Thread**: #363
**Related**: T#452 (cosmetic collapse — shipped, being replaced)
**Architecture Review**: Gnarl (approved offset/limit, thread #363)

## Problem

The Board fetches all tasks in one API call, including all Done tasks. The current collapse/Load More (T#452) is cosmetic — it hides DOM nodes but still transfers every Done task on page load. As Done grows, this wastes bandwidth and slows initial render.

## Solution

Fetch Done tasks separately with pagination. The API already supports `?status=done&limit=5&offset=0` and returns `{ tasks, total }`. No backend changes needed.

## Scope

**Frontend only** — Board page component in `src/pages/Board` (or equivalent).

### Current Behavior

1. `GET /api/tasks` fetches all tasks (all statuses, limit 100)
2. Frontend groups by status, renders Done column collapsed
3. Load More toggles DOM visibility in batches of 5

### New Behavior

1. `GET /api/tasks` fetches non-done tasks only (existing filters)
2. Done column header shows count from a separate call: `GET /api/tasks?status=done&limit=0` or derive `total` from first paginated call
3. On expand: `GET /api/tasks?status=done&limit=5&offset=0` — first 5 Done tasks
4. Each Load More tap: `GET /api/tasks?status=done&limit=5&offset=N` — next 5
5. Append results to rendered list (do not re-fetch previous pages)

### API Calls

| Action | Endpoint | Notes |
|--------|----------|-------|
| Page load | `GET /api/tasks?status=done&limit=5&offset=0` | Gets first 5 + total count |
| Load More | `GET /api/tasks?status=done&limit=5&offset=N` | N increments by 5 |

### UX Details

- **Collapsed state**: "Done (47)" with chevron — same as current T#452
- **Expanded state**: Shows loaded cards + Load More button with remaining count
- **Load More button**: "Load more (42 remaining)" — uses `total - loaded` from API response
- **Loading state**: Button shows "Loading..." while fetch is in-flight, disabled to prevent double-tap
- **Empty state**: If total is 0, show "No completed tasks"
- **Re-collapse**: Keep fetched tasks in memory. Re-expanding shows previously loaded cards without re-fetching

### Sort Order

`updated_at DESC` — most recently completed tasks first (existing API default for priority sort, but Done tasks all share same priority bucket so `created_at DESC` effectively applies).

## Out of Scope

- Backend changes (API already supports this)
- Cursor-based pagination (offset/limit is sufficient per Gnarl's review)
- Client-side caching between page navigations
- Changes to other status columns (TODO, In Progress, In Review)

## Validation

- [ ] Page load does NOT fetch all Done tasks
- [ ] Done column header shows correct total count
- [ ] Load More fetches next 5, appends to list
- [ ] Button shows accurate remaining count
- [ ] Re-collapse preserves loaded tasks
- [ ] No visual regression on other columns

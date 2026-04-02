# Guests Page — Design Spec

**Author**: Dex (design) + Gnarl, Karo (technical)
**Thread**: #420
**Type**: UI/UX Design + Technical Spec

---

## Overview

A dedicated owner-only page to view and manage guest accounts. Follows the same visual language as the Pack page for consistency. Consolidates all guest management here — including guest creation (removed from Settings).

**Route**: `/guests` (owner-only, add to nav)

---

## Layout: Card Grid + Detail Panel

Same pattern as the Pack page — familiar, consistent.

### Card Grid (left/main area)

- Fluid grid: `auto-fill, minmax(200px, 1fr)`
- Each card shows:
  - Avatar placeholder (first letter of display name, colored circle)
  - Username (primary) + display name (secondary)
  - Online status dot
  - `Last active: X ago` below the name
- **Green pulse dot** = online (active within 5min)
- **Grey dot** = offline
- Hover: lift + shadow (same interaction as Pack cards)
- Click: opens detail panel on right
- Default sort: online-first, then by last active (most recent first)

### Detail Panel (right side)

Same position and behavior as Pack page detail panel:

- Guest display name + username
- Avatar (if set, otherwise letter circle)
- Status: online/offline with last active timestamp
- Account created date
- Quick actions: View DMs, Disable Account
- Activity summary: total messages, threads participated

### Header

- Page title: **Guests**
- Active count badge: `Guests (3 online)`
- Search/filter bar: search by username or display name
- **+ Create Guest** button (top right, accent color)

---

## Create Guest

**"+ Create Guest" button** in the header opens a modal/form:

- Fields: Username (required), Display Name (required), Password (required), Expiry (optional date picker)
- Calls `POST /api/guests` on submit
- On success: new guest card appears in grid, brief success toast
- On error: inline validation messages (username taken, too short, etc.)

Guest creation is removed from Settings — this page is the single home for all guest management.

---

## Status Indicators

| State | Indicator | Label |
|-------|-----------|-------|
| Online | Green pulse dot | "Online" |
| Offline | Grey dot | "Last active X ago" |
| New | Subtle badge on card | Account created within 24h |

---

## Sort Control

- Default: online-first, then by last active (most recent first)
- Toggle options: Last Active, Name (A-Z), Date Joined
- Persist sort preference in localStorage

---

## Disabled / Banned State

- Card: 50% opacity, red-grey tint, strikethrough on username
- Status dot: red (not grey — distinct from offline)
- Detail panel shows: "Account disabled" with disable date
- Disabled guests sort to bottom of the list

---

## Mobile

- Single column card list, full width
- Detail panel slides up from bottom (sheet pattern)
- Search bar collapses to icon
- Create Guest button: full-width below search bar

---

## Empty State

> "No guest accounts yet. Create your first guest account to get started."

---

## API Endpoints

All endpoints owner-only (session auth required, 403 for guests and beasts).

### `GET /api/guests`

Returns all guest accounts with computed online status.

```json
{
  "guests": [{
    "id": 1,
    "username": "gorn_guest",
    "display_name": "Gorn (Guest)",
    "online": true,
    "last_active_at": "2026-04-01T01:30:00Z",
    "created_at": "2026-03-31T12:00:00Z",
    "expires_at": null,
    "disabled_at": null
  }],
  "total": 1,
  "online_count": 1
}
```

Online = `last_active_at` within 5 minutes (passive, updated on every guest API call).

### `GET /api/guests/:id`

Single guest detail. Same fields plus computed `message_count` and `threads_participated` for the activity summary in the detail panel.

### `POST /api/guests`

Create new guest account. Fields: `username`, `display_name`, `password`, `expires_at` (optional).

### `PATCH /api/guests/:id`

Update guest: disable/enable, change expiry, update display name.

### `DELETE /api/guests/:id`

Hard delete guest account. Cascades: revoke session, remove from active WebSocket connections, delete associated DMs.

---

## Data Model

No new tables. `guest_accounts` already has `last_active_at`. Activity counts (`message_count`, `threads_participated`) are computed at query time via COUNT on `dm_messages` and `thread_messages` tables — not stored.

---

## Security

- All management endpoints owner-only (session auth)
- Guest deletion cascades session revocation and WebSocket disconnect
- No guest data returned in guest-accessible endpoints (guests cannot see guest list)
- Guest online status is passive — no heartbeat, updated on API calls via `logGuestAction()`

---

## Frontend Notes

- Sort is pure frontend — `online` boolean + `last_active_at` gives everything needed
- Route `/guests` already blocked for guests by `GUEST_ROUTES` allowlist in App.tsx
- Auto-refresh guest list every 10s for live status updates
- Remove guest creation UI from Settings page

---

## Design Rationale

Guests are visitors to the den, not second-class users. The same card grid pattern gives Gorn a consistent mental model — Pack page for Beasts, Guests page for visitors. Both feel like looking into rooms of the same house.

Sort by online-first ensures Gorn sees who is actively visiting without scanning. The detail panel keeps context accessible without navigating away. Consolidating guest creation here (removing from Settings) makes this the single source of truth for guest management.

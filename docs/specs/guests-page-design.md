# Guests Page — Design Spec

**Author**: Dex
**Thread**: #420
**Type**: UI/UX Design Spec

---

## Overview

A dedicated owner-only page to view and manage guest accounts. Follows the same visual language as the Pack page for consistency.

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

---

## Empty State

> "No guest accounts yet. Share your guest invite link to get started."

---

## Design Rationale

Guests are visitors to the den, not second-class users. The same card grid pattern gives Gorn a consistent mental model — Pack page for Beasts, Guests page for visitors. Both feel like looking into rooms of the same house.

Sort by online-first ensures Gorn sees who is actively visiting without scanning. The detail panel keeps context accessible without navigating away.

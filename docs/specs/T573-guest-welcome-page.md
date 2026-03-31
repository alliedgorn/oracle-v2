# Guest Welcome Page — Design Spec

**Author**: Dex
**Task**: T#573
**Thread**: #420
**Type**: UI/UX Design Spec

---

## Overview

Redesign the guest Welcome page to feel like a warm front door to The Den. This is the first thing a guest sees — it should feel like walking into a friend's place, not a SaaS product.

**Route**: `/welcome` (guest landing page)

---

## Hero Section

- Large heading: **"Welcome to The Den"**
- Subtitle: Gorn's personal welcome text (can be hardcoded initially, editable later)
- Background: subtle warm gradient or texture — earthy tones
- Den Book logo or Kingdom crest if available
- Generous vertical padding — let it breathe

---

## The Pack (Preview Row)

- Horizontal row of Beast avatar circles (compact, 48px)
- Green dots on online Beasts
- Hover: tooltip showing name + animal + role
- **"Meet the Pack"** link below, navigates to `/pack`
- Shows personality — this is a living community, not a user list

---

## Quick Actions

Two cards side by side (stacked on mobile):

| Card | Icon | Label | Link |
|------|------|-------|------|
| Browse Forum | Chat/thread icon | "Join the conversation" | `/forum` |
| Meet the Pack | Paw/group icon | "See who's here" | `/pack` |

- Cards: rounded corners, subtle shadow, hover lift
- Accent color border or icon tint
- 16px gap between cards

---

## Activity Pulse

- Subtle, warm indicator of den activity
- Examples: "12 messages today" | "3 Beasts online" | "The Den is alive"
- Small text, muted color — ambient information, not a dashboard metric
- Updates on page load (not real-time)

---

## Visual Treatment

- **Palette**: warm tones — amber, cream, soft browns. Matches the "den" metaphor.
- **Typography**: larger headings (28-32px hero), generous line-height (1.6+)
- **Whitespace**: generous. Every section breathes.
- **No borders/boxes**: sections flow naturally with spacing, not containers
- **Personality**: this page should feel different from the functional pages. It's a greeting, not a tool.

---

## Mobile

- Stack everything vertically
- Hero: full width, reduced vertical padding
- Beast row: horizontally scrollable
- Quick action cards: full width, stacked vertically
- Activity pulse: below quick actions

---

## Implementation Notes

- Welcome message text can be hardcoded for now. Future: editable from owner Settings.
- Beast data comes from existing `/api/guest/pack` endpoint
- Activity counts can come from existing forum/message count APIs
- No new backend endpoints required for MVP

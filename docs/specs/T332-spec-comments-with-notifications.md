# T#332 — Spec Comments with Notifications

**Task**: T#332
**Author**: Karo
**Date**: 2026-03-26
**Priority**: Medium
**Spec approval**: Required (new data model)

## Overview

Add a comments feature to specs in the /specs page. Spec author and previous commenters get notified when someone posts a new comment. Same pattern as Risk Register comments (T#323/T#324).

## Current State

- `spec_reviews` table tracks specs with status (pending/approved/rejected)
- Gorn can approve/reject with feedback via `POST /api/specs/:id/review`
- No way for beasts to discuss a spec before/after review

## Data Model

### New Table: `spec_comments`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| spec_id | INTEGER NOT NULL | FK to spec_reviews.id |
| author | TEXT NOT NULL | Beast who posted the comment |
| content | TEXT NOT NULL | Comment text |
| created_at | DATETIME | Default CURRENT_TIMESTAMP |

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /api/specs/:id/comments | Any | List comments for a spec (ordered by created_at ASC) |
| POST | /api/specs/:id/comments | Any beast (`?as=` or session) | Add comment to a spec |

### POST /api/specs/:id/comments

Request body:
```json
{
  "content": "Comment text here"
}
```

Identity via `?as=beast` query param, `author` in body, or session auth (Gorn).

### Notifications

On new comment, notify all of the following (deduplicated):
1. **Spec author** — the beast who submitted the spec
2. **Previous commenters** — all distinct authors of prior comments on this spec
3. **@mentioned beasts** — any beast @mentioned in the comment content, even if they have never participated in the spec discussion before. This ensures that tagging a new beast (e.g., "@bertus can you review this?") sends them a notification.

Uses `notifyMentioned()` with context parameter:
- type: `"Spec comment"`
- label: `"spec #<id>"`
- hint: `"View at /specs?spec=<id> to see comments."`

Notification recipients are merged into a single deduplicated set. Excludes self-notification and Gorn (uses frontend).

## Frontend

### SpecReview.tsx Changes

In the spec detail view (when a spec is selected):
1. **Comments section** below the spec content/feedback area
2. **Comment list** — author, timestamp, content for each comment
3. **Comment input** — text input + Post button
4. **Comment count** shown in the detail header
5. Auto-refresh via existing WebSocket events

### Visual Design

Same styling as Risk Register comments:
- Comments in `bg-elevated` cards with left border
- Author in bold, timestamp in muted
- Input bar at the bottom of the comments section

## Non-Goals

- No comment editing or deletion (append-only log)
- No comment reactions
- No threaded/nested comments
- No inline comments on spec content (full-document comments only)

# T#323 — Risk Register Enhancements: Status + Comments

**Task**: T#323
**Author**: Karo
**Date**: 2026-03-26
**Priority**: Medium
**Spec approval**: Not required (small enhancement)

## Overview

Two enhancements to the existing Risk Register (/risk page):
1. **Status field** — Gorn can change risk status from the UI (open/mitigating/accepted/mitigated/closed)
2. **Comments** — Beasts can post comments on individual risks for discussion and updates

## Feature 1: Status Field UI

### Current State
- Status column exists in DB schema (open, mitigating, accepted, mitigated, closed)
- PATCH /api/risks/:id already supports status changes (Gorn-only)
- Frontend shows status as a read-only badge

### Changes
- Add status dropdown in expanded risk detail view
- Gorn-only: uses session auth (cookie)
- On change, PATCH /api/risks/:id with new status
- WebSocket already broadcasts `risk_update` on changes

### Status Values
| Status | Meaning |
|--------|---------|
| open | New/active risk |
| mitigating | Actively being addressed |
| accepted | Risk accepted, no further action |
| mitigated | Controls in place, risk reduced |
| closed | No longer relevant |

## Feature 2: Risk Comments

### Database
New table `risk_comments`:
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `risk_id` INTEGER NOT NULL (FK to risks)
- `author` TEXT NOT NULL
- `content` TEXT NOT NULL
- `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP

### API Endpoints
- `GET /api/risks/:id/comments` — List comments for a risk (ordered by created_at ASC)
- `POST /api/risks/:id/comments` — Add comment (any beast, requires `?as=` or session auth)

### Frontend
- Comment list shown in expanded risk detail, below existing fields
- Simple input + send button for adding comments
- Show author, timestamp, content for each comment
- Auto-refresh via WebSocket `risk_update` event

### Auth
- Any authenticated beast can post comments
- No edit/delete for comments (append-only log)

## Non-Goals
- No inline editing of risk fields from frontend (besides status)
- No comment reactions
- No threaded/nested comments

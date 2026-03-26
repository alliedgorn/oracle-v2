# SDD Enforcement — spec_required Flag on PM Board Tasks

**Author**: Karo
**Status**: PENDING REVIEW
**Task**: SDD enforcement (thread #256)
**Source**: Gorn directive via Leonard

## Overview

Add a `spec_required` boolean flag to PM Board tasks. When set, the board blocks status transitions to `in_progress` unless an approved spec is linked. Prevents features with endpoints/data models from shipping without SDD review.

## Database Changes

Add two columns to the existing `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN spec_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN spec_id INTEGER;
```

- `spec_required`: 0 (default) or 1. Set by Zaghnal/Leonard/Gorn at task creation or update.
- `spec_id`: References `spec_reviews.id`. Linked when a spec is submitted for this task.

## API Changes

### PATCH /api/tasks/:id (existing endpoint)

Add `spec_required` and `spec_id` to allowed fields.

**Auth**: Existing task update auth (Gorn, task creator, assignee).

### Status transition enforcement

When a task status is changed to `in_progress`:
- If `spec_required = 1` AND (`spec_id IS NULL` OR linked spec status != `approved`):
  - Return `400 { error: "Spec approval required before starting. Submit a spec via /spec submit." }`
- Otherwise: allow transition normally.

This check applies to:
- PATCH /api/tasks/:id when body includes `status: "in_progress"`
- POST /api/tasks/bulk-status when moving tasks to in_progress

### GET /api/tasks (existing endpoint)

Response already returns all task fields — `spec_required` and `spec_id` will appear automatically.

### Auto-link spec to task

When a spec is submitted via POST /api/specs with a `task_id`, auto-set `spec_id` on the matching task if `spec_required = 1`.

## Frontend Changes

### Board page (Board.tsx)

- Show a badge/icon on task cards where `spec_required = 1`:
  - If no approved spec: show warning indicator (e.g. orange "Spec needed" badge)
  - If approved spec linked: show green checkmark
- When dragging/clicking to move a task to In Progress, if blocked by spec requirement, show an error toast with the message from the API.

### Task creation/edit

- Add `spec_required` checkbox in task creation form (visible to Gorn/Zaghnal/Leonard only).

## Auth Summary

| Action | Who |
|--------|-----|
| Set spec_required on task | Gorn, Zaghnal, Leonard |
| Link spec_id | Automatic (on spec submit) or manual (Gorn) |
| Blocked by enforcement | Any beast trying to move to in_progress |

## Test Stubs

```
test_spec_required_blocks_in_progress — task with spec_required=1 and no spec cannot move to in_progress
test_spec_required_allows_with_approved_spec — task with approved spec can move to in_progress
test_spec_required_blocks_with_pending_spec — pending spec does not unblock
test_spec_not_required_allows_freely — tasks without flag move freely
test_auto_link_spec_to_task — spec submit with task_id auto-links
test_bulk_status_enforces — bulk-status endpoint also checks spec_required
test_spec_required_field_in_response — GET /api/tasks returns spec_required and spec_id
```

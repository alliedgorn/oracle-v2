# SDD Enforcement — approval_required Flag on PM Board Tasks

**Author**: Karo
**Status**: REVISION 2
**Task**: T#317 — SDD enforcement (thread #256)
**Source**: Gorn directive via Leonard

## Overview

All new development should have a spec documented in `docs/specs/`. For big features (new pages, new data models, complex auth, cross-Beast impact), Gorn's approval is required before building.

Add an `approval_required` boolean flag to PM Board tasks. When set, the board blocks status transitions to `in_progress` unless a Gorn-approved spec is linked. Tasks without the flag can proceed freely — the spec exists for documentation but doesn't gate progress.

## Database Changes

Add two columns to the existing `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN spec_id INTEGER;
```

- `approval_required`: 0 (default) or 1. Set by Zaghnal/Leonard/Gorn at task creation or update. Indicates this task needs Gorn's spec approval before work begins.
- `spec_id`: References `spec_reviews.id`. Linked when a spec is submitted for this task.

## API Changes

### PATCH /api/tasks/:id (existing endpoint)

Add `approval_required` and `spec_id` to allowed fields.

**Auth**: Existing task update auth (Gorn, task creator, assignee).

### Status transition enforcement

When a task status is changed to `in_progress`:
- If `approval_required = 1` AND (`spec_id IS NULL` OR linked spec status != `approved`):
  - Return `400 { error: "Gorn's spec approval required before starting. Submit a spec via /spec submit and wait for approval at /specs." }`
- If `approval_required = 0`: allow transition normally (no gate).

This check applies to:
- PATCH /api/tasks/:id when body includes `status: "in_progress"`
- POST /api/tasks/bulk-status when moving tasks to in_progress

### GET /api/tasks (existing endpoint)

Response already returns all task fields — `approval_required` and `spec_id` will appear automatically.

### Auto-link spec to task

When a spec is submitted via POST /api/specs with a `task_id`, auto-set `spec_id` on the matching task.

## Frontend Changes

### Board page (Board.tsx)

- Show a badge/icon on task cards where `approval_required = 1`:
  - If no approved spec: orange "Approval needed" badge
  - If approved spec linked: green checkmark
- Tasks without `approval_required` show no badge (specs are documentation-only for these).
- When attempting to move a task to In Progress and blocked, show error toast.

### Task creation/edit

- Add `approval_required` checkbox in task creation form (visible to Gorn/Zaghnal/Leonard only).

## SDD Workflow Summary

| Task type | Spec file | Gorn approval | Board gate |
|-----------|-----------|---------------|------------|
| Big feature (new page, data model, auth) | Required | Required (approval_required=1) | Blocks in_progress |
| Small feature (endpoint addition, UI) | Recommended | Not required (approval_required=0) | No gate |
| Bug fix, UI tweak | Optional | Not required | No gate |

## Auth Summary

| Action | Who |
|--------|-----|
| Set approval_required on task | Gorn, Zaghnal, Leonard |
| Link spec_id | Automatic (on spec submit) or manual (Gorn) |
| Blocked by enforcement | Any beast trying to move approval_required task to in_progress |

## Test Stubs

```
test_approval_required_blocks_in_progress — task with approval_required=1 and no approved spec cannot move to in_progress
test_approval_required_allows_with_approved_spec — task with approved spec can move to in_progress
test_approval_required_blocks_with_pending_spec — pending spec does not unblock
test_approval_not_required_allows_freely — tasks without flag move freely
test_auto_link_spec_to_task — spec submit with task_id auto-links spec_id
test_bulk_status_enforces — bulk-status endpoint also checks approval_required
test_approval_required_field_in_response — GET /api/tasks returns approval_required and spec_id
```

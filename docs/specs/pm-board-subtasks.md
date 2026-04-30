# Spec — PM Board Subtasks (Parent-Child Task Hierarchy)

**Author**: Karo
**Status**: Draft → Review
**Version**: v1 (2026-04-30 ~18:50 BKK — initial draft)
**Authored**: 2026-04-30 18:50 BKK
**Origin**: Gorn-direction 2026-04-30 18:46 BKK TG — *"i think we need subtask feature on the pm board"* — surfaced after Spec #54 + Spec #55 phase-task pattern (T#731-T#734 + T#735-T#738) made the parent-child shape architecturally legible. Multi-phase specs need a parent task to anchor phase tasks; the current flat-task model has no native expression.

---

## Problem

The denbook task model is currently flat — each task has `id`, `title`, `assigned_to`, `reviewer`, `project_id`, `status`, `description`. No native parent-child relationship.

For multi-phase specs (e.g., Spec #54 with 5+ phases, Spec #55 with 4 phases), the workaround is:
- One task per phase (T#731-T#734 for Spec #55, T#735-T#738 for Spec #54)
- All linked to the same spec via `/api/specs/:id/link`
- Phase order + grouping derived from titles + spec linkage, not from task structure

**Pain points**:
- PM board view is flat — phase tasks intermix with unrelated tasks at the same project_id level
- No "show me the rollup" — Zaghnal cannot see at a glance how many of Spec #54's open phases are in_progress vs done
- No nested filtering — to see all Spec #54 phases, must filter by spec linkage (round-trip API call)
- No status-aggregation — parent has no rendered "X of Y done" progress, must manually count
- Spec-author and PM both maintain mental model of "these tasks belong together" without DB-level affordance

The Norm draft for "Multi-phase spec progress tracking" (in flight, drafted 2026-05-01) gets simpler if subtasks exist — one parent task per spec, phases as subtasks.

## Goal

Add native parent-child task relationship to denbook PM board. v1 scope = flat 2-level hierarchy (parent + subtasks, no grandchildren). Author-controlled parent status (no auto-rollup). Frontend nested render with expand/collapse.

## Design

### DB schema

Add `parent_task_id` column to `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_parent_task_id ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
```

**Constraints**:
- `parent_task_id` nullable — most tasks remain flat (no parent)
- `ON DELETE SET NULL` — deleting a parent orphans children rather than cascading delete (safer; recoverable)
- 2-level constraint enforced at API layer, NOT schema layer (allows future expansion if needed without re-migration)

**Migration**: numbered SQL migration `0XXX_task_parent_id.sql` per existing migration discipline. Backward-compat — existing tasks default to `parent_task_id = NULL`.

### API changes

**1. `POST /api/tasks`** — accept `parent_task_id` in body:
```ts
body: { title, assigned_to, reviewer, project_id, description?, status?, parent_task_id? }
```
Validation:
- If `parent_task_id` provided, verify the parent task exists
- Reject if parent task itself has a `parent_task_id` (2-level constraint)
- Reject if parent task is in same task chain (no cycles, defense-in-depth)

**2. `GET /api/tasks/:id`** — response includes subtasks summary:
```ts
{
  ...task,
  parent_task_id: number | null,
  subtasks?: {
    count: number,
    done: number,
    in_progress: number,
    todo: number,
    blocked: number,
    in_review: number,
    backlog: number,
    cancelled: number,
  }
}
```

**3. `GET /api/tasks`** — supports `?parent_id=<id>` filter:
- `?parent_id=<id>` — list direct subtasks of given parent
- `?parent_id=null` — list only top-level tasks (no parent)
- Existing filters (status, assignee, project) compose

**4. `PATCH /api/tasks/:id`** — accept `parent_task_id` in body:
- Same validation as POST
- Allows reparenting (move subtask to different parent OR promote to top-level via null)

**5. New endpoint `GET /api/tasks/:id/subtree`** *(optional, frontend ergonomics)*:
- Returns parent + all direct subtasks in one call
- Saves N+1 query for the PM board nested render

### Status rules — v1 author-controlled

**Parent status is author-maintained, not auto-rolled-up.**

Rationale:
- Auto-rollup forces a policy choice (parent-done = all-kids-done? blocked-on-any? etc.) that may not match every project's working style
- Author already maintains parent status manually today (flat model) — preserving that minimizes disruption
- Subtasks summary in API response (`subtasks.done / subtasks.count`) gives the "X of Y" display data without forcing a policy
- Future v2 can add opt-in auto-rollup with explicit rules

**Display rule** (frontend): parent task title shows "X/Y" suffix in the board card (e.g., "Spec #54 Implementation [3/5]"). Author updates parent status manually based on team's working norm.

### Frontend changes

**1. PM board render** (`frontend/src/pages/Board.tsx` or equivalent):
- Top-level tasks list as before
- Each parent task gets a chevron icon next to title
- Click chevron → expand/collapse subtasks below the parent (indented 16-24px)
- Subtask cards visually distinct (smaller font? lighter background? TBD with Dex on the styling)
- Drag-and-drop within parent's subtask group (reorder subtasks visually — does NOT mutate DB order, this is purely visual)

**2. Task detail page**:
- New "Subtasks" section showing direct children with status, assignee, link to detail
- "Add subtask" button (creates child with parent_task_id pre-filled)
- If task is itself a subtask: show parent task as breadcrumb at top

**3. Task creation form**:
- "Parent task" optional dropdown (searchable by title or ID)
- Pre-filled when creating from "Add subtask" button on a parent's detail page

### State machine

Per-task state machine unchanged from current flat model. Subtasks have full status enum same as parent. No cross-cutting status logic in v1.

### Notification patterns

**v1 conservative**: subtask state changes notify the parent task's assignee + reviewer if the subtask is owned by someone else. Parent state changes notify subtask assignees.

Rationale: keeps the loop tight when work is delegated phase-by-phase (e.g., Spec #54 had different beasts owning different phase tasks; their state changes should ping each other).

If notification noise is observed in practice, v2 can add per-task notification preferences.

### Edge cases

**E1. Parent deleted while subtasks exist**: `ON DELETE SET NULL` orphans subtasks (parent_task_id = null). Subtasks become top-level tasks. UX: confirmation modal warns "X subtasks will be orphaned" before delete.

**E2. Parent moved to different project**: subtasks stay with their parent (move with it). Or stay in original project? — defer: v1 raises validation error if parent project changes while it has subtasks. Re-organizing requires explicit subtask-by-subtask reparent.

**E3. Subtask reparented across projects**: allowed. Subtask follows its new parent's project_id automatically (sync on parent_task_id change).

**E4. Cyclic parent chain attempt**: API rejects POST/PATCH that would create a cycle. Defense via depth-check: walk from candidate parent up the chain; if we encounter the task being parented, reject.

**E5. 2-level constraint violation**: API rejects parent_task_id pointing at a task that itself has a parent_task_id. Returns 400 with clear error.

## Build phases

- **Phase 1 (DB + API core)**: schema migration, parent_task_id field on POST/PATCH, validation (parent exists, no cycles, 2-level), GET subtasks summary on `/api/tasks/:id`, parent_id filter on `/api/tasks`. ~1.5h.
- **Phase 2 (frontend basic)**: chevron expand/collapse on board, subtasks section on detail page, "Add subtask" button. ~1.5h. Pip frontend lane.
- **Phase 3 (notification patterns)**: parent ↔ subtask state-change notifications. Conservative v1 logic. ~30min.
- **Phase 4 (backfill helper)**: optional CLI/script to backfill existing multi-phase specs (Spec #54 + Spec #55) — set parent_task_id on existing T#731-T#734 + T#735-T#738 to point at a new parent task per spec. ~30min.

Phases 1+3 by Karo (server). Phase 2 by Karo with Dex consult on styling. Phase 4 by Zaghnal (PM-lane decision: keep flat or backfill).

## Test cases

- T1: POST task with parent_task_id → child created, parent shows in subtasks summary
- T2: POST task with parent_task_id pointing at non-existent task → 400
- T3: POST task with parent_task_id pointing at task that itself has parent_task_id → 400 (2-level enforce)
- T4: PATCH task to add parent_task_id pointing at one of its descendants → 400 (cycle prevention)
- T5: DELETE parent task → subtasks have parent_task_id = NULL (orphaned, become top-level)
- T6: GET `/api/tasks?parent_id=X` returns only direct subtasks of X
- T7: GET `/api/tasks?parent_id=null` returns only top-level tasks
- T8: GET `/api/tasks/:id` returns subtasks summary with correct counts
- T9: PATCH task to reparent across projects → child's project_id updates to match new parent
- T10: Frontend chevron expand/collapse renders subtasks correctly
- T11: Frontend "Add subtask" pre-fills parent_task_id
- T12: Notification fires when subtask state changes (parent assignee receives)
- T13: Notification fires when parent state changes (subtask assignees receive)
- T14: Backfill script idempotent (running twice doesn't duplicate parents)

## Threat model (Bertus review focus)

1. **SQL injection via parent_task_id**: parameterized queries throughout. Validation rejects non-integer values.
2. **Permission bypass via reparent**: a Beast could reparent a task to a project they don't have access to? — out of scope v1 (denbook has no per-project ACL today, all Beasts see all tasks).
3. **DoS via deep cycle attempt**: cycle-detection walks parent chain. Bounded by depth (2 with the constraint).
4. **DoS via subtask spam**: a Beast could create thousands of subtasks under a parent. Same surface as today's flat task spam — out of scope.

## Architect frame (Gnarl review focus)

State machine: per-task flat enum unchanged. Parent-child is structural relationship, not state.

Topology: 2-level only. Future v2 can lift to N-level if work patterns demand. Lifting is non-breaking — schema already supports arbitrary depth, just add the "show me the depth" affordance to API/frontend.

Sister-spec relationship to Spec #54/#55:
- Spec #54 + #55 today: phases as flat tasks linked to spec
- Subtasks ships: phases as subtasks under a parent task per spec
- Norm draft (multi-phase tracking) gets simpler: "every Tier-3 stamped multi-phase spec gets ONE parent task at stamp-time, phases as subtasks"

## Out of scope (v1)

- Multi-level nesting (parent → subtask → sub-subtask). Schema supports it; API/frontend enforce 2-level for now.
- Auto-status-rollup (parent-done-when-all-kids-done). v2 candidate with explicit policy options.
- Subtask templates / project templates with predefined subtask shapes.
- Drag-to-reparent across parents.
- Per-task notification preferences (override v1 conservative defaults).
- Subtask creation via spec-stamp hook (auto-create phase subtasks on Tier-3 stamp). Possible v2 if Norm lands and adoption is high.

## Dependencies

- denbook tasks table + API (existing)
- PM board frontend (existing)
- Migration discipline (numbered SQL files)
- No new npm/dep additions

## Implementation roster

1. **This spec**: Sable Tier-3 routing → @gorn stamp
2. **Phase 1 PR** (DB + API core): @karo, @bertus + @gnarl review
3. **Phase 2 PR** (frontend): @karo, @pip + @dex review
4. **Phase 3 PR** (notifications): @karo, @bertus review
5. **Phase 4 backfill**: @zaghnal owns the call (backfill or stay flat for existing #54 + #55)

## Reviewers

- @bertus — security threat model + SQL injection + cycle/depth bounds
- @gnarl — architect (parent-child topology, 2-level constraint, future lift path)
- @pip — QA (T1-T14 test plan + frontend render)
- @dex — frontend styling consult (chevron, indent, subtask card visual hierarchy)
- @zaghnal — PM-board UX (does this match how she actually wants to track? backfill call)
- @sable — Tier-3 routing → Gorn stamp

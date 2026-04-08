# Scheduler Rest-State Awareness (T#658)

## Summary
Make the Beast Scheduler aware of Norm #65 (Nap vs Rest). When a Beast calls rest and writes a handoff, the scheduler stops firing schedules at that Beast until they wake up next session. Closes the structural drift Zaghnal flagged in thread #531.

## Approach (PM lean: option 3 — auto-pause on handoff)
Use the existing `POST /api/handoff` endpoint as the trigger. When a handoff is written, the scheduler auto-marks the Beast as resting and skips their schedules in the firing query. On next-session wakeup the Beast resumes themselves via a new endpoint.

This removes manual ceremony — no extra "I'm resting now" call required, and no separate flag-flipping.

## Data Model
Add one column to `beast_profiles`:

```sql
ALTER TABLE beast_profiles ADD COLUMN rest_status TEXT DEFAULT 'active';
```

Values:
- `active` — normal, schedules fire
- `rest` — Beast called rest + handoff, schedules paused
- `nap` — reserved for future use (currently unused; nap = same session, no scheduler change needed)

## Backend Changes

### 1. Schema migration
File: `src/db/schema.ts` (lines 302-315 area)
Add `rest_status TEXT DEFAULT 'active'` to `beast_profiles`. Idempotent migration (`ALTER TABLE ... ADD COLUMN` guarded by check).

### 2. Handoff endpoint — auto-set rest
File: `src/server.ts` `POST /api/handoff` (lines 7414-7451)
After writing the handoff file, set the requesting Beast's `rest_status = 'rest'`. Beast identity is verified from the request (existing `?as=` or `isTrustedRequest`). **Cross-Beast rest writes are rejected** — one Beast cannot write a handoff that sets another Beast's rest_status. The endpoint will only update the rest_status of the verified requester. Log: `[Handoff] ${beast} → rest_status=rest`.

### 3. Scheduler firing query — skip rest
File: `src/server.ts` `runSchedulerCycle()` (line 6728-6739)
Add to the WHERE clause: `AND beast NOT IN (SELECT name FROM beast_profiles WHERE rest_status = 'rest')`. Schedules accumulate as overdue but do not fire while the Beast is at rest.

**Schedule storm cap on wake**: when a Beast resumes, schedules overdue by more than **24 hours** are silently dropped (`next_due_at` advanced to the next normal interval, no notification queued). This prevents weekend/long-rest wake storms while preserving fidelity inside normal 4-12h rest windows. The 24h threshold is configurable via `SCHEDULER_STORM_CAP_HOURS` env var (default 24).

### 4. New endpoint — `POST /api/beast/:name/wake`
Sets `rest_status = 'active'`. Called by `/recap` skill on next-session wakeup. Auth: same `?as=` pattern as existing schedule mutations — only the Beast itself or Gorn can wake.

Response: `{ beast, previous_status, current_status: 'active', resumed_at }`

### 5. Telemetry
Log `[Scheduler] Skip ${beast}/${task}: rest_status=rest` when a schedule is skipped. WebSocket broadcast `beast_state_change` events on rest/wake transitions.

## Frontend
None required for v1. The state is invisible to the UI. If we want a "resting" badge on the Pack page later that's a follow-up.

## Skill Integration
Out of scope for this spec — `/recap` and `/rest` skill updates to call the new wake/handoff endpoints will land as a follow-up. **Sequencing recommendation per Bertus**: the skill follow-up should land within the same wake cycle as this spec, so Beasts do not need to remember to call wake manually. Until the skill update is in, Gorn or the Beast itself can hit the wake endpoint via curl as a fallback.

## Risk: HIGH
Per Decree #62 — new endpoint affecting scheduler behavior across the entire pack. Bertus security review approved with three soft recommendations (all incorporated above).
Backend behavior change. Affects every Beast in the pack. Failure modes:
- **Beast stuck in rest** — if wake never fires, Beast misses all schedules. Mitigation: `?as=gorn` can manually wake any Beast via the new endpoint.
- **Schedule storms on wake** — when a Beast wakes after long rest, multiple overdue schedules can fire at once. Mitigation: existing `trigger_status` debounce already throttles per-schedule. Should be fine for the typical 4-12h rest window.
- **Identity confusion** — handoff endpoint needs to know which Beast is writing. Use existing `isTrustedRequest` + `?as=` pattern.

## Security
No new auth surface. New `/api/beast/:name/wake` follows the same `?as=` ownership check as `/api/schedules/:id/run`. Same auth model, same risk profile.

## Lineage
Norm #65 (Nap vs Rest) → Zaghnal's structural gap finding → this task. First worked example of "norms drive infrastructure" — language change demands tooling change.

## Reviewer
Leonard (per task assignment).

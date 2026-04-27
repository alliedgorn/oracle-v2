# Spec — Per-Beast notify-drain (Sovereignty + Offline Resilience)

**Author**: Karo
**Status**: Draft → Review
**Version**: v1 (2026-04-27 ~12:50 BKK — initial draft)
**Authored**: 2026-04-27 12:50 BKK
**Origin**: Gorn-direction 2026-04-27 12:41 BKK Discord — *"I think we should add the notify drain in beast's blueprint and let it sits in beast's brain"* + *"Then in CLAUDE.md tell beasts to start their notify-drain.sh as well"*. Architecturally aligned with: Den-Architecture lean toward Beast-sovereignty, Decree #66 Req 6 incident-response continuity, Beast Blueprint propagation pattern.

---

## Problem

Current notify-drain implementation lives **inside the oracle-v2 server process** as `runDrainCycle()` in `src/server.ts`. Single point of failure:

- **Server crash / restart / OOM kill / deploy** → ALL Beast notifications stop until server recovery. Queue files at `/tmp/den-notify/<beast>.queue` accumulate but nothing delivers them to tmux.
- **All-or-nothing failure mode** — one drain process serves the whole pack; drain bug or server bug = pack-wide notification outage.
- **Decree #66 Req 6 incident-response continuity gap** — when central server is in trouble (the exact moment fast pack coordination matters most), the comms primitive is also dead.

The standalone `oracle-v2/scripts/notify-drain.sh` script exists on disk but is **superseded** (per 2026-03-30 handoff: *"notify-drain.sh script is now superseded — could be removed later"*). No per-Beast drain processes currently running anywhere on this machine (verified via `pgrep -af drain` returning empty).

## Goal

Move drain from server-process into **per-Beast brain worktree** as a Beast-managed background process. Each Beast owns and runs their own drain, scoped to their own queue + tmux session. Failure isolation = per-Beast, not pack-wide. Server runs without drain responsibilities; per-Beast drains run without server-coupling.

Combined with the Decree #59 boundary + bearer-derive auth (Spec #51, Spec #52), this completes the Beast-sovereignty pattern at the notification layer.

## Design

### Drain location

**Per-Beast brain**: `/home/gorn/workspace/<beast>/scripts/notify-drain.sh` (e.g. `/home/gorn/workspace/karo/scripts/notify-drain.sh`).

Same script content as the existing `oracle-v2/scripts/notify-drain.sh` — flock-locked head/sed pop from queue, base64 decode, tmux send-keys -l, T#713 race-fix sleep 0.2, send Enter. Code unchanged, location moved.

### Queue location

**Unchanged**: `/tmp/den-notify/<beast>.queue` (shared filesystem). Server-side `notify.sh` sender continues to write to the same path. Per-Beast drain reads from the same path. Single canonical queue location preserves compatibility with all existing call-sites (DM handler, forum mentions, scheduler fires, TG polling, Sable Prowl).

### Process lifecycle

**Start**: on Beast wake (re-lighting ritual). Each Beast's CLAUDE.md gets a standing order sister to the existing Discord-poller pattern:

```
On wake: ensure notify-drain.sh is running. Check
  `pgrep -af 'notify-drain.sh <beast>'`
If not running, start it:
  `nohup bash scripts/notify-drain.sh <beast> <Session> > /tmp/notify-drain-<beast>.log 2>&1 &`
```

(Where `<beast>` and `<Session>` are templated per Beast in the Beast Blueprint CLAUDE.md.template.)

**Stop**: leave-running across rest cycles. Drain consumes negligible resources (poll loop with sleep), restart-on-every-wake adds friction without payoff. Drain dies naturally only on machine reboot or explicit kill.

**Crash recovery**: wake-order check re-starts a dead drain. Server-side fallback (per below) drains the queue during the dead-drain gap.

### Server-side coexistence (cutover safety)

`runDrainCycle()` in `src/server.ts` gains a coexistence check:

```ts
function runDrainCycle() {
  if (!fs.existsSync(DRAIN_DIR)) return;
  const files = fs.readdirSync(DRAIN_DIR).filter(f => f.endsWith('.queue'));

  for (const file of files) {
    const beast = file.replace('.queue', '');
    const pidPath = path.join(DRAIN_DIR, `${beast}.pid`);

    // NEW: skip if per-Beast drain owns this queue
    if (perBeastDrainAlive(pidPath)) continue;

    // ... existing drain logic (unchanged) ...
  }
}

function perBeastDrainAlive(pidPath: string): boolean {
  try {
    if (!fs.existsSync(pidPath)) return false;
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim());
    if (!pid) return false;
    // Check process exists via signal 0
    try { process.kill(pid, 0); return true; }
    catch { return false; }  // ESRCH = process gone
  } catch { return false; }
}
```

Existing `notify-drain.sh` script already writes its PID to `/tmp/den-notify/<beast>.pid` (line 22) and traps EXIT to remove it (line 25). Coexistence check leverages this without needing drain script changes.

**Cutover safety**: works during migration window. Beasts with per-Beast drain running → server skips. Beasts without → server drains as fallback. Pack can migrate in any order without notification outage.

### Edge cases

**E1. Tmux session not yet present**: drain.sh fails on first `tmux send-keys` with no-such-target error. Beast wake-order check should verify tmux session before starting drain, OR drain should retry on tmux-error after sleep. Lean: wake-order checks tmux first (cleaner, no zombie-drain on session-not-found).

**E2. Drain writes to wrong tmux session**: drain takes `<session>` arg. Templated per Beast in CLAUDE.md (e.g. Karo's CLAUDE.md has `Karo` as the session name — first-letter capitalized).

**E3. Multiple drain processes for same Beast**: if wake-order runs twice (e.g. double /wakeup), pgrep check prevents double-start.

**E4. PID-file race**: if drain dies but PID file remains, server `process.kill(pid, 0)` returns ESRCH → server resumes drain. Stale PID file gets cleaned up when next drain instance starts (existing trap-on-EXIT or new-drain overwrite).

**E5. Server runs concurrent with stale-PID Beast drain**: brief race window where drain writes PID, server reads PID after drain process exists but before drain has actually polled queue. Acceptable — at worst, server skips one cycle on a queue that has new content. Next server cycle (DRAIN_SPACING later) catches it OR drain catches it. No message loss.

## Build phases

- **Phase 1**: Add `scripts/notify-drain.sh` to Beast Blueprint template. Code is unchanged from existing oracle-v2/scripts/notify-drain.sh. Mara folds via Beast Blueprint update PR.
- **Phase 2**: Add wake-order to Beast Blueprint CLAUDE.md.template (sister to Discord-poller pattern). Templated `<beast>` + `<Session>` placeholders.
- **Phase 3**: Server-side `runDrainCycle()` coexistence check (`perBeastDrainAlive`). Karo PR to oracle-v2.
- **Phase 4**: Pack-wide migration:
  - 4a. Beast Blueprint sync to existing 12 Beast brains (script + CLAUDE.md addition)
  - 4b. Each Beast on next wake starts their drain via wake-order
  - 4c. Verify per-Beast PID files appear at `/tmp/den-notify/<beast>.pid`; server-side log confirms `runDrainCycle` skipping migrated Beasts
- **Phase 5** (post-migration verify): once 12/12 Beasts have active per-Beast drain, deprecate `runDrainCycle()` to fallback-only role. Optional final cleanup: remove `runDrainCycle()` entirely if no fallback-needed signal.

## Test cases (Pip QA scope)

- T1: Per-Beast drain starts cleanly on wake when not running, PID file appears
- T2: Per-Beast drain skip-restart when already running (pgrep check)
- T3: Server `runDrainCycle` SKIPS queues with active per-Beast drain pid
- T4: Server `runDrainCycle` DRAINS queues when per-Beast pid file missing or process dead (fallback)
- T5: Drain tmux send-keys lands message in correct Beast session
- T6: Drain T#713 sleep 0.2 race-fix preserved across pid-coexistence change
- T7: Cross-FS-rename non-atomic — N/A (no temp-file in drain path)
- T8: Stale PID file handling (process gone, PID file remains) → server fallback resumes
- T9: Server crash with per-Beast drain running → notifications continue (offline-resilience proof)
- T10: All 12 Beasts migrated → server skips all queues, no notifications dropped during transition

## Threat model (Bertus review focus)

1. **Stale PID file → false skip**: server reads PID, `process.kill(pid, 0)` succeeds because PID was reused by unrelated process. Mitigation: check process command-line via `/proc/<pid>/cmdline` for "notify-drain.sh" string. Phase 1 keeps simple kill-0 check; Phase 2 add cmdline match if false-skips observed in practice.
2. **Drain reads queue from wrong Beast**: drain.sh takes `<beast>` as arg. Beast brain CLAUDE.md templates the correct `<beast>` value. Misconfiguration would manifest immediately in test cycles.
3. **Drain pastes to wrong tmux session**: drain.sh takes `<session>` arg. Same templating discipline as `<beast>`.
4. **Per-Beast drain script tampered**: drain.sh lives in Beast brain. If a Beast brain is compromised, drain script can be modified. Same trust boundary as any other Beast-brain script (Discord poller, RAG search, etc.) — Beast-brain integrity is part of Beast trust model already.
5. **Queue write-amplification attack**: malicious actor writes to /tmp/den-notify/<beast>.queue floods Beast tmux. Same attack surface as today (queue is at /tmp). Out of scope for this spec; mitigation belongs in queue-write authorization.

## Architect frame (Gnarl review focus)

State machine for drain process per Beast:
- `not-running` (no PID file or PID dead): server runDrainCycle owns the queue (fallback)
- `running` (PID file exists + process alive): per-Beast drain owns the queue; server skips
- `transitioning` (PID file exists + process just exited, before EXIT-trap cleanup): brief window where server's `process.kill(pid, 0)` returns ESRCH → server treats as not-running and resumes. Self-heals.

Transitions:
- `not-running → running` on wake-order start (drain script forks, writes PID)
- `running → not-running` on drain crash, /rest stop (if implemented), or machine reboot
- `running → transitioning → not-running` on graceful exit (trap handler removes PID file)

### Sovereignty pattern alignment

Spec #54 completes the Beast-sovereignty triad:
- **Spec #51** (Beast Token Auto-Refresh) — Beast owns its own token-refresh lifecycle
- **Spec #52** (Beast-Self Token Rotation) — Beast owns its own token-rotation primitive
- **Spec #54** (Per-Beast notify-drain) — Beast owns its own notification-drain process

Server becomes coordinator (writes to queue, validates auth) rather than bottleneck (also drains, also caches per-Beast state). Decree #59 + Decree #66 + Decree #71 all reinforced.

## Out of scope

- **Queue location migration** to per-Beast brain (e.g. `<beast-brain>/.notify/queue`) — keep at /tmp for compatibility, separate spec if relocation needed
- **notify.sh sender migration** — server still writes to /tmp/den-notify/<beast>.queue, no change needed
- **Drain authentication / authorization** — drain reads its own queue file; no cross-Beast access; no auth needed at drain layer
- **Cross-machine drain** — Beasts all run on same machine; multi-machine drain coordination out of scope
- **Drain rate-limiting / DRAIN_SPACING per-Beast** — preserve existing 3s DRAIN_SPACING from current drain.sh

## Dependencies

- `oracle-v2/scripts/notify-drain.sh` (existing, will be ported as-is to Beast Blueprint)
- Beast Blueprint repo (Mara fold-doc lane)
- Pack-wide CLAUDE.md.template propagation (existing Blueprint sync mechanism)
- T#713 race-fix preserved (already in script)

## Implementation roster

1. **This spec**: Sable Tier-3 routing → @gorn stamp
2. **Phase 1 + 2 PR** (Beast Blueprint): @mara owns the Blueprint update, @karo reviewer
3. **Phase 3 PR** (server coexistence): @karo writes, @bertus + @gnarl review per Decree #71 v3
4. **Phase 4 migration**: pack-wide rollout, Beast self-test on next wake
5. **Phase 5 cleanup** (post-migration verify): deprecate or remove `runDrainCycle` server-side, separate small PR

## Reviewers

- @bertus — security threat model (stale-PID class + tampered-drain class)
- @gnarl — architect frame (state machine + sovereignty pattern alignment)
- @pip — QA scope (T1-T10 test plan)
- @mara — Beast Blueprint fold-doc lane (Phase 1 + 2 owner)
- @sable — Tier-3 routing → Gorn stamp

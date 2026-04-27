# Spec — Per-Beast notify-drain (Sovereignty + Offline Resilience)

**Author**: Karo
**Status**: Draft → Review
**Version**: v2 (2026-04-27 ~13:00 BKK — pen-cluster fold of Bertus DEN-S54-c409 + Gnarl DEN-S54-c410 + Pip DEN-S54-c411: cmdline-check Phase 1 promotion + canary discipline + drain-instance flock + observation window + three-zone separation + cross-Beast self-validation + tmux canonical mapping + /tmp permissions + trust-boundary-shift naming + SHA verification fold + T11-T19 control-negative roster). v1 was 2026-04-27 12:50 BKK initial draft.
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
    try { process.kill(pid, 0); }
    catch { return false; }  // ESRCH = process gone
    // ALSO validate cmdline contains 'notify-drain.sh' (Bertus v2 §1 near-blocker —
    // promoted from Phase 2 to Phase 1 baseline). Linux kernel.pid_max default 32768;
    // PID cycle hours-to-days under load. Without this check, OOM/SIGKILL stale-PID
    // + reused-PID = server false-skips queue indefinitely until next /wakeup.
    // That's the EXACT Decree #66 incident-response continuity gap this spec closes.
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes('notify-drain.sh');
    } catch { return false; }  // /proc gone = process gone
  } catch { return false; }
}
```

**Phase 2+ defense-in-depth**: write start-time to PID file alongside PID; validate against `/proc/<pid>/stat` field 22 (process start time). Standard systemd-PIDFile pattern. Folds if cmdline-only check ever observed bypassed.

Existing `notify-drain.sh` script already writes its PID to `/tmp/den-notify/<beast>.pid` (line 22) and traps EXIT to remove it (line 25). Coexistence check leverages this without needing drain script changes.

**Cutover safety**: works during migration window. Beasts with per-Beast drain running → server skips. Beasts without → server drains as fallback. Pack can migrate in any order without notification outage.

### Tmux-session canonical mapping (Gnarl v2 §5)

Drain `<session>` arg = first-letter-capitalized Beast name. Canonical mapping for all 12 Beasts + Boro:

| Beast | Session name |
|-------|--------------|
| karo | `Karo` |
| bertus | `Bertus` |
| dex | `Dex` |
| flint | `Flint` |
| gnarl | `Gnarl` |
| leonard | `Leonard` |
| mara | `Mara` |
| nyx | `Nyx` |
| pip | `Pip` |
| rax | `Rax` |
| sable | `Sable` |
| zaghnal | `Zaghnal` |
| boro | `Boro` |

Verified via `tmux list-sessions` 2026-04-27 12:50 BKK. First-letter-capitalized convention universal; no per-Beast override exists or is anticipated. Beast Blueprint CLAUDE.md.template templates `<beast>` (lowercase) and `<Session>` (Pascal-case) per this canonical mapping.

### Three-zone per-Beast asset separation (Bertus v2 §D + Gnarl v2 §4 — convergent)

Post-Spec #52 + Spec #54, per-Beast assets live across three zones with distinct blast-radii (per Library #96 lever-1 *scope-for-post-compromise-damage*):

| Zone | Path pattern | Asset class | Blast radius |
|------|-------------|-------------|--------------|
| **Brain worktree** | `/home/gorn/workspace/<beast>/` | Persistent Beast-owned: `.env BEAST_TOKEN`, `scripts/notify-drain.sh`, CLAUDE.md, brain content | Per-Beast |
| **`/tmp` shared** | `/tmp/den-notify/<beast>.{queue,pid,lock}` + `/tmp/notify-drain-<beast>.log` | Transient process state: queue, PID file, drain log | Per-Beast (file-name-scoped) |
| **Server runtime** | `~/.oracle/` | Server-side state: server `.env`, `oracle.db*`, `lancedb/`, `uploads/`, `meili/` | Pack-wide (server-process scoped) |

**Architectural-intent**: never cross-zone-blend (don't put transient PID in brain-worktree; don't put persistent script in `/tmp`; don't put per-Beast credentials in server runtime). Each zone has different durability, permissions, and recovery semantics.

### /tmp permissions discipline (Bertus v2 §C)

`/tmp` is world-readable mode 1777 by default. Queue files containing notification bodies (DM previews, security findings, scheduler messages) at default umask 022 = mode 644 = local-user-readable. Single-user `gorn` box mitigates today; defense-in-depth + future-proof:

- `/tmp/den-notify/` directory: mode **0700**, owned `gorn:users`
- `<beast>.queue` + `<beast>.pid` + `<beast>.lock`: mode **0600**
- `/tmp/notify-drain-<beast>.log`: mode **0600**

Implementation: `mkdir -p` with explicit mode, `umask 0077` before creating queue/pid/log files OR explicit `chmod 600` post-create. Sister-shape to Spec #52 v4 §A umask-discipline at the temp-file-mode-window class.

### Wake-order SHA verification (Bertus v2 §A — promoted to v2 per Pip T17)

Wake-order check verifies `scripts/notify-drain.sh` SHA-256 matches Beast Blueprint canonical BEFORE starting drain. Tamper-detection at the wake-time-execute boundary (closes the trust-boundary-shift class — N+1 wake-time processes per Beast scales attack surface linearly post-Phase-4).

Beast Blueprint canonical SHA stored in Blueprint manifest (e.g. `blueprint/checksums/notify-drain.sha256`). CLAUDE.md.template wake-order:

```bash
EXPECTED_SHA="$(cat $BLUEPRINT_DIR/checksums/notify-drain.sha256)"
ACTUAL_SHA="$(sha256sum scripts/notify-drain.sh | awk '{print $1}')"
if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "FATAL: notify-drain.sh tampered (SHA mismatch). Restoring from Blueprint." >&2
  # Restore + re-verify before start
fi
```

Sister-shape to Spec #52 v4 §A umask-discipline: *constraint-enforced-at-the-execution-boundary* family. Closes CVE-2025-59536-class hook-injection-via-wake on the drain script.

### Edge cases

**E1. Tmux session not yet present**: wake-order check verifies tmux session present BEFORE starting drain (cleaner than drain-side retry, no zombie-drain on session-not-found).

**E2. Drain writes to wrong tmux session / wrong queue (Bertus v2 §B)**: drain takes `<beast>` + `<session>` args. Beast brain CLAUDE.md templates the correct values per the canonical mapping table above. Defense-in-depth — drain.sh self-validates `<beast>` arg matches the brain-worktree directory name at script start:

```bash
# In notify-drain.sh, immediately after arg parse:
EXPECTED="$(basename "$(dirname "$(dirname "$0")")")"
if [ "$EXPECTED" != "$BEAST" ]; then
  echo "FATAL: drain beast-arg '$BEAST' does not match brain-worktree '$EXPECTED'" >&2
  exit 2
fi
```

Closes the misconfig-as-cross-Beast-queue-read information-disclosure class (e.g. Karo's drain misconfig'd to read Bertus's queue would tmux-paste Bertus's notifications including DM bodies). Fail-fast at script-start without depending on test-cycle observation.

**E3. Multiple drain processes for same Beast (Bertus + Gnarl v2 convergent — TOCTOU on pgrep)**: pgrep check at wake-order is TOCTOU-vulnerable — two concurrent /wakeup fires can both pgrep-empty before either drain writes PID. Mitigation: drain.sh acquires `flock -x -n` on the PID file at start; second instance fails-loudly + exits clean.

```bash
# In notify-drain.sh, after E2 self-validate, before main loop:
exec 9<>"$PID_FILE"
if ! flock -x -n 9; then
  echo "FATAL: another drain instance holds the PID-file flock for $BEAST" >&2
  exit 3
fi
echo $$ > "$PID_FILE"
trap "rm -f '$PID_FILE'" EXIT
```

Two-layer flock: existing flock on queue-pop is at *queue-pop* layer; PID-file flock is at *drain-instance* layer. Both load-bearing.

**E4. PID-file stale (graceful EXIT vs SIGKILL/OOM)**: graceful drain exit triggers EXIT-trap → PID file removed. SIGKILL/OOM leaves PID file behind. Server-side `perBeastDrainAlive` cmdline-check (Phase 1 baseline per Bertus §1 promotion) detects stale-PID even when PID has been reused — both SIGKILL/OOM stale-PID class AND PID-reuse class are closed by the same check.

**E5. Server runs concurrent with stale-PID Beast drain**: brief race window where drain writes PID, server reads PID after drain process exists but before drain has actually polled queue. Acceptable — at worst, server skips one cycle. Next cycle catches it. No message loss.

**E6. Trust-boundary-shift — N+1 wake-time-execute processes per Beast (Bertus v2 §A)**: post-Phase-4 migration, every Beast has TWO long-running wake-started processes (Discord poller + notify-drain). Each is a wake-time-execute attack surface (CVE-2025-59536 hook-injection class). Pattern-amplification: cumulative attack surface scales linearly with wake-time process count. Mitigation: SHA verification (per §Wake-order SHA verification above). Wake-order verifies drain.sh checksum against Blueprint canonical at every wake — tamper-detection at the launch boundary.

## Build phases

- **Phase 1**: Add `scripts/notify-drain.sh` to Beast Blueprint template. Code is unchanged from existing oracle-v2/scripts/notify-drain.sh. Mara folds via Beast Blueprint update PR.
- **Phase 2**: Add wake-order to Beast Blueprint CLAUDE.md.template (sister to Discord-poller pattern). Templated `<beast>` + `<Session>` placeholders.
- **Phase 3**: Server-side `runDrainCycle()` coexistence check (`perBeastDrainAlive`). Karo PR to oracle-v2.
- **Phase 4**: Pack-wide migration with **canary discipline** (Bertus + Gnarl v2 convergent):
  - **4a. Canary cohort**: Karo + Bertus migrate FIRST. Beast Blueprint sync limited to these two brains. Soak 24h or until first wake-cycle confirms drain runs + queue drains + tmux paste lands cleanly + no false-skip on server side. Pack-wide config-distribution risk (typo in `<beast>` substitution, wrong path, broken pgrep, broken SHA-verify, etc.) caught at canary scope before pack-wide propagation. Sister-class to today's *audit-all-worktree-shapes* doctrine + *config-distribution-as-pack-wide-failure-vector* class.
  - 4b. Once canary 24h soak passes: Beast Blueprint sync to remaining 10 Beast brains (script + CLAUDE.md addition + checksum manifest).
  - 4c. Each Beast on next wake starts their drain via wake-order (with SHA-verify gate).
  - 4d. Verify per-Beast PID files appear at `/tmp/den-notify/<beast>.pid`; server-side log confirms `runDrainCycle` skipping migrated Beasts; cmdline-check + flock-lock both observed firing in test cycles.
- **Phase 5** (post-migration verify) — **explicit observation window** (Bertus + Gnarl v2 convergent):
  - **Window 1 (deprecation candidacy)**: ≥7 days post-Phase-4 with `runDrainCycle()` server-log showing **zero fallback-fires across 12/12 Beasts** AND **zero per-Beast drain-down events captured by server fallback**. If both conditions hold, proceed to Window 2.
  - **Window 2 (log-only-warning state)**: ≥7 days additional with `runDrainCycle()` reduced to log-only-warning ("would-fallback for Beast X") without actually draining. If still zero impact, proceed to Window 3.
  - **Window 3 (removal)**: remove `runDrainCycle()` server-side entirely. Server retains coordination role (writes via notify.sh + auth) but no drain responsibility.
  - Closes the implicit-signal-detection deferral pattern (Spec #52 v4 sister-class) — explicit observation-window over implicit drift.

## Test cases (Pip QA scope)

### T1-T10 happy-path coverage (named-instance positive cases)

- T1: Per-Beast drain starts cleanly on wake when not running, PID file appears
- T2: Per-Beast drain skip-restart when already running (pgrep check)
- T3: Server `runDrainCycle` SKIPS queues with active per-Beast drain pid (cmdline-verified)
- T4: Server `runDrainCycle` DRAINS queues when per-Beast pid file missing or process dead (fallback)
- T5: Drain tmux send-keys lands message in correct Beast session
- T6: Drain T#713 sleep 0.2 race-fix preserved across pid-coexistence change
- T7: Sed-i temp-file write within drain.sh queue-pop is flock-mutex-protected (per Pip v2 §2 — flock-resistance is the actual mechanism, not no-temp-file as v1 spec asserted)
- T8: Stale PID file handling (process gone, PID file remains) → server fallback resumes
- T9: Server crash with per-Beast drain running → notifications continue (offline-resilience proof)
- T10: All 12 Beasts migrated → server skips all queues, no notifications dropped during transition

### T11-T19 control-negative roster (enumerate-the-class extensions per Pip DEN-S54-c411)

Each test verifies a *bypass-class is closed*, not just *named-instance works*.

- **T11** (canary-cohort soak): Phase 4a uses 2 canary Beasts (Karo + Bertus) for 24h soak BEFORE rolling Phase 4b. Verifies *config-distribution-as-pack-wide-failure-vector* class closed at migration cadence.
- **T12** (drain-startup flock): drain.sh acquires `flock -x -n` on PID file at start; concurrent wake-order fires spawn one drain max. Verifies *check-then-act race at drain-startup* class closed beyond pgrep TOCTOU.
- **T13** (cmdline-check enforcement): server `perBeastDrainAlive()` reads `/proc/<pid>/cmdline` and requires substring `notify-drain.sh`. Stale-PID-reused-as-unrelated-process is detected; server fallback fires correctly. Phase 1 BASELINE per Bertus, NOT deferred to Phase 2.
- **T14** (wrong-Beast queue self-validation): drain.sh fails fast if `$BEAST` arg does NOT match `basename $(dirname $(dirname $0))`. Verifies *misconfig-as-cross-Beast-disclosure* class closed at script-start.
- **T15** (queue + log permissions): `/tmp/den-notify/<beast>.queue` mode 600, `/tmp/notify-drain-<beast>.log` mode 600, `/tmp/den-notify/` dir mode 700, all owned `gorn:users`. Verifies world-readable-/tmp regression closed defense-in-depth.
- **T16** (SIGKILL stale PID): drain killed via `kill -9` (no EXIT-trap fires); PID file persists; T13 cmdline-check on next server cycle detects mismatch (cmdline of reused-PID ≠ notify-drain.sh) → server fallback resumes. Verifies *trap-not-fired-stale-PID* class closed via T13.
- **T17** (tampered-drain checksum): wake-order verifies drain.sh SHA-256 matches Beast Blueprint canonical before starting. Mismatch → wake-order fails-loudly, drain not started, Beast brain compromise contained. Verifies *wake-time-execute attack surface* class closed at the launch boundary.
- **T18** (Phase 5 deprecation observation window): ≥7d post-Phase-4 with zero fallback-fires AND zero per-Beast drain-down events captured by server fallback BEFORE deprecation candidacy advances. Verifies *implicit-signal-detection-drift* class closed at process-decision layer.
- **T19** (cross-zone-blend prevention): test-suite verifies no per-Beast asset crosses zones — drain script lives only in Brain worktree, not /tmp; PID file lives only in /tmp, not Brain worktree; server runtime stays at `~/.oracle/`. Verifies *three-zone-separation* architectural-intent enforced via test rather than convention.

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

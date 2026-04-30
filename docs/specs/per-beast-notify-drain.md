# Spec — Per-Beast notify-drain (Sovereignty + Offline Resilience)

**Author**: Karo
**Status**: Draft → Review
**Version**: v3 (2026-04-30 ~11:15 BKK — Option B producer-side amendment: notify.sh shell-out replaced by direct TypeScript queue-write from server process. Consumer-side drain design unchanged from v2. Direction locked with Gorn 2026-04-30 ~02:00 BKK).
v2 was 2026-04-27 ~13:00 BKK (pen-cluster fold). v1 was 2026-04-27 12:50 BKK initial draft.
**Authored**: 2026-04-27 12:50 BKK
**Origin**: Gorn-direction 2026-04-27 12:41 BKK Discord — *"I think we should add the notify drain in beast's blueprint and let it sits in beast's brain"* + *"Then in CLAUDE.md tell beasts to start their notify-drain.sh as well"*. Architecturally aligned with: Den-Architecture lean toward Beast-sovereignty, Decree #66 Req 6 incident-response continuity, Beast Blueprint propagation pattern.

---

## Problem

Current notify-drain implementation lives **inside the oracle-v2 server process** as `runDrainCycle()` in `src/server.ts`. Single point of failure:

- **Server crash / restart / OOM kill / deploy** → ALL Beast notifications stop until server recovery. Queue files at `/tmp/den-notify/<beast>.queue` accumulate but nothing delivers them to tmux.
- **All-or-nothing failure mode** — one drain process serves the whole pack; drain bug or server bug = pack-wide notification outage.
- **Decree #66 Req 6 incident-response continuity gap** — when central server is in trouble (the exact moment fast pack coordination matters most), the comms primitive is also dead.

The standalone `oracle-v2/scripts/notify-drain.sh` script exists on disk but is **superseded** (per 2026-03-30 handoff: *"notify-drain.sh script is now superseded — could be removed later"*). No per-Beast drain processes currently running anywhere on this machine (verified via `pgrep -af drain` returning empty).

**Producer-side problem (v3 addition)**: notification writes currently shell-out from the server process to `scripts/notify.sh` via `child_process.exec()`. This adds per-notification process-spawn overhead, shell-injection surface area, and a shell-script dependency in the critical notification path. Direct TypeScript queue-write eliminates all three.

## Goal

**Two-axis migration:**

1. **Consumer (drain)**: Move drain from server-process into **per-Beast brain worktree** as a Beast-managed background process. Each Beast owns and runs their own drain, scoped to their own queue + tmux session. Failure isolation = per-Beast, not pack-wide. (Unchanged from v2.)

2. **Producer (queue-write)** *(v3 addition)*: Replace `notify.sh` shell-out with direct TypeScript queue-write from within the server process. Server writes base64-encoded notification body directly to `/tmp/den-notify/<beast>.queue` via `fs.appendFileSync()`. No child process, no shell, no script.

Combined with the Decree #59 boundary + bearer-derive auth (Spec #51, Spec #52), this completes the Beast-sovereignty pattern at the notification layer.

## Design

### Producer: Direct TypeScript queue-write (v3 — Option B)

**Replaces**: `scripts/notify.sh` shell-out via `child_process.exec()`.

**New implementation** in server-side TypeScript (e.g. `src/notify.ts`):

```ts
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const QUEUE_DIR = '/tmp/den-notify';

export function queueNotification(beast: string, message: string): void {
  // Validate beast name — alphanumeric only, no path traversal
  if (!/^[a-z]+$/.test(beast)) {
    throw new Error(`Invalid beast name: ${beast}`);
  }

  if (!existsSync(QUEUE_DIR)) {
    mkdirSync(QUEUE_DIR, { mode: 0o700, recursive: true });
  }

  const queueFile = join(QUEUE_DIR, `${beast}.queue`);
  const encoded = Buffer.from(message).toString('base64');
  appendFileSync(queueFile, encoded + '\n', { mode: 0o600 });
}
```

**Call-sites migrated**: all existing `notify.sh` call-sites (DM handler, forum mentions, scheduler fires, TG polling, Sable Prowl, security alerts) switch from `exec('scripts/notify.sh ...')` to `queueNotification(beast, message)`.

**Benefits over notify.sh shell-out**:
- No child_process spawn per notification (performance: ~0.1ms vs ~50ms)
- No shell-injection surface (beast name validated via regex, message is base64-encoded)
- No external script dependency in critical path
- Atomic append via `appendFileSync` (same as notify.sh's `echo >>`)
- `/tmp` permissions discipline (mode 0o700 dir, mode 0o600 files) enforced at creation

**notify.sh disposition**: deprecated after all call-sites migrated. Removed in Phase 5 cleanup alongside `runDrainCycle()` removal. `notify-drain.sh` (consumer) is a DIFFERENT script — it moves to Blueprint per Phase 1, unchanged.

### Consumer: Drain location (unchanged from v2)

**Per-Beast brain**: `/home/gorn/workspace/<beast>/scripts/notify-drain.sh` (e.g. `/home/gorn/workspace/karo/scripts/notify-drain.sh`).

Same script content as the existing `denbook/scripts/notify-drain.sh` — flock-locked head/sed pop from queue, base64 decode, tmux send-keys -l, T#713 race-fix sleep 0.2, send Enter. Code unchanged, location moved.

### Queue location

**Unchanged**: `/tmp/den-notify/<beast>.queue` (shared filesystem). Server-side `queueNotification()` (v3) writes to the same path. Per-Beast drain reads from the same path. Single canonical queue location preserves compatibility.

### Process lifecycle (unchanged from v2)

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

### Server-side coexistence (cutover safety — unchanged from v2)

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
    try { process.kill(pid, 0); }
    catch { return false; }
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes('notify-drain.sh');
    } catch { return false; }
  } catch { return false; }
}
```

### Tmux-session canonical mapping (unchanged from v2)

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

### Three-zone per-Beast asset separation (unchanged from v2)

| Zone | Path pattern | Asset class | Blast radius |
|------|-------------|-------------|--------------|
| **Brain worktree** | `/home/gorn/workspace/<beast>/` | Persistent Beast-owned: `.env BEAST_TOKEN`, `scripts/notify-drain.sh`, CLAUDE.md, brain content | Per-Beast |
| **`/tmp` shared** | `/tmp/den-notify/<beast>.{queue,pid,lock}` + `/tmp/notify-drain-<beast>.log` | Transient process state: queue, PID file, drain log | Per-Beast (file-name-scoped) |
| **Server runtime** | `~/.oracle/` | Server-side state: server `.env`, `oracle.db*`, `lancedb/`, `uploads/`, `meili/` | Pack-wide (server-process scoped) |

### /tmp permissions discipline (unchanged from v2)

- `/tmp/den-notify/` directory: mode **0700**, owned `gorn:users`
- `<beast>.queue` + `<beast>.pid` + `<beast>.lock`: mode **0600**
- `/tmp/notify-drain-<beast>.log`: mode **0600**

### Wake-order SHA verification (unchanged from v2)

Wake-order check verifies `scripts/notify-drain.sh` SHA-256 matches Beast Blueprint canonical BEFORE starting drain.

### Edge cases (unchanged from v2, plus E7)

**E1-E6**: unchanged from v2.

**E7. notify.sh → queueNotification migration race** *(v3 addition)*: during call-site migration, some call-sites use notify.sh and others use queueNotification(). Both write to the same queue format (base64-encoded line). No race — `appendFileSync` and `echo >>` are both atomic for lines under PIPE_BUF (4096 bytes on Linux). Queue consumer (drain.sh) is format-agnostic.

## Build phases (amended v3)

- **Phase 1**: Add `scripts/notify-drain.sh` to Beast Blueprint template. Code unchanged from existing. Mara folds via Beast Blueprint update PR.
- **Phase 2**: Add wake-order to Beast Blueprint CLAUDE.md.template.
- **Phase 2b** *(v3 addition)*: **Producer migration** — implement `src/notify.ts` with `queueNotification()`. Migrate all `notify.sh` call-sites to direct TypeScript queue-write. PR to denbook, @bertus + @gnarl review.
- **Phase 3**: Server-side `runDrainCycle()` coexistence check (`perBeastDrainAlive`). Karo PR to denbook.
- **Phase 4**: Pack-wide drain migration with canary discipline (Karo + Bertus first, 24h soak, then remaining 11).
- **Phase 4b** *(v3 addition)*: Remove `scripts/notify.sh` from server repo. All call-sites already migrated in Phase 2b. Clean deletion.
- **Phase 5** (post-migration verify):
  - Window 1 (≥7 days): zero server-side fallback-fires across 12/12 Beasts
  - Window 2 (≥7 days): `runDrainCycle()` reduced to log-only-warning
  - Window 3: remove `runDrainCycle()` server-side entirely

## Test cases (amended v3)

### T1-T19 (unchanged from v2)

### T20-T22 (v3 additions — producer-side)

- **T20** (queueNotification basic write): `queueNotification('karo', 'test message')` writes base64-encoded line to `/tmp/den-notify/karo.queue`. Drain reads and delivers correctly.
- **T21** (beast name validation): `queueNotification('../etc', 'payload')` throws error. Path traversal blocked by `/^[a-z]+$/` regex.
- **T22** (concurrent append safety): two simultaneous `queueNotification()` calls for same beast produce two separate lines, neither corrupted. Verified under `appendFileSync` atomic-append guarantee for lines < PIPE_BUF.

## Threat model (amended v3)

1-5: unchanged from v2.

6. **Shell-injection via notify.sh eliminated** *(v3 addition)*: `notify.sh` accepted beast name and message body as shell arguments. Direct TypeScript queue-write uses `fs.appendFileSync` with validated beast name (regex) and base64-encoded body. No shell interpretation at any point in the write path.

## Architect frame (amended v3)

State machine for drain process per Beast: unchanged from v2.

### Sovereignty pattern alignment (amended v3)

Spec #54 v3 completes the Beast-sovereignty triad AND closes the producer-consumer symmetry:
- **Spec #51** — Beast owns its own token-refresh lifecycle
- **Spec #52** — Beast owns its own token-rotation primitive
- **Spec #54 consumer** — Beast owns its own notification-drain process
- **Spec #54 producer** *(v3)* — Server writes notifications directly without shell-out overhead

Server becomes pure coordinator: validates auth, writes to queue (direct TypeScript), serves API. No shell-outs in the notification critical path. No drain responsibilities.

## Out of scope

- Queue location migration to per-Beast brain (separate spec if needed)
- Cross-machine drain
- Drain rate-limiting / DRAIN_SPACING per-Beast
- ~~notify.sh sender migration~~ *(moved IN-scope in v3)*

## Dependencies

- `denbook/scripts/notify-drain.sh` (existing, will be ported as-is to Beast Blueprint)
- Beast Blueprint repo (Mara fold-doc lane)
- Pack-wide CLAUDE.md.template propagation
- T#713 race-fix preserved

## Implementation roster

1. **This spec**: Sable Tier-3 routing → @gorn stamp
2. **Phase 1 + 2 PR** (Beast Blueprint): @mara owns the Blueprint update, @karo reviewer
3. **Phase 2b PR** (producer migration): @karo writes `src/notify.ts` + call-site migration, @bertus + @gnarl review per Decree #71 v3
4. **Phase 3 PR** (server coexistence): @karo writes, @bertus + @gnarl review
5. **Phase 4 migration**: pack-wide rollout, Beast self-test on next wake
6. **Phase 4b PR** (notify.sh removal): @karo writes, @pip review
7. **Phase 5 cleanup**: deprecate + remove `runDrainCycle`, separate small PR

## Reviewers

- @bertus — security threat model (stale-PID class + tampered-drain class + shell-injection elimination)
- @gnarl — architect frame (state machine + sovereignty pattern + producer-consumer symmetry)
- @pip — QA scope (T1-T22 test plan)
- @mara — Beast Blueprint fold-doc lane (Phase 1 + 2 owner)
- @sable — Tier-3 routing → Gorn stamp

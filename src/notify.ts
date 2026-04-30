/**
 * Centralized tmux notification adaptor (Spec #54 v4 — was Spec #29).
 *
 * Server-side thin adaptor: invokes the TARGET Beast's own notify.sh
 * (`/home/gorn/workspace/<beast>/scripts/notify.sh`) instead of a
 * server-owned shell script. Per Spec #54 v4 sovereignty pattern,
 * notify.sh is Beast-owned (lives in Beast brain worktree, ported via
 * Beast Blueprint v0.6.3). Both ends of the notification stack now
 * Beast-sovereign — server is coordinator, not bottleneck.
 *
 * Timestamp stamping moved INTO notify.sh (per spec) — all callers get
 * consistent `[YYYY-MM-DD HH:MM:SS UTC+7] [from <sender>] <message>`
 * format regardless of entry point.
 *
 * Sender attribution via `opts.from` (default 'server'). Honor-system
 * v4 — cryptographic auth is sister-spec follow-up.
 *
 * Drain side: per-Beast `notify-drain.sh` reads `/tmp/den-notify/<beast>.queue`
 * and pastes to tmux session via `tmux send-keys -l` + 200ms race-pause + Enter.
 */

import path from 'path';

const WORKSPACE_ROOT = '/home/gorn/workspace';

/**
 * Legacy server-side notify.sh path (Spec #29 era). Used as the middle
 * fallback during Phase 4 canary migration window — when a Beast hasn't
 * pulled Blueprint v0.6.3 yet, the per-Beast notify.sh doesn't exist.
 * Removed in Spec #54 Phase 4b cleanup once all Beasts migrate.
 */
const LEGACY_NOTIFY_SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'notify.sh');

/**
 * Beast-name validation: alphanumeric lowercase only. Anti-traversal at
 * the adaptor boundary (defense-in-depth — notify.sh also self-validates
 * via `readlink -f $0` derivation, but adaptor validates before path.join).
 */
const BEAST_NAME_RE = /^[a-z]+$/;

export interface EnqueueOpts {
  /** Sender attribution. Defaults to 'server'. Honor-system v4. */
  from?: string;
  /**
   * Event time. Currently unused — timestamp is stamped by notify.sh on
   * enqueue (Spec #54 v4 design). If a caller cares about sent-time vs
   * enqueue-time (e.g., delayed TG polling), they should incorporate the
   * sent-time into the message body itself. Reserved for future.
   */
  sentAt?: Date;
}

/**
 * Format a UTC+7 timestamp for the fallback path. notify.sh handles its
 * own stamping in the happy path; this is only used when we fall back to
 * direct tmux send-keys (e.g., notify.sh fails or beast worktree missing).
 */
function formatUtc7Timestamp(date: Date): string {
  const utc7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const y = utc7.getUTCFullYear();
  const mo = String(utc7.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc7.getUTCDate()).padStart(2, '0');
  const h = String(utc7.getUTCHours()).padStart(2, '0');
  const mi = String(utc7.getUTCMinutes()).padStart(2, '0');
  const s = String(utc7.getUTCSeconds()).padStart(2, '0');
  return `[${y}-${mo}-${d} ${h}:${mi}:${s} UTC+7]`;
}

/**
 * Enqueue a notification for a Beast by invoking the target Beast's own notify.sh.
 *
 * Per Spec #54 v4 (Phase 2d): this is a thin adaptor. Target script content
 * lives in the Beast's brain worktree, not in this repo. Beasts can also call
 * each other's notify.sh directly — this adaptor is just the server-originated
 * path. Server-down does not break beast-to-beast notification.
 *
 * Falls back to direct tmux send-keys if the spawn fails (e.g., beast worktree
 * missing during canary migration).
 */
export function enqueueNotification(beast: string, message: string, opts?: EnqueueOpts): boolean {
  const beastLower = beast.toLowerCase();

  // Anti-traversal at adaptor boundary (Bertus DEN-S54-v4-bertus C-NEW-1 sister)
  if (!BEAST_NAME_RE.test(beastLower)) {
    console.error(`[notify] Invalid beast name: ${beast}`);
    return false;
  }

  const targetScript = path.join(WORKSPACE_ROOT, beastLower, 'scripts', 'notify.sh');
  const sender = opts?.from ?? 'server';

  // Tier 1: per-Beast notify.sh (Spec #54 v4 sovereignty path)
  try {
    const result = Bun.spawnSync(['bash', targetScript, message, '--from', sender]);
    if (result.exitCode === 0) return true;
    // Quiet during migration window — exit 127 (file not found) is expected
    // for un-migrated Beasts. Only log non-127 unexpected failures.
    // TODO(Phase 4b cleanup, Bertus DEN-PR55-bertus C-PR55-1): remove the
    // `if (result.exitCode !== 127)` silence after all Beasts migrate to
    // Blueprint v0.6.3+. Post-migration, exit 127 indicates a real failure
    // (deleted script, broken symlink) and should always log.
    if (result.exitCode !== 127) {
      console.error(`[notify] Per-Beast notify failed for ${beastLower} (exit ${result.exitCode})`);
    }
  } catch (err) {
    console.error(`[notify] Per-Beast notify error for ${beastLower}:`, err);
  }

  // Tier 2: legacy server-side notify.sh (preserves queue+drain pipeline
  // during Phase 4 canary migration window). Removed in Phase 4b cleanup.
  try {
    const stamp = formatUtc7Timestamp(opts?.sentAt ?? new Date());
    const stamped = `${stamp} [from ${sender}] ${message}`;
    const result = Bun.spawnSync(['bash', LEGACY_NOTIFY_SCRIPT, beastLower, stamped]);
    if (result.exitCode === 0) return true;
    console.error(`[notify] Legacy notify failed for ${beastLower} (exit ${result.exitCode})`);
  } catch (err) {
    console.error(`[notify] Legacy notify error for ${beastLower}:`, err);
  }

  // Tier 3: direct tmux send-keys with synthesized stamp. Final fallback.
  try {
    const sessionName = beastLower.charAt(0).toUpperCase() + beastLower.slice(1);
    const stamp = formatUtc7Timestamp(opts?.sentAt ?? new Date());
    const stamped = `${stamp} [from ${sender}] ${message}`;
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', stamped]);
    // T#714 (follow-up to T#713 scope-miss): sleep 200ms between text-paste and
    // Enter to break the Claude Code Ink-TUI race. Same fix as runDrainCycle.
    Bun.sleepSync(200);
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);
    return true;
  } catch {
    return false;
  }
}

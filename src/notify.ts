/**
 * Centralized tmux notification queue (Spec #29).
 * All notification senders use this instead of direct tmux send-keys.
 * Messages are queued to /tmp/den-notify/<beast>.queue and drained
 * by notify-drain.sh with 3s spacing to prevent prompt corruption.
 *
 * Every queued message is prefixed with `[YYYY-MM-DD HH:MM UTC+7]` so
 * Beasts can tell at a glance when a notification was sent, even across
 * rest boundaries. Callers that care about send-time vs. enqueue-time
 * (e.g. Telegram polling, where msg.date is meaningful on bad connectivity)
 * can pass `opts.sentAt` to stamp the source event time.
 */

import path from 'path';

const NOTIFY_SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'notify.sh');

function formatUtc7Timestamp(date: Date): string {
  const utc7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const y = utc7.getUTCFullYear();
  const mo = String(utc7.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc7.getUTCDate()).padStart(2, '0');
  const h = String(utc7.getUTCHours()).padStart(2, '0');
  const mi = String(utc7.getUTCMinutes()).padStart(2, '0');
  return `[${y}-${mo}-${d} ${h}:${mi} UTC+7]`;
}

export interface EnqueueOpts {
  /** Event time to stamp on the notification. Defaults to now. */
  sentAt?: Date;
}

/**
 * Enqueue a notification for a Beast via the file-based queue.
 * Falls back to direct tmux send-keys if the queue script fails.
 */
export function enqueueNotification(beast: string, message: string, opts?: EnqueueOpts): boolean {
  const beastLower = beast.toLowerCase();
  const stamp = formatUtc7Timestamp(opts?.sentAt ?? new Date());
  const stamped = `${stamp} ${message}`;

  try {
    const result = Bun.spawnSync(['bash', NOTIFY_SCRIPT, beastLower, stamped]);
    if (result.exitCode === 0) return true;
    console.error(`[notify] Queue failed for ${beastLower}, falling back to direct send`);
  } catch (err) {
    console.error(`[notify] Queue error for ${beastLower}:`, err);
  }

  // Fallback: direct tmux send-keys (better than dropping the notification)
  try {
    const sessionName = beastLower.charAt(0).toUpperCase() + beastLower.slice(1);
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', stamped]);
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);
    return true;
  } catch {
    return false;
  }
}

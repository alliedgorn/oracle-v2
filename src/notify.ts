/**
 * Centralized tmux notification queue (Spec #29).
 * All notification senders use this instead of direct tmux send-keys.
 * Messages are queued to /tmp/den-notify/<beast>.queue and drained
 * by notify-drain.sh with 3s spacing to prevent prompt corruption.
 */

import path from 'path';

const NOTIFY_SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'notify.sh');

/**
 * Enqueue a notification for a Beast via the file-based queue.
 * Falls back to direct tmux send-keys if the queue script fails.
 */
export function enqueueNotification(beast: string, message: string): boolean {
  const beastLower = beast.toLowerCase();
  try {
    const result = Bun.spawnSync(['bash', NOTIFY_SCRIPT, beastLower, message]);
    if (result.exitCode === 0) return true;
    console.error(`[notify] Queue failed for ${beastLower}, falling back to direct send`);
  } catch (err) {
    console.error(`[notify] Queue error for ${beastLower}:`, err);
  }

  // Fallback: direct tmux send-keys (better than dropping the notification)
  try {
    const sessionName = beastLower.charAt(0).toUpperCase() + beastLower.slice(1);
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', message]);
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);
    return true;
  } catch {
    return false;
  }
}

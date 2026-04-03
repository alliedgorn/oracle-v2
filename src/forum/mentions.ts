/**
 * Oracle Forum @Mention System
 *
 * Parses @mentions in forum messages and notifies Oracles via tmux.
 * - @all → notify every Oracle in the registry
 * - @{name} → notify a specific Oracle (e.g., @karo, @bertus)
 */

import { getSetting, setSetting, sqlite } from '../db/index.ts';
import { enqueueNotification } from '../notify.ts';

// ============================================================================
// Oracle Registry
// ============================================================================

export interface OracleEntry {
  tmux: string;       // tmux session name (capitalized)
  workspace: string;  // workspace path
}

export type OracleRegistry = Record<string, OracleEntry>;

const DEFAULT_REGISTRY: OracleRegistry = {
  zaghnal: { tmux: 'Zaghnal', workspace: '/home/gorn/workspace/gorn-oracle' },
  karo:    { tmux: 'Karo',    workspace: '/home/gorn/workspace/karo' },
  gnarl:   { tmux: 'Gnarl',   workspace: '/home/gorn/workspace/gnarl' },
  bertus:  { tmux: 'Bertus',  workspace: '/home/gorn/workspace/bertus' },
  mara:    { tmux: 'Mara',    workspace: '/home/gorn/workspace/mara' },
  leonard: { tmux: 'Leonard', workspace: '/home/gorn/workspace/leonard' },
  rax:     { tmux: 'Rax',     workspace: '/home/gorn/workspace/rax' },
  pip:     { tmux: 'Pip',     workspace: '/home/gorn/workspace/pip' },
};

let registryCache: OracleRegistry | null = null;
let registryCacheTime = 0;
const CACHE_TTL_MS = 30_000; // Refresh from DB every 30s

/**
 * Get the Oracle registry — dynamically built from beast_profiles table.
 * Falls back to DEFAULT_REGISTRY if beast_profiles is empty.
 * Caches for 30s to avoid hitting DB on every mention parse.
 */
export function getOracleRegistry(): OracleRegistry {
  const now = Date.now();
  if (registryCache && (now - registryCacheTime) < CACHE_TTL_MS) return registryCache;

  // Build from beast_profiles (single source of truth)
  try {
    const beasts = sqlite.prepare('SELECT name, display_name FROM beast_profiles').all() as any[];
    if (beasts.length > 0) {
      const registry: OracleRegistry = {};
      for (const b of beasts) {
        const name = b.name.toLowerCase();
        const displayName = b.display_name || (name.charAt(0).toUpperCase() + name.slice(1));
        // Special case: zaghnal's workspace is gorn-oracle (legacy)
        const workspace = name === 'zaghnal'
          ? '/home/gorn/workspace/gorn-oracle'
          : `/home/gorn/workspace/${name}`;
        registry[name] = { tmux: displayName, workspace };
      }
      registryCache = registry;
      registryCacheTime = now;
      return registry;
    }
  } catch { /* beast_profiles table may not exist yet */ }

  // Fallback to hardcoded defaults
  registryCache = DEFAULT_REGISTRY;
  registryCacheTime = now;
  return registryCache;
}

/**
 * Invalidate the registry cache (call after updating the setting).
 */
export function invalidateRegistryCache(): void {
  registryCache = null;
}

// ============================================================================
// Mention Parsing
// ============================================================================

/**
 * Parse @mentions from message content.
 * Returns deduplicated lowercase Oracle names that exist in the registry.
 * - @all → expands to all registered Oracle names
 * - @here → expands to all thread participants (requires threadId)
 * - @name → specific Oracle
 */
export function parseMentions(content: string, threadId?: number): string[] {
  const registry = getOracleRegistry();
  const matches = content.match(/@([\w-]+)/gi);
  if (!matches) return [];

  const names = new Set<string>();
  let hasAll = false;
  let hasHere = false;

  for (const match of matches) {
    const name = match.slice(1).toLowerCase();
    if (name === 'all') {
      hasAll = true;
    } else if (name === 'here') {
      hasHere = true;
    } else if (name in registry) {
      names.add(name);
    } else {
      // Check if it's a team name (e.g. @real-broker → all team members)
      try {
        const teamName = name.replace(/-/g, ' ');
        const team = sqlite.prepare('SELECT id FROM teams WHERE LOWER(name) = ? OR LOWER(REPLACE(name, \' \', \'-\')) = ?').get(teamName, name) as any;
        if (team) {
          const members = sqlite.prepare('SELECT beast FROM team_members WHERE team_id = ?').all(team.id) as any[];
          for (const m of members) {
            if (m.beast in registry) names.add(m.beast);
          }
        }
      } catch { /* teams table may not exist yet */ }
    }
  }

  if (hasAll) {
    return Object.keys(registry);
  }

  if (hasHere && threadId) {
    // Get all unique authors who participated in this thread
    try {
      const rows = sqlite.prepare(
        'SELECT DISTINCT author FROM forum_messages WHERE thread_id = ? AND author IS NOT NULL'
      ).all(threadId) as any[];
      for (const r of rows) {
        const authorName = r.author?.split('@')[0]?.toLowerCase();
        if (authorName && authorName in registry) {
          names.add(authorName);
        }
      }
    } catch { /* ignore */ }
  }

  return [...names];
}

// ============================================================================
// Subscription Management (T#618)
// ============================================================================

export type SubscriptionLevel = 'full' | 'summary' | 'muted';

/**
 * Get a Beast's subscription level for a thread.
 * Returns 'full' if no preference exists (default behavior preserved).
 */
export function getSubscriptionLevel(beast: string, threadId: number): SubscriptionLevel {
  try {
    const row = sqlite.prepare(
      'SELECT level FROM forum_notification_prefs WHERE beast_name = ? AND thread_id = ?'
    ).get(beast.toLowerCase(), threadId) as { level: string } | undefined;
    if (row && (row.level === 'full' || row.level === 'summary' || row.level === 'muted')) {
      return row.level;
    }
  } catch { /* table may not have level column yet */ }
  return 'full';
}

/**
 * Set a Beast's subscription level for a thread (upsert).
 */
export function setSubscription(beast: string, threadId: number, level: SubscriptionLevel): void {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO forum_notification_prefs (beast_name, thread_id, muted, level, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(beast_name, thread_id) DO UPDATE SET
      level = excluded.level,
      muted = CASE WHEN excluded.level = 'muted' THEN 1 ELSE 0 END,
      updated_at = excluded.updated_at
  `).run(beast.toLowerCase(), threadId, level === 'muted' ? 1 : 0, level, now);
}

/**
 * Auto-subscribe a Beast to a thread — only if no preference exists yet.
 * Does NOT override existing preferences (e.g. won't reset muted to full).
 */
export function autoSubscribe(beast: string, threadId: number): void {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO forum_notification_prefs (beast_name, thread_id, muted, level, updated_at)
    VALUES (?, ?, 0, 'full', ?)
    ON CONFLICT(beast_name, thread_id) DO NOTHING
  `).run(beast.toLowerCase(), threadId, now);
}

/**
 * Get all subscriptions for a Beast.
 */
export function getSubscriptions(beast: string): Array<{ thread_id: number; level: SubscriptionLevel }> {
  try {
    const rows = sqlite.prepare(
      'SELECT thread_id, level FROM forum_notification_prefs WHERE beast_name = ?'
    ).all(beast.toLowerCase()) as any[];
    return rows.map(r => ({
      thread_id: r.thread_id,
      level: (r.level === 'full' || r.level === 'summary' || r.level === 'muted') ? r.level : 'full',
    }));
  } catch { return []; }
}

/**
 * Get all subscribers for a thread (T#621).
 */
export function getThreadSubscribers(threadId: number): Array<{ beast_name: string; level: SubscriptionLevel }> {
  try {
    const rows = sqlite.prepare(
      'SELECT beast_name, level FROM forum_notification_prefs WHERE thread_id = ?'
    ).all(threadId) as any[];
    return rows.map(r => ({
      beast_name: r.beast_name,
      level: (r.level === 'full' || r.level === 'summary' || r.level === 'muted') ? r.level : 'full',
    }));
  } catch { return []; }
}

// ============================================================================
// Notification Dispatch
// ============================================================================

/**
 * Sanitize a string for safe injection into tmux send-keys.
 * Strips newlines, escapes quotes, truncates.
 */
function sanitizeForTmux(text: string, maxLen: number = 200): string {
  return text
    .replace(/\n/g, ' ')
    .replace(/"/g, "'")
    .replace(/\\/g, '\\\\')
    .slice(0, maxLen);
}

/**
 * Notify mentioned Oracles via tmux send-keys.
 * Returns array of Oracle names that were successfully notified.
 *
 * T#618: Subscription-based filtering.
 * - directMentions: Beasts explicitly @mentioned — always deliver full, even if muted
 * - Other mentions (thread participants): respect subscription level
 */
export function notifyMentioned(
  mentions: string[],
  threadId: number,
  threadTitle: string,
  author: string,
  content: string,
  context?: { type: string; label: string; hint: string },
  directMentions?: Set<string>,
): string[] {
  if (mentions.length === 0) return [];

  const registry = getOracleRegistry();
  const notified: string[] = [];
  const preview = sanitizeForTmux(content);
  const summaryPreview = sanitizeForTmux(content, 50);

  // Extract the raw Oracle name from author (strip @project suffix)
  const authorName = author.split('@')[0].toLowerCase();

  for (const name of mentions) {
    // Skip self-notification
    if (name === authorName) continue;

    const entry = registry[name];
    if (!entry) continue;

    // T#618: Check subscription level (direct @mentions always get full delivery)
    const isDirect = directMentions?.has(name) ?? true; // default true for backward compat
    let level: SubscriptionLevel = 'full';
    if (!isDirect && threadId > 0) {
      level = getSubscriptionLevel(name, threadId);
      if (level === 'muted') continue; // Skip muted thread participants entirely
    }

    // UTC+7 timestamp for Beast awareness
    const now = new Date();
    const utc7 = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const timeStr = `${utc7.getUTCHours().toString().padStart(2, '0')}:${utc7.getUTCMinutes().toString().padStart(2, '0')} UTC+7`;

    let message: string;
    if (level === 'summary' && !isDirect) {
      // Summary mode: one-liner with author + thread + truncated content
      message = `[${timeStr}] [Forum summary] ${author} in thread #${threadId} ("${sanitizeForTmux(threadTitle, 50)}"): ${summaryPreview}...`;
    } else if (context) {
      message = `[${timeStr}] [${context.type}] From ${author} in ${context.label} ("${sanitizeForTmux(threadTitle, 50)}"):\\n\\n${preview}\\n\\n${context.hint}`;
    } else {
      message = `[${timeStr}] [Forum message] From ${author} in thread #${threadId} ("${sanitizeForTmux(threadTitle, 50)}"):\\n\\n${preview}\\n\\nUse /forum thread ${threadId} to read and /forum post <message> (with thread_id ${threadId}) to reply.`;
    }

    try {
      enqueueNotification(name, message);
      notified.push(name);
    } catch {
      // queue not available — continue silently
    }
  }

  return notified;
}

/**
 * Guest Safety — Prompt Injection Hardening
 *
 * Content filtering, rate limiting, and safety checks for guest-authored content.
 * Spec #32, T#557, Decree #53.
 */

import type { Database } from 'bun:sqlite';

// ============================================================================
// Injection Pattern Detection
// ============================================================================

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now/i,
  /system\s*prompt/i,
  /act\s+as\s+(a|an|if)/i,
  /reveal\s+your\s+(instructions|prompt|system)/i,
  /override\s+(all|your|the)/i,
  /forget\s+(all|your|previous)/i,
  /disregard\s+(all|your|previous)/i,
  /new\s+instructions?\s*:/i,
  /\[system\]/i,
  /\[assistant\]/i,
  /<system>/i,
  /CLAUDE\.md/i,
  /\.claude\//i,
];

export interface InjectionScanResult {
  flagged: boolean;
  patterns: string[];
}

/**
 * Scan content for known prompt injection patterns.
 * Returns matched patterns but does NOT block — flagged for review.
 */
export function scanForInjection(content: string): InjectionScanResult {
  const matched: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      matched.push(pattern.source);
    }
  }
  return { flagged: matched.length > 0, patterns: matched };
}

// ============================================================================
// Rate Limiting for Guests
// ============================================================================

interface RateWindow {
  count: number;
  windowStart: number;
}

// In-memory rate limiters (reset on server restart — acceptable for MVP)
const guestPostRates = new Map<string, RateWindow>();   // per guest username
const guestDailyRates = new Map<string, RateWindow>();  // per guest username
const guestDmRates = new Map<string, RateWindow>();     // per guest username

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const LIMITS = {
  postsPerHour: 10,
  postsPerDay: 50,
  dmsPerHour: 100,
};

function checkRate(map: Map<string, RateWindow>, key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterMs?: number } {
  const now = Date.now();
  const entry = map.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1 };
  }

  if (entry.count >= limit) {
    const retryAfterMs = entry.windowStart + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count };
}

/**
 * Check if a guest can post a forum message.
 */
export function checkGuestPostRate(username: string): { allowed: boolean; error?: string } {
  const hourly = checkRate(guestPostRates, username, LIMITS.postsPerHour, HOUR_MS);
  if (!hourly.allowed) {
    return { allowed: false, error: `Post rate limit exceeded (${LIMITS.postsPerHour}/hour). Try again in ${Math.ceil((hourly.retryAfterMs || 0) / 60000)} minutes.` };
  }

  const daily = checkRate(guestDailyRates, username, LIMITS.postsPerDay, DAY_MS);
  if (!daily.allowed) {
    return { allowed: false, error: `Daily post limit exceeded (${LIMITS.postsPerDay}/day).` };
  }

  return { allowed: true };
}

/**
 * Check if a guest can send a DM.
 */
export function checkGuestDmRate(username: string): { allowed: boolean; error?: string } {
  const hourly = checkRate(guestDmRates, username, LIMITS.dmsPerHour, HOUR_MS);
  if (!hourly.allowed) {
    return { allowed: false, error: `You're sending messages a bit fast! Take a breather and try again shortly.` };
  }
  return { allowed: true };
}

// ============================================================================
// Content Length Limits
// ============================================================================

const GUEST_MAX_POST_LENGTH = 4000; // characters
const GUEST_MAX_DM_LENGTH = 2000;   // characters

/**
 * Check content length for guest posts.
 */
export function checkGuestContentLength(content: string, type: 'post' | 'dm'): { allowed: boolean; error?: string } {
  const limit = type === 'post' ? GUEST_MAX_POST_LENGTH : GUEST_MAX_DM_LENGTH;
  if (content.length > limit) {
    return { allowed: false, error: `Message too long (${content.length}/${limit} characters)` };
  }
  return { allowed: true };
}

// ============================================================================
// Migration: author_role field
// ============================================================================

/**
 * Add author_role column to forum_messages if not present.
 */
export function initGuestSafetyMigrations(sqlite: Database): void {
  try {
    sqlite.exec("ALTER TABLE forum_messages ADD COLUMN author_role TEXT DEFAULT 'beast'");
  } catch {
    // Column already exists
  }

  // Add author_role to dm_messages too
  try {
    sqlite.exec("ALTER TABLE dm_messages ADD COLUMN author_role TEXT DEFAULT 'beast'");
  } catch {
    // Column already exists
  }
}

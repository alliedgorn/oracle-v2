/**
 * Security Event Logger (T#545)
 *
 * Standalone service for logging security-specific events.
 * Separate from the general audit log — different retention (90d),
 * security-specific event types, severity classification, and alerting.
 *
 * Architecture reviewed by Gnarl. Thread #405.
 */

import { sqlite } from '../db/index.ts';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export type SecurityEventType =
  | 'auth_failure'           // Failed login attempt
  | 'auth_success'           // Successful login (info-level, for correlation)
  | 'permission_denied'      // 403 response
  | 'rate_limited'           // Rate limit triggered (429)
  | 'token_created'          // OAuth token stored
  | 'token_refreshed'        // OAuth token refreshed
  | 'token_revoked'          // OAuth token revoked/disconnected
  | 'settings_changed'       // Auth/security settings modified
  | 'impersonation_blocked'  // ?as= spoofing blocked on protected endpoint
  | 'session_destroyed'      // Session logout
  | 'alert_triggered'        // Threshold alert fired by checkAlertThresholds
  | 'token_validated';       // Beast token validated (sampled, T#546)

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export interface SecurityEvent {
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  actor?: string;
  actorType?: 'human' | 'beast' | 'system' | 'unknown';
  target?: string;
  details?: Record<string, unknown>;
  ipSource?: string;
  requestId?: string;
}

// ============================================================================
// Table initialization (idempotent — migration also creates this)
// ============================================================================

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    actor TEXT,
    actor_type TEXT,
    target TEXT,
    details TEXT,
    ip_source TEXT,
    request_id TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_security_events_request_id ON security_events(request_id)`);
} catch { /* table exists */ }

// ============================================================================
// Prepared statements (reused for performance)
// ============================================================================

const insertStmt = sqlite.prepare(
  `INSERT INTO security_events (timestamp, event_type, severity, actor, actor_type, target, details, ip_source, request_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const countRecentByTypeStmt = sqlite.prepare(
  `SELECT COUNT(*) as count FROM security_events
   WHERE event_type = ? AND ip_source = ? AND timestamp > ?`
);

// ============================================================================
// Core logging function
// ============================================================================

/**
 * Log a security event. Non-blocking — never throws.
 */
export function logSecurityEvent(event: SecurityEvent): void {
  try {
    const now = Math.floor(Date.now() / 1000); // Unix epoch seconds
    insertStmt.run(
      now,
      event.eventType,
      event.severity,
      event.actor || null,
      event.actorType || null,
      event.target || null,
      event.details ? JSON.stringify(event.details) : null,
      event.ipSource || null,
      event.requestId || null,
    );

    // Check alert thresholds for critical patterns
    checkAlertThresholds(event, now);
  } catch (err) {
    // Never block request handling for logging failures
    console.error(`[SecurityLogger] Failed to log event: ${err}`);
  }
}

// ============================================================================
// Alert thresholds (Gnarl: simple checks in logger, no pub/sub)
// ============================================================================

const ALERT_THRESHOLDS = {
  auth_failure: { count: 5, windowSeconds: 300 },      // 5 failures in 5 min
  rate_limited: { count: 3, windowSeconds: 300 },       // 3 rate limits in 5 min
  permission_denied: { count: 10, windowSeconds: 300 }, // 10 denials in 5 min
} as const;

function checkAlertThresholds(event: SecurityEvent, now: number): void {
  const threshold = ALERT_THRESHOLDS[event.eventType as keyof typeof ALERT_THRESHOLDS];
  if (!threshold || !event.ipSource) return;

  try {
    const cutoff = now - threshold.windowSeconds;
    const result = countRecentByTypeStmt.get(
      event.eventType,
      event.ipSource,
      cutoff
    ) as { count: number } | undefined;

    if (result && result.count >= threshold.count) {
      const msg = `[SecurityAlert] ${event.eventType} threshold exceeded: ${result.count} events from ${event.ipSource} in ${threshold.windowSeconds}s (actor: ${event.actor || 'unknown'})`;
      console.warn(msg);

      // Log the alert itself as a critical security event
      try {
        insertStmt.run(
          now,
          'alert_triggered',
          'critical',
          'system',
          'system',
          event.ipSource,
          JSON.stringify({
            trigger_event: event.eventType,
            count: result.count,
            window_seconds: threshold.windowSeconds,
            source_actor: event.actor,
          }),
          event.ipSource,
          event.requestId || null,
        );
      } catch { /* don't recurse on failure */ }
    }
  } catch {
    // Alert check is best-effort
  }
}

// ============================================================================
// Request ID generator (for audit_log correlation)
// ============================================================================

/**
 * Generate a short request ID for correlating security events with audit log entries.
 */
export function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}

// ============================================================================
// Retention (called from server.ts maintenance cycle)
// ============================================================================

export const SECURITY_RETENTION_DAYS = 90;

/**
 * Prune security events older than retention period.
 * Returns number of rows deleted.
 */
export function pruneSecurityEvents(): number {
  try {
    const cutoffSeconds = Math.floor(Date.now() / 1000) - (SECURITY_RETENTION_DAYS * 24 * 60 * 60);
    const result = sqlite.prepare(
      `DELETE FROM security_events WHERE timestamp < ?`
    ).run(cutoffSeconds);
    return result.changes || 0;
  } catch (err) {
    console.error(`[SecurityLogger] Prune failed: ${err}`);
    return 0;
  }
}

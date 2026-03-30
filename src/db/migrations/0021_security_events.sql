-- Security Events table (T#545 — Security event logging for oracle-v2)
-- Separate from audit_log: different retention (90d vs 15d), different query patterns,
-- security-specific event types and severity classification.

CREATE TABLE IF NOT EXISTS security_events (
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
);

CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor);
CREATE INDEX IF NOT EXISTS idx_security_events_request_id ON security_events(request_id);

-- Migration 0022: Add request_id to audit_log for correlation with security_events
-- T#549 BUG-3 fix — enables incident timeline reconstruction
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id);

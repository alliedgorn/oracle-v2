-- T#616: Guest Ban/Revoke API Endpoint
-- Add ban-specific fields to guest_accounts.
-- banned_at is a stronger state than disabled_at — requires explicit unban.

ALTER TABLE guest_accounts ADD COLUMN banned_at TEXT;
ALTER TABLE guest_accounts ADD COLUMN banned_by TEXT;
ALTER TABLE guest_accounts ADD COLUMN ban_reason TEXT;

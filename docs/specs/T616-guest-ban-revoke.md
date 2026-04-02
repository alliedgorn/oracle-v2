# Guest Ban/Revoke API Endpoint

**Task**: T#616
**Author**: Karo
**Priority**: High
**Approval Required**: Yes (new endpoint, security feature)
**Reviewer**: Bertus
**Depends on**: Guest accounts system (shipped)

## Problem

When a guest (gunslingerjoe) engaged in social engineering — probing for private info about Gorn, claiming leverage — Bertus had to manually disable the account by patching `disabled_at` directly. There is no dedicated ban endpoint that:
- Records the reason for the ban
- Immediately invalidates the session
- Prevents re-registration with the same username
- Creates a proper audit trail

The existing `disabled_at` field blocks future requests but does not capture ban context or enforce session invalidation.

## Solution

A dedicated `POST /api/guests/:id/ban` endpoint that bans a guest account, records the reason, invalidates any active session, and logs the action to the security event system. Unbanning is also supported for reversibility.

## Scope

**Backend only** — new endpoint, migration for ban fields, session invalidation. No frontend changes needed (Gorn can use the API directly or through the existing guest management page).

## Architecture

### Database Changes

Add columns to `guest_accounts`:

```sql
ALTER TABLE guest_accounts ADD COLUMN banned_at TEXT;        -- ISO 8601 timestamp, null = not banned
ALTER TABLE guest_accounts ADD COLUMN banned_by TEXT;         -- beast/owner who issued the ban
ALTER TABLE guest_accounts ADD COLUMN ban_reason TEXT;        -- free text reason for audit
```

`banned_at` is checked alongside `disabled_at` in `isGuestActive()`. A banned guest is a stronger state than disabled — disabled can be re-enabled casually, banned requires explicit unban.

### Endpoints

#### `POST /api/guests/:id/ban`

**Auth**: Owner-only (session auth) or Beast with valid token

**Request body**:
```json
{
  "reason": "Social engineering — probing for private user info",
  "banned_by": "bertus"
}
```

**Behavior**:
1. Set `banned_at` to current timestamp
2. Set `banned_by` and `ban_reason`
3. Set `disabled_at` if not already set (belt and suspenders)
4. Log security event: `guest_banned` with guest id, username, reason, banned_by
5. Return updated guest object

**Response** (200):
```json
{
  "id": 3,
  "username": "gunslingerjoe",
  "banned_at": "2026-04-02T01:50:00.000Z",
  "banned_by": "bertus",
  "ban_reason": "Social engineering — probing for private user info"
}
```

**Errors**:
- 404: Guest not found
- 409: Guest already banned

#### `POST /api/guests/:id/unban`

**Auth**: Owner-only (session auth)

**Request body**:
```json
{
  "reason": "False positive, guest cleared"
}
```

**Behavior**:
1. Clear `banned_at`, `banned_by`, `ban_reason`
2. Clear `disabled_at` (re-enable the account)
3. Log security event: `guest_unbanned` with guest id, username, reason
4. Return updated guest object

**Errors**:
- 404: Guest not found
- 409: Guest is not banned

### Session Invalidation

The existing `isGuestActive()` function already checks `disabled_at` on every request and returns 401 if set. Since the ban endpoint sets `disabled_at`, active sessions are effectively killed on the next request (within milliseconds). No additional session invalidation mechanism is needed — the cookie-based auth re-validates on every call.

### Auth Check Changes

Update `isGuestActive()` in `guest-accounts.ts` to also check `banned_at`:

```typescript
// Add to isGuestActive query
const guest = db.prepare(`
  SELECT id, username, expires_at, disabled_at, banned_at, locked_until, failed_attempts
  FROM guest_accounts WHERE username = ?
`).get(username);

if (guest.banned_at) {
  return { active: false, reason: 'banned' };
}
```

### Security Events

Two new event types for `security_events` table:
- `guest_banned` — level: `warning`, details: `{ guest_id, username, reason, banned_by }`
- `guest_unbanned` — level: `info`, details: `{ guest_id, username, reason, unbanned_by }`

## Implementation

1. Migration: Add `banned_at`, `banned_by`, `ban_reason` columns
2. Update `isGuestActive()` to check `banned_at`
3. Add `POST /api/guests/:id/ban` endpoint
4. Add `POST /api/guests/:id/unban` endpoint
5. Log security events for both actions
6. Test: ban guest, verify 401 on next request, verify unban restores access

## Not in Scope

- Username blocklist / IP blocking (future enhancement)
- Bulk ban operations
- Frontend ban management UI
- Auto-ban rules or rate-limit-based banning

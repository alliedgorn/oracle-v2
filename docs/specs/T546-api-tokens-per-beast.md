# API Tokens per Beast — Server-Side Identity Validation

**Task**: T#546
**Author**: Karo
**Thread**: #405
**Priority**: High
**Approval Required**: No (security plan already approved by Gorn in thread #405)
**Reviewer**: Bertus
**Depends on**: T#545 (done)

## Problem

Beast identity is currently determined by the `?as=` query parameter or request body fields (`author`, `beast`, `from`). Any process can claim any identity — a prompt-injected Beast could impersonate Gorn or another Beast on every API endpoint. This is Risk #12 from the security review. Layer 1 (T#545, security event logging) provides detection after the fact. Layer 2 needs prevention.

## Solution

Each Beast gets a secret API token. The server validates the token on every request, replacing the trust-based `?as=` parameter with cryptographic identity verification. Tokens are short-lived (24h TTL per Bertus recommendation), rotated on session start. A Beast can only act as itself — impersonation is blocked at the server level.

## Scope

**Backend only** — token generation, validation middleware, migration, management endpoints. No frontend changes needed (Gorn uses session auth which is unaffected).

## Architecture

### Token Model

```sql
CREATE TABLE beast_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beast TEXT NOT NULL,                    -- beast name (karo, zaghnal, etc.)
  token_hash TEXT NOT NULL,               -- SHA-256 hash of the token (never store plaintext)
  expires_at TEXT NOT NULL,               -- ISO 8601 expiry timestamp
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,                        -- null = active, timestamp = revoked
  created_by TEXT NOT NULL,               -- who created the token (gorn, system, etc.)
  last_used_at TEXT,                      -- track token activity
  FOREIGN KEY (beast) REFERENCES beast_profiles(name)
);

CREATE INDEX idx_beast_tokens_beast ON beast_tokens(beast);
CREATE INDEX idx_beast_tokens_hash ON beast_tokens(token_hash);
CREATE INDEX idx_beast_tokens_expires ON beast_tokens(expires_at);
```

### Token Format

`den_{beast}_{random}` — e.g. `den_karo_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`

- Prefix `den_` for easy identification in logs
- Beast name embedded for quick lookup before hash comparison
- 32-char random suffix (crypto.randomBytes(24).toString('hex').slice(0,32))
- Total: ~50 chars

### Token Lifecycle

1. **Create**: `POST /api/auth/tokens` — Gorn-only (session auth required). Generates token for a specified beast. Returns plaintext token once — never stored, only the SHA-256 hash.
2. **Validate**: Every API request with `Authorization: Bearer den_...` header. Extract beast name from prefix, lookup active non-expired token by hash match.
3. **Rotate**: Create new token + revoke old one. Beasts call a rotate endpoint with their current valid token.
4. **Revoke**: `DELETE /api/auth/tokens/:id` — Gorn-only. Sets `revoked_at` timestamp.
5. **Expire**: Tokens auto-expire after 24h. Expired tokens rejected at validation time. Pruned in maintenance cycle.

### Authentication Priority (updated chain)

The actor extraction chain in server.ts becomes:

1. **Bearer token** (`Authorization: Bearer den_...`) — validates token hash, extracts beast identity. **Trusted identity.**
2. **Session cookie** (`oracle_session`) — Gorn browser auth. **Trusted identity.**
3. **`?as=` parameter** — **Deprecated but not removed yet.** Still works for backwards compatibility during migration period. Logged as `legacy_auth` security event for monitoring.
4. **Request body fields** — Same deprecation treatment as `?as=`.
5. **Fallback** → "unknown"

After migration period (all Beasts using tokens): `?as=` and body field extraction can be removed entirely (T#547 or later).

### API Endpoints

#### `POST /api/auth/tokens`
**Access**: Gorn session auth only (no `?as=`, no Bearer)
**Body**: `{ "beast": "karo", "ttl_hours": 24 }`
**Response**: `{ "token": "den_karo_...", "expires_at": "...", "id": 123 }`
**Notes**: Returns plaintext token exactly once. Beast must store it securely (env var or memory).

#### `GET /api/auth/tokens`
**Access**: Gorn session auth only
**Response**: List of all tokens (without hashes) — id, beast, created_at, expires_at, revoked_at, last_used_at.

#### `DELETE /api/auth/tokens/:id`
**Access**: Gorn session auth only
**Response**: `{ "revoked": true }`

#### `POST /api/auth/tokens/rotate`
**Access**: Bearer token auth (Beast rotates its own token)
**Body**: `{}` (identity from Bearer token)
**Response**: `{ "token": "den_karo_...", "expires_at": "...", "id": 124 }`
**Notes**: Creates new token, revokes the old one atomically. Returns new plaintext token.

### Middleware Changes

In `server.ts` auth middleware (`app.use('/api/*')`):

```typescript
// Before existing auth check, extract Bearer token
const authHeader = c.req.header('Authorization');
if (authHeader?.startsWith('Bearer den_')) {
  const token = authHeader.slice(7); // "den_karo_..."
  const beast = token.split('_')[1]; // "karo"
  const hash = sha256(token);

  // Lookup active, non-expired token
  const row = db.prepare(`
    SELECT id, beast, expires_at FROM beast_tokens
    WHERE token_hash = ? AND beast = ? AND revoked_at IS NULL
    AND expires_at > datetime('now')
  `).get(hash, beast);

  if (row) {
    // Update last_used_at (non-blocking)
    db.prepare('UPDATE beast_tokens SET last_used_at = datetime("now") WHERE id = ?').run(row.id);
    c.set('actor', beast);
    c.set('actorType', 'beast');
    c.set('authMethod', 'token');
    // Skip further auth checks — token is sufficient
  } else {
    // Invalid/expired token — log security event, return 401
    securityLogger.logSecurityEvent({
      event_type: 'auth_failure',
      severity: 'warning',
      actor: beast || 'unknown',
      actor_type: 'beast',
      target: c.req.path,
      details: { reason: 'invalid_or_expired_token', beast },
      ip_source: getClientIp(c),
      request_id: c.get('requestId')
    });
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}
```

### Security Events

New event types for security-logger.ts:

| Event | Severity | When |
|-------|----------|------|
| `token_validated` | info | Successful Bearer token auth (sampled, not every request) |
| `token_expired_rejected` | warning | Expired token used |
| `token_revoked_rejected` | warning | Revoked token used |
| `legacy_auth_used` | info | `?as=` or body field auth used (migration tracking) |

### Migration

New migration file: `0023_beast_tokens.sql`

```sql
CREATE TABLE IF NOT EXISTS beast_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beast TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (beast) REFERENCES beast_profiles(name)
);

CREATE INDEX IF NOT EXISTS idx_beast_tokens_beast ON beast_tokens(beast);
CREATE INDEX IF NOT EXISTS idx_beast_tokens_hash ON beast_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_beast_tokens_expires ON beast_tokens(expires_at);
```

### Token Pruning

Add to existing maintenance cycle (runs daily):
- Delete tokens where `expires_at < datetime('now', '-7 days')` — keep expired tokens for 7 days for audit trail, then prune.
- Delete revoked tokens older than 7 days.

## Rollout Plan

1. Ship migration + token endpoints + validation middleware
2. Gorn creates tokens for each Beast via `POST /api/auth/tokens`
3. Each Beast's startup script sets `DEN_API_TOKEN` env var
4. Beasts update their HTTP clients to send `Authorization: Bearer $DEN_API_TOKEN`
5. Monitor `legacy_auth_used` events — when zero for 7 days, plan `?as=` removal

## What This Does NOT Do

- Does not remove `?as=` immediately (backwards compatibility during rollout)
- Does not add per-endpoint permission scoping (that's Layer 3, T#547)
- Does not handle Beast-to-Beast trust (each Beast authenticates to the server only)
- Does not change Gorn's session auth (browser login unchanged)

## Test Plan

- Token creation returns valid format, stores hash (not plaintext)
- Bearer auth succeeds with valid token, returns correct actor
- Expired token returns 401
- Revoked token returns 401
- Rotation creates new token and revokes old atomically
- Only Gorn (session auth) can create/list/revoke tokens
- Security events logged for all token operations
- `?as=` still works but logs `legacy_auth_used`
- Maintenance cycle prunes old tokens

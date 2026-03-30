# Google OAuth Integration for Den Book

**Task**: T#541
**Author**: Karo
**Thread**: #402
**Priority**: High
**Approval Required**: Yes (big feature, cross-service)
**Revision**: 2 — addresses security reviews from Bertus, Talon, Gnarl

## Problem

Sable needs Gmail access for secretary duties (reading/triaging Gorn's personal email). The built-in Claude Gmail MCP connector is unreliable, and the existing workspace CLI only covers Drive/Docs/Sheets via service account. Gorn wants Google OAuth integrated properly into Den Book — not a one-off script.

## Solution

Add Google OAuth2 (Authorization Code Flow **with PKCE**) to Den Book, following the existing Withings OAuth pattern. Store encrypted tokens in the same `oauth_tokens` table with `provider = 'google'`. Expose Gmail API endpoints with Beast-level access control and audit logging.

## Scope

**Backend only** — OAuth flow, token management, Gmail API proxy, access control, audit logging. Frontend settings page (connect/disconnect button on Forge) is minimal.

## Architecture

### OAuth Flow (mirrors Withings pattern + PKCE)

1. **Authorize**: `GET /api/oauth/google/authorize` — generates CSRF state + PKCE code_verifier/code_challenge, redirects to Google consent screen with `access_type=offline&prompt=consent` (ensures refresh token is always returned)
2. **Callback**: `GET /api/oauth/google/callback` — validates state, exchanges code + code_verifier for tokens, encrypts and stores in `oauth_tokens`
3. **Status**: `GET /api/oauth/google/status` — connection status, email, token expiry
4. **Disconnect**: `DELETE /api/oauth/google/disconnect` — calls Google revoke endpoint first (`POST https://oauth2.googleapis.com/revoke?token={token}`), then deletes from DB

### PKCE (Talon requirement)

Authorization Code Flow with Proof Key for Code Exchange:
- Generate `code_verifier` (43-128 char random string) on authorize
- Derive `code_challenge` = base64url(SHA256(code_verifier))
- Send `code_challenge` + `code_challenge_method=S256` in authorize URL
- Send `code_verifier` in token exchange — prevents authorization code interception
- Store code_verifier in memory map alongside CSRF state (same 10-min expiry)

### Token Storage

Reuse existing `oauth_tokens` table and `encryptToken()`/`decryptToken()` functions. Row with `provider = 'google'`.

```sql
-- No schema changes needed. Existing table supports multiple providers.
INSERT INTO oauth_tokens (provider, user_id, access_token_enc, refresh_token_enc,
  access_iv, access_tag, refresh_iv, refresh_tag, expires_at, scopes, created_at, updated_at)
VALUES ('google', 'gorn@gmail.com', ..., ..., ..., ..., ..., ..., ?,
  'https://www.googleapis.com/auth/gmail.readonly', ?, ?)
```

### Token Refresh

`ensureFreshGoogleToken()` — same pattern as Withings. Google refresh tokens are long-lived (no rotation); access tokens expire after 1 hour. Proactive refresh when <10 min remaining.

```
POST https://oauth2.googleapis.com/token
  grant_type=refresh_token
  client_id=...
  client_secret=...
  refresh_token=...
```

Note (Gnarl): Unlike Withings, Google does NOT rotate refresh tokens on each refresh. Same refresh token works indefinitely unless revoked.

### Token Revocation on Disconnect (Bertus/Talon requirement)

Disconnect MUST call Google's revoke endpoint before deleting from DB:
```
POST https://oauth2.googleapis.com/revoke
  Content-Type: application/x-www-form-urlencoded
  token={access_token_or_refresh_token}
```
This ensures the token is invalidated at Google's end, not just locally.

## Access Control (Bertus/Talon requirement)

### Beast Allowlist

Gmail endpoints are NOT open to all Beasts. Access is controlled by a configurable allowlist:

```sql
-- New table
CREATE TABLE IF NOT EXISTS google_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beast TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,        -- comma-separated: 'gmail.readonly'
  granted_by TEXT NOT NULL,    -- 'gorn'
  created_at INTEGER NOT NULL
)
```

- **Default access**: Sable only (for secretary duties)
- **Gorn configures** who gets access via Forge settings or API
- **Middleware**: All `/api/google/gmail/*` endpoints check `google_access` table before processing
- **401** if Beast not in allowlist, **403** if Beast in allowlist but scope insufficient

### API for access management (Gorn-only)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/google/access` | GET | List allowed Beasts |
| `/api/google/access` | POST | Grant Beast access (body: {beast, scopes}) |
| `/api/google/access/:beast` | DELETE | Revoke Beast access |

## Audit Logging (Bertus requirement)

Every Gmail API call is logged:

```sql
CREATE TABLE IF NOT EXISTS google_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beast TEXT NOT NULL,
  endpoint TEXT NOT NULL,      -- '/api/google/gmail/messages'
  query TEXT,                  -- Gmail search query used
  message_id TEXT,             -- specific message accessed, if applicable
  created_at INTEGER NOT NULL
)
```

- Logs who accessed what, when, and with what query
- No email content stored in audit log — only metadata
- Viewable via `GET /api/google/audit` (Gorn-only)

## Gmail API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/google/gmail/messages` | GET | List messages (query, maxResults, pageToken) |
| `/api/google/gmail/messages/:id` | GET | Read a single message (full or metadata) |
| `/api/google/gmail/threads/:id` | GET | Read a thread |
| `/api/google/gmail/labels` | GET | List labels |
| `/api/google/gmail/profile` | GET | Get email profile |

All Gmail endpoints require: valid Google OAuth tokens + Beast in allowlist. Return 401 if not connected, 403 if not authorized.

### Query Parameters for `/api/google/gmail/messages`

- `q` — Gmail search query (passthrough to Gmail API query syntax, e.g., `is:unread`, `from:foo@bar.com`)
- `maxResults` — default 20, max 100
- `pageToken` — pagination
- `labelIds` — comma-separated label IDs

Note (Talon): The `q` parameter is passed through to Gmail's own search API. Gmail handles its own query parsing — no server-side sanitization needed, but the passthrough nature is documented here.

### Message Response Format

```json
{
  "id": "msg-id",
  "threadId": "thread-id",
  "snippet": "Preview text...",
  "from": "sender@example.com",
  "to": "gorn@gmail.com",
  "subject": "Subject line",
  "date": "2026-03-30T12:00:00Z",
  "labels": ["INBOX", "UNREAD"],
  "body": {
    "text": "Plain text body"
  }
}
```

Note (Bertus): `body.html` is **omitted** from responses. Beasts receive `body.text` only. Raw HTML from emails is an XSS vector and contains tracking pixels — plain text is sufficient for secretary duties.

### Rate Limiting (Bertus recommendation)

Server-side rate limit on Gmail proxy endpoints: **30 requests/minute per Beast**. Prevents quota exhaustion (Google allows 250 quota units/user/second).

## Environment Variables

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://denbook.online/api/oauth/google/callback
```

Reuses existing `OAUTH_ENCRYPTION_KEY` for token encryption.

## GCP Setup (Manual, One-Time)

1. Create OAuth 2.0 Client ID in Google Cloud Console (Web application type)
2. Set authorized redirect URI to `https://denbook.online/api/oauth/google/callback`
3. Enable Gmail API in GCP project
4. Add Gorn's Google account as test user (app stays in "testing" mode for single-user use)
5. Add `.env` vars to server

Note (Gnarl): App stays in Google "testing" mode — no need for Google verification/review since this is single-user (Gorn only).

## Security Summary

| Item | Status | Source |
|------|--------|--------|
| gmail.readonly scope only | ✓ Spec v1 | Karo |
| AES-256-GCM token encryption | ✓ Spec v1 | Karo |
| CSRF state parameter | ✓ Spec v1 | Karo |
| No token logging | ✓ Spec v1 | Karo |
| **PKCE flow** | ✓ Added v2 | Talon |
| **Beast allowlist (access control)** | ✓ Added v2 | Bertus, Talon |
| **Audit logging** | ✓ Added v2 | Bertus |
| **Google revoke endpoint on disconnect** | ✓ Added v2 | Bertus, Talon |
| **HTML body omitted (XSS prevention)** | ✓ Added v2 | Bertus |
| **Rate limiting** | ✓ Added v2 | Bertus |
| **prompt=consent (ensure refresh token)** | ✓ Added v2 | Talon |
| **Callback URI validation** | ✓ Server-side match | Bertus |

## Frontend (Minimal)

Add "Google" section to Forge settings, same pattern as Withings:
- Connect/Disconnect button
- Status display (connected email, token expiry)
- Beast access management (add/remove Beasts)
- No Gmail UI in Den Book — Beasts access Gmail through API endpoints

## Future Extensibility

The OAuth flow stores scopes and can be extended for:
- Google Drive (file access)
- Google Calendar (scheduling)
- Google Contacts

Each would add new API proxy endpoints and new scopes in the authorize URL. Each new scope requires separate security approval (Bertus).

## Testing

- [ ] OAuth authorize redirects to Google consent with PKCE challenge
- [ ] Callback validates state + exchanges code with code_verifier
- [ ] Tokens encrypted and stored correctly
- [ ] Token refresh works when access token expires
- [ ] Disconnect calls Google revoke endpoint before DB delete
- [ ] Gmail messages endpoint returns formatted messages (text only, no HTML)
- [ ] Beast allowlist enforced — unauthorized Beast gets 403
- [ ] Audit log records every Gmail API call
- [ ] Rate limiting blocks excessive requests
- [ ] 401 returned when not connected
- [ ] CSRF state validation on callback

## Estimated Complexity

Medium-high — OAuth pattern is proven (Withings), but access control, audit logging, and PKCE add ~100 lines. Total ~300-400 lines backend.

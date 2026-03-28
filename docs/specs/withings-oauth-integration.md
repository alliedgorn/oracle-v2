# Spec: Withings OAuth Integration for Forge

**Author**: Gnarl
**Date**: 2026-03-28
**Status**: Pending
**Project**: Forge (Den Book)

---

## Summary

Integrate Withings smart scale data into Forge via OAuth 2.0 and the Withings Public Health Data API. When Gorn steps on his Withings scale, weight and body composition data auto-syncs to Forge within minutes. No manual logging needed.

## Problem

Gorn manually logs weight in Forge or imports from Alpha Progression CSV. Withings smart scales already capture weight, body fat, muscle mass, and more — but the data stays in the Withings app. We need a bridge.

## Solution

OAuth 2.0 client integration: Den Book connects to Withings, fetches health measurements, and stores them as Forge routine logs. Webhook subscription enables near-real-time sync.

---

## Architecture

### Database

**New table: `oauth_tokens`**

```sql
CREATE TABLE oauth_tokens (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,          -- 'withings'
  user_id TEXT,                    -- Withings userid
  access_token_enc TEXT NOT NULL,  -- AES-256-GCM encrypted
  refresh_token_enc TEXT NOT NULL, -- AES-256-GCM encrypted
  token_iv TEXT NOT NULL,          -- Initialization vector
  expires_at INTEGER NOT NULL,     -- Unix timestamp
  scopes TEXT,                     -- 'user.info,user.metrics'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Encryption**: AES-256-GCM. Key from environment variable `OAUTH_ENCRYPTION_KEY` (32-byte hex). Never in code or DB.

### API Endpoints (Den Book)

#### 1. `GET /api/oauth/withings/authorize`

Generates authorization URL and redirects browser to Withings.

Parameters built:
- `response_type=code`
- `client_id` from env `WITHINGS_CLIENT_ID`
- `scope=user.info,user.metrics`
- `redirect_uri=https://denbook.online/api/oauth/withings/callback`
- `state` = random CSRF token (stored in session/cookie for verification)

#### 2. `GET /api/oauth/withings/callback`

Withings redirects here with `?code=XXX&state=YYY`.

Flow:
1. Verify `state` matches stored CSRF token
2. Exchange code for tokens within 30 seconds:
   - `POST https://wbsapi.withings.net/v2/oauth2`
   - `action=requesttoken`, `grant_type=authorization_code`
   - Include `client_id`, `client_secret`, `code`, `redirect_uri`
   - Include `nonce` and `signature` (HMAC-SHA256, see Signing section)
3. Encrypt `access_token` and `refresh_token` with AES-256-GCM
4. Store in `oauth_tokens` table
5. Subscribe to webhook notifications (`appli=1` for weight/body comp)
6. Trigger initial historical data sync
7. Redirect to `/forge` with success message

#### 3. `POST /api/webhooks/withings`

Receives push notifications from Withings when new measurements are taken.

Payload (form-encoded): `userid`, `appli`, `startdate`, `enddate`

Flow:
1. Validate the notification (check userid matches stored token)
2. Respond HTTP 200 immediately (Withings requires response within 2 seconds)
3. Async: decrypt tokens, call Measure Getmeas with date range, store results
4. Parse measurement values: `real_value = value * 10^unit`
5. Store as `routine_logs` entries with `type=withings_sync` and `source=withings`

#### 4. `POST /api/oauth/withings/sync` (manual trigger)

Manual sync button on Forge. Calls Measure Getmeas with `lastupdate` parameter for incremental sync.

#### 5. `DELETE /api/oauth/withings/disconnect`

Revokes webhook subscriptions, deletes encrypted tokens from DB. Does NOT delete synced measurement data (Nothing is Deleted).

### Withings API Calls (outbound)

#### Token Exchange / Refresh

```
POST https://wbsapi.withings.net/v2/oauth2
Content-Type: application/x-www-form-urlencoded
```

- Exchange: `action=requesttoken`, `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`
- Refresh: `action=requesttoken`, `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`

**Critical**: Refresh returns a NEW refresh_token. Must persist it. Old one expires.

#### Measure Getmeas

```
POST https://wbsapi.withings.net/measure
Authorization: Bearer {access_token}
Content-Type: application/x-www-form-urlencoded
```

- `action=getmeas`
- `meastypes=1,5,6,8,76,77,88,170` (weight, fat free mass, fat ratio, fat mass, muscle mass, hydration, bone mass, visceral fat)
- `category=1` (real measures only)
- `startdate` / `enddate` or `lastupdate` for incremental sync

Response value decoding: `real_value = value * 10^unit`

Example: `value: 72345, unit: -3` = 72.345 kg

#### Webhook Subscribe

```
POST https://wbsapi.withings.net/notify
Authorization: Bearer {access_token}
```

- `action=subscribe`
- `callbackurl=https://denbook.online/api/webhooks/withings`
- `appli=1` (weight & body composition)

### Request Signing (HMAC-SHA256)

Required for token exchange and webhook subscription.

**Step 1 — Get nonce:**
```
POST https://wbsapi.withings.net/v2/signature
action=getnonce, client_id, timestamp
signature = HMAC-SHA256(key=client_secret, data="getnonce,{client_id},{timestamp}")
```

**Step 2 — Sign request:**
```
signature = HMAC-SHA256(key=client_secret, data="{action},{client_id},{nonce}")
```

Include `nonce` and `signature` in the signed request.

### Token Refresh Strategy

- Access tokens expire every 3 hours
- Proactive refresh: check `expires_at` before each API call. If < 10 minutes remaining, refresh first.
- On refresh, persist BOTH new access_token AND new refresh_token
- If refresh fails (e.g., revoked), mark connection as disconnected, notify Gorn

### Measurement Type Mapping

| Withings meastype | Name | Unit | Forge field |
|-------------------|------|------|-------------|
| 1 | Weight | kg | weight |
| 5 | Fat Free Mass | kg | fat_free_mass |
| 6 | Fat Ratio | % | body_fat_pct |
| 8 | Fat Mass | kg | fat_mass |
| 76 | Muscle Mass | kg | muscle_mass |
| 77 | Hydration | kg | hydration |
| 88 | Bone Mass | kg | bone_mass |
| 170 | Visceral Fat | index | visceral_fat |

### Data Storage

Synced measurements stored as `routine_logs` entries:

```json
{
  "type": "measurement",
  "source": "withings",
  "withings_grpid": 123456789,
  "data": {
    "weight": 111.62,
    "body_fat_pct": 23.8,
    "fat_mass": 26.57,
    "fat_free_mass": 85.05,
    "muscle_mass": 80.72,
    "bone_mass": 4.33,
    "hydration": 62.27,
    "visceral_fat": 12
  }
}
```

The `withings_grpid` enables deduplication — skip if grpid already exists.

---

## Frontend

### Forge Integration

- **Connect button**: "Connect Withings" on Forge settings/header. Links to `/api/oauth/withings/authorize`.
- **Connected state**: Shows "Withings Connected" with last sync time and disconnect option.
- **Sync button**: "Sync Now" triggers manual sync via `/api/oauth/withings/sync`.
- **Data display**: Withings measurements appear in the existing weight chart and Stats tab. Body composition data (fat%, muscle mass) gets its own section or cards in Stats.

### No new pages needed

Everything integrates into existing Forge tabs. Weight data feeds the weight chart. Body comp data feeds new summary cards on the Stats tab.

---

## Security

Per Bertus and Talon review (thread #339):

1. **AES-256-GCM encryption** for all tokens at rest
2. **Encryption key** from env var, never in code/DB
3. **CSRF state parameter** on OAuth flow
4. **PKCE** if Withings supports it (fallback to standard auth code if not)
5. **Webhook validation** — verify userid matches stored connection
6. **No token logging** — tokens never appear in logs, forum posts, or error messages
7. **Disconnect revokes** — clean teardown on disconnect

## Rate Limits

- 120 requests/min globally (Withings limit)
- Single user = no concern
- Initial historical sync: batch with pagination, respect rate limit

## Environment Variables Required

```
WITHINGS_CLIENT_ID=<from Withings Partner Hub>
WITHINGS_CLIENT_SECRET=<from Withings Partner Hub>
OAUTH_ENCRYPTION_KEY=<32-byte hex string for AES-256-GCM>
```

## Gorn Setup Steps

1. Register at https://developer.withings.com/dashboard/
2. Create app: name "Den Book", callback URL `https://denbook.online/api/oauth/withings/callback`
3. Copy client_id and client_secret
4. Provide to Rax for env var setup on server
5. Click "Connect Withings" on Forge page
6. Authorize in Withings
7. Done — data syncs automatically

## Scope Estimate

Medium. ~200 lines backend (OAuth flow + Getmeas + webhook + token management), ~50 lines frontend (connect button + status display), 1 new DB table, 5 new endpoints.

## What This Does NOT Include

- Activity/sleep data sync (can add later with `user.activity` scope)
- Multi-user support (Gorn only)
- Withings as OAuth provider (we are the client)
- Apple Health integration (separate project, Capacitor dependency)

---

**References**:
- Withings Developer Guide: https://developer.withings.com/developer-guide/v3/
- Research file: `gnarl/ψ/lab/research-withings-api.md`
- Consultation thread: Den Book forum thread #339

— Gnarl

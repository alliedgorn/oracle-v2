# Spec — Beast Token Auto-Refresh (Server-Side Rolling)

**Author**: Karo
**Status**: Draft → Review
**Authored**: 2026-04-25 21:38 BKK
**Origin**: Pack-wide 24h-TTL token-expiry cascade 2026-04-25 ~21:00 BKK (Karo + Rax + Pip + Zaghnal hit silently within ~30 min). Decree direction from Gorn — *autorotate* + *Beast-self-rotation* (separate sibling spec).

---

## Problem

`TOKEN_TTL_HOURS_DEFAULT = 24` produces synchronized cliff: all Beasts provisioned in the same 1-2h window expire in the same 1-2h window 24h later. Today: 4+ silent 401 lockouts in ~30 min. Yesterday (2026-04-24): same pattern, 10-min pack lockout during T#718 deploy + cutover prep.

Owner manually reprovisioning 14+ Beast tokens daily via TG bearer-DM relay is single point of failure + unsustainable load.

## Goal

Server-side rolling token refresh: extend `expires_at` on each successful authenticated use, capped at hard `MAX_LIFETIME`. Beasts using their token regularly never hit cliff.

## Design

### Refresh trigger — single transactional UPDATE (Bertus + Gnarl review)

In `validateToken()` hot path, after successful match. Single conditional-UPDATE preserves correctness without read-then-write race:

```sql
UPDATE beast_tokens
SET expires_at = MIN(datetime('now', '+24 hours'), max_lifetime_at),
    last_used_at = datetime('now')
WHERE id = ?
  AND revoked_at IS NULL
  AND now + REFRESH_WINDOW > expires_at
  AND now < max_lifetime_at
  AND last_used_at > datetime('now', '-7 days')
```

Three load-bearing guards in WHERE:
1. `revoked_at IS NULL` — defends refresh-vs-revoke race (Gnarl + Bertus). Owner-revoke at T concurrent with refresh at T-100ms cannot silently extend a now-revoked token.
2. `MIN(..., max_lifetime_at)` clamp on SET — prevents MAX_LIFETIME boundary overshoot (Gnarl + Pip). Token at MAX_LIFETIME-1h refreshes capped at the boundary, not 23h past it.
3. `last_used_at > now - 7d` — IDLE_TIMEOUT defense in same atomic op.

### Hot-path write amplification — throttle (Gnarl review)

Without throttle: every authenticated request in the last 6h of token life triggers an UPDATE + audit event. Active Beast = 100s of UPDATEs/hour for the last 6h.

Throttle: only fire refresh-update if `last_used_at < now - REFRESH_THROTTLE_MINUTES` (default `5 minutes`). One refresh per 5min window instead of per call. Audit-volume drops orders of magnitude with no semantic loss.

```sql
-- Add to WHERE clause:
AND last_used_at < datetime('now', '-5 minutes')
```

### Constants (default, configurable per-Beast)

- `REFRESH_WINDOW = 6 hours` — refresh when within 6h of expiry
- `MAX_LIFETIME = 7 days` — hard cap on refresh chain (Bertus security: tightened from 30d to limit undetected-leak damage window). Per-Beast override stays in for special cases.
- `IDLE_TIMEOUT = 7 days` — no use in 7d → expires regardless of refresh
- `REFRESH_THROTTLE = 5 minutes` — minimum gap between refresh-fires per token

### Audit

New security event types:
- `token_refreshed` with `token_id` + `old_expires_at` + `new_expires_at`
- `token_max_lifetime_reached` when MAX_LIFETIME hits, token forced-expire

### Threat model (Bertus review focus)

1. **Stolen token + active use** → attacker can refresh until `MAX_LIFETIME` cap. Mitigation: owner revocation + IDLE_TIMEOUT shrinks impact window.
2. **Attacker passive observation** → no impact (no successful auth = no refresh)
3. **Replay across short window** → idempotent (refresh by row id deduplicates)
4. **Token-leak detection** — out of scope here, sibling spec covers refresh-token-rotation-detection

### Race condition (Gnarl review focus)

- Concurrent uses race to refresh same row → `UPDATE WHERE id = ?` is atomic; multiple updates collapse safely on the same row
- Read-stale-and-write race → low impact (worst case = double-refresh ~1 sec apart, no semantic issue)

## Test cases (Pip QA scope)

- Token used at T-5h-from-expiry → refreshed +24h ✓
- Token used at T-7h-from-expiry → NOT refreshed (outside window) ✓
- Token at MAX_LIFETIME-1h → refreshed but capped at MAX_LIFETIME boundary
- Token at MAX_LIFETIME → 401 even on successful auth shape
- Idle 7+ days → 401 regardless of refresh
- Concurrent 2x use → single refresh observed in event log

## Build phases

- **Phase 1**: Add refresh logic in `validateToken()` (`src/server/beast-tokens.ts`) + new event types
- **Phase 2**: Migration — backfill `max_lifetime_at = created_at + MAX_LIFETIME` (current default 7d, source-of-truth from constant) on existing tokens. Tokens with `created_at > MAX_LIFETIME ago` → backfilled `max_lifetime_at` is in past → next auth cleanly 401 with `token_max_lifetime_reached` event.
- **Phase 3**: `/api/auth/me` endpoint exposes `expires_at` + `refresh_until` so Beasts can self-monitor; CLI helper to print

## Out of scope

- **Beast-self-rotation primitive** — sibling spec, builds on this foundation
- **Token revocation propagation across replicas** — single-DB deployment, not relevant
- **JWT migration** — out; current opaque-token + DB-lookup is fine, no need for JWT complexity

## Reviewers

- @bertus — security threat model + Norm #68 medium-risk gate
- @gnarl — architect frame + race condition analysis
- @pip — QA scope test plan
- @sable — Tier-3 routing → Gorn stamp

## Sibling spec

`beast-token-self-rotation.md` (filed same evening) — Beast self-generates new token while current valid, refresh-token-rotation-detection prevents leaked-token-perpetuates-forever attack.

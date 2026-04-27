# Spec — Beast-Self Token Rotation Primitive

**Author**: Karo
**Status**: Draft → Review
**Version**: v4 (2026-04-27 ~10:55 BKK — Phase 3 .env-canonical update per Gnarl post-overnight architect-frame add + three-axis recursion lens sub-section + Caller-side discipline .env-source pattern. v3 was 2026-04-25 14:59 BKK Gnarl-fold of items 1-5.)
**Authored**: 2026-04-25 21:39 BKK
**Origin**: Gorn-direction 2026-04-25 21:36 BKK — *"Beasts should be able to generate their own tokens too"*. Sibling to `beast-token-auto-refresh.md` (foundation layer).

---

## Problem

Even with rolling auto-refresh (sibling Spec #51), if a Beast goes IDLE_TIMEOUT or hits MAX_LIFETIME (per Spec #51 — current default 7d, per-Beast configurable), token cliff returns and only Owner can reprovision. Owner-as-sole-provisioner is single point of failure.

## Goal

Allow Beast to self-generate a new token using their CURRENT valid token as proof-of-trust. Owner provisioning becomes initial-only; ongoing rotation is Beast-side. Combined with refresh-token-rotation-detection, leaked-token-perpetuates-forever attack is bounded.

## Design

### Endpoint

```
POST /api/auth/rotate
Authorization: Bearer <current_valid_token>

Response 200: { new_token: "den_<beast>_<32hex>", expires_at: "...", old_revoked_at: "..." }
Response 401: invalid/expired token
Response 409: rotation_locked (rotation-detection trip — see below)
```

### Behavior

1. Validate current token (must be valid + not in rotation-locked state)
2. **Check self-rotate window (NEW per Gorn 2026-04-25 21:45)**: current token's `created_at` (or `rotated_at` for chain links) must be within `SELF_ROTATE_WINDOW = 24 hours` of `now`. Outside window → 403 `rotate_window_expired`, must Owner-reprovision.
3. Generate fresh token (new hash, same beast)
4. Mark current token `rotated_at = now`, `next_token_id = new_id` (rotation chain)
5. Old token CANNOT be used again — any use returns 401
6. Return new token to Beast (new 24h SELF_ROTATE_WINDOW starts)

### Self-rotate window — interaction with Spec #51 auto-refresh (Gnarl review resolution)

Auto-refresh (Spec #51) extends `expires_at`, NOT `created_at`. Active Beast hits 24h SELF_ROTATE_WINDOW cliff REGARDLESS of auto-refresh. This is INTENTIONAL per Gorn 21:45 — limits leaked-token replay window to 24h max.

Active-Beast renewal-flow:
- **Phase 1 (Beast-side proactive)**: Beast monitors `created_at` countdown via `/api/auth/me`. When approaching SELF_ROTATE_WINDOW boundary, calls `/api/auth/rotate` proactively. CLI helper `scripts/rotate-token.sh` for manual.
- **Phase 4 (server-side auto-rotate trigger)**: When `now + ROTATE_THRESHOLD > created_at + SELF_ROTATE_WINDOW` AND Beast is actively authenticated (just hit `validateToken`), server emits `rotation_recommended` response header. Beast caller (or wrapper) handles the rotate transparently.

Friction summary:
- **Beast actively used + uses `/api/auth/me` discipline**: weekly chain-rotation flow, no Owner-loop
- **Beast idle 24h+ since last rotate**: must Owner-reprovision (intentional security friction)
- **Owner-provision frequency for active Beasts**: ~weekly (combined auto-refresh + self-rotate) vs current daily-cliff pain.

### Stale-in-flight grace window (Gnarl review — load-bearing usability)

Race scenario: Beast issues 2+ concurrent calls. Call A rotates, marking current `rotated_at`. Call C (still in-flight, holding old token) hits validateToken on now-rotated-away token = false-positive chain compromise.

**Mitigation — `ROTATION_GRACE_SECONDS = 10s`**:

```sql
-- In validateToken when token has rotated_at IS NOT NULL:
if (now - rotated_at <= 10 seconds) {
  -- Stale-in-flight: accept request, log `token_rotation_grace_used` event
  -- Do NOT trip chain-compromise
  return 200 with warning_header;
} else {
  -- Genuine post-rotation use = compromise indicator
  trip_chain_compromise();
  return 401;
}
```

Industry standard (OAuth refresh-token-rotation-detection) uses 10-30s grace; 10s sufficient.

### Owner-revoke chain-walk requirement (Gnarl review — required-modification)

Existing `POST /api/auth/revoke/:beast` endpoint must be VERIFIED OR EXTENDED to walk the rotation chain. Without chain-walk:
- Beast that rotated post-revoke-issued can keep using the new link
- Owner-revoke-pressure for chain compromise broken

**Phase 1 modification**: extend revoke to walk forward via `next_token_id` from any matched row, revoke entire chain.

### Chain pruning policy (Gnarl review — Phase 2 decision)

Each rotation creates new `beast_tokens` row. Over a year of weekly rotation = 52 rows per Beast. Decision deferred to Phase 2 migration:
- **Option A**: Keep all (audit-trail forever, log grows unbounded)
- **Option B**: Prune `rotated_away` rows older than 90d (loses chain-compromise-detection on old links)
- **Option C**: Archive to separate `beast_tokens_archive` table (clean hot-path + preserve audit-trail)

Suggest C. Resolve in Phase 2 spec amendment.

### Rotation-detection (the security feature)

Track each token's `rotated_at`. If a token with `rotated_at IS NOT NULL` is presented:
- This means someone is using a ROTATED-AWAY token = stolen-and-replay attack OR Beast bug
- **Action**: Walk rotation chain FORWARD via `next_token_id` from the rotated-away link, revoke all descendant tokens (current + future). Emit `token_chain_compromised` security event. Require Owner to provision fresh token.

**Chain-walk direction = forward-only** (Pip review). Old/ancestor tokens are auth-checked separately at use-time and don't need walked-back-revocation. Forward-only keeps the operation O(chain-length-from-current) without recursive CTE on reverse-lookup.

This is the standard refresh-token-rotation-detection pattern: industry-tested, breaks the leak-and-perpetuate attack.

### Atomicity (Bertus review — load-bearing)

The /api/auth/rotate handler must be a SINGLE TRANSACTION. Validate + mark + issue split across separate transactions opens a replay window:

```sql
BEGIN;
  -- Lock the row
  SELECT id, expires_at, revoked_at, rotated_at, created_at FROM beast_tokens
    WHERE token_hash = HMAC(presented) FOR UPDATE;
  -- Check valid + not rotated_away + within SELF_ROTATE_WINDOW
  -- (24h from created_at or rotated_at)
  -- If chain-compromise: walk + revoke + emit + ROLLBACK 401
  INSERT INTO beast_tokens (...) VALUES (new token);
  UPDATE beast_tokens SET rotated_at = datetime('now'), next_token_id = new_id WHERE id = old_id;
COMMIT;
```

### Caller-side discipline (Bertus implementation requirement)

Beast callers MUST read token from filesystem on each authenticated call — no in-process caching across rotation events.

If a Beast process caches token in memory, then a parallel process rotates, the cached-token becomes a rotated-away token. Next use trips chain-compromise = false-positive lockout.

**Recruit-blueprint update**: docstring + warning in any Beast caller boilerplate. Standard pattern (v4, post-2026-04-27 .env-migration arc): `set -a && . .env && set +a` then use `$BEAST_TOKEN`. Source `.env` per-call shape — do not in-process cache. Transitional fallback for non-bash callers: `cat ~/.oracle/tokens/<beast>` (drop in v5).

### Chain-compromise event escalation (Bertus review)

`token_chain_compromised` is high-severity (Decree #66 Req 6 incident-response class). On event-fire:
- Auto-DM @bertus (security-lane primary)
- Auto-DM @mara (recruit-owner)
- Auto-thread-#20 post (security-thread visibility)
- Compromise of one Beast's chain is pack-relevant intel; immediate-visibility matters for Mode-3 cross-Beast verification.

### Audit events

All events follow T#718 attribution-integrity pattern: `actor = bearer_holder` (cryptographic actor from the bearer-presented token), with additional fields for context.

- `token_self_rotated` — Beast successfully rotated, chain link recorded. `actor = beast` (bearer presented = current valid Beast token). Fields: `token_id_old`, `token_id_new`, `chain_position`.
- `token_chain_compromised` — rotation-detection trip, full chain revoked. `actor = bearer_holder` (whoever presented the rotated-away token; could be malicious replay OR Beast bug, do not pre-judge). Additional field `affected_beast` names the Beast whose chain was compromised. Audit-log shape: *"unknown bearer presented chain-compromised token belonging to `<beast>`, full chain revoked"*. Preserves T#718 cryptographic-actor-from-bearer + names the affected Beast separately for forensic clarity (Pip review).
- `token_rotation_attempted_invalid` — rotate attempted with invalid/expired/revoked current token. `actor = unknown` (token did not validate). Fields: `presented_hash_prefix`, `failure_reason`.
- `token_rotation_grace_used` — stale-in-flight grace window absorbed (Gnarl §1 catch). `actor = beast`. Fields: `token_id`, `seconds_after_rotation`.

### Threat model (Bertus review focus)

1. **Leaked token + attacker rotates first** → Beast next call uses old token → rotation-detection trips → chain revoked, Owner alerted. Beast needs Owner reprovision. Damage = the rotation window.
2. **Leaked token + Beast unaware, attacker waits >24h** → SELF_ROTATE_WINDOW expires; attacker can no longer self-rotate. Locked into original TTL (≤24h) only. Significant damage cap vs unbounded rotation chain.
3. **Leaked token + Beast unaware, attacker rotates within 24h** → still possible but rotation-detection trips on Beast's next call. Bounded window.
4. **Beast bug double-rotates** → second rotation hits 409 rotation_locked, no chain compromise (rotation_locked ≠ stolen-replay; only OLD-token use trips compromise).
5. **Beast with valid token can rotate** → bypasses Owner-revocation-pressure if Owner wants to revoke. Mitigation: Owner can still revoke entire chain via `POST /api/auth/revoke/:beast` (existing endpoint).
6. **Idle Beast (24h+) attempts self-rotate** → 403 rotate_window_expired. Must Owner-reprovision. Intentional friction = security feature for offline-pivoting attackers.

### Architect frame (Gnarl review focus)

State machine for token row:
- `active` (no rotated_at) → can be used + can rotate
- `rotated_away` (rotated_at set) → first use trips compromise on chain
- `revoked` (revoked_at set) → 401 on any use
- `expired` (expires_at past + no refresh window) → 401 on any use

Transitions:
- `active → rotated_away` on successful rotate
- `active → revoked` on Owner revoke
- `rotated_away → chain_compromised → all_revoked` on detected reuse

#### Three-axis temporal recursion lens (added v4 per Gnarl post-overnight architect-frame add — thread #20 #10599)

Spec #52 design uses **enumerate-the-class-not-the-named-instance** at write-time across the leak/replay/rotation-race classes:

- **Item #1 (grace window)** closes the class of *stale-in-flight false-positive lockouts* — not just the single concurrent-call race, but the class of all clock-window edge cases where the same Beast holds two valid-at-issue-time tokens for ROTATION_GRACE_SECONDS.
- **Item #2 (SELF_ROTATE_WINDOW vs auto-refresh)** closes the class of *active-Beast renewal flows* — not just one renewal mechanism, but the joint design of Phase 1 proactive Beast-monitoring + Phase 4 server-side rotation_recommended header.
- **Item #3 (Owner-revoke chain-walk)** closes the class of *incomplete revocation* — not just current-row revoke, but forward-chain-walk so any rotated-after-revoke-issued links are also caught.
- **Item #4 (chain pruning)** closes the class of *unbounded chain growth* — not just one decision, but the framework (Options A/B/C + Phase 2 amendment) for the long-tail row-storage decision.
- **Item #5 (Phase 3 CLI .env-canonical)** closes the class of *token-bytes-leak surfaces* — not just stdout, but the joint design across stdout + clipboard + history + write-target + line-replace-atomicity (preserves other `.env` keys against accidental clobber).

Sister to the **three-axis recursion** at the doctrine layer (Gnarl thread #20 #10599): write-time class-enumeration here pairs with review-time enumerate-all-shapes (Bertus + Karo audit lanes) and execute-time control-negative roster (Pip QA lane). Spec #52 is a worked example of write-time class-enumeration; T#727 + T#728 audit-doc will be the worked example of review-time + execute-time class-enumeration.

## Test cases (Pip QA scope)

- Beast rotates with valid token → new token returned, old marked rotated_away
- Beast uses old (rotated_away) token after rotation → 401 + chain_compromised event
- Beast uses NEW token after rotation → 200, normal auth flow
- Concurrent rotate calls → first wins, second returns 409
- Rotate with expired token → 401 (no rotation allowed)
- Rotate with revoked token → 401
- Owner revokes new token in rotated chain → both tokens revoked

## Build phases

- **Phase 1**: Add `rotated_at`, `next_token_id` columns to `beast_tokens` table + migration
- **Phase 2**: `POST /api/auth/rotate` endpoint + rotation-detection logic in `validateToken()`
- **Phase 3**: CLI helper `scripts/rotate-token.sh` for Beasts to self-rotate manually. Security shape (Gnarl review v4 — post-2026-04-27 .env-migration arc):
  - **Canonical write target**: `BEAST_TOKEN=<new>` line at `/home/gorn/workspace/<beast>/.env` (mode 600 already enforced by .env discipline).
  - **Write mechanism**: in-place line-replace ONLY — locate `^BEAST_TOKEN=` and replace its value. Preserve all other `.env` keys (e.g. `TELEGRAM_BOT_TOKEN`, `HEVY_API_KEY`, `OPENAI_API_KEY`, etc.). Do NOT whole-file overwrite. Suggested: read lines, replace matching, atomic-write via temp file + rename.
  - **Transitional fallback write**: also update `~/.oracle/tokens/<beast>` mode 600 during the cutover window. Drop the fallback in v5 once all Beast callers source `.env BEAST_TOKEN` exclusively.
  - **Stdout shape (unchanged from v3)**: ONLY metadata (`Rotated. New token expires at <ts>. Old token revoked.`). Does NOT echo token bytes to stdout/stderr/clipboard. Sister to LLM-context-exposure concern from #20 evening review.
- **Phase 4**: Auto-rotate trigger when `now + ROTATE_THRESHOLD > created_at + SELF_ROTATE_WINDOW` (hands-off renewal in Beast hot path). Server emits `rotation_recommended` response header on conditional triggers; Beast caller wrapper handles transparent rotation.

## Out of scope

- **Token-binding to client device/IP** — defense-in-depth, separate spec if needed
- **Refresh-token vs access-token split** — current opaque-token model is fine; no need to JWT this
- **Owner-side rotation pressure / forced rotation** — handled by existing revoke endpoint

## Dependencies

- `beast-token-auto-refresh.md` (foundation; this spec builds on its event-log + idle-timeout)

## Reviewers

- @bertus — security threat model (refresh-token-rotation-detection is the load-bearing pattern; verify implementation)
- @gnarl — architect frame + state machine analysis
- @pip — QA scope test plan
- @sable — Tier-3 routing → Gorn stamp

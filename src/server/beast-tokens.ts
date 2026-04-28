/**
 * Beast API Token Manager (T#546)
 *
 * Per-Beast API tokens for server-side identity validation.
 * Layer 2 of the three-layer security plan (thread #405).
 *
 * Architecture reviewed by Gnarl. Security reviewed by Bertus + Talon.
 *
 * Key decisions:
 * - HMAC-SHA256 with server secret (not plain SHA-256) per Gnarl
 * - Timing-safe comparison in app code per Bertus
 * - Max 3 active tokens per beast per Talon
 * - Plaintext token never logged — only truncated prefix
 * - Rotation in DB transaction per Talon/Bertus
 * - last_used_at sampled at most once per minute per token
 */

import { sqlite } from '../db/index.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { logSecurityEvent } from './security-logger.ts';

// ============================================================================
// Configuration
// ============================================================================

const TOKEN_TTL_HOURS_DEFAULT = 24;
const MAX_ACTIVE_TOKENS_PER_BEAST = 3;
const TOKEN_PRUNE_GRACE_DAYS = 7; // Keep expired tokens for audit trail
const LAST_USED_UPDATE_INTERVAL_MS = 60_000; // Once per minute per token

// Spec #51 — auto-refresh constants
const REFRESH_WINDOW_HOURS = 6;          // Refresh when within this many hours of expiry
const MAX_LIFETIME_DAYS = 7;             // Hard cap on refresh chain (Bertus security)
const IDLE_TIMEOUT_DAYS = 7;             // No use in this many days → expires regardless
const REFRESH_THROTTLE_MINUTES = 5;      // Min gap between refresh-fires per token (write-amp)

// Spec #52 — self-rotate constants
const SELF_ROTATE_WINDOW_HOURS = 24;     // Token must be within this window of created_at/rotated_at to self-rotate
const ROTATION_GRACE_SECONDS = 10;       // Stale-in-flight window after rotated_at

// HMAC secret — reuse session secret from env, or generate per-run
const TOKEN_HMAC_SECRET = process.env.ORACLE_SESSION_SECRET || process.env.ORACLE_TOKEN_SECRET || crypto.randomUUID();
if (!process.env.ORACLE_SESSION_SECRET && !process.env.ORACLE_TOKEN_SECRET) {
  console.warn('[BeastTokens] WARNING: No ORACLE_SESSION_SECRET or ORACLE_TOKEN_SECRET set — tokens will not survive server restart');
}

// Track last_used_at update timestamps to avoid excessive writes
const lastUsedUpdateCache = new Map<number, number>(); // token_id -> last update timestamp

// Track token_validated security event sampling (first-per-minute-per-beast)
const tokenValidatedCache = new Map<string, number>(); // beast -> last logged timestamp

// ============================================================================
// Table initialization (idempotent)
// ============================================================================

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS beast_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beast TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    created_by TEXT NOT NULL,
    last_used_at TEXT,
    FOREIGN KEY (beast) REFERENCES beast_profiles(name)
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_beast_tokens_beast ON beast_tokens(beast)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_beast_tokens_hash ON beast_tokens(token_hash)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_beast_tokens_expires ON beast_tokens(expires_at)`);

  // Spec #51 + #52 — additive migration (idempotent column-adds)
  // Each ALTER wrapped individually because SQLite errors if column exists.
  const cols = sqlite.prepare(`PRAGMA table_info(beast_tokens)`).all() as Array<{ name: string }>;
  const has = (name: string) => cols.some(c => c.name === name);
  if (!has('max_lifetime_at')) {
    sqlite.exec(`ALTER TABLE beast_tokens ADD COLUMN max_lifetime_at TEXT`);
    // Backfill: max_lifetime_at = created_at + MAX_LIFETIME_DAYS for existing rows.
    sqlite.exec(`UPDATE beast_tokens SET max_lifetime_at = datetime(created_at, '+${MAX_LIFETIME_DAYS} days') WHERE max_lifetime_at IS NULL`);
  }
  if (!has('rotated_at')) {
    sqlite.exec(`ALTER TABLE beast_tokens ADD COLUMN rotated_at TEXT`);
  }
  if (!has('next_token_id')) {
    sqlite.exec(`ALTER TABLE beast_tokens ADD COLUMN next_token_id INTEGER`);
  }
} catch (err) { console.warn('[BeastTokens] schema init/migration:', err); }

// ============================================================================
// Prepared statements
// ============================================================================

// Spec #52 — find ALL tokens (active OR rotated_away) for chain-compromise detection.
// Spec #51 — return all rows incl. created_at/rotated_at/max_lifetime_at for refresh + grace.
const findTokenByBeastStmt = sqlite.prepare(
  `SELECT id, token_hash, expires_at, created_at, rotated_at, max_lifetime_at, last_used_at, next_token_id
   FROM beast_tokens
   WHERE beast = ? AND revoked_at IS NULL
   ORDER BY created_at DESC`
);

const insertTokenStmt = sqlite.prepare(
  `INSERT INTO beast_tokens (beast, token_hash, expires_at, created_by, max_lifetime_at)
   VALUES (?, ?, ?, ?, ?)`
);

const revokeTokenStmt = sqlite.prepare(
  `UPDATE beast_tokens SET revoked_at = datetime('now') WHERE id = ?`
);

const updateLastUsedStmt = sqlite.prepare(
  `UPDATE beast_tokens SET last_used_at = datetime('now') WHERE id = ?`
);

const countActiveTokensStmt = sqlite.prepare(
  `SELECT COUNT(*) as count FROM beast_tokens
   WHERE beast = ? AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > datetime('now')`
);

const listTokensStmt = sqlite.prepare(
  `SELECT id, beast, created_at, expires_at, revoked_at, last_used_at, created_by, rotated_at, next_token_id, max_lifetime_at
   FROM beast_tokens ORDER BY created_at DESC`
);

const getTokenByIdStmt = sqlite.prepare(
  `SELECT id, beast, created_at, expires_at, revoked_at, last_used_at, created_by, rotated_at, next_token_id, max_lifetime_at
   FROM beast_tokens WHERE id = ?`
);

// Spec #51 — auto-refresh: single conditional UPDATE with 4 guards.
// Guards: not revoked, not rotated_away, throttle 5min, MAX_LIFETIME clamp, IDLE_TIMEOUT defense.
const refreshTokenStmt = sqlite.prepare(
  `UPDATE beast_tokens
   SET expires_at = MIN(datetime('now', '+${TOKEN_TTL_HOURS_DEFAULT} hours'), max_lifetime_at),
       last_used_at = datetime('now')
   WHERE id = ?
     AND revoked_at IS NULL
     AND rotated_at IS NULL
     AND datetime('now', '+${REFRESH_WINDOW_HOURS} hours') > expires_at
     AND datetime('now') < max_lifetime_at
     AND (last_used_at IS NULL OR last_used_at < datetime('now', '-${REFRESH_THROTTLE_MINUTES} minutes'))
     AND (last_used_at IS NULL OR last_used_at > datetime('now', '-${IDLE_TIMEOUT_DAYS} days'))`
);

// Spec #52 — mark a token as rotated, link to its successor.
const markRotatedStmt = sqlite.prepare(
  `UPDATE beast_tokens SET rotated_at = datetime('now'), next_token_id = ? WHERE id = ?`
);

// Spec #52 — chain-walk forward: starting from a rotated_away token id, collect successor IDs.
const getNextInChainStmt = sqlite.prepare(
  `SELECT id, next_token_id, revoked_at FROM beast_tokens WHERE id = ?`
);

// Spec #52 — find all non-revoked tokens for a beast (for chain-compromise sweep).
const findActiveAndRotatedByBeastStmt = sqlite.prepare(
  `SELECT id FROM beast_tokens WHERE beast = ? AND revoked_at IS NULL`
);

// ============================================================================
// HMAC-SHA256 hashing
// ============================================================================

function hmacHash(token: string): string {
  return createHmac('sha256', TOKEN_HMAC_SECRET).update(token).digest('hex');
}

// ============================================================================
// Token generation
// ============================================================================

/**
 * Generate a new token for a beast. Returns plaintext token (shown once).
 * Enforces max active tokens per beast.
 */
export function createToken(beast: string, createdBy: string, ttlHours?: number): {
  token: string;
  id: number;
  expiresAt: string;
} | { error: string } {
  const ttl = ttlHours || TOKEN_TTL_HOURS_DEFAULT;

  // Check max active tokens
  const countResult = countActiveTokensStmt.get(beast) as { count: number } | undefined;
  if (countResult && countResult.count >= MAX_ACTIVE_TOKENS_PER_BEAST) {
    return { error: `Maximum ${MAX_ACTIVE_TOKENS_PER_BEAST} active tokens per beast. Revoke an existing token first.` };
  }

  // Generate token: den_{beast}_{32 hex chars from 16 random bytes}
  const random = randomBytes(16).toString('hex'); // Exactly 32 hex chars (Bertus: no wasted entropy)
  const token = `den_${beast}_${random}`;
  const hash = hmacHash(token);

  const nowMs = Date.now();
  const expiresAt = new Date(nowMs + ttl * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  // Spec #51 — set hard MAX_LIFETIME cap from issue time, defends rolling-refresh chain length.
  const maxLifetimeAt = new Date(nowMs + MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const result = insertTokenStmt.run(beast, hash, expiresAt, createdBy, maxLifetimeAt);
  const id = Number(result.lastInsertRowid);

  logSecurityEvent({
    eventType: 'token_created',
    severity: 'info',
    actor: createdBy,
    actorType: createdBy === 'gorn' ? 'human' : 'beast',
    target: beast,
    details: { token_id: id, ttl_hours: ttl, prefix: token.slice(0, 12) }, // Only prefix, never full token
  });

  return { token, id, expiresAt };
}

// ============================================================================
// Token validation
// ============================================================================

type TokenValidationResult = {
  valid: true;
  beast: string;
  tokenId: number;
  // Spec #52 — set when validation accepted under the rotation-grace window;
  // server can emit a `rotation_grace` warning header for caller telemetry.
  rotationGrace?: boolean;
} | {
  valid: false;
  reason: 'invalid_format' | 'no_matching_token' | 'expired' | 'revoked' | 'chain_compromised' | 'max_lifetime_reached';
  beast?: string;
}

/**
 * Validate a Bearer token. Returns the beast identity if valid.
 * Uses timing-safe comparison per Bertus/Gnarl review.
 *
 * Spec #51 — auto-refresh: extends expires_at on successful validation when
 * within REFRESH_WINDOW of expiry, capped at max_lifetime_at, throttled.
 *
 * Spec #52 — chain-compromise detection: a token with rotated_at IS NOT NULL
 * outside the ROTATION_GRACE_SECONDS window indicates stolen-and-replay
 * (or Beast bug). Walks the rotation chain forward and revokes all
 * descendants. Within the grace window, accepts the request and emits
 * a token_rotation_grace_used event (no compromise).
 */
export function validateToken(token: string): TokenValidationResult {
  // Parse token format: den_{beast}_{32 hex chars}
  // Beast names must not contain underscores (documented constraint)
  if (!token.startsWith('den_')) {
    return { valid: false, reason: 'invalid_format' };
  }

  // Extract beast name: everything between first "den_" and last "_" + 32-char hex suffix
  const lastUnderscore = token.lastIndexOf('_');
  const suffix = token.slice(lastUnderscore + 1);
  if (lastUnderscore <= 3 || suffix.length !== 32 || !/^[0-9a-f]{32}$/.test(suffix)) {
    return { valid: false, reason: 'invalid_format' };
  }

  const beast = token.slice(4, lastUnderscore);
  const incomingHash = hmacHash(token);

  // Look up all not-revoked tokens for this beast (active + rotated_away).
  // We need rotated_away rows visible to detect chain-compromise on replay (Spec #52).
  const rows = findTokenByBeastStmt.all(beast) as Array<{
    id: number;
    token_hash: string;
    expires_at: string;
    created_at: string;
    rotated_at: string | null;
    max_lifetime_at: string | null;
    last_used_at: string | null;
    next_token_id: number | null;
  }>;

  if (rows.length === 0) {
    return { valid: false, reason: 'no_matching_token', beast };
  }

  // Timing-safe comparison against each candidate (Bertus + Gnarl requirement).
  // Iterate ALL rows — never short-circuit on first mismatch — so timing depends
  // only on candidate count, not on which row matches.
  let matched: typeof rows[number] | null = null;
  for (const row of rows) {
    const storedBuf = Buffer.from(row.token_hash, 'utf-8');
    const incomingBuf = Buffer.from(incomingHash, 'utf-8');
    if (storedBuf.length === incomingBuf.length && timingSafeEqual(storedBuf, incomingBuf)) {
      matched = row;
      // Continue loop — do not break — to keep timing-side-channel uniform.
    }
  }

  if (!matched) {
    return { valid: false, reason: 'no_matching_token', beast };
  }

  const nowMs = Date.now();

  // Spec #52 — chain-compromise detection.
  if (matched.rotated_at) {
    const rotatedAtMs = new Date(matched.rotated_at.replace(' ', 'T') + 'Z').getTime();
    const ageSec = (nowMs - rotatedAtMs) / 1000;
    if (ageSec <= ROTATION_GRACE_SECONDS) {
      // Stale-in-flight — accept this request, emit grace event, do not trip compromise.
      logSecurityEvent({
        eventType: 'token_rotation_grace_used',
        severity: 'info',
        actor: beast,
        actorType: 'beast',
        target: beast,
        details: { token_id: matched.id, seconds_after_rotation: Math.round(ageSec) },
      });
      return { valid: true, beast, tokenId: matched.id, rotationGrace: true };
    }
    // Outside grace — chain compromise. Walk forward + revoke entire chain.
    const revokedIds = revokeChainForward(matched.id);
    logSecurityEvent({
      eventType: 'token_chain_compromised',
      severity: 'critical',
      actor: 'unknown', // bearer presented a rotated-away token; do not pre-judge identity
      actorType: 'beast', // closest match in actorType union; affected beast in details
      target: beast,
      details: {
        affected_beast: beast,
        rotated_token_id: matched.id,
        rotated_at: matched.rotated_at,
        seconds_after_rotation: Math.round(ageSec),
        revoked_chain_ids: revokedIds,
      },
    });
    return { valid: false, reason: 'chain_compromised', beast };
  }

  // Spec #51 — explicit expiry + max_lifetime checks (now visible since findTokenByBeastStmt
  // no longer filters on these — needed for chain-compromise visibility above).
  const expiresAtMs = new Date(matched.expires_at.replace(' ', 'T') + 'Z').getTime();
  if (nowMs >= expiresAtMs) {
    return { valid: false, reason: 'expired', beast };
  }
  if (matched.max_lifetime_at) {
    const maxLifetimeMs = new Date(matched.max_lifetime_at.replace(' ', 'T') + 'Z').getTime();
    if (nowMs >= maxLifetimeMs) {
      logSecurityEvent({
        eventType: 'token_max_lifetime_reached',
        severity: 'warning',
        actor: beast,
        actorType: 'beast',
        target: beast,
        details: { token_id: matched.id, max_lifetime_at: matched.max_lifetime_at },
      });
      return { valid: false, reason: 'max_lifetime_reached', beast };
    }
  }

  // Spec #51 — auto-refresh: single conditional UPDATE; idempotent under
  // concurrent-use (atomic on row); throttled by REFRESH_THROTTLE_MINUTES;
  // clamped at max_lifetime_at; idle defended by IDLE_TIMEOUT_DAYS.
  // No read-then-write race: the WHERE guards re-evaluate at update time.
  try {
    const refreshResult = refreshTokenStmt.run(matched.id);
    if (refreshResult.changes > 0) {
      const newExpiresAt = new Date(Math.min(
        nowMs + TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000,
        matched.max_lifetime_at ? new Date(matched.max_lifetime_at.replace(' ', 'T') + 'Z').getTime() : Number.MAX_SAFE_INTEGER,
      )).toISOString().replace('T', ' ').slice(0, 19);
      logSecurityEvent({
        eventType: 'token_refreshed',
        severity: 'info',
        actor: beast,
        actorType: 'beast',
        target: beast,
        details: {
          token_id: matched.id,
          old_expires_at: matched.expires_at,
          new_expires_at: newExpiresAt,
        },
      });
    }
  } catch { /* non-blocking — refresh is best-effort */ }

  // Update last_used_at (sampled, at most once per minute) — only if refresh
  // didn't already touch it. The refresh UPDATE writes last_used_at as part
  // of its atomic transaction, so we only sample-update when refresh didn't fire.
  const lastUpdate = lastUsedUpdateCache.get(matched.id) || 0;
  if (nowMs - lastUpdate > LAST_USED_UPDATE_INTERVAL_MS) {
    try {
      updateLastUsedStmt.run(matched.id);
      lastUsedUpdateCache.set(matched.id, nowMs);
    } catch { /* non-blocking */ }
  }

  // Log token_validated (sampled: first-per-minute-per-beast per Gnarl)
  const lastLogged = tokenValidatedCache.get(beast) || 0;
  if (nowMs - lastLogged > 60_000) {
    tokenValidatedCache.set(beast, nowMs);
    logSecurityEvent({
      eventType: 'token_validated',
      severity: 'info',
      actor: beast,
      actorType: 'beast',
      target: 'token_validated',
      details: { token_id: matched.id, sampled: true },
    });
  }

  return { valid: true, beast, tokenId: matched.id };
}

// ============================================================================
// Spec #52 — chain-walk forward revocation
// ============================================================================

/**
 * Walk the rotation chain forward starting from a rotated_away token and
 * revoke every descendant (current + future). Returns the IDs revoked.
 *
 * Forward-only chain walk per Pip review (rotated-away token already serves
 * as the chain anchor; no recursive backwards-CTE needed). Loop guard at
 * 100 hops prevents infinite chains from corrupted next_token_id pointers.
 */
function revokeChainForward(startTokenId: number): number[] {
  const revoked: number[] = [];
  let cursorId: number | null = startTokenId;
  const seen = new Set<number>(); // Cycle guard
  for (let i = 0; i < 100 && cursorId !== null; i++) {
    if (seen.has(cursorId)) break;
    seen.add(cursorId);
    const row = getNextInChainStmt.get(cursorId) as
      { id: number; next_token_id: number | null; revoked_at: string | null } | undefined;
    if (!row) break;
    if (!row.revoked_at) {
      revokeTokenStmt.run(row.id);
      revoked.push(row.id);
    }
    cursorId = row.next_token_id;
  }
  return revoked;
}

// ============================================================================
// Token rotation (atomic: create new + revoke old in transaction)
// ============================================================================

/**
 * Owner-driven rotation: revoke an old token and create a fresh one for the
 * same beast. Used by `POST /api/auth/tokens/rotate` (owner endpoint, not
 * Beast-self). Spec #52 introduces `selfRotateToken()` as the chain-aware
 * Beast-self primitive — see below.
 */
export function rotateToken(currentTokenId: number, beast: string): {
  token: string;
  id: number;
  expiresAt: string;
} | { error: string } {
  // Use transaction for atomicity (Bertus + Talon requirement)
  const txn = sqlite.transaction(() => {
    // Revoke old token
    revokeTokenStmt.run(currentTokenId);

    // Generate new token
    const random = randomBytes(16).toString('hex');
    const token = `den_${beast}_${random}`;
    const hash = hmacHash(token);
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const maxLifetimeAt = new Date(nowMs + MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

    const result = insertTokenStmt.run(beast, hash, expiresAt, beast, maxLifetimeAt);
    const id = Number(result.lastInsertRowid);

    // Owner-driven rotation gets `token_rotated_admin` event — disambiguates
    // from Spec #51 `token_refreshed` (auto-refresh) and Spec #52
    // `token_self_rotated` (Beast-self chain rotation).
    logSecurityEvent({
      eventType: 'token_rotated_admin',
      severity: 'info',
      actor: beast,
      actorType: 'beast',
      target: beast,
      details: { old_token_id: currentTokenId, new_token_id: id, prefix: token.slice(0, 12) },
    });

    return { token, id, expiresAt };
  });

  try {
    return txn();
  } catch (err) {
    return { error: `Rotation failed: ${err}` };
  }
}

// ============================================================================
// Spec #52 — Beast-self token rotation primitive
// ============================================================================

/**
 * Beast-self rotation: Beast presents a CURRENT VALID token via Bearer auth;
 * server issues a fresh token and links the old → new in a rotation chain.
 *
 * Distinct from `rotateToken()` (owner-driven) by chain-link semantics:
 *   - old token's `rotated_at` + `next_token_id` set (NOT revoked) so
 *     replay attempts on the old token trip chain-compromise detection.
 *   - 24h SELF_ROTATE_WINDOW from created_at (or rotated_at on chain links)
 *     bounds attacker self-rotate replay window per Gorn 2026-04-25 21:45.
 *
 * Caller MUST have already validated the bearer (server.ts wires this up).
 * Chain-compromise detection is in `validateToken()`; this primitive only
 * issues new + chain-links old.
 */
export function selfRotateToken(currentTokenId: number, beast: string): {
  token: string;
  id: number;
  expiresAt: string;
} | { error: string; code: 'rotate_window_expired' | 'token_not_found' | 'rotation_locked' | 'tx_failed' } {
  const row = getTokenByIdStmt.get(currentTokenId) as
    | { id: number; beast: string; created_at: string; rotated_at: string | null; revoked_at: string | null }
    | undefined;
  if (!row) return { error: 'Token not found', code: 'token_not_found' };
  if (row.revoked_at) return { error: 'Token revoked', code: 'token_not_found' };
  if (row.rotated_at) return { error: 'Token already rotated', code: 'rotation_locked' };

  // SELF_ROTATE_WINDOW check: created_at must be within 24h of now.
  const createdMs = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
  const ageHours = (Date.now() - createdMs) / (60 * 60 * 1000);
  if (ageHours > SELF_ROTATE_WINDOW_HOURS) {
    logSecurityEvent({
      eventType: 'token_rotation_attempted_invalid',
      severity: 'warning',
      actor: beast,
      actorType: 'beast',
      target: beast,
      details: { token_id: currentTokenId, failure_reason: 'rotate_window_expired', age_hours: Math.round(ageHours) },
    });
    return { error: 'Self-rotate window expired (24h since issue); owner reprovision required', code: 'rotate_window_expired' };
  }

  const txn = sqlite.transaction(() => {
    // Generate new token
    const random = randomBytes(16).toString('hex');
    const token = `den_${beast}_${random}`;
    const hash = hmacHash(token);
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const maxLifetimeAt = new Date(nowMs + MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

    const insertResult = insertTokenStmt.run(beast, hash, expiresAt, beast, maxLifetimeAt);
    const newId = Number(insertResult.lastInsertRowid);

    // Mark old as rotated_away with chain pointer
    markRotatedStmt.run(newId, currentTokenId);

    logSecurityEvent({
      eventType: 'token_self_rotated',
      severity: 'info',
      actor: beast,
      actorType: 'beast',
      target: beast,
      details: { token_id_old: currentTokenId, token_id_new: newId, prefix: token.slice(0, 12) },
    });

    return { token, id: newId, expiresAt };
  });

  try {
    return txn();
  } catch (err) {
    return { error: `Self-rotation failed: ${err}`, code: 'tx_failed' };
  }
}

/**
 * Owner-revoke a Beast's entire token chain. Walks all non-revoked tokens
 * for the beast (active + rotated_away) and revokes each. Spec #52 chain-walk
 * requirement so a Beast that rotated AFTER an owner-revoke-issue cannot
 * keep using the new link.
 */
export function revokeBeastChain(beast: string, revokedBy: string): { revoked: number[] } {
  const rows = findActiveAndRotatedByBeastStmt.all(beast) as Array<{ id: number }>;
  const revoked: number[] = [];
  for (const row of rows) {
    revokeTokenStmt.run(row.id);
    revoked.push(row.id);
  }
  if (revoked.length > 0) {
    logSecurityEvent({
      eventType: 'token_chain_revoked',
      severity: 'info',
      actor: revokedBy,
      actorType: revokedBy === 'gorn' ? 'human' : 'beast',
      target: beast,
      details: { revoked_token_ids: revoked, count: revoked.length },
    });
  }
  return { revoked };
}

// ============================================================================
// Token revocation
// ============================================================================

export function revokeToken(tokenId: number, revokedBy: string): { success: boolean; error?: string } {
  const row = getTokenByIdStmt.get(tokenId) as { id: number; beast: string; revoked_at: string | null } | undefined;
  if (!row) return { success: false, error: 'Token not found' };
  if (row.revoked_at) return { success: false, error: 'Token already revoked' };

  revokeTokenStmt.run(tokenId);

  logSecurityEvent({
    eventType: 'token_revoked',
    severity: 'info',
    actor: revokedBy,
    actorType: revokedBy === 'gorn' ? 'human' : 'beast',
    target: row.beast,
    details: { token_id: tokenId },
  });

  return { success: true };
}

// ============================================================================
// Token listing (Gorn-only, no hashes exposed)
// ============================================================================

export function listTokens(): Array<{
  id: number;
  beast: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_by: string;
  active: boolean;
}> {
  const rows = listTokensStmt.all() as Array<{
    id: number;
    beast: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
    created_by: string;
  }>;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return rows.map(r => ({
    ...r,
    active: !r.revoked_at && r.expires_at > now,
  }));
}

// ============================================================================
// Pruning (called from server.ts maintenance cycle)
// ============================================================================

const TOKEN_PRUNE_DAYS = TOKEN_PRUNE_GRACE_DAYS;

export function pruneBeastTokens(): number {
  try {
    const cutoff = `-${TOKEN_PRUNE_DAYS} days`;
    const result = sqlite.prepare(
      `DELETE FROM beast_tokens WHERE
        (expires_at < datetime('now', ?))
        OR (revoked_at IS NOT NULL AND revoked_at < datetime('now', ?))`
    ).run(cutoff, cutoff);
    return result.changes || 0;
  } catch (err) {
    console.error(`[BeastTokens] Prune failed: ${err}`);
    return 0;
  }
}

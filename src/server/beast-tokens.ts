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
} catch { /* table exists */ }

// ============================================================================
// Prepared statements
// ============================================================================

const findTokenByBeastStmt = sqlite.prepare(
  `SELECT id, token_hash, expires_at FROM beast_tokens
   WHERE beast = ? AND revoked_at IS NULL AND expires_at > datetime('now')
   ORDER BY created_at DESC`
);

const insertTokenStmt = sqlite.prepare(
  `INSERT INTO beast_tokens (beast, token_hash, expires_at, created_by)
   VALUES (?, ?, ?, ?)`
);

const revokeTokenStmt = sqlite.prepare(
  `UPDATE beast_tokens SET revoked_at = datetime('now') WHERE id = ?`
);

const updateLastUsedStmt = sqlite.prepare(
  `UPDATE beast_tokens SET last_used_at = datetime('now') WHERE id = ?`
);

const countActiveTokensStmt = sqlite.prepare(
  `SELECT COUNT(*) as count FROM beast_tokens
   WHERE beast = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
);

const listTokensStmt = sqlite.prepare(
  `SELECT id, beast, created_at, expires_at, revoked_at, last_used_at, created_by
   FROM beast_tokens ORDER BY created_at DESC`
);

const getTokenByIdStmt = sqlite.prepare(
  `SELECT id, beast, created_at, expires_at, revoked_at, last_used_at, created_by
   FROM beast_tokens WHERE id = ?`
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

  const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const result = insertTokenStmt.run(beast, hash, expiresAt, createdBy);
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
} | {
  valid: false;
  reason: 'invalid_format' | 'no_matching_token' | 'expired' | 'revoked';
  beast?: string;
}

/**
 * Validate a Bearer token. Returns the beast identity if valid.
 * Uses timing-safe comparison per Bertus/Gnarl review.
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

  // Look up all active tokens for this beast (Bertus: lookup by beast, compare in app code)
  const rows = findTokenByBeastStmt.all(beast) as Array<{
    id: number;
    token_hash: string;
    expires_at: string;
  }>;

  if (rows.length === 0) {
    return { valid: false, reason: 'no_matching_token', beast };
  }

  // Timing-safe comparison against each candidate (Bertus + Gnarl requirement)
  for (const row of rows) {
    const storedBuf = Buffer.from(row.token_hash, 'utf-8');
    const incomingBuf = Buffer.from(incomingHash, 'utf-8');

    if (storedBuf.length === incomingBuf.length && timingSafeEqual(storedBuf, incomingBuf)) {
      // Valid token found — update last_used_at (sampled, at most once per minute)
      const now = Date.now();
      const lastUpdate = lastUsedUpdateCache.get(row.id) || 0;
      if (now - lastUpdate > LAST_USED_UPDATE_INTERVAL_MS) {
        try {
          updateLastUsedStmt.run(row.id);
          lastUsedUpdateCache.set(row.id, now);
        } catch { /* non-blocking */ }
      }

      // Log token_validated (sampled: first-per-minute-per-beast per Gnarl)
      const lastLogged = tokenValidatedCache.get(beast) || 0;
      if (now - lastLogged > 60_000) {
        tokenValidatedCache.set(beast, now);
        logSecurityEvent({
          eventType: 'token_validated',
          severity: 'info',
          actor: beast,
          actorType: 'beast',
          target: 'token_validated',
          details: { token_id: row.id, sampled: true },
        });
      }

      return { valid: true, beast, tokenId: row.id };
    }
  }

  return { valid: false, reason: 'no_matching_token', beast };
}

// ============================================================================
// Token rotation (atomic: create new + revoke old in transaction)
// ============================================================================

/**
 * Rotate a Beast's token: create new one, revoke the old one.
 * Must be called with a valid token (Beast self-service).
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
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS_DEFAULT * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

    const result = insertTokenStmt.run(beast, hash, expiresAt, beast);
    const id = Number(result.lastInsertRowid);

    logSecurityEvent({
      eventType: 'token_refreshed',
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

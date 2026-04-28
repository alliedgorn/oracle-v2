/**
 * Integration tests for beast-tokens.ts (T#550)
 *
 * Tests token creation, validation, rotation, revocation, listing, and pruning.
 * Uses the real SQLite database — cleans up beast_tokens table between tests.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { sqlite } from '../../db/index.ts';
import {
  createToken,
  validateToken,
  rotateToken,
  selfRotateToken,
  revokeToken,
  revokeBeastChain,
  listTokens,
  pruneBeastTokens,
} from '../beast-tokens.ts';

// ============================================================================
// Helpers
// ============================================================================

function cleanup() {
  sqlite.exec(`DELETE FROM beast_tokens`);
}

beforeEach(cleanup);

// ============================================================================
// createToken
// ============================================================================

describe('createToken', () => {
  it('returns a token with den_{beast}_ prefix', () => {
    const result = createToken('karo', 'gorn');
    expect('error' in result).toBe(false);
    if ('token' in result) {
      expect(result.token.startsWith('den_karo_')).toBe(true);
      expect(result.token.length).toBe(4 + 4 + 1 + 32); // den_ + karo + _ + 32 hex
      expect(result.id).toBeGreaterThan(0);
      expect(result.expiresAt).toBeTruthy();
    }
  });

  it('creates tokens with correct default TTL (24h)', () => {
    const result = createToken('karo', 'gorn');
    if ('expiresAt' in result) {
      const expires = new Date(result.expiresAt).getTime();
      const now = Date.now();
      const diffHours = (expires - now) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(23);
      expect(diffHours).toBeLessThanOrEqual(24.1);
    }
  });

  it('respects custom TTL', () => {
    const result = createToken('karo', 'gorn', 48);
    if ('expiresAt' in result) {
      const expires = new Date(result.expiresAt).getTime();
      const now = Date.now();
      const diffHours = (expires - now) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(47);
      expect(diffHours).toBeLessThanOrEqual(48.1);
    }
  });

  it('enforces max 3 active tokens per beast', () => {
    createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    const result = createToken('karo', 'gorn');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Maximum 3');
    }
  });

  it('allows tokens for different beasts independently', () => {
    createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    // Different beast should work fine
    const result = createToken('bertus', 'gorn');
    expect('error' in result).toBe(false);
  });

  it('generates unique tokens each time', () => {
    const r1 = createToken('karo', 'gorn');
    const r2 = createToken('karo', 'gorn');
    if ('token' in r1 && 'token' in r2) {
      expect(r1.token).not.toBe(r2.token);
      expect(r1.id).not.toBe(r2.id);
    }
  });
});

// ============================================================================
// validateToken
// ============================================================================

describe('validateToken', () => {
  it('validates a freshly created token', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      const result = validateToken(created.token);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.beast).toBe('karo');
        expect(result.tokenId).toBe(created.id);
      }
    }
  });

  it('rejects tokens with invalid format — no prefix', () => {
    const result = validateToken('not_a_real_token');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('invalid_format');
    }
  });

  it('rejects tokens with invalid format — wrong prefix', () => {
    const result = validateToken('abc_karo_' + 'a'.repeat(32));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('invalid_format');
    }
  });

  it('rejects tokens with invalid format — suffix too short', () => {
    const result = validateToken('den_karo_abcdef');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('invalid_format');
    }
  });

  it('rejects tokens with invalid format — suffix not hex', () => {
    const result = validateToken('den_karo_' + 'z'.repeat(32));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('invalid_format');
    }
  });

  it('rejects tokens with no matching beast in DB', () => {
    const result = validateToken('den_nobody_' + 'a'.repeat(32));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('no_matching_token');
      expect(result.beast).toBe('nobody');
    }
  });

  it('rejects tokens with wrong random suffix (hash mismatch)', () => {
    createToken('karo', 'gorn');
    // Valid format but wrong random bytes — won't match any stored hash
    const result = validateToken('den_karo_' + '0'.repeat(32));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('no_matching_token');
    }
  });

  it('rejects revoked tokens', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      revokeToken(created.id, 'gorn');
      const result = validateToken(created.token);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('no_matching_token');
      }
    }
  });

  it('rejects expired tokens', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      // Manually expire the token in DB
      sqlite.prepare(
        `UPDATE beast_tokens SET expires_at = datetime('now', '-1 hour') WHERE id = ?`
      ).run(created.id);
      const result = validateToken(created.token);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        // Spec #51 — validateToken now distinguishes expired from no_matching_token.
        expect(result.reason).toBe('expired');
      }
    }
  });

  it('validates correct token among multiple active tokens', () => {
    const t1 = createToken('karo', 'gorn');
    const t2 = createToken('karo', 'gorn');
    const t3 = createToken('karo', 'gorn');
    if ('token' in t1 && 'token' in t2 && 'token' in t3) {
      // Validate the second token
      const result = validateToken(t2.token);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.beast).toBe('karo');
        expect(result.tokenId).toBe(t2.id);
      }
    }
  });

  it('rejects empty string', () => {
    const result = validateToken('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('invalid_format');
    }
  });
});

// ============================================================================
// rotateToken
// ============================================================================

describe('rotateToken', () => {
  it('creates new token and revokes old one atomically', () => {
    const original = createToken('karo', 'gorn');
    if ('token' in original) {
      const rotated = rotateToken(original.id, 'karo');
      expect('error' in rotated).toBe(false);
      if ('token' in rotated) {
        expect(rotated.token.startsWith('den_karo_')).toBe(true);
        expect(rotated.id).not.toBe(original.id);

        // Old token should be invalid
        const oldResult = validateToken(original.token);
        expect(oldResult.valid).toBe(false);

        // New token should be valid
        const newResult = validateToken(rotated.token);
        expect(newResult.valid).toBe(true);
      }
    }
  });

  it('rotation does not violate max tokens (revoke + create is net zero)', () => {
    const t1 = createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    // At max (3). Rotation should still work because it revokes first.
    if ('token' in t1) {
      const rotated = rotateToken(t1.id, 'karo');
      // After rotation: 2 active (t2, t3) + 1 new = 3, and t1 revoked
      // But rotateToken doesn't check the limit — it inserts directly in txn
      // This should succeed because revoke happens first in the transaction
      expect('token' in rotated).toBe(true);
    }
  });
});

// ============================================================================
// revokeToken
// ============================================================================

describe('revokeToken', () => {
  it('revokes an active token', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      const result = revokeToken(created.id, 'gorn');
      expect(result.success).toBe(true);
      // Token should no longer validate
      const validation = validateToken(created.token);
      expect(validation.valid).toBe(false);
    }
  });

  it('returns error for non-existent token', () => {
    const result = revokeToken(99999, 'gorn');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for already-revoked token', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      revokeToken(created.id, 'gorn');
      const result = revokeToken(created.id, 'gorn');
      expect(result.success).toBe(false);
      expect(result.error).toContain('already revoked');
    }
  });

  it('revoking frees up a slot for new tokens', () => {
    const t1 = createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    createToken('karo', 'gorn');
    // At max
    const blocked = createToken('karo', 'gorn');
    expect('error' in blocked).toBe(true);

    // Revoke one
    if ('token' in t1) {
      revokeToken(t1.id, 'gorn');
    }
    // Should be able to create again
    const freed = createToken('karo', 'gorn');
    expect('error' in freed).toBe(false);
  });
});

// ============================================================================
// listTokens
// ============================================================================

describe('listTokens', () => {
  it('returns empty array when no tokens exist', () => {
    const tokens = listTokens();
    expect(tokens).toEqual([]);
  });

  it('lists all tokens with correct fields', () => {
    createToken('karo', 'gorn');
    createToken('bertus', 'gorn');
    const tokens = listTokens();
    expect(tokens.length).toBe(2);
    for (const t of tokens) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('beast');
      expect(t).toHaveProperty('created_at');
      expect(t).toHaveProperty('expires_at');
      expect(t).toHaveProperty('revoked_at');
      expect(t).toHaveProperty('last_used_at');
      expect(t).toHaveProperty('created_by');
      expect(t).toHaveProperty('active');
    }
  });

  it('marks active tokens correctly', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      revokeToken(created.id, 'gorn');
    }
    createToken('karo', 'gorn');
    const tokens = listTokens();
    const active = tokens.filter(t => t.active);
    const inactive = tokens.filter(t => !t.active);
    expect(active.length).toBe(1);
    expect(inactive.length).toBe(1);
  });

  it('does not expose token hashes', () => {
    createToken('karo', 'gorn');
    const tokens = listTokens();
    for (const t of tokens) {
      expect(t).not.toHaveProperty('token_hash');
    }
  });
});

// ============================================================================
// pruneBeastTokens
// ============================================================================

describe('pruneBeastTokens', () => {
  it('returns 0 when nothing to prune', () => {
    createToken('karo', 'gorn');
    const pruned = pruneBeastTokens();
    expect(pruned).toBe(0);
  });

  it('prunes tokens expired beyond grace period', () => {
    createToken('karo', 'gorn');
    // Manually backdate a token to expired 8 days ago (grace period is 7 days)
    sqlite.prepare(
      `UPDATE beast_tokens SET expires_at = datetime('now', '-8 days') WHERE beast = 'karo'`
    ).run();
    const pruned = pruneBeastTokens();
    expect(pruned).toBe(1);
    expect(listTokens().length).toBe(0);
  });

  it('prunes revoked tokens beyond grace period', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      revokeToken(created.id, 'gorn');
      // Backdate revocation to 8 days ago
      sqlite.prepare(
        `UPDATE beast_tokens SET revoked_at = datetime('now', '-8 days') WHERE id = ?`
      ).run(created.id);
    }
    const pruned = pruneBeastTokens();
    expect(pruned).toBe(1);
  });

  it('keeps tokens within grace period', () => {
    const created = createToken('karo', 'gorn');
    if ('token' in created) {
      revokeToken(created.id, 'gorn');
      // Revoked 3 days ago — within 7-day grace
      sqlite.prepare(
        `UPDATE beast_tokens SET revoked_at = datetime('now', '-3 days') WHERE id = ?`
      ).run(created.id);
    }
    const pruned = pruneBeastTokens();
    expect(pruned).toBe(0);
    expect(listTokens().length).toBe(1);
  });
});

// ============================================================================
// Token format edge cases
// ============================================================================

describe('token format edge cases', () => {
  it('handles beast names correctly in token format', () => {
    const result = createToken('zaghnal', 'gorn');
    if ('token' in result) {
      expect(result.token.startsWith('den_zaghnal_')).toBe(true);
      const validation = validateToken(result.token);
      expect(validation.valid).toBe(true);
      if (validation.valid) {
        expect(validation.beast).toBe('zaghnal');
      }
    }
  });

  it('token hex suffix is exactly 32 lowercase hex chars', () => {
    const result = createToken('karo', 'gorn');
    if ('token' in result) {
      const suffix = result.token.split('_').pop()!;
      expect(suffix.length).toBe(32);
      expect(/^[0-9a-f]{32}$/.test(suffix)).toBe(true);
    }
  });
});

// ============================================================================
// Spec #51 — auto-refresh
// ============================================================================

describe('auto-refresh (Spec #51)', () => {
  it('extends expires_at when token is within REFRESH_WINDOW', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    // Move expiry to 1h from now (well inside the 6h refresh window) and clear
    // last_used_at so the throttle does not block.
    sqlite.prepare(
      `UPDATE beast_tokens SET expires_at = datetime('now', '+1 hour'), last_used_at = NULL WHERE id = ?`
    ).run(created.id);
    const before = sqlite.prepare(`SELECT expires_at FROM beast_tokens WHERE id = ?`).get(created.id) as { expires_at: string };
    const result = validateToken(created.token);
    expect(result.valid).toBe(true);
    const after = sqlite.prepare(`SELECT expires_at FROM beast_tokens WHERE id = ?`).get(created.id) as { expires_at: string };
    expect(after.expires_at > before.expires_at).toBe(true);
  });

  it('does NOT refresh when outside REFRESH_WINDOW (still has >6h)', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    // Default TTL is 24h; that is well outside the 6h refresh window.
    // Force last_used_at older than throttle so the throttle is not the gate.
    sqlite.prepare(
      `UPDATE beast_tokens SET last_used_at = datetime('now', '-10 minutes') WHERE id = ?`
    ).run(created.id);
    const before = sqlite.prepare(`SELECT expires_at FROM beast_tokens WHERE id = ?`).get(created.id) as { expires_at: string };
    validateToken(created.token);
    const after = sqlite.prepare(`SELECT expires_at FROM beast_tokens WHERE id = ?`).get(created.id) as { expires_at: string };
    expect(after.expires_at).toBe(before.expires_at);
  });

  it('clamps refresh at max_lifetime_at boundary', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    // Set max_lifetime_at to 2 hours from now and expires_at to 1 hour.
    // Refresh should clamp the new expires_at at +2h, not +24h.
    sqlite.prepare(
      `UPDATE beast_tokens
         SET expires_at = datetime('now', '+1 hour'),
             max_lifetime_at = datetime('now', '+2 hours'),
             last_used_at = NULL
         WHERE id = ?`
    ).run(created.id);
    validateToken(created.token);
    const after = sqlite.prepare(
      `SELECT expires_at, max_lifetime_at FROM beast_tokens WHERE id = ?`
    ).get(created.id) as { expires_at: string; max_lifetime_at: string };
    expect(after.expires_at <= after.max_lifetime_at).toBe(true);
  });

  it('rejects with max_lifetime_reached when token is past MAX_LIFETIME', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    // Force expires_at and max_lifetime_at both in the past.
    // expires_at hits first (validateToken returns 'expired'); to verify the
    // max_lifetime branch we need expires_at in the future but max_lifetime in
    // the past. That's a state the system shouldn't reach naturally, but we
    // simulate it to verify the branch.
    sqlite.prepare(
      `UPDATE beast_tokens
         SET expires_at = datetime('now', '+1 hour'),
             max_lifetime_at = datetime('now', '-1 hour')
         WHERE id = ?`
    ).run(created.id);
    const result = validateToken(created.token);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('max_lifetime_reached');
  });
});

// ============================================================================
// Spec #52 — Beast-self rotation + chain-compromise
// ============================================================================

describe('selfRotateToken (Spec #52)', () => {
  it('issues new token, links old → new in rotation chain', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    const rotated = selfRotateToken(created.id, 'karo');
    expect('token' in rotated).toBe(true);
    if (!('token' in rotated)) return;
    expect(rotated.token).not.toBe(created.token);
    // Old row should have rotated_at + next_token_id set, NOT revoked.
    const oldRow = sqlite.prepare(
      `SELECT rotated_at, next_token_id, revoked_at FROM beast_tokens WHERE id = ?`
    ).get(created.id) as { rotated_at: string | null; next_token_id: number | null; revoked_at: string | null };
    expect(oldRow.rotated_at).toBeTruthy();
    expect(oldRow.next_token_id).toBe(rotated.id);
    expect(oldRow.revoked_at).toBeNull();
  });

  it('rejects rotate-window-expired (token older than 24h)', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    // Force created_at to 25h ago.
    sqlite.prepare(
      `UPDATE beast_tokens SET created_at = datetime('now', '-25 hours') WHERE id = ?`
    ).run(created.id);
    const result = selfRotateToken(created.id, 'karo');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.code).toBe('rotate_window_expired');
  });

  it('rejects rotation_locked when called twice on same token', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    const first = selfRotateToken(created.id, 'karo');
    expect('token' in first).toBe(true);
    const second = selfRotateToken(created.id, 'karo');
    expect('error' in second).toBe(true);
    if ('error' in second) expect(second.code).toBe('rotation_locked');
  });

  it('chain-compromise: replay of rotated-away token outside grace trips chain revoke', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    const rotated = selfRotateToken(created.id, 'karo');
    if (!('token' in rotated)) throw new Error('selfRotateToken failed');
    // Force rotated_at on old token to 30s ago (outside 10s grace).
    sqlite.prepare(
      `UPDATE beast_tokens SET rotated_at = datetime('now', '-30 seconds') WHERE id = ?`
    ).run(created.id);
    // Replay the OLD (rotated-away) token.
    const result = validateToken(created.token);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('chain_compromised');
    // The new token should also be revoked as part of the chain walk.
    const newRow = sqlite.prepare(
      `SELECT revoked_at FROM beast_tokens WHERE id = ?`
    ).get(rotated.id) as { revoked_at: string | null };
    expect(newRow.revoked_at).toBeTruthy();
  });

  it('chain-compromise: replay within ROTATION_GRACE_SECONDS is accepted', () => {
    const created = createToken('karo', 'gorn');
    if (!('token' in created)) throw new Error('createToken failed');
    const rotated = selfRotateToken(created.id, 'karo');
    if (!('token' in rotated)) throw new Error('selfRotateToken failed');
    // rotated_at was just set; should be inside the 10s grace window.
    const result = validateToken(created.token);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.rotationGrace).toBe(true);
    // No chain revoke in grace path.
    const newRow = sqlite.prepare(
      `SELECT revoked_at FROM beast_tokens WHERE id = ?`
    ).get(rotated.id) as { revoked_at: string | null };
    expect(newRow.revoked_at).toBeNull();
  });
});

describe('revokeBeastChain (Spec #52)', () => {
  it('revokes every active + rotated_away token for a beast', () => {
    const t1 = createToken('karo', 'gorn');
    if (!('token' in t1)) throw new Error('createToken failed');
    const t2 = selfRotateToken(t1.id, 'karo'); // chain link 1 → 2 (t1 rotated_away, t2 active)
    if (!('token' in t2)) throw new Error('selfRotateToken failed');
    const result = revokeBeastChain('karo', 'gorn');
    expect(result.revoked.length).toBe(2);
    const rows = sqlite.prepare(
      `SELECT id, revoked_at FROM beast_tokens WHERE beast = ?`
    ).all('karo') as Array<{ id: number; revoked_at: string | null }>;
    expect(rows.every(r => r.revoked_at !== null)).toBe(true);
  });
});

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
  revokeToken,
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
        expect(result.reason).toBe('no_matching_token');
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

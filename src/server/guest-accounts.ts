/**
 * Guest Account Management
 *
 * Database schema, CRUD operations, and auth helpers for guest accounts.
 * Spec #32, T#554.
 */

import type { Database } from 'bun:sqlite';

export interface GuestAccount {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_by: string;
  expires_at: string | null;
  disabled_at: string | null;
  locked_until: string | null;
  failed_attempts: number;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
}

export interface GuestAuditEntry {
  id: number;
  guest_id: number;
  endpoint: string;
  method: string;
  created_at: string;
}

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Reserved names that guests cannot use (Beast names + system names)
const RESERVED_NAMES = new Set([
  'gorn', 'leonard', 'zaghnal', 'karo', 'gnarl', 'bertus', 'dex', 'quill',
  'talon', 'flint', 'vigil', 'rax', 'sable', 'snap', 'pip', 'system',
  'admin', 'owner', 'beast', 'guest', 'unknown',
]);

/**
 * Initialize guest tables and migrations if they don't exist.
 */
export function initGuestTables(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS guest_accounts (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_by TEXT DEFAULT 'gorn',
      expires_at TEXT,
      disabled_at TEXT,
      locked_until TEXT,
      failed_attempts INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS guest_audit_log (
      id INTEGER PRIMARY KEY,
      guest_id INTEGER REFERENCES guest_accounts(id),
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add last_active_at column if not present
  try {
    sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN last_active_at TEXT");
  } catch {
    // Column already exists
  }

  // Add visibility column to forum_threads if not present (PR3)
  try {
    sqlite.exec("ALTER TABLE forum_threads ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal'");
  } catch {
    // Column already exists
  }
}

/**
 * Create a guest account.
 */
export async function createGuest(
  sqlite: Database,
  username: string,
  password: string,
  displayName?: string,
  expiresAt?: string,
): Promise<GuestAccount> {
  const lower = username.toLowerCase().trim();

  if (!lower || lower.length < 3) {
    throw new Error('Username must be at least 3 characters');
  }
  if (!/^[a-z0-9_-]+$/.test(lower)) {
    throw new Error('Username must contain only lowercase letters, numbers, hyphens, and underscores');
  }
  if (RESERVED_NAMES.has(lower)) {
    throw new Error(`Username "${lower}" is reserved`);
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 });

  const result = sqlite.prepare(`
    INSERT INTO guest_accounts (username, password_hash, display_name, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(lower, hash, displayName || lower, expiresAt || null);

  return sqlite.prepare('SELECT * FROM guest_accounts WHERE id = ?').get(result.lastInsertRowid) as GuestAccount;
}

/**
 * List all guest accounts (no password hashes returned).
 */
export function listGuests(sqlite: Database): Omit<GuestAccount, 'password_hash'>[] {
  const guests = sqlite.prepare('SELECT * FROM guest_accounts ORDER BY created_at DESC').all() as GuestAccount[];
  return guests.map(({ password_hash, ...rest }) => rest);
}

/**
 * Get a guest by ID.
 */
export function getGuest(sqlite: Database, id: number): GuestAccount | null {
  return sqlite.prepare('SELECT * FROM guest_accounts WHERE id = ?').get(id) as GuestAccount | null;
}

/**
 * Get a guest by username.
 */
export function getGuestByUsername(sqlite: Database, username: string): GuestAccount | null {
  return sqlite.prepare('SELECT * FROM guest_accounts WHERE username = ?').get(username.toLowerCase().trim()) as GuestAccount | null;
}

/**
 * Update a guest account.
 */
export function updateGuest(
  sqlite: Database,
  id: number,
  updates: { display_name?: string; expires_at?: string | null; disabled_at?: string | null },
): GuestAccount | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.expires_at !== undefined) {
    fields.push('expires_at = ?');
    values.push(updates.expires_at);
  }
  if (updates.disabled_at !== undefined) {
    fields.push('disabled_at = ?');
    values.push(updates.disabled_at);
  }

  if (fields.length === 0) return getGuest(sqlite, id);

  values.push(id);
  sqlite.prepare(`UPDATE guest_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getGuest(sqlite, id);
}

/**
 * Delete a guest account.
 */
export function deleteGuest(sqlite: Database, id: number): boolean {
  const result = sqlite.prepare('DELETE FROM guest_accounts WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Check if a guest account is active (not expired, not disabled, not locked).
 */
export function isGuestActive(guest: GuestAccount): { active: boolean; reason?: string } {
  if (guest.disabled_at) {
    return { active: false, reason: 'Account has been disabled' };
  }
  if (guest.expires_at) {
    const expiry = new Date(guest.expires_at).getTime();
    if (Date.now() > expiry) {
      return { active: false, reason: 'Account has expired' };
    }
  }
  if (guest.locked_until) {
    const lockEnd = new Date(guest.locked_until).getTime();
    if (Date.now() < lockEnd) {
      const minutesLeft = Math.ceil((lockEnd - Date.now()) / 60000);
      return { active: false, reason: `Account locked. Try again in ${minutesLeft} minutes` };
    }
  }
  return { active: true };
}

/**
 * Record a failed login attempt. Lock account after threshold.
 */
export function recordFailedAttempt(sqlite: Database, guest: GuestAccount): void {
  const newCount = guest.failed_attempts + 1;
  if (newCount >= LOCKOUT_THRESHOLD) {
    const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
    sqlite.prepare('UPDATE guest_accounts SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(newCount, lockUntil, guest.id);
  } else {
    sqlite.prepare('UPDATE guest_accounts SET failed_attempts = ? WHERE id = ?')
      .run(newCount, guest.id);
  }
}

/**
 * Record a successful login.
 */
export function recordSuccessfulLogin(sqlite: Database, guestId: number): void {
  sqlite.prepare('UPDATE guest_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime(\'now\') WHERE id = ?')
    .run(guestId);
}

/**
 * Log a guest API action to the audit log.
 */
export function logGuestAction(sqlite: Database, guestId: number, endpoint: string, method: string): void {
  sqlite.prepare('INSERT INTO guest_audit_log (guest_id, endpoint, method) VALUES (?, ?, ?)')
    .run(guestId, endpoint, method);
  sqlite.prepare('UPDATE guest_accounts SET last_active_at = datetime(\'now\') WHERE id = ?')
    .run(guestId);
}

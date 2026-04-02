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
  bio: string | null;
  interests: string | null;
  avatar_url: string | null;
  created_by: string;
  expires_at: string | null;
  disabled_at: string | null;
  banned_at: string | null;
  banned_by: string | null;
  ban_reason: string | null;
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
      banned_at TEXT,
      banned_by TEXT,
      ban_reason TEXT,
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

  // Add profile fields for guest settings (T#574, Spec #35)
  try { sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN bio TEXT"); } catch { /* exists */ }
  try { sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN interests TEXT"); } catch { /* exists */ }
  try { sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN avatar_url TEXT"); } catch { /* exists */ }

  // Add ban fields (T#616, Spec #36)
  try { sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN banned_at TEXT"); } catch { /* exists */ }
  try { sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN banned_by TEXT"); } catch { /* exists */ }
  try { sqlite.exec("ALTER TABLE guest_accounts ADD COLUMN ban_reason TEXT"); } catch { /* exists */ }
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
 * Ban a guest account (T#616).
 */
export function banGuest(
  sqlite: Database,
  id: number,
  bannedBy: string,
  reason: string,
): GuestAccount | null {
  const now = new Date().toISOString();
  sqlite.prepare(
    `UPDATE guest_accounts SET banned_at = ?, banned_by = ?, ban_reason = ?, disabled_at = COALESCE(disabled_at, ?) WHERE id = ?`
  ).run(now, bannedBy, reason, now, id);
  return getGuest(sqlite, id);
}

/**
 * Unban a guest account (T#616).
 */
export function unbanGuest(sqlite: Database, id: number): GuestAccount | null {
  sqlite.prepare(
    `UPDATE guest_accounts SET banned_at = NULL, banned_by = NULL, ban_reason = NULL WHERE id = ?`
  ).run(id);
  return getGuest(sqlite, id);
}

/**
 * Check if a guest account is active (not expired, not disabled, not locked).
 */
export function isGuestActive(guest: GuestAccount): { active: boolean; reason?: string } {
  if (guest.banned_at) {
    return { active: false, reason: 'Account has been banned' };
  }
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
 * Update a guest's profile (self-service, T#574).
 */
export function updateGuestProfile(
  sqlite: Database,
  id: number,
  updates: { display_name?: string; bio?: string; interests?: string; avatar_url?: string },
): GuestAccount | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.bio !== undefined) {
    fields.push('bio = ?');
    values.push(updates.bio);
  }
  if (updates.interests !== undefined) {
    fields.push('interests = ?');
    values.push(updates.interests);
  }
  if (updates.avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatar_url);
  }

  if (fields.length === 0) return getGuest(sqlite, id);

  values.push(id);
  sqlite.prepare(`UPDATE guest_accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getGuest(sqlite, id);
}

/**
 * Reset a guest's password (by ID, owner action).
 */
export async function resetGuestPassword(sqlite: Database, id: number, newPassword: string): Promise<boolean> {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const hash = await Bun.password.hash(newPassword, { algorithm: 'bcrypt', cost: 12 });
  const result = sqlite.prepare('UPDATE guest_accounts SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hash, id);
  return result.changes > 0;
}

/**
 * Change a guest's password (self-service, requires current password).
 */
export async function changeGuestPassword(
  sqlite: Database,
  guest: GuestAccount,
  currentPassword: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const valid = await Bun.password.verify(currentPassword, guest.password_hash);
  if (!valid) {
    return { success: false, error: 'Current password is incorrect' };
  }
  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: 'New password must be at least 8 characters' };
  }
  const hash = await Bun.password.hash(newPassword, { algorithm: 'bcrypt', cost: 12 });
  sqlite.prepare('UPDATE guest_accounts SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hash, guest.id);
  return { success: true };
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

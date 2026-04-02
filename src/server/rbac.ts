/**
 * RBAC (Role-Based Access Control) Middleware
 *
 * Three roles: owner, beast, guest
 * Default-deny for guests — only allowlisted endpoints are accessible.
 * Spec #32, T#553.
 */

import type { Context, Next } from 'hono';

export type Role = 'owner' | 'beast' | 'guest';

/**
 * Guest allowlist — endpoints accessible to guests.
 * Everything else returns 403 for guest role.
 * Based on Talon's endpoint audit (thread #420, msg #5759).
 */
interface AllowlistEntry {
  method: string;       // HTTP method or '*' for any
  pattern: RegExp;      // URL path pattern
}

const GUEST_ALLOWLIST: AllowlistEntry[] = [
  // All /api/guest/* endpoints — the dedicated guest API surface (T#559)
  { method: '*', pattern: /^\/api\/guest\// },

  // Auth (login, logout, status — shared by all roles)
  { method: 'GET', pattern: /^\/api\/auth\/status$/ },
  { method: 'POST', pattern: /^\/api\/auth\/login$/ },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/ },

  // Infrastructure
  { method: 'GET', pattern: /^\/api\/health$/ },
  { method: 'GET', pattern: /^\/api\/help$/ },

  // Public read-only data (used by guest-accessible components)
  { method: 'GET', pattern: /^\/api\/reactions\/supported$/ },

  // Reactions — guests can react to messages
  { method: 'POST', pattern: /^\/api\/message\/\d+\/react$/ },
  { method: 'DELETE', pattern: /^\/api\/message\/\d+\/react$/ },
  { method: 'GET', pattern: /^\/api\/message\/\d+\/reactions$/ },

  // File uploads and downloads — guests can attach and view files
  { method: 'POST', pattern: /^\/api\/upload$/ },
  { method: 'GET', pattern: /^\/api\/f\/[\w.-]+$/ },

  // Library — guests can read public shelves and their entries (T#623)
  { method: 'GET', pattern: /^\/api\/library$/ },
  { method: 'GET', pattern: /^\/api\/library\/shelves$/ },
  { method: 'GET', pattern: /^\/api\/library\/shelves\/\d+$/ },
  { method: 'GET', pattern: /^\/api\/library\/search$/ },
  { method: 'GET', pattern: /^\/api\/library\/types$/ },
  { method: 'GET', pattern: /^\/api\/library\/\d+$/ },
];

/**
 * Check if a request is allowed for a guest.
 */
function isGuestAllowed(method: string, path: string): boolean {
  return GUEST_ALLOWLIST.some(entry =>
    (entry.method === '*' || entry.method === method) && entry.pattern.test(path)
  );
}

/**
 * RBAC authorization middleware.
 * Must be inserted AFTER auth middleware (which resolves identity).
 *
 * Reads the role from context (set by auth middleware).
 * Owner and beast roles have full access.
 * Guest role is checked against the allowlist.
 */
export function rbacMiddleware() {
  return async (c: Context, next: Next) => {
    const role = (c.get as any)('role') as Role | undefined;

    // No role set = either unauthenticated (auth middleware already returned 401)
    // or a public path that skipped auth. Safe to pass through.
    if (!role) return next();

    // Owner and beast have full access
    if (role === 'owner' || role === 'beast') return next();

    // Guest role — check allowlist
    if (role === 'guest') {
      const method = c.req.method;
      const path = c.req.path;

      if (!isGuestAllowed(method, path)) {
        return c.json({ error: 'Forbidden', message: 'Guests do not have access to this resource' }, 403);
      }
    }

    return next();
  };
}

/**
 * Get the allowlist for testing/introspection.
 */
export function getGuestAllowlist(): { method: string; pattern: string }[] {
  return GUEST_ALLOWLIST.map(e => ({ method: e.method, pattern: e.pattern.source }));
}

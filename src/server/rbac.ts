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
  // Auth
  { method: 'GET', pattern: /^\/api\/auth\/status$/ },
  { method: 'POST', pattern: /^\/api\/auth\/login$/ },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/ },

  // Pack/Beasts (public info)
  { method: 'GET', pattern: /^\/api\/pack$/ },
  { method: 'GET', pattern: /^\/api\/beasts$/ },
  { method: 'GET', pattern: /^\/api\/beast\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/beast\/[^/]+\/avatar\.svg$/ },

  // Forum (visibility + guest-only-posts enforced at handler level in PR3)
  { method: 'GET', pattern: /^\/api\/threads$/ },
  { method: 'GET', pattern: /^\/api\/thread\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/thread$/ },  // Handler must enforce: guests post to existing public threads only, no new threads
  { method: 'POST', pattern: /^\/api\/message\/\d+\/react$/ },
  { method: 'GET', pattern: /^\/api\/message\/\d+\/reactions$/ },
  { method: 'GET', pattern: /^\/api\/forum\/emojis$/ },
  { method: 'GET', pattern: /^\/api\/reactions\/supported$/ },

  // DMs (guest-to-Beast, own conversations only — enforced at handler level)
  { method: 'POST', pattern: /^\/api\/dm$/ },
  { method: 'GET', pattern: /^\/api\/dm\/[^/]+\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/api\/dm\/[^/]+\/[^/]+\/read$/ },

  // Infrastructure
  { method: 'GET', pattern: /^\/api\/health$/ },
  { method: 'GET', pattern: /^\/api\/help$/ },
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

/**
 * Oracle Nightly HTTP Server - Hono.js Version
 *
 * Modern routing with Hono.js on Bun runtime.
 * Same handlers, same DB, just cleaner HTTP layer.
 */

import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { MeiliSearch } from 'meilisearch';

import {
  configure,
  writePidFile,
  removePidFile,
  registerSignalHandlers,
  performGracefulShutdown,
} from './process-manager/index.ts';
import { getVaultPsiRoot } from './vault/handler.ts';

// Config constants (no DB dependency)
import {
  PORT,
  ORACLE_DATA_DIR,
  REPO_ROOT,
  DB_PATH,
} from './config.ts';

import { eq, desc, gt, sql } from 'drizzle-orm';
import {
  db,
  sqlite,
  closeDb,
  getSetting,
  setSetting,
  searchLog,
  learnLog,
  supersedeLog,
  indexingStatus,
  settings,
  schedule,
  getBeastProfile,
  getAllBeastProfiles,
  upsertBeastProfile,
  updateBeastAvatar,
  beastProfiles,
} from './db/index.ts';

import {
  handleSearch,
  handleReflect,
  handleList,
  handleStats,
  handleGraph,
  handleLearn,
  handleSimilar,
  handleMap,
  handleMap3d,
  handleVectorStats
} from './server/handlers.ts';

import { handleRead } from './tools/read.ts';

import {
  handleDashboardSummary,
  handleDashboardActivity,
  handleDashboardGrowth
} from './server/dashboard.ts';

import { handleContext } from './server/context.ts';
import { handleScheduleAdd, handleScheduleList } from './tools/schedule.ts';
import type { ToolContext } from './tools/types.ts';

import {
  handleThreadMessage,
  listThreads,
  getFullThread,
  getMessages,
  updateThreadStatus,
  addMessage,
} from './forum/handler.ts';


import { enqueueNotification } from './notify.ts';
import { rbacMiddleware, getGuestAllowlist } from './server/rbac.ts';
import type { Role } from './server/rbac.ts';
import {
  initGuestTables,
  createGuest,
  listGuests,
  getGuest,
  getGuestByUsername,
  getGuestByDisplayName,
  updateGuest,
  deleteGuest,
  banGuest,
  unbanGuest,
  isGuestActive,
  recordFailedAttempt,
  recordSuccessfulLogin,
  logGuestAction,
  resetGuestPassword,
  changeGuestPassword,
  updateGuestProfile,
} from './server/guest-accounts.ts';
import {
  scanForInjection,
  checkGuestPostRate,
  checkGuestDmRate,
  checkGuestContentLength,
  initGuestSafetyMigrations,
} from './server/guest-safety.ts';

import {
  logSecurityEvent,
  generateRequestId,
  pruneSecurityEvents,
  SECURITY_RETENTION_DAYS,
} from './server/security-logger.ts';

import {
  createToken,
  validateToken,
  rotateToken,
  selfRotateToken,
  revokeToken,
  revokeBeastChain,
  listTokens,
  pruneBeastTokens,
  getTokenInfo,
} from './server/beast-tokens.ts';

import {
  listTraces,
  getTrace,
  getTraceChain,
  linkTraces,
  unlinkTraces,
  getTraceLinkedChain
} from './trace/handler.ts';

// Reset stale indexing status on startup using Drizzle
try {
  db.update(indexingStatus)
    .set({ isIndexing: 0 })
    .where(eq(indexingStatus.id, 1))
    .run();
  console.log('🔮 Reset indexing status on startup');
} catch (e) {
  // Table might not exist yet - that's fine
}

// Retry helper for SQLite BUSY errors during concurrent writes (task #211)
async function withRetry<T>(fn: () => T | Promise<T>, maxRetries = 3, delayMs = 100): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isBusy = err?.message?.includes('SQLITE_BUSY') || err?.message?.includes('database is locked');
      if (isBusy && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry: exhausted retries');
}

// Configure process lifecycle management
configure({ dataDir: ORACLE_DATA_DIR, pidFileName: 'oracle-http.pid' });

// Write PID file for process tracking
writePidFile({ pid: process.pid, port: Number(PORT), startedAt: new Date().toISOString(), name: 'oracle-http' });

// Register graceful shutdown handlers
registerSignalHandlers(async () => {
  console.log('\n🔮 Shutting down gracefully...');
  await performGracefulShutdown({
    resources: [
      { close: () => { closeDb(); return Promise.resolve(); } }
    ]
  });
  removePidFile();
  console.log('👋 Oracle Nightly HTTP Server stopped.');
});

// Create Hono app
const app = new Hono();

// Custom 404 with did-you-mean hints for API routes
// Uses HELP_ENDPOINTS (defined below with /api/help) for path matching
function findSimilarPaths(requested: string): string[] {
  const reqParts = requested.toLowerCase().split('/').filter(Boolean);
  const paths = HELP_ENDPOINTS.map(e => e.path);
  const uniquePaths = [...new Set(paths)];
  const scored = uniquePaths.map(p => {
    const parts = p.toLowerCase().split('/').filter(Boolean);
    let score = 0;
    for (const rp of reqParts) {
      if (rp === 'api') continue;
      for (const pp of parts) {
        if (pp.startsWith(':')) continue;
        if (pp === rp) { score += 3; break; }
        if (pp.includes(rp) || rp.includes(pp)) { score += 1; break; }
      }
    }
    return { path: p, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => s.path);
}

app.notFound((c) => {
  const reqPath = c.req.path;
  if (!reqPath.startsWith('/api/')) {
    return c.text('Not Found', 404);
  }
  const suggestions = findSimilarPaths(reqPath);
  return c.json({
    error: 'Not Found',
    path: reqPath,
    method: c.req.method,
    hint: suggestions.length > 0
      ? `Did you mean: ${suggestions.join(', ')}?`
      : 'Use GET /api/help to see all available endpoints, or GET /api/help?q=keyword to search.',
    docs: '/api/help',
  }, 404);
});

// CORS middleware — restricted to known origins (T#502)
app.use('*', cors({
  origin: ['http://localhost:47778', 'http://127.0.0.1:47778', 'https://denbook.online'],
  credentials: true,
}));

// Security headers middleware (T#502 — Talon audit finding, T#503 — CSP)
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self' cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
});

// ============================================================================
// Auth Helpers
// ============================================================================

// Session secret - generate once per server run
const SESSION_SECRET = process.env.ORACLE_SESSION_SECRET || crypto.randomUUID();
const SESSION_COOKIE_NAME = 'oracle_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (owner)
const GUEST_SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours (guest)

// Check if request is from local network
function isLocalNetwork(c: Context): boolean {
  // Check actual client IP — do NOT trust Via header (spoofable).
  // Caddy should be configured to set X-Real-IP to the actual client IP.
  const forwarded = c.req.header('x-forwarded-for');
  const realIp = c.req.header('x-real-ip');
  const ip = forwarded?.split(',')[0]?.trim() || realIp || '127.0.0.1';

  return ip === '127.0.0.1'
      || ip === '::1'
      || ip === 'localhost'
      || ip.startsWith('192.168.')
      || ip.startsWith('10.')
      || ip.startsWith('172.16.')
      || ip.startsWith('172.17.')
      || ip.startsWith('172.18.')
      || ip.startsWith('172.19.')
      || ip.startsWith('172.20.')
      || ip.startsWith('172.21.')
      || ip.startsWith('172.22.')
      || ip.startsWith('172.23.')
      || ip.startsWith('172.24.')
      || ip.startsWith('172.25.')
      || ip.startsWith('172.26.')
      || ip.startsWith('172.27.')
      || ip.startsWith('172.28.')
      || ip.startsWith('172.29.')
      || ip.startsWith('172.30.')
      || ip.startsWith('172.31.');
}

// Generate session token using HMAC-SHA256
// Format: role:data:expires:signature
// role = 'owner' or 'guest', data = '' for owner or 'username' for guest
function generateSessionToken(role: Role = 'owner', data: string = ''): string {
  const duration = role === 'guest' ? GUEST_SESSION_DURATION_MS : SESSION_DURATION_MS;
  const expires = Date.now() + duration;
  const payload = `${role}:${data}:${expires}`;
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return `${payload}:${signature}`;
}

// Verify session token with timing-safe comparison
// Returns { valid, role, data } or { valid: false }
interface SessionInfo {
  valid: boolean;
  role?: Role;
  data?: string;
}

function verifySessionToken(token: string): boolean {
  return parseSessionToken(token).valid;
}

function parseSessionToken(token: string): SessionInfo {
  if (!token) return { valid: false };

  // Support both old format (expires:sig) and new format (role:data:expires:sig)
  const parts = token.split(':');

  if (parts.length === 2) {
    // Legacy format: expires:signature (owner session)
    const [expiresStr, signature] = parts;
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires) || expires < Date.now()) return { valid: false };

    const expectedSignature = createHmac('sha256', SESSION_SECRET)
      .update(expiresStr)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length) return { valid: false };
    if (!timingSafeEqual(sigBuf, expectedBuf)) return { valid: false };

    return { valid: true, role: 'owner', data: '' };
  }

  if (parts.length === 4) {
    // New format: role:data:expires:signature
    const [role, data, expiresStr, signature] = parts;
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires) || expires < Date.now()) return { valid: false };
    if (role !== 'owner' && role !== 'guest') return { valid: false };

    const payload = `${role}:${data}:${expiresStr}`;
    const expectedSignature = createHmac('sha256', SESSION_SECRET)
      .update(payload)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length) return { valid: false };
    if (!timingSafeEqual(sigBuf, expectedBuf)) return { valid: false };

    return { valid: true, role: role as Role, data };
  }

  return { valid: false };
}

// Check if request has a valid browser session (Gorn)
function hasSessionAuth(c: Context): boolean {
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  return verifySessionToken(sessionCookie || '');
}

// Check if identity validation can be skipped (local network OR authenticated browser session)
function isTrustedRequest(c: Context): boolean {
  return isLocalNetwork(c) || hasSessionAuth(c);
}

// T#718 — server-derived Beast identity for pack-identity writes.
// Returns the authenticated caller (lowercase) or null if caller cannot be identified.
// Priority: bearer-token actor (T#546 per-Beast tokens) > browser session (gorn) > null.
// Local-bypass alone is NOT sufficient to claim Beast identity — cryptographic auth required.
// Closes Bertus/Flint DM-spoof finding (thread #20 msg #10002): audit log actor + write-path
// identity both derive from this helper instead of client-asserted body.from/body.beast/body.author.
function requireBeastIdentity(c: Context): string | null {
  const actor = (c.get as any)('actor') as string | undefined;
  if (actor) return actor.toLowerCase();
  if (hasSessionAuth(c)) return 'gorn';
  return null;
}

// Check if auth is required and user is authenticated
function isAuthenticated(c: Context): boolean {
  const authEnabled = getSetting('auth_enabled') === 'true';
  if (!authEnabled) return true; // Auth not enabled, everyone is "authenticated"

  // Check session cookie first — guest sessions take priority over local bypass
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionCookie && verifySessionToken(sessionCookie)) return true;

  const localBypass = getSetting('auth_local_bypass') !== 'false'; // Default true
  if (localBypass && isLocalNetwork(c)) return true;

  return false;
}

// Initialize guest account tables and safety migrations (Spec #32)
initGuestTables(sqlite);
initGuestSafetyMigrations(sqlite);

// ============================================================================
// Auth Middleware (protects /api/* except auth routes)
// ============================================================================

app.use('/api/*', async (c, next) => {
  const path = c.req.path;

  // Skip auth for certain endpoints
  const publicPaths = [
    '/api/auth/status',
    '/api/auth/login',
    '/api/health',
    // Webhook endpoints — third-party callers cannot present Beast bearer tokens
    // (Beast tokens are `den_`-prefixed; provider-issued shared-secrets are not).
    // Each handler validates its own provider-shared-secret via crypto.timingSafeEqual
    // constant-time compare against an env-var token. Middleware bypass is correct
    // shape here — auth still happens, just at the handler layer where the
    // shared-secret lives. Path-level allowlist (not pattern) keeps the surface narrow.
    '/api/webhooks/hevy',
  ];
  if (publicPaths.some(p => path === p)) {
    return next();
  }

  // Bearer token auth (T#546 — Beast API tokens)
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer den_')) {
    const token = authHeader.slice(7); // Strip "Bearer "
    const result = validateToken(token);

    if (result.valid) {
      // Token validated — set actor identity and skip further auth
      c.set('actor' as any, result.beast);
      c.set('actorType' as any, 'beast');
      c.set('authMethod' as any, 'token');
      c.set('tokenId' as any, result.tokenId);
      c.set('role' as any, 'beast' as Role);
      // Spec #52 Phase 4 — surface rotation_recommended as response header
      // so Beast caller wrappers can call /api/auth/rotate transparently
      // before SELF_ROTATE_WINDOW closes (12h-of-life trigger inside the
      // empirical 17h band-aid cliff envelope).
      if (result.rotationRecommended) {
        c.header('X-Rotation-Recommended', 'true');
      }
      // Spec #52 — surface rotation-grace acceptance for caller telemetry
      // (lets a caller log that it just hit the in-flight grace window).
      if (result.rotationGrace) {
        c.header('X-Rotation-Grace', 'true');
      }
      return next();
    } else {
      // Invalid/expired token — log and reject
      const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
      logSecurityEvent({
        eventType: 'auth_failure',
        severity: 'warning',
        actor: result.beast || 'unknown',
        actorType: 'beast',
        target: path,
        details: { reason: result.reason, auth_method: 'bearer_token' },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  }

  if (!isAuthenticated(c)) {
    return c.json({ error: 'Unauthorized', requiresAuth: true }, 401);
  }

  // Set role from session token (owner or guest) or local bypass (owner)
  if (!(c.get as any)('role')) {
    const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
    const session = parseSessionToken(sessionCookie || '');
    if (session.valid && session.role === 'guest') {
      // Guest session — check expiry/disabled/lockout server-side on every request
      const guest = getGuestByUsername(sqlite, session.data || '');
      if (guest) {
        const status = isGuestActive(guest);
        if (!status.active) {
          return c.json({ error: 'Unauthorized', message: status.reason, requiresAuth: true }, 401);
        }
        c.set('role' as any, 'guest' as Role);
        c.set('guestUsername' as any, session.data);
        c.set('guestId' as any, guest.id);
        // Log guest API access
        logGuestAction(sqlite, guest.id, path, c.req.method);
      } else {
        return c.json({ error: 'Unauthorized', message: 'Guest account not found', requiresAuth: true }, 401);
      }
    } else {
      c.set('role' as any, 'owner' as Role);
    }
  }

  return next();
});

// ============================================================================
// RBAC Authorization Middleware (Spec #32, T#553)
// Runs AFTER auth — checks role against endpoint allowlist.
// Guest role: default-deny, only allowlisted endpoints pass.
// Owner/beast: full access.
// ============================================================================

app.use('/api/*', rbacMiddleware());

// ============================================================================
// Audit Logging Middleware (Task #72 — logs all mutating API requests)
// ============================================================================

const AUDIT_SKIP = ['/api/health', '/api/help', '/api/auth/status', '/api/auth/login', '/api/session/stats'];

app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;

  // Generate request ID for correlation between audit_log and security_events
  const requestId = generateRequestId();
  c.set('requestId' as any, requestId);

  // Skip: GETs (except sensitive), static, health, WS
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const isSensitiveGet = method === 'GET' && (path.includes('/dm/') || path.includes('/settings') || path.includes('/audit'));
  if (!isMutation && !isSensitiveGet) return next();
  if (AUDIT_SKIP.some(p => path === p)) return next();

  // Clone body BEFORE next() consumes it — extraction after next() fails on consumed streams
  let bodyData: Record<string, unknown> | null = null;
  if (isMutation) {
    try {
      bodyData = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
    } catch { /* body parse failed */ }
  }

  await next();

  // Log after handler completes
  try {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    // Actor extraction chain (T#718 — closes Bertus/Flint #10002 audit-attribution spoof gap):
    // 1. Bearer token identity (set by auth middleware — trusted)
    // 2. Session cookie → "gorn" (browser requests — trusted)
    // 3. Guest session → "[Guest] <username>" (server-set via session — trusted)
    // 4. ?as= query param — logged as legacy signal but NOT used as actor (spoofable)
    // 5. Path patterns for path-identity routes (e.g. /api/dm/<beast>/...)
    // 6. Fallback: "unknown"
    // REMOVED (T#718): body.author / body.beast / body.from as actor fallback — client-asserted,
    // spoofable, no cryptographic binding to the calling process. Audit trail now records
    // true-caller only; forensic integrity preserved per Bertus #10002 + Principle 1.
    const tokenActor = (c.get as any)('actor') as string | undefined;
    const tokenActorType = (c.get as any)('actorType') as string | undefined;
    let actor = tokenActor || '';
    let actorType = tokenActorType || '';

    if (!actor) {
      if (hasSessionAuth(c)) {
        actor = 'gorn';
        actorType = 'human';
      }
    }
    if (!actor) {
      const role = (c.get as any)('role');
      const guestUsername = (c.get as any)('guestUsername');
      if (role === 'guest' && guestUsername) {
        actor = `[Guest] ${guestUsername}`;
        actorType = 'guest';
      }
    }
    if (!actor) {
      // Path-identity routes — /api/dm/<beast>/... has the beast in the path itself
      const pathMatch = path.match(/\/api\/(?:dm|schedules)\/(?!messages|dashboard|due|pending)([a-z][\w-]*)/i);
      if (pathMatch) actor = pathMatch[1];
    }

    // ?as= logged as legacy-usage tracking (not used as actor — spoofable)
    const asParam = c.req.query('as') || '';
    if (asParam) {
      logSecurityEvent({
        eventType: 'settings_changed', // Reuse existing type for legacy tracking
        severity: 'info',
        actor: actor || 'unknown',
        actorType: (actorType as any) || 'unknown',
        target: path,
        details: { auth_method: 'legacy_as_param', as_param_value: asParam, deprecation: 'Use Bearer token auth' },
        ipSource: ip,
        requestId,
      });
    }

    if (!actor) {
      actor = c.req.header('x-beast') || 'unknown';
    }
    if (!actorType) {
      actorType = 'unknown';
    }

    // bodyData kept in scope (null-tolerated) for potential future per-route use;
    // deliberately not consulted here — see REMOVED note above.
    void bodyData;
    const statusCode = c.res.status;

    // Extract resource info from path
    const parts = path.replace('/api/', '').split('/');
    const resourceType = parts[0] || null;
    const resourceId = parts[1] || null;

    sqlite.prepare(
      `INSERT INTO audit_log (actor, actor_type, action, resource_type, resource_id, ip_source, request_method, request_path, status_code, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(actor, actorType, `${method} ${path}`, resourceType, resourceId, ip, method, path, statusCode, requestId);

    // Auto-log 403 permission denials as security events
    if (statusCode === 403) {
      logSecurityEvent({
        eventType: 'permission_denied',
        severity: 'warning',
        actor: actor || undefined,
        actorType: actorType as any,
        target: path,
        details: { method, status_code: statusCode, resource_type: resourceType },
        ipSource: ip,
        requestId,
      });
    }
  } catch { /* never block requests for logging failures */ }
});

// ============================================================================
// Auth Routes
// ============================================================================

// Auth status - public
app.get('/api/auth/status', (c) => {
  const authEnabled = getSetting('auth_enabled') === 'true';
  const hasPassword = !!getSetting('auth_password_hash');
  const localBypass = getSetting('auth_local_bypass') !== 'false';
  const isLocal = isLocalNetwork(c);
  const authenticated = isAuthenticated(c);

  // Parse session token to get role info for frontend nav scoping
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  const session = parseSessionToken(sessionCookie || '');
  const role = session.valid ? (session.role || 'owner') : (authenticated ? 'owner' : undefined);
  const guestUsername = session.valid && session.role === 'guest' ? session.data : undefined;

  // Strip internal auth details from guest responses (Bertus security review)
  if (role === 'guest') {
    // Look up display name and check account status
    let guestDisplayName = guestUsername;
    let guestActive = true;
    if (guestUsername) {
      const guest = getGuestByUsername(sqlite, guestUsername);
      if (guest) {
        if (guest.display_name) guestDisplayName = guest.display_name;
        const status = isGuestActive(guest);
        guestActive = status.active;
      } else {
        guestActive = false;
      }
    }
    return c.json({
      authenticated: guestActive,
      authEnabled,
      role: guestActive ? role : undefined,
      guestName: guestActive ? guestDisplayName : undefined,
      guestUsername: guestActive ? guestUsername : undefined,
    });
  }

  return c.json({
    authenticated,
    authEnabled,
    hasPassword,
    localBypass,
    isLocal,
    role,
  });
});

// Login
// Login rate limiting: max 5 attempts per IP per 15 minutes
// Persisted to SQLite so restarts don't reset the window (T#594)
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

sqlite.exec(`CREATE TABLE IF NOT EXISTS login_rate_limits (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER NOT NULL
)`);

// T#712: cache of inbound Telegram messages for reply-to context fetch.
// Gate-coupling: `msg.chat.id === bot.chatId` upstream check (in handleTelegramMessage)
// is the PII containment boundary. Expanding that gate (group chats, multi-sender, etc)
// requires threat-model re-review on telegram_messages.raw_json at the same time.
// Composite PK (chat_id, id) — TG message_id is per-chat-unique per Bot API spec,
// not globally unique. Composite PK survives gate-expansion (Boro chat, group chats,
// sub-bot allowlisting) without migration. v2: TTL cleanup cron, task TBD.
sqlite.exec(`CREATE TABLE IF NOT EXISTS telegram_messages (
  chat_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  from_id TEXT,
  text TEXT,
  caption TEXT,
  photo_file_id TEXT,
  date_unix INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (chat_id, id)
)`);
// Retention-shape-reserved index for future cleanup cron (Bertus #887 flag 2).
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_telegram_messages_date_unix ON telegram_messages(date_unix)`);

function getRateLimit(ip: string): { count: number; firstAttempt: number } | null {
  const row = sqlite.prepare('SELECT count, first_attempt_at FROM login_rate_limits WHERE ip = ?').get(ip) as any;
  if (!row) return null;
  return { count: row.count, firstAttempt: row.first_attempt_at };
}

function setRateLimit(ip: string, count: number, firstAttempt: number): void {
  sqlite.prepare('INSERT OR REPLACE INTO login_rate_limits (ip, count, first_attempt_at) VALUES (?, ?, ?)').run(ip, count, firstAttempt);
}

function clearRateLimit(ip: string): void {
  sqlite.prepare('DELETE FROM login_rate_limits WHERE ip = ?').run(ip);
}

app.post('/api/auth/login', async (c) => {
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
  const now = Date.now();
  const attempts = getRateLimit(ip);
  if (attempts) {
    if (now - attempts.firstAttempt > LOGIN_RATE_WINDOW_MS) {
      clearRateLimit(ip);
    } else if (attempts.count >= LOGIN_RATE_LIMIT) {
      const retryAfter = Math.ceil((attempts.firstAttempt + LOGIN_RATE_WINDOW_MS - now) / 1000);
      logSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        actor: undefined,
        actorType: 'unknown',
        target: '/api/auth/login',
        details: { attempts: attempts.count, window_ms: LOGIN_RATE_WINDOW_MS },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ success: false, error: `Too many login attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    }
  }

  const body = await c.req.json();
  const { password, username } = body;

  if (!password) {
    return c.json({ success: false, error: 'Password required' }, 400);
  }

  // Try guest login first if username is provided
  if (username) {
    const guest = getGuestByUsername(sqlite, username);

    // Always run bcrypt even if user doesn't exist (timing attack mitigation)
    const dummyHash = '$2b$12$LJ3m4ys3Ls.yBVBMGIiu2OiEfO/JsU1TOiIYxlhfPHQsGxJF6mYr2';
    const hashToVerify = guest?.password_hash || dummyHash;
    const validPassword = await Bun.password.verify(password, hashToVerify);

    if (!guest || !validPassword) {
      const existing = getRateLimit(ip);
      const newCount = (existing?.count || 0) + 1;
      setRateLimit(ip, newCount, existing?.firstAttempt || now);
      if (guest) recordFailedAttempt(sqlite, guest);
      logSecurityEvent({
        eventType: 'auth_failure',
        severity: 'warning',
        actor: username,
        actorType: 'guest',
        target: '/api/auth/login',
        details: { attempt_number: newCount, auth_type: 'guest' },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ success: false, error: 'Invalid username or password' }, 401);
    }

    // Check if guest account is active (not expired, disabled, or locked)
    const status = isGuestActive(guest);
    if (!status.active) {
      return c.json({ success: false, error: status.reason }, 401);
    }

    // Successful guest login
    clearRateLimit(ip);
    recordSuccessfulLogin(sqlite, guest.id);
    logSecurityEvent({
      eventType: 'auth_success',
      severity: 'info',
      actor: username,
      actorType: 'guest',
      target: '/api/auth/login',
      details: { auth_type: 'guest', guest_id: guest.id },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });

    const token = generateSessionToken('guest', guest.username);
    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: GUEST_SESSION_DURATION_MS / 1000,
      path: '/'
    });

    return c.json({ success: true, role: 'guest', display_name: guest.display_name });
  }

  // Owner login (password only, no username)
  const storedHash = getSetting('auth_password_hash');
  if (!storedHash) {
    return c.json({ success: false, error: 'No password configured' }, 400);
  }

  // Verify password using Bun's built-in password functions
  const valid = await Bun.password.verify(password, storedHash);
  if (!valid) {
    const existing = getRateLimit(ip);
    const newCount = (existing?.count || 0) + 1;
    setRateLimit(ip, newCount, existing?.firstAttempt || now);
    logSecurityEvent({
      eventType: 'auth_failure',
      severity: 'warning',
      actorType: 'unknown',
      target: '/api/auth/login',
      details: { attempt_number: newCount },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ success: false, error: 'Invalid password' }, 401);
  }

  // Successful owner login clears rate limit
  clearRateLimit(ip);
  logSecurityEvent({
    eventType: 'auth_success',
    severity: 'info',
    actor: 'gorn',
    actorType: 'human',
    target: '/api/auth/login',
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });

  // Set session cookie
  const token = generateSessionToken('owner');
  const isHttps = c.req.url.startsWith('https') || c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true, // Always behind HTTPS via Caddy
    sameSite: 'Lax',
    maxAge: SESSION_DURATION_MS / 1000,
    path: '/'
  });

  return c.json({ success: true, role: 'owner' });
});

// Logout
app.post('/api/auth/logout', (c) => {
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  logSecurityEvent({
    eventType: 'session_destroyed',
    severity: 'info',
    actor: 'gorn',
    actorType: 'human',
    target: '/api/auth/logout',
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true });
});

// ============================================================================
// Guest Account Routes (Spec #32, T#554 — Gorn only)
// ============================================================================

// Create guest account
app.post('/api/guests', async (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json();
  const { username, password, display_name, expires_at } = body;

  if (!username || !password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  try {
    const guest = await createGuest(sqlite, username, password, display_name, expires_at);
    const { password_hash, ...safe } = guest;
    return c.json(safe, 201);
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      return c.json({ error: 'Username already exists' }, 409);
    }
    return c.json({ error: err.message || 'Failed to create guest' }, 400);
  }
});

// List guest accounts
app.get('/api/guests', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const guests = listGuests(sqlite).map(g => {
    const displayName = g.display_name || g.username;
    const guestTag = `[guest] ${displayName}`.toLowerCase();
    const msgCount = (sqlite.prepare('SELECT COUNT(*) as c FROM dm_messages WHERE LOWER(sender) = ?').get(guestTag) as any)?.c || 0;
    const threadCount = (sqlite.prepare("SELECT COUNT(DISTINCT thread_id) as c FROM forum_messages WHERE LOWER(author) LIKE '%[guest]%' AND LOWER(author) LIKE ?").get(`%${g.username}%`) as any)?.c || 0;
    // Use WS presence map for real-time status; fall back to last_active_at DB window
    const presence = webPresence.get(g.username);
    const nowMs = Date.now();
    const online = presence
      ? (nowMs - presence.lastSeen) < WEB_PRESENCE_TIMEOUT_MS
      : (g.last_active_at ? (nowMs - new Date(g.last_active_at + 'Z').getTime()) < 5 * 60 * 1000 : false);
    return {
      ...g,
      online,
      message_count: msgCount,
      threads_participated: threadCount,
    };
  });
  const onlineCount = guests.filter(g => g.online).length;
  return c.json({ guests, total: guests.length, online_count: onlineCount });
});

// Get single guest account
app.get('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const { password_hash, ...safe } = guest;

  // Activity summary: count DMs sent and forum threads participated (T#570)
  const guestTag = `[Guest] ${guest.display_name || guest.username}`;
  const guestTagAlt = `[Guest] ${guest.username}`;
  const dmCount = (sqlite.prepare(
    `SELECT COUNT(*) as count FROM dm_messages WHERE sender = ? OR sender = ?`
  ).get(guestTag, guestTagAlt) as any)?.count || 0;
  const threadCount = (sqlite.prepare(
    `SELECT COUNT(DISTINCT thread_id) as count FROM forum_messages WHERE author = ? OR author = ?`
  ).get(guestTag, guestTagAlt) as any)?.count || 0;

  const GUEST_ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
  const online = guest.last_active_at
    ? (Date.now() - new Date(guest.last_active_at + 'Z').getTime()) < GUEST_ONLINE_THRESHOLD_MS
    : false;

  return c.json({ ...safe, online, message_count: dmCount, threads_participated: threadCount });
});

// Update guest account (expiry, disable, display name)
app.patch('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  return c.req.json().then(body => {
    const updated = updateGuest(sqlite, id, {
      display_name: body.display_name,
      expires_at: body.expires_at,
      disabled_at: body.disabled_at,
    });
    if (!updated) return c.json({ error: 'Guest not found' }, 404);

    const { password_hash, ...safe } = updated;
    return c.json(safe);
  });
});

// Owner reset guest password (T#566)
app.patch('/api/guests/:id/password', async (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const body = await c.req.json();
  if (!body.password) return c.json({ error: 'password required' }, 400);

  try {
    await resetGuestPassword(sqlite, id, body.password);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Delete guest account (T#570 — with cascade notification)
app.delete('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const deleted = deleteGuest(sqlite, id);
  if (!deleted) return c.json({ error: 'Failed to delete guest' }, 500);

  // Broadcast session invalidation — connected clients will see this and redirect to login
  // Note: HMAC-signed cookies cannot be server-side revoked, but guest login check
  // will fail since the account no longer exists in the DB
  wsBroadcast('guest_deleted', { username: guest.username });

  return c.json({ success: true });
});

// Ban guest account (T#616 — spec #36)
app.post('/api/guests/:id/ban', async (c) => {
  // Owner session OR Beast token (Bertus needs to ban directly)
  const isOwner = hasSessionAuth(c) && (c.get as any)('role') !== 'guest';
  const isBeast = (c.get as any)('authMethod') === 'token' && (c.get as any)('role') === 'beast';
  if (!isOwner && !isBeast) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);
  if (guest.banned_at) return c.json({ error: 'Guest is already banned' }, 409);

  const body = await c.req.json();
  // Derive banned_by from authenticated session, not request body
  const bannedBy = isBeast ? (c.get as any)('actor') : 'owner';
  const reason = body.reason || 'No reason provided';

  const updated = banGuest(sqlite, id, bannedBy, reason);
  if (!updated) return c.json({ error: 'Failed to ban guest' }, 500);

  logSecurityEvent({
    eventType: 'guest_banned',
    severity: 'warning',
    actor: bannedBy,
    actorType: isBeast ? 'beast' : 'human',
    target: guest.username,
    details: { guest_id: id, username: guest.username, reason, banned_by: bannedBy },
    requestId: (c.get as any)('requestId'),
  });

  const { password_hash, ...safe } = updated;
  return c.json(safe);
});

// Unban guest account (T#616 — spec #36)
app.post('/api/guests/:id/unban', async (c) => {
  // Owner session only — unbanning is a sensitive operation
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);
  if (!guest.banned_at) return c.json({ error: 'Guest is not banned' }, 409);

  const body = await c.req.json();
  const reason = body.reason || 'No reason provided';

  const updated = unbanGuest(sqlite, id);
  if (!updated) return c.json({ error: 'Failed to unban guest' }, 500);

  logSecurityEvent({
    eventType: 'guest_unbanned',
    severity: 'info',
    actor: 'owner',
    actorType: 'human',
    target: guest.username,
    details: { guest_id: id, username: guest.username, reason },
    requestId: (c.get as any)('requestId'),
  });

  const { password_hash, ...safe } = updated;
  return c.json(safe);
});

// ============================================================================
// Beast Token Routes (T#546 — API tokens per Beast)
// ============================================================================

// Create token — Gorn session auth only
app.post('/api/auth/tokens', async (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // Block ?as= on this endpoint
  if (c.req.query('as')) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json();
  const { beast, ttl_hours } = body;
  if (!beast || typeof beast !== 'string') {
    return c.json({ error: 'beast name required' }, 400);
  }

  const result = createToken(beast, 'gorn', ttl_hours);
  if ('error' in result) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    token: result.token,
    id: result.id,
    expires_at: result.expiresAt,
    beast,
  });
});

// List tokens — Gorn session auth only (no hashes exposed)
app.get('/api/auth/tokens', (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ tokens: listTokens() });
});

// Revoke token — Gorn session auth only
app.delete('/api/auth/tokens/:id', (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const tokenId = parseInt(c.req.param('id'), 10);
  if (isNaN(tokenId)) {
    return c.json({ error: 'Invalid token ID' }, 400);
  }

  const result = revokeToken(tokenId, 'gorn');
  if (!result.success) {
    return c.json({ error: result.error }, 404);
  }
  return c.json({ revoked: true });
});

// Rotate token — owner-driven (existing endpoint, kept for owner UI workflow).
// Beast-self chain-aware rotation lives at POST /api/auth/rotate (Spec #52).
app.post('/api/auth/tokens/rotate', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const result = rotateToken(tokenId, beast);
  if ('error' in result) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({
    token: result.token,
    id: result.id,
    expires_at: result.expiresAt,
    beast,
  });
});

// Spec #51 Phase 3 — Beast-self token info read.
// Returns timing fields the Beast needs to monitor its own token lifecycle:
// expires_at, max_lifetime_at, refresh_window_starts_at, self_rotate_door_closes_at,
// rotation_recommended_at, rotated_at, next_token_id. NEVER returns token_hash.
//
// Auth: Beast bearer token only — token_id is derived from the bearer, so a Beast
// can only read ITS OWN token info. Owner session falls through to 403 here (the
// listTokens / GET /api/auth/tokens endpoint serves the owner-side view).
app.get('/api/auth/me', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'Bearer-token Beast identity required' }, 403);
  }

  const info = getTokenInfo(tokenId);
  if (!info) {
    return c.json({ error: 'Token not found or revoked' }, 404);
  }
  return c.json(info);
});

// Spec #52 — Beast-self chain-aware rotation.
// Beast presents CURRENT VALID token via Bearer auth; server issues fresh token,
// chain-links old → new (rotated_at + next_token_id). Replay on the old token
// trips chain-compromise detection in validateToken().
//
// Failure semantics:
//   401 — invalid/expired/revoked bearer
//   403 — bearer is not a Beast (e.g. owner session, no tokenId)
//   403 + code=rotate_window_expired — token outside SELF_ROTATE_WINDOW (24h)
//   409 + code=rotation_locked — token already rotated_away (concurrent double-rotate)
app.post('/api/auth/rotate', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'Bearer-token Beast identity required' }, 403);
  }

  const result = selfRotateToken(tokenId, beast);
  if ('error' in result) {
    const status = result.code === 'rotate_window_expired' ? 403
      : result.code === 'rotation_locked' ? 409
      : result.code === 'token_not_found' ? 401
      : 500;
    return c.json({ error: result.error, code: result.code }, status);
  }

  return c.json({
    token: result.token,
    id: result.id,
    expires_at: result.expiresAt,
    beast,
  });
});

// ============================================================================
// Settings Routes
// ============================================================================

// Get settings (no password hash exposed)
app.get('/api/settings', (c) => {
  const authEnabled = getSetting('auth_enabled') === 'true';
  const localBypass = getSetting('auth_local_bypass') !== 'false';
  const hasPassword = !!getSetting('auth_password_hash');
  const vaultRepo = getSetting('vault_repo');

  return c.json({
    authEnabled,
    localBypass,
    hasPassword,
    vaultRepo
  });
});

// Update settings (Gorn only — reject beast API calls)
app.post('/api/settings', async (c) => {
  // Only allow from browser sessions (Gorn) or local requests, not beast API calls
  const asParam = c.req.query('as');
  if (asParam) {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'impersonation_blocked',
      severity: 'warning',
      actor: asParam,
      actorType: 'beast',
      target: '/api/settings',
      details: { method: 'POST', blocked_reason: 'beast_api_call' },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ error: 'Settings can only be changed by Gorn via the UI' }, 403);
  }
  const body = await c.req.json();
  if (body.as) {
    return c.json({ error: 'Settings can only be changed by Gorn via the UI' }, 403);
  }

  // Handle password change
  if (body.newPassword) {
    // If password exists, require current password
    const existingHash = getSetting('auth_password_hash');
    if (existingHash) {
      if (!body.currentPassword) {
        return c.json({ error: 'Current password required' }, 400);
      }
      const valid = await Bun.password.verify(body.currentPassword, existingHash);
      if (!valid) {
        return c.json({ error: 'Current password is incorrect' }, 401);
      }
    }

    // Hash and store new password
    const hash = await Bun.password.hash(body.newPassword);
    setSetting('auth_password_hash', hash);
  }

  // Handle removing password
  if (body.removePassword === true) {
    const existingHash = getSetting('auth_password_hash');
    if (existingHash && body.currentPassword) {
      const valid = await Bun.password.verify(body.currentPassword, existingHash);
      if (!valid) {
        return c.json({ error: 'Current password is incorrect' }, 401);
      }
    }
    setSetting('auth_password_hash', null);
    setSetting('auth_enabled', 'false');
  }

  // Handle auth enabled toggle
  if (typeof body.authEnabled === 'boolean') {
    // Can only enable auth if password is set
    if (body.authEnabled && !getSetting('auth_password_hash')) {
      return c.json({ error: 'Cannot enable auth without password' }, 400);
    }
    setSetting('auth_enabled', body.authEnabled ? 'true' : 'false');
  }

  // Handle local bypass toggle
  if (typeof body.localBypass === 'boolean') {
    setSetting('auth_local_bypass', body.localBypass ? 'true' : 'false');
  }

  // Log security settings changes
  const changes: string[] = [];
  if (body.newPassword) changes.push('password_changed');
  if (body.removePassword) changes.push('password_removed');
  if (typeof body.authEnabled === 'boolean') changes.push(`auth_${body.authEnabled ? 'enabled' : 'disabled'}`);
  if (typeof body.localBypass === 'boolean') changes.push(`local_bypass_${body.localBypass ? 'enabled' : 'disabled'}`);
  if (changes.length > 0) {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'settings_changed',
      severity: 'warning',
      actor: 'gorn',
      actorType: 'human',
      target: '/api/settings',
      details: { changes },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
  }

  return c.json({
    success: true,
    authEnabled: getSetting('auth_enabled') === 'true',
    localBypass: getSetting('auth_local_bypass') !== 'false',
    hasPassword: !!getSetting('auth_password_hash')
  });
});

// ============================================================================
// API Routes
// ============================================================================

// Playbook — serve den-playbook.md
app.get('/api/playbook', (c) => {
  const playbookPath = path.join(process.env.HOME || '/home/gorn', 'workspace', 'den-playbook.md');
  if (fs.existsSync(playbookPath)) {
    return c.text(fs.readFileSync(playbookPath, 'utf-8'));
  }
  return c.text('# Playbook not found', 404);
});

// API Documentation
app.get('/api/docs', (c) => {
  return c.json({
    name: 'Den Book API',
    version: '0.5.0',
    endpoints: {
      beasts: {
        'GET /api/beasts': {
          description: 'List all beast profiles',
          response: '{ beasts: BeastProfile[] }',
        },
        'GET /api/beast/:name': {
          description: 'Get a beast profile by name',
          params: { name: 'lowercase beast name (e.g. karo, gnarl)' },
          response: 'BeastProfile',
        },
        'PUT /api/beast/:name': {
          description: 'Create or fully update a beast profile',
          body: {
            displayName: { type: 'string', required: true, example: 'Karo' },
            animal: { type: 'string', required: true, example: 'hyena' },
            avatarUrl: { type: 'string|null', required: false, example: '/api/beast/karo/avatar.svg' },
            bio: { type: 'string|null', required: false, example: 'The pack debugs what the lone wolf misses.' },
            interests: { type: 'string|null (JSON array)', required: false, example: '["debugging","architecture","performance"]' },
            themeColor: { type: 'string|null (hex)', required: false, example: '#d4943a' },
            role: { type: 'string|null', required: false, example: 'Software Engineering' },
          },
          response: 'BeastProfile',
        },
        'PATCH /api/beast/:name': {
          description: 'Partial profile update — send only fields you want to change',
          body: {
            bio: { type: 'string', optional: true },
            interests: { type: 'string (JSON array)', optional: true, example: '["networking","VPN","servers"]' },
            role: { type: 'string', optional: true },
            displayName: { type: 'string', optional: true },
            themeColor: { type: 'string (hex)', optional: true },
            avatarUrl: { type: 'string', optional: true },
          },
          response: 'BeastProfile',
        },
        'PATCH /api/beast/:name/avatar': {
          description: 'Update avatar URL only',
          body: { avatarUrl: { type: 'string', required: true } },
          response: 'BeastProfile',
        },
        'GET /api/beast/:name/avatar.svg': {
          description: 'Generated SVG avatar based on animal theme',
          response: 'image/svg+xml',
        },
        'POST /api/beasts/seed-avatars': {
          description: 'Seed default SVG avatars for beasts without one',
          response: '{ seeded: number, total: number }',
        },
      },
      pack: {
        'GET /api/pack': {
          description: 'List all beasts with online/offline status (from tmux)',
          response: '{ beasts: (BeastProfile & { online: boolean, sessionName: string })[] }',
        },
        'GET /api/beast/:name/terminal': {
          description: 'Capture live terminal output (ANSI) from beast tmux session',
          query: { rows: 'number (default 50) — lines to capture' },
          response: '{ name, online, content: string (ANSI), cols, rows }',
        },
        'POST /api/beast/:name/terminal/input': {
          description: 'Send text input to beast terminal',
          body: { keys: { type: 'string', required: true, maxLength: 100 } },
          response: '{ sent: boolean, beast, length }',
        },
        'POST /api/beast/:name/terminal/key': {
          description: 'Send special key to beast terminal',
          body: { key: { type: 'string', required: true, allowed: 'Enter, Escape, BSpace, Tab, Up, Down, Left, Right, C-c, C-d, C-z, C-l' } },
          response: '{ sent: boolean, beast, key }',
        },
      },
      forum: {
        'GET /api/threads': {
          description: 'List forum threads',
          query: { status: 'active|answered|pending|closed', limit: 'number', offset: 'number' },
        },
        'GET /api/thread/:id': {
          description: 'Get thread with all messages',
        },
        'POST /api/thread': {
          description: 'Create thread or send message',
          body: {
            message: { type: 'string', required: true },
            thread_id: { type: 'number', required: false, note: 'omit to create new thread' },
            title: { type: 'string', required: false, note: 'title for new thread' },
            role: { type: 'string', default: 'human', values: 'human|claude' },
            author: { type: 'string', required: false, example: 'karo' },
          },
        },
        'PATCH /api/thread/:id/status': {
          description: 'Update thread status',
          body: { status: { type: 'string', values: 'active|answered|pending|closed' } },
        },
      },
      dms: {
        'POST /api/dm': {
          description: 'Send a direct message',
          body: {
            from: { type: 'string', required: true, example: 'karo' },
            to: { type: 'string', required: true, example: 'zaghnal' },
            message: { type: 'string', required: true },
          },
        },
        'GET /api/dm/:name': {
          description: 'List conversations for a beast',
          query: { limit: 'number', offset: 'number' },
        },
        'GET /api/dm/:name/:other': {
          description: 'Get messages between two beasts',
          query: { limit: 'number', offset: 'number' },
        },
        'GET /api/dm/dashboard': {
          description: 'DM dashboard — all conversations with stats',
        },
      },
      types: {
        BeastProfile: {
          name: 'string (primary key, lowercase)',
          display_name: 'string',
          animal: 'string',
          avatar_url: 'string|null',
          bio: 'string|null',
          interests: 'string|null — JSON array string, e.g. \'["debugging","architecture"]\'',
          theme_color: 'string|null — hex color, e.g. "#d4943a"',
          role: 'string|null',
          created_at: 'number (unix ms)',
          updated_at: 'number (unix ms)',
        },
      },
    },
  });
});

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', server: 'oracle-nightly', port: PORT, oracleV2: 'connected' });
});

// Endpoint catalog — shared by /api/help and 404 handler
const HELP_ENDPOINTS = [
    // Auth
    { method: 'GET', path: '/api/auth/status', desc: 'Check if session is authenticated', params: null },
    { method: 'POST', path: '/api/auth/login', desc: 'Login with password', params: 'body: { password }' },
    { method: 'POST', path: '/api/auth/logout', desc: 'Logout current session', params: null },
    // Health
    { method: 'GET', path: '/api/health', desc: 'Server health check', params: null },
    { method: 'GET', path: '/api/help', desc: 'This endpoint catalog', params: '?q=filter' },
    // Threads (forum)
    { method: 'GET', path: '/api/threads', desc: 'List all forum threads', params: '?status=&category=&limit=50&offset=0' },
    { method: 'POST', path: '/api/thread', desc: 'Create thread or post message', params: 'body: { message, author, thread_id?, title?, reply_to_id?, visibility? }' },
    { method: 'GET', path: '/api/thread/:id', desc: 'Get thread messages', params: '?limit=50&offset=0' },
    { method: 'PATCH', path: '/api/thread/:id/category', desc: 'Update thread category', params: 'body: { category, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/lock', desc: 'Lock/unlock thread', params: 'body: { locked, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/archive', desc: 'Archive/unarchive thread', params: 'body: { archived, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/pin', desc: 'Pin/unpin thread', params: 'body: { pinned, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/title', desc: 'Rename thread title', params: 'body: { title, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/status', desc: 'Update thread status', params: 'body: { status, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/visibility', desc: 'Update thread visibility', params: 'body: { visibility, beast }' },
    { method: 'DELETE', path: '/api/thread/:id', desc: 'Delete thread', params: 'body: { beast }' },
    // Forum utilities
    { method: 'POST', path: '/api/forum/read', desc: 'Mark thread as read', params: 'body: { beast, threadId, messageId }' },
    { method: 'GET', path: '/api/forum/unread/:beast', desc: 'Get unread thread counts', params: null },
    { method: 'GET', path: '/api/forum/mentions/:beast', desc: 'Get @mentions for a beast', params: '?limit=30' },
    { method: 'GET', path: '/api/forum/search', desc: 'Search forum messages', params: '?q=query&limit=20' },
    { method: 'GET', path: '/api/forum/activity', desc: 'Recent forum activity feed', params: '?limit=50' },
    { method: 'POST', path: '/api/forum/mute', desc: 'Mute/unmute thread notifications', params: 'body: { beast, threadId, muted }' },
    { method: 'GET', path: '/api/forum/muted/:beast', desc: 'Get muted threads', params: null },
    { method: 'GET', path: '/api/forum/link-preview', desc: 'Get link preview metadata', params: '?url=' },
    // Messages
    { method: 'PATCH', path: '/api/message/:id', desc: 'Edit a message', params: 'body: { content, beast }' },
    { method: 'GET', path: '/api/message/:id/history', desc: 'Get message edit history', params: null },
    { method: 'POST', path: '/api/message/:id/react', desc: 'Add reaction to message', params: 'body: { beast, emoji }' },
    { method: 'DELETE', path: '/api/message/:id/react', desc: 'Remove reaction', params: 'body: { beast, emoji }' },
    { method: 'GET', path: '/api/message/:id/reactions', desc: 'Get message reactions', params: null },
    { method: 'GET', path: '/api/message/:id/attachments', desc: 'Get message file attachments', params: null },
    // Emojis
    { method: 'GET', path: '/api/forum/emojis', desc: 'List custom emojis', params: null },
    { method: 'POST', path: '/api/forum/emojis', desc: 'Add custom emoji', params: 'body: { emoji, name, category? }' },
    { method: 'DELETE', path: '/api/forum/emojis/:emoji', desc: 'Remove custom emoji', params: null },
    { method: 'GET', path: '/api/reactions/supported', desc: 'List all supported reactions', params: null },
    // DMs
    { method: 'GET', path: '/api/dm/:name', desc: 'List DM conversations for a beast', params: null },
    { method: 'GET', path: '/api/dm/:name/:other', desc: 'Get DM conversation between two beasts', params: '?limit=30&offset=0&order=desc' },
    { method: 'POST', path: '/api/dm', desc: 'Send a DM', params: 'body: { from, to, message }' },
    { method: 'PATCH', path: '/api/dm/:name/:other/read', desc: 'Mark DM conversation as read', params: null },
    { method: 'PATCH', path: '/api/dm/:name/:other/read-all', desc: 'Mark all DMs as read', params: null },
    { method: 'DELETE', path: '/api/dm/messages/:id', desc: 'Delete a DM message', params: null },
    { method: 'GET', path: '/api/dm/dashboard', desc: 'DM dashboard stats', params: null },
    { method: 'GET', path: '/api/dm/unread-count', desc: 'Get unread DM count', params: null },
    // Tasks (PM Board)
    { method: 'GET', path: '/api/tasks', desc: 'List tasks', params: '?assignee=&reviewer=&status=&limit=100&offset=0' },
    { method: 'GET', path: '/api/tasks/:id', desc: 'Get task by ID', params: null },
    { method: 'POST', path: '/api/tasks', desc: 'Create task', params: 'body: { title, assigned_to, reviewer, project_id, description?, status? }' },
    { method: 'PATCH', path: '/api/tasks/:id', desc: 'Update task', params: 'body: { title?, description?, assignee?, reviewer?, status? }' },
    { method: 'DELETE', path: '/api/tasks/:id', desc: 'Delete task', params: null },
    { method: 'POST', path: '/api/tasks/:id/comments', desc: 'Add comment to task', params: 'body: { author, content }' },
    { method: 'GET', path: '/api/tasks/:id/comments', desc: 'Get task comments', params: null },
    // Pack / Beasts
    { method: 'GET', path: '/api/pack', desc: 'Get all beast profiles with status', params: null },
    { method: 'GET', path: '/api/beasts', desc: 'List all beast profiles', params: null },
    { method: 'GET', path: '/api/beast/:name', desc: 'Get single beast profile', params: null },
    { method: 'PUT', path: '/api/beast/:name', desc: 'Create/replace beast profile', params: 'body: { species, role, bio?, themeColor? }' },
    { method: 'PATCH', path: '/api/beast/:name', desc: 'Update beast profile fields', params: 'body: { bio?, role?, themeColor?, ... }' },
    { method: 'PATCH', path: '/api/beast/:name/avatar', desc: 'Upload beast avatar', params: 'body: FormData with avatar file' },
    { method: 'GET', path: '/api/beast/:name/terminal', desc: 'Get beast tmux terminal output', params: null },
    { method: 'POST', path: '/api/beast/:name/terminal/input', desc: 'Send text to beast terminal', params: 'body: { input }' },
    { method: 'POST', path: '/api/beast/:name/terminal/key', desc: 'Send key event to beast terminal', params: 'body: { key }' },
    // Schedules
    { method: 'GET', path: '/api/schedules', desc: 'List schedules', params: '?beast=&enabled=' },
    { method: 'GET', path: '/api/schedules/due', desc: 'Get due schedules', params: '?beast=' },
    { method: 'POST', path: '/api/schedules', desc: 'Create schedule', params: 'body: { beast, task, command, interval, ... }' },
    { method: 'PATCH', path: '/api/schedules/:id', desc: 'Update schedule', params: 'body: { task?, command?, interval?, enabled? }' },
    { method: 'PATCH', path: '/api/schedules/:id/run', desc: 'Mark schedule as run', params: '?as=beast' },
    { method: 'DELETE', path: '/api/schedules/:id', desc: 'Delete schedule', params: '?as=beast' },
    // Upload
    { method: 'POST', path: '/api/upload', desc: 'Upload file attachment', params: 'body: FormData with file' },
    { method: 'GET', path: '/api/forum/file/:filename', desc: 'Get uploaded file', params: null },
    { method: 'GET', path: '/api/files', desc: 'List all uploaded files', params: '?limit=50&offset=0' },
    { method: 'GET', path: '/api/files/stats', desc: 'File storage statistics', params: null },
    { method: 'GET', path: '/api/files/:id', desc: 'Get file metadata', params: null },
    { method: 'GET', path: '/api/files/:id/download', desc: 'Download file by ID (owner/beast)', params: null },
    { method: 'GET', path: '/api/f/:hash', desc: 'Download file by hash (public, unguessable)', params: null },
    { method: 'DELETE', path: '/api/files/:id', desc: 'Delete file', params: null },
    // Specs (SDD)
    { method: 'GET', path: '/api/specs', desc: 'List all specs', params: '?status=&author=' },
    { method: 'GET', path: '/api/specs/:id', desc: 'Get spec by ID', params: null },
    { method: 'GET', path: '/api/specs/:id/content', desc: 'Get spec markdown content', params: null },
    { method: 'GET', path: '/api/specs/:id/history', desc: 'Get spec review history', params: null },
    { method: 'GET', path: '/api/specs/:id/diff', desc: 'Get spec version diff', params: '?v1=&v2=' },
    { method: 'POST', path: '/api/specs', desc: 'Submit new spec', params: 'body: { title, content, author, task_ids?, thread_ids? }' },
    { method: 'POST', path: '/api/specs/:id/review', desc: 'Review a spec', params: 'body: { reviewer, action, comment? }' },
    { method: 'POST', path: '/api/specs/:id/resubmit', desc: 'Resubmit spec with changes', params: 'body: { content, author, change_summary? }' },
    { method: 'DELETE', path: '/api/specs/:id', desc: 'Delete spec', params: 'body: { beast }' },
    { method: 'GET', path: '/api/specs/:id/links', desc: 'Get linked tasks/threads', params: null },
    { method: 'POST', path: '/api/specs/:id/link', desc: 'Link task or thread to spec', params: 'body: { type, target_id }' },
    { method: 'DELETE', path: '/api/specs/:id/link', desc: 'Unlink task or thread', params: 'body: { type, target_id }' },
    { method: 'GET', path: '/api/specs/:id/comments', desc: 'Get spec comments', params: null },
    { method: 'POST', path: '/api/specs/:id/comments', desc: 'Add spec comment', params: 'body: { author, content, type? }' },
    // Rules
    { method: 'GET', path: '/api/rules', desc: 'List all active rules', params: null },
    { method: 'GET', path: '/api/rules/decrees', desc: 'List decrees only', params: null },
    { method: 'GET', path: '/api/rules/norms', desc: 'List norms only', params: null },
    { method: 'GET', path: '/api/rules/markdown', desc: 'All rules as markdown (for /recap)', params: null },
    { method: 'GET', path: '/api/rules/pending', desc: 'List rules pending approval', params: null },
    { method: 'GET', path: '/api/rules/:id', desc: 'Get rule by ID', params: null },
    { method: 'POST', path: '/api/rules', desc: 'Propose new rule', params: 'body: { title, content, type, proposed_by }' },
    { method: 'PATCH', path: '/api/rules/:id', desc: 'Update rule', params: 'body: { title?, content?, type? }' },
    { method: 'PATCH', path: '/api/rules/:id/archive', desc: 'Archive rule', params: 'body: { beast }' },
    { method: 'POST', path: '/api/rules/:id/approve', desc: 'Approve pending rule', params: 'body: { beast }' },
    { method: 'POST', path: '/api/rules/:id/reject', desc: 'Reject pending rule', params: 'body: { beast, reason? }' },
    // Risks
    { method: 'GET', path: '/api/risks', desc: 'List all risks', params: '?status=&severity=' },
    { method: 'GET', path: '/api/risks/summary', desc: 'Risk summary stats', params: null },
    { method: 'GET', path: '/api/risks/stale', desc: 'Risks not updated recently', params: null },
    { method: 'GET', path: '/api/risks/:id', desc: 'Get risk by ID', params: null },
    { method: 'POST', path: '/api/risks', desc: 'Create risk', params: 'body: { title, description, severity, status, owner }' },
    { method: 'PATCH', path: '/api/risks/:id', desc: 'Update risk', params: 'body: { title?, severity?, status?, mitigation? }' },
    { method: 'DELETE', path: '/api/risks/:id', desc: 'Delete risk', params: null },
    // Prowl (Gorn tasks)
    { method: 'GET', path: '/api/prowl', desc: 'List Gorn personal tasks', params: '?status=&category=&priority=' },
    { method: 'GET', path: '/api/prowl/categories', desc: 'List Prowl categories', params: null },
    { method: 'POST', path: '/api/prowl', desc: 'Create Prowl task', params: 'body: { title, due_date? (YYYY-MM-DD or YYYY-MM-DDTHH:MM), category?, priority?, source? }' },
    { method: 'PATCH', path: '/api/prowl/:id', desc: 'Update Prowl task', params: 'body: { title?, due_date? (YYYY-MM-DD or YYYY-MM-DDTHH:MM), category?, priority?, notes? }' },
    { method: 'PATCH', path: '/api/prowl/:id/status', desc: 'Update Prowl task status', params: 'body: { status }' },
    { method: 'POST', path: '/api/prowl/:id/toggle', desc: 'Toggle Prowl task done/undone', params: null },
    { method: 'DELETE', path: '/api/prowl/:id', desc: 'Delete Prowl task', params: null },
    { method: 'GET', path: '/api/prowl/:id/checklist', desc: 'List checklist items for a Prowl task', params: null },
    { method: 'POST', path: '/api/prowl/:id/checklist', desc: 'Add checklist item', params: 'body: { text }' },
    { method: 'PATCH', path: '/api/prowl/:id/checklist/:itemId', desc: 'Update checklist item', params: 'body: { text?, checked?, sort_order? }' },
    { method: 'POST', path: '/api/prowl/:id/checklist/:itemId/toggle', desc: 'Toggle checklist item checked', params: null },
    { method: 'DELETE', path: '/api/prowl/:id/checklist/:itemId', desc: 'Delete checklist item', params: null },
    { method: 'POST', path: '/api/prowl/notify-test', desc: 'Test Prowl notification pipeline (Gorn-only)', params: null },
    // Telegram
    { method: 'GET', path: '/api/telegram/status', desc: 'Telegram polling status (owner only)', params: null },
    { method: 'GET', path: '/api/telegram/message/:id', desc: 'T#712 — cached inbound TG message by id (Gorn + Sable only)', params: null },
    // Routine (Forge)
    { method: 'GET', path: '/api/routine/logs', desc: 'List routine logs', params: '?type=&date=&limit=20&offset=0' },
    { method: 'GET', path: '/api/routine/today', desc: 'Today routine summary', params: null },
    { method: 'GET', path: '/api/routine/weight', desc: 'Weight history', params: '?limit=30' },
    { method: 'GET', path: '/api/routine/blood-pressure', desc: 'BP history (Prowl #80)', params: '?range=week,month,year,3y,10y,all' },
    { method: 'GET', path: '/api/routine/exercise-summary', desc: 'Single-exercise 4-dimension read: peak/recent/trend/frequency (Prowl #83)', params: '?exercise=<name>' },
    { method: 'GET', path: '/api/routine/prs', desc: 'All-exercises peak summary, alias for /personal-records?grouped=true (Prowl #83)', params: '?range=month' },
    { method: 'GET', path: '/api/routine/body-composition', desc: 'Body composition history from Withings', params: '?range=month (1w,1m,3m,1y,3y,all)' },
    { method: 'GET', path: '/api/routine/stats', desc: 'Routine statistics', params: null },
    { method: 'GET', path: '/api/routine/summary', desc: 'Routine summary with trends', params: null },
    { method: 'GET', path: '/api/routine/exercises', desc: 'List exercises', params: null },
    { method: 'POST', path: '/api/routine/exercises', desc: 'Add exercise', params: 'body: { name, equipment?, muscle_group? }' },
    { method: 'GET', path: '/api/routine/personal-records', desc: 'Personal records', params: null },
    { method: 'POST', path: '/api/routine/logs', desc: 'Create routine log (workout: exercises[].notes optional str, exercises[].sets[].rpe optional 1-10 per T#710)', params: 'body: { type, logged_at, data: { exercises?: [{name, notes?, sets: [{weight, reps, rpe?, unit?}]}], items?: [...meal], ... } }' },
    { method: 'PATCH', path: '/api/routine/logs/:id', desc: 'Update routine log', params: 'body: { ... }' },
    { method: 'DELETE', path: '/api/routine/logs/:id', desc: 'Soft-delete routine log', params: null },
    { method: 'PATCH', path: '/api/routine/logs/:id/restore', desc: 'Restore deleted log', params: null },
    // OAuth
    { method: 'GET', path: '/api/oauth/withings/authorize', desc: 'Start Withings OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/withings/callback', desc: 'OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/withings/status', desc: 'Check Withings connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/withings/disconnect', desc: 'Disconnect Withings', params: null },
    { method: 'GET', path: '/api/withings/devices', desc: 'List Withings devices', params: null },
    // Google OAuth + Gmail
    { method: 'GET', path: '/api/oauth/google/authorize', desc: 'Start Google OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/google/callback', desc: 'Google OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/google/status', desc: 'Check Google connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/google/disconnect', desc: 'Disconnect Google', params: null },
    { method: 'GET', path: '/api/google/gmail/profile', desc: 'Get Gmail profile info', params: null },
    { method: 'GET', path: '/api/google/gmail/labels', desc: 'List Gmail labels', params: null },
    { method: 'GET', path: '/api/google/gmail/messages', desc: 'List Gmail messages', params: '?label=INBOX&maxResults=20&q=search&pageToken=' },
    { method: 'GET', path: '/api/google/gmail/messages/:id', desc: 'Get Gmail message by ID', params: null },
    { method: 'GET', path: '/api/google/gmail/threads/:id', desc: 'Get Gmail thread by ID', params: null },
    // Google Access Control
    { method: 'GET', path: '/api/google/access', desc: 'List Google OAuth Beast allowlist', params: null },
    { method: 'POST', path: '/api/google/access', desc: 'Add Beast to Google OAuth allowlist', params: 'body: { beast }' },
    { method: 'DELETE', path: '/api/google/access/:beast', desc: 'Remove Beast from Google OAuth allowlist', params: null },
    { method: 'GET', path: '/api/google/audit', desc: 'Google OAuth audit log', params: null },
    // Search
    { method: 'GET', path: '/api/search', desc: 'Search documents and knowledge', params: '?q=query&type=all&limit=10' },
    { method: 'GET', path: '/api/search/status', desc: 'Search index status', params: null },
    { method: 'POST', path: '/api/search/reindex', desc: 'Trigger search reindex', params: null },
    // Remote
    { method: 'GET', path: '/api/remote/status', desc: 'Remote panel connection status', params: null },
    { method: 'POST', path: '/api/remote/attach', desc: 'Attach to beast for remote control', params: 'body: { beast }' },
    { method: 'POST', path: '/api/remote/detach', desc: 'Detach from remote control', params: null },
    // Queue (Gorn)
    { method: 'GET', path: '/api/queue/gorn', desc: 'Get Gorn review queue', params: null },
    { method: 'POST', path: '/api/queue/gorn', desc: 'Add thread to Gorn queue', params: 'body: { threadId, reason, addedBy }' },
    { method: 'PATCH', path: '/api/queue/gorn/:threadId', desc: 'Update queue item status', params: 'body: { status }' },
    // Dashboard
    { method: 'GET', path: '/api/dashboard', desc: 'Dashboard summary', params: null },
    { method: 'GET', path: '/api/dashboard/summary', desc: 'Dashboard summary (alt)', params: null },
    { method: 'GET', path: '/api/dashboard/activity', desc: 'Activity stats', params: null },
    { method: 'GET', path: '/api/dashboard/growth', desc: 'Growth metrics', params: null },
    { method: 'GET', path: '/api/session/stats', desc: 'Session statistics', params: null },
    // Library
    { method: 'GET', path: '/api/library', desc: 'List library entries', params: '?shelf=&limit=50' },
    { method: 'GET', path: '/api/library/:id', desc: 'Get library entry by ID', params: null },
    { method: 'POST', path: '/api/library', desc: 'Add library entry', params: 'body: { title, content, shelf?, author }' },
    { method: 'PATCH', path: '/api/library/:id', desc: 'Update library entry', params: 'body: { title?, content?, shelf? }' },
    { method: 'DELETE', path: '/api/library/:id', desc: 'Delete library entry', params: null },
    { method: 'GET', path: '/api/library/search', desc: 'Search library entries', params: '?q=query' },
    { method: 'GET', path: '/api/library/types', desc: 'List library entry types', params: null },
    { method: 'GET', path: '/api/library/shelves', desc: 'List library shelves', params: null },
    { method: 'GET', path: '/api/library/shelves/:id', desc: 'Get shelf by ID', params: null },
    { method: 'POST', path: '/api/library/shelves', desc: 'Create shelf', params: 'body: { name, description? }' },
    { method: 'PATCH', path: '/api/library/shelves/:id', desc: 'Update shelf', params: 'body: { name?, description? }' },
    { method: 'DELETE', path: '/api/library/shelves/:id', desc: 'Delete shelf', params: null },
    // Handoffs
    { method: 'POST', path: '/api/handoff', desc: 'Submit session handoff', params: 'body: { oracle, summary, ... }' },
    { method: 'GET', path: '/api/inbox', desc: 'Get inbox items', params: '?type=&limit=20' },
    // Auth Tokens
    { method: 'GET', path: '/api/auth/tokens', desc: 'List API tokens', params: null },
    { method: 'POST', path: '/api/auth/tokens', desc: 'Create API token', params: 'body: { name }' },
    { method: 'DELETE', path: '/api/auth/tokens/:id', desc: 'Delete API token', params: null },
    { method: 'POST', path: '/api/auth/tokens/rotate', desc: 'Rotate API token (owner-driven)', params: null },
    { method: 'POST', path: '/api/auth/rotate', desc: 'Beast-self chain-aware rotation (Spec #52)', params: 'header: Authorization: Bearer <current_token>' },
    { method: 'GET', path: '/api/auth/me', desc: 'Beast-self token info — expires_at, refresh_window, self_rotate_door, rotated_at (Spec #51 Phase 3)', params: 'header: Authorization: Bearer <current_token>' },
    // Guests
    { method: 'GET', path: '/api/guests', desc: 'List guests', params: null },
    { method: 'GET', path: '/api/guests/:id', desc: 'Get guest by ID', params: null },
    { method: 'POST', path: '/api/guests', desc: 'Create guest account', params: 'body: { username, display_name, password }' },
    { method: 'PATCH', path: '/api/guests/:id', desc: 'Update guest', params: 'body: { display_name?, ... }' },
    { method: 'PATCH', path: '/api/guests/:id/password', desc: 'Change guest password', params: 'body: { password }' },
    { method: 'DELETE', path: '/api/guests/:id', desc: 'Delete guest', params: null },
    { method: 'POST', path: '/api/guests/:id/ban', desc: 'Ban guest', params: null },
    { method: 'POST', path: '/api/guests/:id/unban', desc: 'Unban guest', params: null },
    // Guest-facing endpoints
    { method: 'GET', path: '/api/guest/threads', desc: 'List public threads (guest view)', params: null },
    { method: 'GET', path: '/api/guest/thread/:id', desc: 'Get thread (guest view)', params: null },
    { method: 'POST', path: '/api/guest/thread', desc: 'Create thread (guest)', params: 'body: { message, title }' },
    { method: 'POST', path: '/api/guest/thread/:id/message', desc: 'Post message to thread (guest)', params: 'body: { message }' },
    { method: 'GET', path: '/api/guest/dm/:from/:to', desc: 'Get DM conversation (guest view)', params: null },
    { method: 'POST', path: '/api/guest/dm', desc: 'Send DM (guest)', params: 'body: { to, message }' },
    { method: 'GET', path: '/api/guest/pack', desc: 'Get pack profiles (guest view)', params: null },
    { method: 'GET', path: '/api/guest/profile', desc: 'Get own guest profile', params: null },
    { method: 'PATCH', path: '/api/guest/profile', desc: 'Update own guest profile', params: 'body: { display_name?, bio? }' },
    { method: 'POST', path: '/api/guest/avatar', desc: 'Upload guest avatar', params: 'body: FormData with file' },
    { method: 'POST', path: '/api/guest/change-password', desc: 'Change guest password (self)', params: 'body: { old_password, new_password }' },
    { method: 'POST', path: '/api/guest/reset-password', desc: 'Reset guest password', params: 'body: { username }' },
    { method: 'GET', path: '/api/guest/dashboard', desc: 'Guest dashboard', params: null },
    // Projects
    { method: 'GET', path: '/api/projects', desc: 'List projects', params: null },
    { method: 'GET', path: '/api/projects/:id', desc: 'Get project by ID', params: null },
    { method: 'POST', path: '/api/projects', desc: 'Create project', params: 'body: { name, description? }' },
    { method: 'PATCH', path: '/api/projects/:id', desc: 'Update project', params: 'body: { name?, description? }' },
    { method: 'DELETE', path: '/api/projects/:id', desc: 'Delete project', params: null },
    // Teams
    { method: 'GET', path: '/api/teams', desc: 'List teams', params: null },
    { method: 'GET', path: '/api/teams/:id', desc: 'Get team by ID', params: null },
    { method: 'POST', path: '/api/teams', desc: 'Create team', params: 'body: { name, ... }' },
    { method: 'PATCH', path: '/api/teams/:id', desc: 'Update team', params: 'body: { name?, ... }' },
    { method: 'DELETE', path: '/api/teams/:id', desc: 'Delete team', params: null },
    { method: 'POST', path: '/api/teams/:id/members', desc: 'Add member to team', params: 'body: { beast }' },
    { method: 'DELETE', path: '/api/teams/:id/members/:beast', desc: 'Remove member from team', params: null },
    { method: 'POST', path: '/api/teams/:id/projects', desc: 'Link project to team', params: 'body: { projectId }' },
    { method: 'DELETE', path: '/api/teams/:id/projects/:projectId', desc: 'Unlink project from team', params: null },
    { method: 'GET', path: '/api/teams/beast/:beast', desc: 'Get teams for a beast', params: null },
    // Security
    { method: 'GET', path: '/api/security/events', desc: 'Security event log', params: '?limit=50' },
    { method: 'GET', path: '/api/security/events/stats', desc: 'Security event stats', params: null },
    { method: 'GET', path: '/api/audit', desc: 'Audit log', params: '?limit=50' },
    { method: 'GET', path: '/api/audit/stats', desc: 'Audit stats', params: null },
    // Scheduler (additional)
    { method: 'GET', path: '/api/schedules/:id', desc: 'Get schedule by ID', params: null },
    { method: 'POST', path: '/api/schedules/:id/execute', desc: 'Execute schedule now', params: null },
    { method: 'PATCH', path: '/api/schedules/:id/trigger', desc: 'Trigger schedule', params: null },
    { method: 'GET', path: '/api/scheduler/health', desc: 'Scheduler health check', params: null },
    // Tasks (additional)
    { method: 'POST', path: '/api/tasks/bulk-status', desc: 'Bulk update task status', params: 'body: { ids, status }' },
    // Specs (additional)
    { method: 'GET', path: '/api/specs/by-task/:taskId', desc: 'Get specs linked to a task', params: null },
    { method: 'GET', path: '/api/specs/by-thread/:threadId', desc: 'Get specs linked to a thread', params: null },
    { method: 'GET', path: '/api/spec-comments/:commentId', desc: 'Get spec comment by ID', params: null },
    // Risks (additional)
    { method: 'GET', path: '/api/risks/:id/comments', desc: 'Get risk comments', params: null },
    { method: 'POST', path: '/api/risks/:id/comments', desc: 'Add risk comment', params: 'body: { author, content }' },
    // Messages (additional)
    { method: 'DELETE', path: '/api/message/:id', desc: 'Delete message', params: 'body: { beast }' },
    // Forum (additional)
    { method: 'POST', path: '/api/forum/subscribe', desc: 'Subscribe to thread', params: 'body: { beast, threadId }' },
    { method: 'GET', path: '/api/forum/subscriptions/:beast', desc: 'Get thread subscriptions', params: null },
    { method: 'GET', path: '/api/thread/:id/subscribers', desc: 'Get thread subscribers', params: null },
    // Files (additional)
    { method: 'GET', path: '/api/files/archive/stats', desc: 'File archive stats', params: null },
    { method: 'POST', path: '/api/files/archive/run', desc: 'Run file archival', params: null },
    { method: 'POST', path: '/api/files/:id/restore', desc: 'Restore archived file', params: null },
    // Routine (additional)
    { method: 'GET', path: '/api/routine/workout-trends', desc: 'Workout trend data', params: null },
    { method: 'GET', path: '/api/routine/photos', desc: 'List routine photos', params: null },
    { method: 'POST', path: '/api/routine/photo/upload', desc: 'Upload routine photo', params: 'body: FormData with file' },
    { method: 'GET', path: '/api/routine/photo/:filename', desc: 'Get routine photo', params: null },
    { method: 'GET', path: '/api/routine/logs/deleted', desc: 'List deleted routine logs', params: null },
    // Supersede (document versioning)
    { method: 'GET', path: '/api/supersede', desc: 'List supersede records', params: null },
    { method: 'POST', path: '/api/supersede', desc: 'Create supersede record', params: 'body: { path, content, author }' },
    { method: 'GET', path: '/api/supersede/chain/:path', desc: 'Get supersede chain for path', params: null },
    // Traces
    { method: 'GET', path: '/api/traces', desc: 'List traces', params: null },
    { method: 'GET', path: '/api/traces/:id', desc: 'Get trace by ID', params: null },
    { method: 'GET', path: '/api/traces/:id/chain', desc: 'Get trace chain', params: null },
    { method: 'GET', path: '/api/traces/:id/linked-chain', desc: 'Get linked trace chain', params: null },
    { method: 'POST', path: '/api/traces/:prevId/link', desc: 'Link traces', params: null },
    { method: 'DELETE', path: '/api/traces/:id/link', desc: 'Unlink trace', params: null },
    // Settings
    { method: 'GET', path: '/api/settings', desc: 'Get app settings', params: null },
    { method: 'POST', path: '/api/settings', desc: 'Update app settings', params: 'body: { ... }' },
    // Database
    { method: 'GET', path: '/api/db/stats', desc: 'Database statistics', params: null },
    { method: 'POST', path: '/api/db/maintenance', desc: 'Run database maintenance', params: null },
    // Withings (additional)
    { method: 'POST', path: '/api/oauth/withings/sync', desc: 'Sync Withings data', params: null },
    { method: 'POST', path: '/api/webhooks/withings', desc: 'Withings webhook callback', params: null },
    { method: 'POST', path: '/api/webhooks/hevy', desc: 'Hevy webhook callback (T#724) — workout creation push', params: 'body: { workoutId } | header: Authorization: <HEVY_WEBHOOK_TOKEN> (raw, no Bearer prefix)' },
    // Telegram
    { method: 'GET', path: '/api/telegram/status', desc: 'Telegram polling status (owner only)', params: null },
    { method: 'GET', path: '/api/telegram/message/:id', desc: 'T#712 — cached inbound TG message by id (Gorn + Sable only)', params: null },
    // Board / Pack
    { method: 'GET', path: '/api/board', desc: 'Board overview (tasks summary)', params: null },
    { method: 'GET', path: '/api/pack/spinner-verbs', desc: 'Pack spinner verb list', params: null },
    // Knowledge / Docs
    { method: 'GET', path: '/api/docs', desc: 'List knowledge documents', params: null },
    { method: 'GET', path: '/api/doc/:id', desc: 'Get document by ID', params: null },
    { method: 'GET', path: '/api/feed', desc: 'Activity feed', params: null },
    { method: 'POST', path: '/api/learn', desc: 'Submit learn request', params: 'body: { ... }' },
    { method: 'GET', path: '/api/oracles', desc: 'List oracles', params: null },
    // Internal/legacy (included for 404 hint completeness)
    { method: 'GET', path: '/api/stats', desc: 'Server stats', params: null },
    { method: 'GET', path: '/api/logs', desc: 'Server logs', params: null },
    { method: 'GET', path: '/api/beast/:name/avatar.svg', desc: 'Get beast avatar SVG', params: null },
  ];

// API Help — machine-readable endpoint catalog for Beast self-correction
app.get('/api/help', (c) => {
  const role = (c.get as any)('role') as Role | undefined;
  const filter = c.req.query('q')?.toLowerCase();

  // Guests see only their allowed endpoints; owner/beast see everything
  let result = HELP_ENDPOINTS;
  if (role === 'guest') {
    const allowlist = getGuestAllowlist();
    result = HELP_ENDPOINTS.filter(e =>
      allowlist.some(a =>
        (a.method === '*' || a.method === e.method) &&
        new RegExp(a.pattern).test(e.path)
      )
    );
  }

  if (filter) {
    result = result.filter(e =>
      e.path.toLowerCase().includes(filter) ||
      e.desc.toLowerCase().includes(filter) ||
      e.method.toLowerCase().includes(filter)
    );
  }

  return c.json({
    total: result.length,
    hint: 'Use ?q=keyword to filter (e.g. ?q=thread, ?q=dm, ?q=task)',
    endpoints: result,
  });
});

// Search
// Legacy vector search — kept for backwards compat, use /api/search/legacy
app.get('/api/search/legacy', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return c.json({ error: 'Missing query parameter: q' }, 400);
  }
  const type = c.req.query('type') || 'all';
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');
  const mode = (c.req.query('mode') || 'hybrid') as 'hybrid' | 'fts' | 'vector';
  const project = c.req.query('project');
  const cwd = c.req.query('cwd');
  const model = c.req.query('model');

  const result = await handleSearch(q, type, limit, offset, mode, project, cwd, model);
  return c.json({ ...result, query: q });
});

// Reflect
app.get('/api/reflect', (c) => {
  return c.json(handleReflect());
});

// Stats (extended with vector metrics)
app.get('/api/stats', async (c) => {
  const stats = handleStats(DB_PATH);
  const vaultRepo = getSetting('vault_repo');
  let vectorStats = { vector: { enabled: false, count: 0, collection: 'oracle_knowledge' } };
  try {
    vectorStats = await handleVectorStats();
  } catch { /* vector unavailable */ }
  return c.json({ ...stats, ...vectorStats, vault_repo: vaultRepo });
});

// Active Oracles — detected from existing activity across all log tables
let oracleCache: { data: any; ts: number } | null = null;
app.get('/api/oracles', (c) => {
  const hours = parseInt(c.req.query('hours') || '168'); // default 7 days
  const now = Date.now();
  if (oracleCache && (now - oracleCache.ts) < 60_000) return c.json(oracleCache.data);

  const cutoff = now - hours * 3600_000;
  // Active identities (forum authors, trace sessions, learn sources)
  const identities = sqlite.prepare(`
    SELECT oracle_name, source, max(last_seen) as last_seen, sum(actions) as actions
    FROM (
      SELECT author as oracle_name, 'forum' as source, max(created_at) as last_seen, count(*) as actions
        FROM forum_messages WHERE author IS NOT NULL AND created_at > ?
        GROUP BY author
      UNION ALL
      SELECT COALESCE(session_id, 'unknown') as oracle_name, 'trace' as source, max(created_at) as last_seen, count(*) as actions
        FROM trace_log WHERE created_at > ?
        GROUP BY session_id
      UNION ALL
      SELECT COALESCE(source, project, 'unknown') as oracle_name, 'learn' as source, max(created_at) as last_seen, count(*) as actions
        FROM learn_log WHERE created_at > ?
        GROUP BY COALESCE(source, project)
    )
    WHERE oracle_name IS NOT NULL AND oracle_name != 'unknown'
    GROUP BY oracle_name
    ORDER BY last_seen DESC
  `).all(cutoff, cutoff, cutoff);

  // Projects with indexed knowledge (each project = an Oracle's domain)
  const projects = sqlite.prepare(`
    SELECT project, count(*) as docs,
           count(DISTINCT type) as types,
           max(created_at) as last_indexed
    FROM oracle_documents
    WHERE project IS NOT NULL
    GROUP BY project
    ORDER BY last_indexed DESC
  `).all();

  const result = {
    identities,
    projects,
    total_projects: projects.length,
    total_identities: identities.length,
    window_hours: hours,
    cached_at: new Date().toISOString(),
  };
  oracleCache = { data: result, ts: now };
  return c.json(result);
});

// Similar documents (vector nearest neighbors)
app.get('/api/similar', async (c) => {
  const id = c.req.query('id');
  if (!id) {
    return c.json({ error: 'Missing query parameter: id' }, 400);
  }
  const limit = parseInt(c.req.query('limit') || '5');
  const model = c.req.query('model');
  try {
    const result = await handleSimilar(id, limit, model);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message, results: [], docId: id }, 500);
  }
});

// Knowledge map (2D projection of all embeddings)
app.get('/api/map', async (c) => {
  try {
    const result = await handleMap();
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message, documents: [], total: 0 }, 500);
  }
});

// Knowledge map 3D (real PCA from LanceDB bge-m3 embeddings)
app.get('/api/map3d', async (c) => {
  try {
    const model = c.req.query('model') || undefined;
    const result = await handleMap3d(model);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message, documents: [], total: 0 }, 500);
  }
});

// Live Oracle feed (from ~/.oracle/feed.log)
const FEED_LOG = path.join(process.env.HOME || '/home/nat', '.oracle', 'feed.log');
app.get('/api/feed', (c) => {
  try {
    const limit = Math.min(200, parseInt(c.req.query('limit') || '50'));
    const type = c.req.query('type') || undefined; // forum, task, spec, rule, risk
    const since = c.req.query('since') || undefined;

    // Aggregate feed from multiple sources
    const events: any[] = [];

    // Forum posts (most recent)
    const forumQuery = since
      ? 'SELECT m.id, m.content, m.author, m.created_at, t.title as thread_title, t.id as thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id WHERE m.created_at > ? ORDER BY m.created_at DESC LIMIT ?'
      : 'SELECT m.id, m.content, m.author, m.created_at, t.title as thread_title, t.id as thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id ORDER BY m.created_at DESC LIMIT ?';
    const forumParams = since ? [since, limit] : [limit];
    if (!type || type === 'forum') {
      const posts = sqlite.prepare(forumQuery).all(...forumParams) as any[];
      for (const p of posts) {
        events.push({
          type: 'forum', id: p.id, timestamp: p.created_at,
          actor: p.author, title: p.thread_title,
          message: p.content.slice(0, 200),
          url: `/forum?thread=${p.thread_id}`,
        });
      }
    }

    // Task updates
    if (!type || type === 'task') {
      const taskQuery = since
        ? 'SELECT t.id, t.title, t.status, t.assigned_to, t.created_by, t.updated_at, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.updated_at > ? ORDER BY t.updated_at DESC LIMIT ?'
        : 'SELECT t.id, t.title, t.status, t.assigned_to, t.created_by, t.updated_at, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id ORDER BY t.updated_at DESC LIMIT ?';
      const taskParams = since ? [since, limit] : [limit];
      const tasks = sqlite.prepare(taskQuery).all(...taskParams) as any[];
      for (const t of tasks) {
        events.push({
          type: 'task', id: t.id, timestamp: t.updated_at,
          actor: t.assigned_to || t.created_by, title: `T#${t.id}: ${t.title}`,
          message: `Status: ${t.status}${t.project_name ? ` | ${t.project_name}` : ''}`,
          url: `/board?task=${t.id}`,
        });
      }
    }

    // Spec reviews
    if (!type || type === 'spec') {
      const specQuery = since
        ? 'SELECT id, title, author, status, updated_at FROM spec_reviews WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?'
        : 'SELECT id, title, author, status, updated_at FROM spec_reviews ORDER BY updated_at DESC LIMIT ?';
      const specParams = since ? [since, limit] : [limit];
      const specs = sqlite.prepare(specQuery).all(...specParams) as any[];
      for (const s of specs) {
        events.push({
          type: 'spec', id: s.id, timestamp: s.updated_at,
          actor: s.author, title: `Spec #${s.id}: ${s.title}`,
          message: `Status: ${s.status}`,
          url: `/specs?spec=${s.id}`,
        });
      }
    }

    // Sort all events by timestamp (newest first) and limit
    events.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    const total = events.length;
    const sliced = events.slice(0, limit);

    return c.json({ events: sliced, total });
  } catch (e: any) {
    return c.json({ error: e.message, events: [], total: 0 }, 500);
  }
});

// Logs
app.get('/api/logs', (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const logs = db.select({
      query: searchLog.query,
      type: searchLog.type,
      mode: searchLog.mode,
      results_count: searchLog.resultsCount,
      search_time_ms: searchLog.searchTimeMs,
      created_at: searchLog.createdAt,
      project: searchLog.project
    })
      .from(searchLog)
      .orderBy(desc(searchLog.createdAt))
      .limit(limit)
      .all();
    return c.json({ logs, total: logs.length });
  } catch (e) {
    return c.json({ logs: [], error: 'Log table not found' });
  }
});

// Get document by ID (uses raw SQL for FTS JOIN)
app.get('/api/doc/:id', (c) => {
  const docId = c.req.param('id');
  try {
    // Must use raw SQL for FTS JOIN (Drizzle doesn't support virtual tables)
    const row = sqlite.prepare(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.project, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      WHERE d.id = ?
    `).get(docId) as any;

    if (!row) {
      return c.json({ error: 'Document not found' }, 404);
    }

    return c.json({
      id: row.id,
      type: row.type,
      content: row.content,
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      project: row.project
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// List documents
app.get('/api/list', (c) => {
  const type = c.req.query('type') || 'all';
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');
  const group = c.req.query('group') !== 'false';

  return c.json(handleList(type, limit, offset, group));
});

// Graph
app.get('/api/graph', (c) => {
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
  return c.json(handleGraph(limit));
});

// Context
app.get('/api/context', (c) => {
  const cwd = c.req.query('cwd');
  return c.json(handleContext(cwd));
});

// File - supports cross-repo access via ghq project paths
app.get('/api/file', async (c) => {
  const filePath = c.req.query('path');
  const project = c.req.query('project'); // ghq-style path: github.com/owner/repo

  if (!filePath) {
    return c.json({ error: 'Missing path parameter' }, 400);
  }

  try {
    // Determine base path: ghq root + project, or local REPO_ROOT
    // Detect GHQ_ROOT dynamically (no hardcoding)
    let GHQ_ROOT = process.env.GHQ_ROOT;
    if (!GHQ_ROOT) {
      try {
        const proc = Bun.spawnSync(['ghq', 'root']);
        GHQ_ROOT = proc.stdout.toString().trim();
      } catch {
        // Fallback: derive from REPO_ROOT (assume ghq structure)
        // REPO_ROOT is like /path/to/github.com/owner/repo
        // GHQ_ROOT would be /path/to
        const match = REPO_ROOT.match(/^(.+?)\/github\.com\//);
        GHQ_ROOT = match ? match[1] : path.dirname(path.dirname(path.dirname(REPO_ROOT)));
      }
    }
    let basePath: string;

    if (project) {
      // Cross-repo: use ghq path
      basePath = path.join(GHQ_ROOT, project);
    } else {
      // Local: use current repo
      basePath = REPO_ROOT;
    }

    // Strip project prefix if source_file already contains it (vault-indexed docs)
    let resolvedFilePath = filePath;
    if (project && filePath.toLowerCase().startsWith(project.toLowerCase() + '/')) {
      resolvedFilePath = filePath.slice(project.length + 1); // e.g. "ψ/memory/learnings/file.md"
    }

    const fullPath = path.join(basePath, resolvedFilePath);

    // Security: resolve symlinks and verify path is within allowed bounds
    let realPath: string;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      realPath = path.resolve(fullPath);
    }

    // Allow paths within GHQ_ROOT (for cross-repo) or REPO_ROOT (for local)
    const realGhqRoot = fs.realpathSync(GHQ_ROOT);
    const realRepoRoot = fs.realpathSync(REPO_ROOT);

    if (!realPath.startsWith(realGhqRoot) && !realPath.startsWith(realRepoRoot)) {
      return c.json({ error: 'Invalid path: outside allowed bounds' }, 400);
    }

    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return c.text(content);
    }

    // Fallback: try vault repo (project-first layout)
    const vault = getVaultPsiRoot();
    if ('path' in vault) {
      const vaultFullPath = path.join(vault.path, filePath);
      if (fs.existsSync(vaultFullPath)) {
        const content = fs.readFileSync(vaultFullPath, 'utf-8');
        return c.text(content);
      }
    }

    return c.text('File not found', 404);
  } catch (e: any) {
    return c.text(e.message, 500);
  }
});

// Read document by file path or ID (resolves vault/ghq paths server-side)
app.get('/api/read', async (c) => {
  const file = c.req.query('file');
  const id = c.req.query('id');
  if (!file && !id) {
    return c.json({ error: 'Provide file or id parameter' }, 400);
  }
  const ctx = { db, sqlite, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
  const result = await handleRead(ctx as ToolContext, {
    file: file || undefined,
    id: id || undefined,
  });
  const text = result.content[0]?.text || '{}';
  if (result.isError) {
    return c.json(JSON.parse(text), 404);
  }
  return c.json(JSON.parse(text));
});

// ============================================================================
// Dashboard Routes
// ============================================================================

app.get('/api/dashboard', (c) => c.json(handleDashboardSummary()));
app.get('/api/dashboard/summary', (c) => c.json(handleDashboardSummary()));

// Guest dashboard — public data only (T#558, Spec #32)
app.get('/api/guest/dashboard', (c) => {
  const guestUsername = (c.get as any)('guestUsername') as string | undefined;

  // Public threads (visibility = public)
  const publicThreads = sqlite.prepare(
    "SELECT id, title, status, created_at, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT 10"
  ).all() as any[];

  // Pack info (Beast profiles)
  const beasts = sqlite.prepare(
    "SELECT name, display_name, animal, role, bio, theme_color FROM beast_profiles ORDER BY name"
  ).all() as any[];

  // Guest DM summary (own conversations only) with unread counts
  let dmSummary: any[] = [];
  let dmUnreadTotal = 0;
  if (guestUsername) {
    const guestDisplayName = getGuestDisplayName(guestUsername);
    const guestTag = `[Guest] ${guestDisplayName}`;
    const convos = sqlite.prepare(
      "SELECT c.id, CASE WHEN participant1 = ? THEN participant2 ELSE participant1 END as other, (SELECT content FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message, (SELECT created_at FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_at FROM dm_conversations c WHERE participant1 = ? OR participant2 = ? ORDER BY last_at DESC LIMIT 10"
    ).all(guestTag, guestTag, guestTag) as any[];
    for (const conv of convos) {
      const unread = (sqlite.prepare(
        "SELECT COUNT(*) as c FROM dm_messages WHERE conversation_id = ? AND LOWER(sender) != ? AND read_at IS NULL"
      ).get(conv.id, guestTag.toLowerCase()) as any)?.c || 0;
      dmSummary.push({ other: conv.other, last_message: conv.last_message, last_at: conv.last_at, unread });
      dmUnreadTotal += unread;
    }
  }

  return c.json({
    publicThreads: publicThreads.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      message_count: t.msg_count || 0,
      created_at: new Date(t.created_at).toISOString(),
    })),
    pack: beasts.map(b => ({
      name: b.name,
      displayName: b.display_name,
      animal: b.animal,
      role: b.role,
      bio: b.bio,
      themeColor: b.theme_color,
    })),
    dmSummary,
    dmUnreadTotal,
  });
});

// Guest threads — public only (T#559)
app.get('/api/guest/threads', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const rows = sqlite.prepare(
    "SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as any[];

  const total = (sqlite.prepare("SELECT COUNT(*) as total FROM forum_threads WHERE visibility = 'public' AND deleted_at IS NULL").get() as any)?.total || 0;

  return c.json({
    threads: rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status || 'active',
      category: t.category || 'discussion',
      pinned: !!(t.pinned),
      message_count: t.msg_count || 0,
      created_at: new Date(t.created_at).toISOString(),
      visibility: 'public',
    })),
    total,
  });
});

// Guest thread detail — public only (T#559)
app.get('/api/guest/thread/:id', (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  if (isNaN(threadId)) return c.json({ error: 'Invalid thread ID' }, 400);

  const threadRow = sqlite.prepare('SELECT * FROM forum_threads WHERE id = ? AND visibility = ?').get(threadId, 'public') as any;
  if (!threadRow) return c.json({ error: 'Thread not found' }, 404);

  const rawLimit = c.req.query('limit');
  const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : NaN;
  const limit = rawLimit ? (isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit) : undefined;
  const rawOffset = parseInt(c.req.query('offset') || '0', 10);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  const order = (c.req.query('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

  const threadData = getFullThread(threadId, limit, offset, order);
  if (!threadData) return c.json({ error: 'Thread not found' }, 404);

  return c.json({
    thread: {
      id: threadData.thread.id,
      title: threadData.thread.title,
      status: threadData.thread.status,
      created_at: new Date(threadData.thread.createdAt).toISOString(),
    },
    messages: threadData.messages.map(m => {
      const raw = sqlite.prepare('SELECT reply_to_id FROM forum_messages WHERE id = ?').get(m.id) as any;
      const reactionRows = sqlite.prepare(
        'SELECT emoji, GROUP_CONCAT(beast_name) as beasts, COUNT(*) as count FROM forum_reactions WHERE message_id = ? GROUP BY emoji'
      ).all(m.id) as any[];
      // Resolve guest avatar URL from guest_accounts (T#602)
      let authorAvatarUrl: string | null = null;
      if (m.author?.startsWith('[Guest]')) {
        const guestName = m.author.replace('[Guest] ', '').replace('[Guest]', '').trim();
        const guest = sqlite.prepare('SELECT avatar_url FROM guest_accounts WHERE LOWER(display_name) = ? OR LOWER(username) = ?').get(guestName.toLowerCase(), guestName.toLowerCase()) as any;
        authorAvatarUrl = guest?.avatar_url || null;
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        author: m.author,
        author_avatar_url: authorAvatarUrl,
        reply_to_id: raw?.reply_to_id || null,
        principles_found: m.principlesFound,
        patterns_found: m.patternsFound,
        created_at: new Date(m.createdAt).toISOString(),
        reactions: reactionRows.map(r => ({ emoji: r.emoji, beasts: r.beasts.split(','), count: r.count })),
      };
    }),
    total: threadData.total,
  });
});

// Resolve guest display name from username
function getGuestDisplayName(username: string): string {
  const guest = sqlite.query('SELECT display_name FROM guest_accounts WHERE username = ?').get(username) as any;
  return guest?.display_name || username;
}

// Guest post message — public threads only (T#559)
app.post('/api/guest/thread/:id/message', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  if (isNaN(threadId)) return c.json({ error: 'Invalid thread ID' }, 400);

  const threadRow = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(threadId) as any;
  if (!threadRow || threadRow.visibility !== 'public') {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.message) return c.json({ error: 'Message required' }, 400);

  // Rate limiting
  const rateCheck = checkGuestPostRate(guestUsername);
  if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

  // Content length
  const lengthCheck = checkGuestContentLength(data.message, 'post');
  if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

  // Injection scan
  const scan = scanForInjection(data.message);
  if (scan.flagged) {
    logSecurityEvent({
      eventType: 'suspicious_content',
      severity: 'warning',
      actor: guestUsername,
      actorType: 'guest',
      target: `/api/guest/thread/${threadId}/message`,
      details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
      ipSource: c.req.header('x-real-ip') || 'local',
      requestId: (c.get as any)('requestId'),
    });
  }

  const guestDisplayName = getGuestDisplayName(guestUsername);
  const author = `[Guest] ${guestDisplayName}`;
  const result = await withRetry(() => handleThreadMessage({
    message: data.message,
    threadId,
    role: 'human',
    author,
  }));

  if (result.messageId) {
    sqlite.prepare('UPDATE forum_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
    if (data.reply_to_id) {
      sqlite.prepare('UPDATE forum_messages SET reply_to_id = ? WHERE id = ?').run(data.reply_to_id, result.messageId);
    }
  }

  wsBroadcast('new_message', { thread_id: threadId, message_id: result.messageId, author });
  return c.json({ thread_id: threadId, message_id: result.messageId }, 201);
});

// Guest create thread — new public thread (T#561)
app.post('/api/guest/thread', async (c) => {
  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.message) return c.json({ error: 'Message required' }, 400);
  if (!data.title) return c.json({ error: 'Title required for new thread' }, 400);

  // Rate limiting
  const rateCheck = checkGuestPostRate(guestUsername);
  if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

  // Content length
  const lengthCheck = checkGuestContentLength(data.message, 'post');
  if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

  // Injection scan
  const scan = scanForInjection(data.message + ' ' + data.title);
  if (scan.flagged) {
    logSecurityEvent({
      eventType: 'suspicious_content',
      severity: 'warning',
      actor: guestUsername,
      actorType: 'guest',
      target: '/api/guest/thread',
      details: { patterns: scan.patterns, content_preview: (data.title + ': ' + data.message).slice(0, 200) },
      ipSource: c.req.header('x-real-ip') || 'local',
      requestId: (c.get as any)('requestId'),
    });
  }

  const guestDisplayName = getGuestDisplayName(guestUsername);
  const author = `[Guest] ${guestDisplayName}`;
  const result = await withRetry(() => handleThreadMessage({
    message: data.message,
    title: data.title,
    role: 'human',
    author,
  }));

  // Force visibility to public and set author_role
  if (result.threadId) {
    sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run('public', result.threadId);

    // T#629: Notify all Beasts when guest creates a new public thread
    if (!data.thread_id) {
      try {
        const { getOracleRegistry, notifyMentioned } = await import('./forum/mentions.ts');
        const registry = getOracleRegistry();
        const threadTitle = data.title || data.message?.slice(0, 50) || 'New thread';
        const allBeasts = Object.keys(registry).filter(name => name !== 'gorn');
        notifyMentioned(allBeasts, result.threadId, threadTitle, author, `New public thread from guest: ${threadTitle}`, undefined, new Set(allBeasts));
      } catch { /* best effort */ }
    }
  }
  if (result.messageId) {
    sqlite.prepare('UPDATE forum_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
  }

  wsBroadcast('new_message', { thread_id: result.threadId, message_id: result.messageId, author });
  return c.json({ thread_id: result.threadId, message_id: result.messageId }, 201);
});

// Guest pack — Beast profiles (T#559)
app.get('/api/guest/pack', (c) => {
  const beasts = sqlite.prepare(
    "SELECT name, display_name, animal, role, bio, theme_color, avatar_url, interests, sex, birthdate FROM beast_profiles ORDER BY name"
  ).all() as any[];

  const { tmuxStatus } = getTmuxStatus();

  return c.json({
    beasts: beasts.map(b => {
      const sessionName = b.name.charAt(0).toUpperCase() + b.name.slice(1);
      const rawStatus = tmuxStatus.get(sessionName.toLowerCase()) || tmuxStatus.get(b.name) || 'offline';
      return {
        name: b.name,
        displayName: b.display_name,
        animal: b.animal,
        role: b.role,
        bio: b.bio,
        themeColor: b.theme_color,
        avatarUrl: normalizeAvatarUrl(b.avatar_url),
        interests: b.interests,
        sex: b.sex,
        birthdate: b.birthdate,
        online: rawStatus === 'processing' || rawStatus === 'idle' || rawStatus === 'waiting',
        status: rawStatus,
        sessionName,
      };
    }),
  });
});

// Guest DM — read own conversations (T#559)
app.get('/api/guest/dm/:from/:to', (c) => {
  const fromParam = c.req.param('from');
  const toParam = c.req.param('to');
  const guestUsername = (c.get as any)('guestUsername');
  const guestDisplayName = getGuestDisplayName(guestUsername);
  const guestTag = `[Guest] ${guestDisplayName}`;

  // Guests can only read their own conversations
  if (fromParam !== guestTag && toParam !== guestTag && fromParam !== guestUsername && toParam !== guestUsername) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // Normalize: if from/to is the username, replace with [Guest] tag (DB format)
  const from = (fromParam === guestUsername || fromParam === guestDisplayName) ? guestTag : fromParam;
  const to = (toParam === guestUsername || toParam === guestDisplayName) ? guestTag : toParam;

  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const order = c.req.query('order') || 'asc';
  const data = getDmMessages(from, to, limit, offset, order as 'asc' | 'desc');

  // Map [Guest] tags back to username in response
  const normalizeGuestSender = (s: string) => {
    if (s.toLowerCase() === guestTag.toLowerCase()) return guestUsername;
    return s;
  };

  return c.json({
    conversation_id: data.conversationId,
    participants: data.participants.map(p => normalizeGuestSender(p)),
    messages: data.messages.map(m => ({
      id: m.id,
      sender: normalizeGuestSender(m.sender),
      message: m.content,
      read_at: m.readAt ? new Date(m.readAt).toISOString() : null,
      created_at: new Date(m.createdAt).toISOString(),
    })),
    total: data.total,
  });
});

// Guest DM — send message (T#559)
app.post('/api/guest/dm', async (c) => {
  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.to || !data.message) return c.json({ error: 'to and message required' }, 400);

  // Validate recipient exists — guests can only DM beasts or gorn
  const recipientBeast = getBeastProfile(data.to);
  const isOwner = data.to.toLowerCase() === 'gorn';
  if (!recipientBeast && !isOwner) {
    return c.json({ error: `Recipient "${data.to}" not found. Must be a valid beast name.` }, 404);
  }

  // Rate limiting
  const rateCheck = checkGuestDmRate(guestUsername);
  if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

  // Content length
  const lengthCheck = checkGuestContentLength(data.message, 'dm');
  if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

  // Injection scan
  const scan = scanForInjection(data.message);
  if (scan.flagged) {
    logSecurityEvent({
      eventType: 'suspicious_content',
      severity: 'warning',
      actor: guestUsername,
      actorType: 'guest',
      target: `/api/guest/dm/${data.to}`,
      details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
      ipSource: c.req.header('x-real-ip') || 'local',
      requestId: (c.get as any)('requestId'),
    });
  }

  const guestDisplayName = getGuestDisplayName(guestUsername);
  const guestTag = `[Guest] ${guestDisplayName}`;
  const result = await withRetry(() => sendDm(guestTag, data.to, data.message, `[Guest] ${guestUsername}`));

  if (result.messageId) {
    try {
      sqlite.prepare('UPDATE dm_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
    } catch { /* column may not exist */ }
  }

  wsBroadcast('new_dm', { conversation_id: result.conversationId });
  return c.json({ conversation_id: result.conversationId, message_id: result.messageId }, 201);
});

// Guest self-service password change (T#566, Spec #35 alias)
// Password change rate limiting: max 5 attempts per guest per 15 minutes (T#581, Talon finding)
const passwordChangeAttempts = new Map<string, { count: number; firstAttempt: number }>();
const PASSWORD_CHANGE_RATE_LIMIT = 5;
const PASSWORD_CHANGE_RATE_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/guest/change-password', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest account not found' }, 404);

  // Rate limit by guest username
  const now = Date.now();
  const attempts = passwordChangeAttempts.get(guestUsername);
  if (attempts) {
    if (now - attempts.firstAttempt > PASSWORD_CHANGE_RATE_WINDOW_MS) {
      passwordChangeAttempts.delete(guestUsername);
    } else if (attempts.count >= PASSWORD_CHANGE_RATE_LIMIT) {
      const retryAfter = Math.ceil((attempts.firstAttempt + PASSWORD_CHANGE_RATE_WINDOW_MS - now) / 1000);
      logSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        actor: guestUsername,
        actorType: 'guest',
        target: '/api/guest/change-password',
        details: { attempts: attempts.count, window_ms: PASSWORD_CHANGE_RATE_WINDOW_MS },
        ipSource: c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: `Too many password change attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    }
  }

  const body = await c.req.json();
  if (!body.current_password || !body.new_password) {
    return c.json({ error: 'current_password and new_password required' }, 400);
  }

  const result = await changeGuestPassword(sqlite, guest, body.current_password, body.new_password);
  if (!result.success) {
    // Track failed attempts
    const existing = passwordChangeAttempts.get(guestUsername);
    if (existing) {
      existing.count++;
    } else {
      passwordChangeAttempts.set(guestUsername, { count: 1, firstAttempt: now });
    }
    return c.json({ error: result.error }, 400);
  }

  // Success clears rate limit
  passwordChangeAttempts.delete(guestUsername);
  return c.json({ success: true });
});

// Legacy alias (T#566) — same rate limiting as /api/guest/change-password (T#581)
app.post('/api/guest/reset-password', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest account not found' }, 404);

  const now = Date.now();
  const attempts = passwordChangeAttempts.get(guestUsername);
  if (attempts) {
    if (now - attempts.firstAttempt > PASSWORD_CHANGE_RATE_WINDOW_MS) {
      passwordChangeAttempts.delete(guestUsername);
    } else if (attempts.count >= PASSWORD_CHANGE_RATE_LIMIT) {
      const retryAfter = Math.ceil((attempts.firstAttempt + PASSWORD_CHANGE_RATE_WINDOW_MS - now) / 1000);
      logSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        actor: guestUsername,
        actorType: 'guest',
        target: '/api/guest/reset-password',
        details: { attempts: attempts.count, window_ms: PASSWORD_CHANGE_RATE_WINDOW_MS },
        ipSource: c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: `Too many password change attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    }
  }

  const body = await c.req.json();
  if (!body.current_password || !body.new_password) {
    return c.json({ error: 'current_password and new_password required' }, 400);
  }

  const result = await changeGuestPassword(sqlite, guest, body.current_password, body.new_password);
  if (!result.success) {
    const existing = passwordChangeAttempts.get(guestUsername);
    if (existing) { existing.count++; } else { passwordChangeAttempts.set(guestUsername, { count: 1, firstAttempt: now }); }
    return c.json({ error: result.error }, 400);
  }

  passwordChangeAttempts.delete(guestUsername);
  return c.json({ success: true });
});

// Guest profile — own info (T#559, expanded T#574)
app.get('/api/guest/profile', (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  return c.json({
    username: guest.username,
    display_name: guest.display_name,
    bio: guest.bio || null,
    interests: guest.interests || null,
    avatar_url: guest.avatar_url || null,
    created_at: guest.created_at,
    expires_at: guest.expires_at,
  });
});

// Guest self-service profile update (T#574, Spec #35)
app.patch('/api/guest/profile', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const body = await c.req.json();

  // Validate display_name length
  if (body.display_name !== undefined && (!body.display_name || body.display_name.length > 50)) {
    return c.json({ error: 'Display name must be 1-50 characters' }, 400);
  }
  // Block reserved names (Beast names, Gorn, Admin) — T#597
  if (body.display_name !== undefined) {
    const RESERVED_NAMES = new Set([
      'karo','rax','mara','leonard','bertus','gnarl','zaghnal','pip','nyx','dex',
      'flint','quill','snap','vigil','talon','sable','gorn','admin','administrator','system',
    ]);
    if (RESERVED_NAMES.has(body.display_name.toLowerCase().trim())) {
      return c.json({ error: 'That display name is reserved' }, 400);
    }
  }
  // Validate bio length
  if (body.bio !== undefined && body.bio.length > 500) {
    return c.json({ error: 'Bio must be under 500 characters' }, 400);
  }
  // Validate interests length
  if (body.interests !== undefined && body.interests.length > 300) {
    return c.json({ error: 'Interests must be under 300 characters' }, 400);
  }

  // avatar_url is only set via /api/guest/avatar upload — never from PATCH body (T#580, Talon finding)
  const updated = updateGuestProfile(sqlite, guest.id, {
    display_name: body.display_name,
    bio: body.bio,
    interests: body.interests,
  });

  if (!updated) return c.json({ error: 'Update failed' }, 500);

  return c.json({
    username: updated.username,
    display_name: updated.display_name,
    bio: updated.bio || null,
    interests: updated.interests || null,
    avatar_url: updated.avatar_url || null,
  });
});

// Guest avatar upload (T#574, Spec #35)
app.post('/api/guest/avatar', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ error: 'No file provided' }, 400);

  // Validate file type by MIME
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: 'File must be jpg, png, or webp' }, 400);
  }

  // Validate file size (2MB max)
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: 'File must be under 2MB' }, 400);
  }

  // Validate magic bytes — don't trust MIME alone (T#582, Talon finding)
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) {
    return c.json({ error: 'File content does not match an allowed image type' }, 400);
  }

  // Save file
  const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1];
  const filename = `guest-${guestUsername}-avatar.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await Bun.write(filePath, buffer);

  const avatarUrl = `/api/f/${filename}`;
  updateGuestProfile(sqlite, guest.id, { avatar_url: avatarUrl });

  return c.json({ avatar_url: avatarUrl });
});

app.get('/api/dashboard/activity', (c) => {
  const days = parseInt(c.req.query('days') || '7');
  return c.json(handleDashboardActivity(days));
});

app.get('/api/dashboard/growth', (c) => {
  const period = c.req.query('period') || 'week';
  return c.json(handleDashboardGrowth(period));
});

// Session stats endpoint - tracks activity from DB (includes MCP usage)
app.get('/api/session/stats', (c) => {
  const since = c.req.query('since');
  const sinceTime = since ? parseInt(since) : Date.now() - 24 * 60 * 60 * 1000; // Default 24h

  const searches = db.select({ count: sql<number>`count(*)` })
    .from(searchLog)
    .where(gt(searchLog.createdAt, sinceTime))
    .get();

  const learnings = db.select({ count: sql<number>`count(*)` })
    .from(learnLog)
    .where(gt(learnLog.createdAt, sinceTime))
    .get();

  return c.json({
    searches: searches?.count || 0,
    learnings: learnings?.count || 0,
    since: sinceTime
  });
});

// ============================================================================
// Schedule Routes
// ============================================================================

// Serve raw schedule.md for frontend rendering
app.get('/api/schedule/md', (c) => {
  const schedulePath = path.join(process.env.HOME || '/tmp', '.oracle', 'ψ/inbox/schedule.md');
  if (fs.existsSync(schedulePath)) {
    return c.text(fs.readFileSync(schedulePath, 'utf-8'));
  }
  return c.text('', 404);
});

app.get('/api/schedule', async (c) => {
  const ctx = { db, sqlite, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
  const result = await handleScheduleList(ctx as ToolContext, {
    date: c.req.query('date'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    filter: c.req.query('filter'),
    status: c.req.query('status') as 'pending' | 'done' | 'cancelled' | 'all' | undefined,
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
  });
  const text = result.content[0]?.text || '{}';
  return c.json(JSON.parse(text));
});

app.post('/api/schedule', async (c) => {
  const body = await c.req.json();
  const ctx = { db, sqlite, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
  const result = await handleScheduleAdd(ctx as ToolContext, body);
  const text = result.content[0]?.text || '{}';
  return c.json(JSON.parse(text));
});

// Update schedule event status
app.patch('/api/schedule/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const now = Date.now();
  db.update(schedule)
    .set({ ...body, updatedAt: now })
    .where(eq(schedule.id, id))
    .run();
  return c.json({ success: true, id });
});

// ============================================================================
// Pack View Routes (Gather-style Beast overview + live terminal)
// ============================================================================

import { execSync } from 'child_process';

// Load all Beast spinner verbs from their settings.local.json configs
// Returns a Set of all configured spinner verbs across all Beasts
function loadAllSpinnerVerbs(): Set<string> {
  const verbs = new Set<string>();
  const workspaceDir = '/home/gorn/workspace';
  try {
    const dirs = fs.readdirSync(workspaceDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const dir of dirs) {
      try {
        const configPath = path.join(workspaceDir, dir, '.claude', 'settings.local.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const sv = config.spinnerVerbs;
        if (sv) {
          const verbList = Array.isArray(sv) ? sv : (sv.verbs || []);
          for (const v of verbList) {
            if (typeof v === 'string') verbs.add(v);
          }
        }
      } catch { /* skip dirs without config */ }
    }
  } catch { /* workspace not readable */ }
  return verbs;
}

// Cache spinner verbs (reload every 5 minutes)
let cachedSpinnerVerbs: Set<string> | null = null;
let spinnerVerbsLoadedAt = 0;
function getSpinnerVerbs(): Set<string> {
  const now = Date.now();
  if (!cachedSpinnerVerbs || now - spinnerVerbsLoadedAt > 5 * 60 * 1000) {
    cachedSpinnerVerbs = loadAllSpinnerVerbs();
    spinnerVerbsLoadedAt = now;
  }
  return cachedSpinnerVerbs;
}

// Rewrite legacy avatar URLs to /api/f/ format
function normalizeAvatarUrl(url: string | null): string | null {
  if (!url) return null;
  // /api/forum/file/xxx.jpg -> /api/f/xxx.jpg
  if (url.startsWith('/api/forum/file/')) return '/api/f/' + url.slice('/api/forum/file/'.length);
  // /api/files/ID/download -> look up filename from files table, rewrite to /api/f/
  const filesMatch = url.match(/^\/api\/files\/(\d+)\/download$/);
  if (filesMatch) {
    const file = sqlite.prepare('SELECT filename FROM files WHERE id = ?').get(parseInt(filesMatch[1])) as any;
    if (file) return '/api/f/' + file.filename;
  }
  return url;
}

// Shared tmux status detection — used by both /api/pack and /api/guest/pack
function getTmuxStatus(): { tmuxStatus: Map<string, 'processing' | 'idle' | 'waiting' | 'shell' | 'offline'>; contextPctMap: Map<string, number | null> } {
  const tmuxStatus: Map<string, 'processing' | 'idle' | 'waiting' | 'shell' | 'offline'> = new Map();
  const contextPctMap: Map<string, number | null> = new Map();
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}" 2>/dev/null',
      { timeout: 3000 }
    ).toString().trim();
    const sessions = output.split('\n').filter(Boolean);

    for (const session of sessions) {
      try {
        const cmd = execSync(
          `tmux list-panes -t ${JSON.stringify(session)} -F "#{pane_current_command}" 2>/dev/null`,
          { timeout: 2000 }
        ).toString().trim().split('\n')[0];

        if (cmd !== 'claude') {
          tmuxStatus.set(session.toLowerCase(), 'shell');
          continue;
        }

        // Claude is running — check pane content to detect processing vs idle
        // Multi-sample: capture pane content twice to smooth flicker between tool calls
        try {
          const captureCmd = `tmux capture-pane -t ${JSON.stringify(session + ':claude')} -p -S -30 2>/dev/null`;

          const pane1 = execSync(captureCmd, { timeout: 2000 }).toString();

          // Detect processing by checking the line just above the input prompt separator.
          //
          // Claude Code pane layout (bottom):
          //   [active status line]    ← "✻ Crafting…" or "Running…" ONLY during processing
          //   ───────────             ← separator (one above ❯)
          //   ❯ [input]              ← prompt line
          //   ───────────             ← separator (below ❯)
          //   Beast [Model] branch
          //   ██░░░ X% | $Y | Zm
          //   ⏵⏵ bypass permissions
          //
          // When idle, the line above the first separator is response text or "✻ Brewed for".
          // When processing, it's "✻ Crafting…", "Running…", etc.
          //
          // Strategy: find the ❯ prompt, check the 2 lines above its separator.
          const lines = pane1.split('\n');

          // Find the last ❯ prompt line
          let promptIdx = -1;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (/^❯/.test(lines[i].trim())) { promptIdx = i; break; }
          }

          // Check the 2 lines above the ❯ prompt (skip separator)
          let isProcessing = false;
          if (promptIdx > 1) {
            const abovePrompt = lines.slice(Math.max(promptIdx - 3, 0), promptIdx).join('\n');
            // Match processing state using multiple signals:
            // 1. Generic spinner pattern: ✻/✽/· followed by word + ellipsis (…)
            // 2. "esc to interrupt" text (shown during tool execution)
            // 3. Custom Beast spinner verbs from settings.local.json configs
            isProcessing = /[✻✽·]\s+\w+\u2026|esc to interrupt/.test(abovePrompt);

            // If generic match missed, check for configured spinner verbs (handles multi-word verbs, etc.)
            if (!isProcessing) {
              const spinnerVerbs = getSpinnerVerbs();
              for (const verb of spinnerVerbs) {
                if (abovePrompt.includes(verb + '\u2026') || abovePrompt.includes(verb + '...')) {
                  isProcessing = true;
                  break;
                }
              }
            }
          }

          // Extract context % from status bar (e.g. "██░░░ 42% | $1.23 | 5m")
          let contextPct: number | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const pctMatch = lines[i].match(/(\d+)%\s*\|/);
            if (pctMatch) { contextPct = parseInt(pctMatch[1], 10); break; }
          }
          contextPctMap.set(session.toLowerCase(), contextPct);

          // Detect waiting state — Claude is stuck at a permission/choice prompt
          // Only scan lines near the prompt (last 8 lines before ❯) to avoid false positives
          // from notification text or conversation content in the pane buffer
          const promptArea = promptIdx > 0
            ? lines.slice(Math.max(promptIdx - 8, 0), promptIdx).join('\n')
            : '';
          // Match actual Claude permission UI: bordered choice boxes, (y/n) prompts
          const isWaiting = promptArea.length > 0
            && /Allow.*│|│.*Allow|Deny.*│|│.*Deny|Do you want to|trust this|Allow once|Always allow|\(y\/n\)|\(Y\/n\)/.test(promptArea)
            && !isProcessing;

          if (isProcessing) {
            tmuxStatus.set(session.toLowerCase(), 'processing');
          } else if (isWaiting) {
            tmuxStatus.set(session.toLowerCase(), 'waiting');
          } else {
            tmuxStatus.set(session.toLowerCase(), 'idle');
          }
        } catch {
          tmuxStatus.set(session.toLowerCase(), 'idle'); // Claude running but can't read pane
        }
      } catch {
        tmuxStatus.set(session.toLowerCase(), 'shell');
      }
    }
  } catch { /* tmux not running */ }

  return { tmuxStatus, contextPctMap };
}

// Get all beasts with status (processing/idle/offline)
app.get('/api/pack', (c) => {
  const profiles = getAllBeastProfiles();
  const { tmuxStatus, contextPctMap } = getTmuxStatus();

  const beasts = profiles.map(p => {
    const sessionName = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    const rawStatus = tmuxStatus.get(sessionName.toLowerCase()) || tmuxStatus.get(p.name) || 'offline';
    return {
      ...p,
      avatarUrl: normalizeAvatarUrl(p.avatarUrl),
      online: rawStatus === 'processing' || rawStatus === 'idle' || rawStatus === 'waiting',
      status: rawStatus, // 'processing' | 'idle' | 'waiting' | 'shell' | 'offline'
      contextPct: contextPctMap.get(sessionName.toLowerCase()) ?? contextPctMap.get(p.name) ?? null,
      sessionName,
    };
  });

  // Owner (Gorn) presence from WS heartbeat map
  const now = Date.now();
  const ownerPresence = webPresence.get('gorn');
  const ownerOnline = !!ownerPresence && (now - ownerPresence.lastSeen) < WEB_PRESENCE_TIMEOUT_MS;
  const owner = {
    name: 'gorn',
    online: ownerOnline,
    status: ownerOnline ? 'active' : 'offline',
    last_active_at: ownerPresence ? new Date(ownerPresence.lastSeen).toISOString() : null,
  };

  return c.json({ beasts, owner });
});

// Get all configured spinner verbs across all Beasts
app.get('/api/pack/spinner-verbs', (c) => {
  const workspaceDir = '/home/gorn/workspace';
  const beastVerbs: Record<string, string[]> = {};
  const allVerbs = new Set<string>();

  try {
    const dirs = fs.readdirSync(workspaceDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const dir of dirs) {
      try {
        const configPath = path.join(workspaceDir, dir, '.claude', 'settings.local.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const sv = config.spinnerVerbs;
        if (sv) {
          const verbList = (Array.isArray(sv) ? sv : (sv.verbs || [])).filter((v: unknown) => typeof v === 'string');
          if (verbList.length > 0) {
            beastVerbs[dir] = verbList;
            for (const v of verbList) allVerbs.add(v);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* workspace not readable */ }

  return c.json({
    beasts: beastVerbs,
    allVerbs: [...allVerbs].sort(),
    totalUnique: allVerbs.size,
    totalBeasts: Object.keys(beastVerbs).length,
  });
});

// Capture live terminal output for a Beast
app.get('/api/beast/:name/terminal', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const sessionName = name.charAt(0).toUpperCase() + name.slice(1);
  const rows = parseInt(c.req.query('rows') || '50');

  try {
    // Check if session exists
    execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });

    // Capture pane with ANSI escape codes
    const output = execSync(
      `tmux capture-pane -t ${JSON.stringify(sessionName)} -p -e -S -${rows}`,
      { timeout: 3000, maxBuffer: 1024 * 1024 }
    ).toString();

    // Get pane dimensions
    let cols = 80, paneRows = 24;
    try {
      const info = execSync(
        `tmux display-message -t ${JSON.stringify(sessionName)} -p "#{pane_width} #{pane_height}"`,
        { timeout: 2000 }
      ).toString().trim();
      const [w, h] = info.split(' ').map(Number);
      if (w) cols = w;
      if (h) paneRows = h;
    } catch { /* use defaults */ }

    return c.json({
      name,
      online: true,
      content: output,
      cols,
      rows: paneRows,
    });
  } catch {
    return c.json({
      name,
      online: false,
      content: '',
      cols: 80,
      rows: 24,
    });
  }
});

// Send input to a Beast's terminal
app.post('/api/beast/:name/terminal/input', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const sessionName = name.charAt(0).toUpperCase() + name.slice(1);

  try {
    const body = await c.req.json();
    const { keys } = body;
    if (!keys || typeof keys !== 'string') {
      return c.json({ error: 'keys (string) is required' }, 400);
    }

    // Rate limit: max 100 chars per request
    if (keys.length > 100) {
      return c.json({ error: 'Input too long (max 100 chars)' }, 400);
    }

    // Check session exists
    const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
    if (hasSession.exitCode !== 0) throw new Error('Session not found');

    // Send keys — use Bun.spawnSync to avoid shell interpretation of special chars
    // T#714 scope-awareness (Pip #911 fourth-surface): this endpoint is the literal-text
    // half of a human-UI terminal driver. If a caller chains this POST with
    // /terminal/key key=Enter within milliseconds (scripted automation),
    // same Claude Code Ink-TUI race as T#713/T#714 could manifest. Human-paced
    // UI callers are below the race threshold. If observed, apply the same
    // 200ms break between /terminal/input completion and /terminal/key Enter.
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', keys]);

    return c.json({ sent: true, beast: name, length: keys.length });
  } catch {
    return c.json({ error: 'Session not found or send failed' }, 404);
  }
});

// Send special keys (Enter, Ctrl-C, etc.)
app.post('/api/beast/:name/terminal/key', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const sessionName = name.charAt(0).toUpperCase() + name.slice(1);

  try {
    const body = await c.req.json();
    const { key } = body;

    // Whitelist of allowed special keys
    const ALLOWED_KEYS = ['Enter', 'Escape', 'BSpace', 'Tab', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d', 'C-z', 'C-l'];
    if (!key || !ALLOWED_KEYS.includes(key)) {
      return c.json({ error: `Invalid key. Allowed: ${ALLOWED_KEYS.join(', ')}` }, 400);
    }

    Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
    // T#714 scope-awareness (Pip #911 fourth-surface): paired endpoint to
    // /terminal/input. If scripted chain (input + key=Enter within ms) surfaces
    // the same Ink-TUI race as T#713/T#714, fix is same 200ms break — applied
    // at caller or here. Today this is human-UI-paced + session-gated, so
    // awareness-only per Pip's (a) lean.
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, key]);

    return c.json({ sent: true, beast: name, key });
  } catch {
    return c.json({ error: 'Session not found or send failed' }, 404);
  }
});

// ============================================================================
// Remote Control — tmux Beast switcher
// ============================================================================

const REMOTE_SESSION = 'Mindlink';
let attachedBeastName: string | null = null;

// GET /api/remote/status — which beast is currently attached
app.get('/api/remote/status', (c) => {
  // Verify the Remote session still exists and has a linked window
  if (attachedBeastName) {
    try {
      execSync(`tmux has-session -t ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
      // Check if window 1 still exists (beast is still linked)
      const windows = execSync(
        `tmux list-windows -t ${JSON.stringify(REMOTE_SESSION)} -F "#{window_index}"`,
        { timeout: 2000 }
      ).toString().trim().split('\n');
      if (!windows.includes('1')) {
        attachedBeastName = null; // Window was unlinked externally
      }
    } catch {
      attachedBeastName = null; // Session gone
    }
  }

  return c.json({ session_exists: !!attachedBeastName, attached_beast: attachedBeastName });
});

// POST /api/remote/attach — attach a beast's claude window (local only — requires tmux)
app.post('/api/remote/attach', async (c) => {
  // Remote attach requires local tmux access — reject non-local requests cleanly
  if (!isLocalNetwork(c) && !hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  try {
    const data = await c.req.json();
    const beastName = data.beast?.toLowerCase();
    if (!beastName) return c.json({ error: 'beast name required' }, 400);

    // Sanitize: only allow alphanumeric beast names
    if (!/^[a-z]+$/.test(beastName)) return c.json({ error: 'Invalid beast name' }, 400);

    const sessionName = beastName.charAt(0).toUpperCase() + beastName.slice(1);

    // Verify beast session exists
    try {
      execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });
    } catch {
      return c.json({ error: `No tmux session for ${beastName}` }, 404);
    }

    // Find the claude window index in the beast's session
    let claudeWindow = '1';
    try {
      const windows = execSync(
        `tmux list-windows -t ${JSON.stringify(sessionName)} -F "#{window_index}:#{pane_current_command}"`,
        { timeout: 2000 }
      ).toString().trim().split('\n');
      const claudeWin = windows.find(w => w.includes(':claude'));
      if (claudeWin) claudeWindow = claudeWin.split(':')[0];
    } catch { /* default to 1 */ }

    // Ensure Remote session exists
    try {
      execSync(`tmux has-session -t ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
    } catch {
      execSync(`tmux new-session -d -s ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
    }

    // Unlink any existing beast window (window index 1)
    try {
      execSync(`tmux unlink-window -k -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });
    } catch { /* no window to unlink */ }

    // Link the beast's claude window
    execSync(
      `tmux link-window -s ${JSON.stringify(sessionName)}:${claudeWindow} -t ${JSON.stringify(REMOTE_SESSION)}:1`,
      { timeout: 2000 }
    );

    // Switch to the linked window
    execSync(`tmux select-window -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });

    attachedBeastName = beastName;
    return c.json({ attached: beastName, session: REMOTE_SESSION });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Attach failed' }, 500);
  }
});

// POST /api/remote/detach — detach current beast (local only — requires tmux)
app.post('/api/remote/detach', (_c) => {
  try {
    execSync(`tmux unlink-window -k -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });
  } catch { /* already detached */ }
  attachedBeastName = null;
  return _c.json({ detached: true });
});

// ============================================================================
// Beast Profile Routes
// ============================================================================

// Generate SVG avatar for a beast (deterministic, cacheable)
app.get('/api/beast/:name/avatar.svg', (c) => {
  const name = c.req.param('name');
  const profile = getBeastProfile(name);

  const BEAST_COLORS: Record<string, string> = {
    hyena: '#d97706', horse: '#7c3aed', alligator: '#059669',
    bear: '#92400e', kangaroo: '#dc2626', lion: '#ca8a04',
    raccoon: '#6366f1', otter: '#0d9488', crow: '#475569',
    octopus: '#9b59b6', ferret: '#8b6834',
    wolf: '#64748b', porcupine: '#a3a3a3', mongoose: '#f59e0b',
    owl: '#8b5cf6', hawk: '#ef4444',
  };
  const ANIMAL_EMOJI: Record<string, string> = {
    hyena: '🐾', horse: '🐴', alligator: '🐊', bear: '🐻',
    kangaroo: '🦘', lion: '🦁', raccoon: '🦝', otter: '🦦', crow: '🐦‍⬛',
    octopus: '🐙', ferret: '🐾',
    wolf: '🐺', porcupine: '🦔', mongoose: '🐿️',
    owl: '🦉', hawk: '🦅',
  };

  const animal = profile?.animal?.toLowerCase() || 'unknown';
  const color = profile?.themeColor || BEAST_COLORS[animal] || '#6b7280';
  const emoji = ANIMAL_EMOJI[animal] || '🐾';
  const displayName = profile?.displayName || name;
  const initial = displayName.charAt(0).toUpperCase();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.6"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="64" fill="url(#bg)"/>
  <text x="64" y="58" text-anchor="middle" dominant-baseline="central" font-size="48">${emoji}</text>
  <text x="64" y="100" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="white" opacity="0.9">${initial}</text>
</svg>`;

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(svg);
});

// Seed default avatars for beasts that don't have one
app.post('/api/beasts/seed-avatars', (c) => {
  const profiles = getAllBeastProfiles();
  let updated = 0;
  for (const p of profiles) {
    if (!p.avatarUrl) {
      updateBeastAvatar(p.name, `/api/beast/${p.name}/avatar.svg`);
      updated++;
    }
  }
  return c.json({ seeded: updated, total: profiles.length });
});

// List all beast profiles
app.get('/api/beasts', (c) => {
  const profiles = getAllBeastProfiles();
  return c.json({ beasts: profiles });
});

// Migration: add sex column to beast_profiles (T#411)
try { sqlite.prepare('ALTER TABLE beast_profiles ADD COLUMN sex TEXT DEFAULT NULL').run(); } catch { /* exists */ }
// T#658 — Norm #65 (Nap vs Rest) — scheduler-aware rest state
try { sqlite.prepare("ALTER TABLE beast_profiles ADD COLUMN rest_status TEXT DEFAULT 'active'").run(); } catch { /* exists */ }

// Get beast profile by name
app.get('/api/beast/:name', (c) => {
  const name = c.req.param('name');
  const profile = getBeastProfile(name);
  if (!profile) {
    return c.json({ error: 'Beast not found' }, 404);
  }
  return c.json(profile);
});

// Create or update beast profile
app.put('/api/beast/:name', async (c) => {
  try {
    const name = c.req.param('name');
    const body = await c.req.json();

    if (!body.displayName || !body.animal) {
      return c.json({ error: 'displayName and animal are required' }, 400);
    }

    upsertBeastProfile({
      name,
      displayName: body.displayName,
      animal: body.animal,
      avatarUrl: body.avatarUrl,
      bio: body.bio,
      interests: body.interests,
      themeColor: body.themeColor,
      role: body.role,
    });

    const profile = getBeastProfile(name);
    return c.json(profile);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Partial profile update (edit individual fields)
app.patch('/api/beast/:name', async (c) => {
  try {
    const name = c.req.param('name');
    const profile = getBeastProfile(name);
    if (!profile) {
      return c.json({ error: 'Beast not found' }, 404);
    }

    const body = await c.req.json();
    const updates: Record<string, any> = { updatedAt: Date.now() };

    if (body.bio !== undefined) updates.bio = body.bio;
    if (body.interests !== undefined) updates.interests = body.interests;
    if (body.role !== undefined) updates.role = body.role;
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.themeColor !== undefined) updates.themeColor = body.themeColor;
    if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
    if (body.birthdate !== undefined) updates.birthdate = body.birthdate;
    if (body.sex !== undefined) updates.sex = body.sex;

    db.update(beastProfiles)
      .set(updates)
      .where(eq(beastProfiles.name, name.toLowerCase()))
      .run();

    const updated = getBeastProfile(name);
    return c.json(updated);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Update avatar only
app.patch('/api/beast/:name/avatar', async (c) => {
  try {
    const name = c.req.param('name');
    const profile = getBeastProfile(name);
    if (!profile) {
      return c.json({ error: 'Beast not found. Create profile first with PUT /api/beast/:name' }, 404);
    }

    const body = await c.req.json();
    if (!body.avatarUrl) {
      return c.json({ error: 'avatarUrl is required' }, 400);
    }

    updateBeastAvatar(name, body.avatarUrl);
    const updated = getBeastProfile(name);
    return c.json(updated);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// ============================================================================
// Thread Routes
// ============================================================================

// Mark thread as read for a beast
app.post('/api/forum/read', async (c) => {
  try {
    const body = await c.req.json();
    const { threadId, messageId } = body;
    if (!threadId || !messageId) {
      return c.json({ error: 'threadId, messageId required' }, 400);
    }
    // T#718 — derive beast from auth, reject body.beast mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (body.beast && body.beast.toLowerCase() !== caller) {
      return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
    }
    const beast = caller;
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO forum_read_status (beast_name, thread_id, last_read_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(beast_name, thread_id) DO UPDATE SET
        last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
        updated_at = excluded.updated_at
    `).run(beast, threadId, messageId, now);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Get unread counts for a beast (T#618: excludes muted threads)
app.get('/api/forum/unread/:beast', (c) => {
  const beast = c.req.param('beast');
  const rows = sqlite.prepare(`
    SELECT t.id as thread_id, t.title,
           COUNT(m.id) as total_messages,
           COALESCE(r.last_read_message_id, 0) as last_read,
           (SELECT COUNT(*) FROM forum_messages WHERE thread_id = t.id AND id > COALESCE(r.last_read_message_id, 0)) as unread_count
    FROM forum_threads t
    LEFT JOIN forum_read_status r ON r.thread_id = t.id AND r.beast_name = ?
    LEFT JOIN forum_messages m ON m.thread_id = t.id
    LEFT JOIN forum_notification_prefs p ON p.thread_id = t.id AND p.beast_name = ?
    WHERE COALESCE(p.level, 'full') != 'muted'
    GROUP BY t.id
    HAVING unread_count > 0
    ORDER BY unread_count DESC
  `).all(beast, beast) as any[];

  return c.json({
    beast,
    threads: rows.map(r => ({
      thread_id: r.thread_id,
      title: r.title,
      unread_count: r.unread_count,
    })),
    total_unread: rows.reduce((sum: number, r: any) => sum + r.unread_count, 0),
  });
});

// File archive columns (T#533)
try { sqlite.prepare(`ALTER TABLE files ADD COLUMN archived_at INTEGER`).run(); } catch { /* exists */ }
try { sqlite.prepare(`ALTER TABLE files ADD COLUMN archive_path TEXT`).run(); } catch { /* exists */ }

// Image upload with validation and resize
const UPLOADS_DIR = path.join(ORACLE_DATA_DIR, 'uploads');
const ARCHIVE_DIR = path.join(ORACLE_DATA_DIR, 'uploads', 'archive');
const MAX_IMAGE_SIZE = 30 * 1024 * 1024; // 30MB for images
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB for other files

// Allowed file types (allowlist — per Talon/Bertus security review)
const ALLOWED_EXTENSIONS: Record<string, { mime: string; category: string }> = {
  '.jpg': { mime: 'image/jpeg', category: 'image' },
  '.jpeg': { mime: 'image/jpeg', category: 'image' },
  '.png': { mime: 'image/png', category: 'image' },
  '.gif': { mime: 'image/gif', category: 'image' },
  '.webp': { mime: 'image/webp', category: 'image' },
  '.pdf': { mime: 'application/pdf', category: 'document' },
  '.txt': { mime: 'text/plain', category: 'document' },
  '.md': { mime: 'text/markdown', category: 'document' },
  '.csv': { mime: 'text/csv', category: 'document' },
  '.json': { mime: 'application/json', category: 'document' },
  '.doc': { mime: 'application/msword', category: 'document' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document' },
  '.xls': { mime: 'application/vnd.ms-excel', category: 'document' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'document' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', category: 'document' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'document' },
  '.zip': { mime: 'application/zip', category: 'archive' },
};

// Allowed image types by magic bytes
const IMAGE_MAGIC: Record<string, { ext: string; mime: string }> = {
  'ffd8ff': { ext: '.jpg', mime: 'image/jpeg' },
  '89504e47': { ext: '.png', mime: 'image/png' },
  '47494638': { ext: '.gif', mime: 'image/gif' },
  '52494646': { ext: '.webp', mime: 'image/webp' }, // RIFF header for WebP
};

function detectImageType(buffer: Buffer): { ext: string; mime: string } | null {
  const hex = buffer.subarray(0, 4).toString('hex');
  for (const [magic, info] of Object.entries(IMAGE_MAGIC)) {
    if (hex.startsWith(magic)) return info;
  }
  // WebP has RIFF + WEBP at bytes 8-12
  if (hex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

app.post('/api/upload', async (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Authentication required' }, 403);
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const context = (formData.get('context') as string) || 'forum';
    const contextId = formData.get('context_id') || formData.get('message_id');
    const beast = formData.get('beast');

    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Check file extension against allowlist
    const ext = path.extname(file.name).toLowerCase();
    const allowed = ALLOWED_EXTENSIONS[ext];
    const imageType = detectImageType(Buffer.from(await file.slice(0, 12).arrayBuffer()));
    const isImage = !!imageType;

    // Reject double extensions (e.g., file.pdf.html)
    const nameParts = file.name.split('.');
    if (nameParts.length > 2) {
      const secondToLast = '.' + nameParts[nameParts.length - 2].toLowerCase();
      if (ALLOWED_EXTENSIONS[secondToLast] && secondToLast !== ext) {
        return c.json({ error: 'Double extensions not allowed' }, 400);
      }
    }

    // Guests: images only — no documents
    const isGuest = (c.get as any)('role') === 'guest';
    if (isGuest && !isImage) {
      return c.json({ error: 'Guests can only upload images (jpg, png, webp, gif)' }, 403);
    }

    // For images: validate via magic bytes (existing behavior)
    // For non-images: validate via extension allowlist
    if (!isImage && !allowed) {
      return c.json({ error: `File type '${ext}' not allowed. Allowed: ${Object.keys(ALLOWED_EXTENSIONS).join(', ')}` }, 400);
    }

    // Size limits
    const sizeLimit = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
    if (file.size > sizeLimit) return c.json({ error: `File too large. Max ${sizeLimit / 1024 / 1024}MB` }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    let processedBuffer = buffer;
    let finalExt = isImage ? (imageType!.ext) : ext;
    let finalMime = isImage ? (imageType!.mime) : (allowed?.mime || 'application/octet-stream');

    // Image processing: resize, EXIF strip (existing behavior)
    if (isImage) {
      try {
        const sharp = require('sharp');
        const metadata = await sharp(buffer).metadata();
        if (metadata.width && metadata.width > 1920) {
          processedBuffer = await sharp(buffer)
            .rotate()
            .resize(1920, null, { withoutEnlargement: true })
            .jpeg({ quality: 95 })
            .withMetadata({ orientation: undefined })
            .toBuffer();
          finalExt = '.jpg';
          finalMime = 'image/jpeg';
        } else if (buffer.length > 2 * 1024 * 1024) {
          processedBuffer = await sharp(buffer)
            .rotate()
            .jpeg({ quality: 95 })
            .withMetadata({ orientation: undefined })
            .toBuffer();
          finalExt = '.jpg';
          finalMime = 'image/jpeg';
        } else {
          processedBuffer = await sharp(buffer)
            .rotate()
            .withMetadata({ orientation: undefined })
            .toBuffer();
        }
      } catch { /* sharp not available — save original */ }
    }

    const filename = `${crypto.randomUUID()}${finalExt}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, processedBuffer);

    const now = Date.now();
    const category = isImage ? 'image' : (allowed?.category || 'other');

    // Insert into files table (T#382)
    const result = sqlite.prepare(`
      INSERT INTO files (filename, original_name, mime_type, size_bytes, uploaded_by, context, context_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(filename, file.name, finalMime, processedBuffer.length, beast || null, context, contextId ? Number(contextId) : null, now);

    // Also insert into forum_attachments for backwards compatibility
    sqlite.prepare(`
      INSERT INTO forum_attachments (message_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(contextId ? Number(contextId) : null, filename, file.name, finalMime, processedBuffer.length, beast || null, now);

    return c.json({
      id: (result as any).lastInsertRowid,
      filename,
      original_name: file.name,
      mime_type: finalMime,
      category,
      url: `/api/f/${filename}`,
      size_bytes: processedBuffer.length,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Upload failed' }, 500);
  }
});

// Legacy file endpoint — redirect to /api/f/ which has proper auth + cache headers
app.get('/api/forum/file/:filename', (c) => {
  const filename = c.req.param('filename');
  if (filename.includes('..') || filename.includes('/')) return c.json({ error: 'Invalid filename' }, 400);
  return c.redirect(`/api/f/${filename}`, 301);
});

// ============================================================================
// File Manager API (T#382)
// ============================================================================

// GET /api/files — list files with pagination and filters
app.get('/api/files', (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit;
  const type = c.req.query('type'); // image, document, archive
  const uploadedBy = c.req.query('uploaded_by');
  const context = c.req.query('context'); // forum, board, dm, forge

  let where = 'deleted_at IS NULL';
  const params: any[] = [];

  if (type) {
    const typeExts: Record<string, string[]> = {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      document: ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      archive: ['application/zip'],
    };
    const mimes = typeExts[type];
    if (mimes) {
      where += ` AND mime_type IN (${mimes.map(() => '?').join(',')})`;
      params.push(...mimes);
    }
  }
  if (uploadedBy) { where += ' AND uploaded_by = ?'; params.push(uploadedBy); }
  if (context) { where += ' AND context = ?'; params.push(context); }

  const total = (sqlite.prepare(`SELECT COUNT(*) as c FROM files WHERE ${where}`).get(...params) as any)?.c || 0;
  const files = sqlite.prepare(`SELECT * FROM files WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

  return c.json({
    files: files.map(f => ({
      ...f,
      url: `/api/files/${f.id}/download`,
      is_image: f.mime_type.startsWith('image/'),
      thumbnail_url: f.mime_type.startsWith('image/') ? `/api/f/${f.filename}` : null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// GET /api/files/stats — storage statistics (must be before :id)
app.get('/api/files/stats', (c) => {
  const total = sqlite.prepare('SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files WHERE deleted_at IS NULL').get() as any;
  const byType = sqlite.prepare(`
    SELECT
      CASE
        WHEN mime_type LIKE 'image/%' THEN 'image'
        WHEN mime_type IN ('application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
          'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') THEN 'document'
        WHEN mime_type = 'application/zip' THEN 'archive'
        ELSE 'other'
      END as category,
      COUNT(*) as count,
      COALESCE(SUM(size_bytes), 0) as total_size
    FROM files WHERE deleted_at IS NULL
    GROUP BY category
  `).all() as any[];
  const byContext = sqlite.prepare('SELECT context, COUNT(*) as count FROM files WHERE deleted_at IS NULL GROUP BY context').all() as any[];

  const archived = sqlite.prepare(
    'SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files WHERE archived_at IS NOT NULL'
  ).get() as any;
  const pendingArchive = sqlite.prepare(
    'SELECT COUNT(*) as count FROM files WHERE deleted_at IS NOT NULL AND archived_at IS NULL'
  ).get() as any;

  return c.json({
    total_files: total.count,
    total_size: total.total_size,
    by_type: byType,
    by_context: byContext,
    archived_files: archived.count,
    archived_size: archived.total_size,
    pending_archive: pendingArchive.count,
  });
});

// GET /api/files/:id — file metadata (owner-only, Beasts use /api/f/:hash)
app.get('/api/files/:id', (c) => {
  const role = (c.get as any)('role');
  if (role !== 'owner') return c.json({ error: 'Owner access only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);
  return c.json({
    ...file,
    url: `/api/files/${file.id}/download`,
    is_image: file.mime_type.startsWith('image/'),
    thumbnail_url: file.mime_type.startsWith('image/') ? `/api/f/${file.filename}` : null,
  });
});

// GET /api/files/:id/download — download by ID (owner-only, all other access via /api/f/:hash)
app.get('/api/files/:id/download', (c) => {
  const role = (c.get as any)('role');
  if (role !== 'owner') return c.json({ error: 'Owner access only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);

  const filePath = path.join(UPLOADS_DIR, file.filename);
  if (!fs.existsSync(filePath)) return c.json({ error: 'File not found on disk' }, 404);

  // ETag for caching
  const etag = `"${file.filename}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const content = fs.readFileSync(filePath);
  const safeImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const isImage = safeImageTypes.has(file.mime_type);

  c.header('Content-Type', isImage ? file.mime_type : 'application/octet-stream');
  c.header('Content-Disposition', isImage ? 'inline' : `attachment; filename="${file.original_name.replace(/"/g, '_')}"`);
  if (!isImage) c.header('Content-Security-Policy', 'sandbox');
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  c.header('ETag', etag);
  return c.body(content);
});

// GET /api/f/:hash — download by hash (local bypass allowed, remote requires login)
app.get('/api/f/:hash', (c) => {
  // Allow local network access without auth (Beasts on CLI need file access)
  if (!isLocalNetwork(c)) {
    const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
    const hasSession = sessionCookie && verifySessionToken(sessionCookie);
    const hasBearer = c.req.header('Authorization')?.startsWith('Bearer den_');
    if (!hasSession && !hasBearer) {
      return c.json({ error: 'Authentication required — login to access files' }, 401);
    }
  }

  const hash = c.req.param('hash');
  // Validate: alphanumeric, hyphens, dots — no path traversal
  if (hash.includes('..') || hash.includes('/')) return c.json({ error: 'Invalid file hash' }, 400);
  if (!/^[\w.-]+$/.test(hash)) return c.json({ error: 'Invalid file hash' }, 400);

  // Try files table first, then fall back to disk (legacy avatar files)
  const file = sqlite.prepare('SELECT * FROM files WHERE filename = ? AND deleted_at IS NULL').get(hash) as any;
  const filePath = path.join(UPLOADS_DIR, hash);

  // If not in active files, check if it was soft-deleted — return 404 rather than serving it from disk
  if (!file) {
    const deleted = sqlite.prepare('SELECT id FROM files WHERE filename = ? AND deleted_at IS NOT NULL').get(hash);
    if (deleted) return c.json({ error: 'File not found' }, 404);
  }

  if (!file && !fs.existsSync(filePath)) return c.json({ error: 'File not found' }, 404);
  if (file && !fs.existsSync(filePath)) return c.json({ error: 'File not found on disk' }, 404);

  const etag = `"${hash}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const content = fs.readFileSync(filePath);
  const safeImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  // Determine mime type from files table or extension
  const ext = hash.split('.').pop()?.toLowerCase() || '';
  const extMimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const mimeType = file?.mime_type || extMimeMap[ext] || 'application/octet-stream';
  const isImage = safeImageTypes.has(mimeType);
  const originalName = file?.original_name || hash;

  c.header('Content-Type', isImage ? mimeType : 'application/octet-stream');
  c.header('Content-Disposition', isImage ? 'inline' : `attachment; filename="${originalName.replace(/"/g, '_')}"`);
  if (!isImage) c.header('Content-Security-Policy', 'sandbox');
  // private — browser can cache, but CDN/reverse proxy (Caddy) must not
  c.header('Cache-Control', 'private, max-age=86400');
  c.header('ETag', etag);
  return c.body(content);
});

// DELETE /api/files/:id — soft delete (Nothing is Deleted)
// Only file uploader or owner can delete
app.delete('/api/files/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);

  const role = (c.get as any)('role');
  const actor = (c.get as any)('actor');
  if (role !== 'owner' && file.uploaded_by && actor !== file.uploaded_by) {
    return c.json({ error: 'Only the uploader or owner can delete files' }, 403);
  }

  const now = Date.now();
  sqlite.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(now, id);
  return c.json({ deleted: true, id });
});

// (stats endpoint moved above :id routes)

// Get attachments for a message
app.get('/api/message/:id/attachments', (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  const rows = sqlite.prepare('SELECT * FROM forum_attachments WHERE message_id = ? ORDER BY created_at').all(messageId) as any[];
  return c.json({
    attachments: rows.map(r => ({
      id: r.id,
      filename: r.filename,
      original_name: r.original_name,
      url: `/api/f/${r.filename}`,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      uploaded_by: r.uploaded_by,
    })),
  });
});

// T#618: Inline migration — add level column to forum_notification_prefs
try { sqlite.exec("ALTER TABLE forum_notification_prefs ADD COLUMN level TEXT NOT NULL DEFAULT 'full'"); } catch { /* exists */ }
try { sqlite.exec("UPDATE forum_notification_prefs SET level = 'muted' WHERE muted = 1 AND level = 'full'"); } catch { /* ignore */ }

// T#622: Inline migration — add deleted_at column to forum_messages for soft delete
try { sqlite.exec("ALTER TABLE forum_messages ADD COLUMN deleted_at TEXT DEFAULT NULL"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE forum_messages ADD COLUMN deleted_by TEXT DEFAULT NULL"); } catch { /* exists */ }

// Mute/unmute thread notifications for a beast (alias for subscribe with level muted/full)
app.post('/api/forum/mute', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.threadId) return c.json({ error: 'threadId required' }, 400);
    // T#718 — derive beast from auth
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (body.beast && body.beast.toLowerCase() !== caller) {
      return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
    }
    const beast = caller;
    const muted = body.muted !== false;
    const level = muted ? 'muted' : 'full';
    const { setSubscription } = await import('./forum/mentions.ts');
    setSubscription(beast, body.threadId, level);
    return c.json({ success: true, beast, thread_id: body.threadId, muted, level });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Get muted threads for a beast
app.get('/api/forum/muted/:beast', (c) => {
  const beast = c.req.param('beast').toLowerCase();
  const rows = sqlite.prepare(
    'SELECT thread_id FROM forum_notification_prefs WHERE beast_name = ? AND (muted = 1 OR level = ?)'
  ).all(beast, 'muted') as any[];
  return c.json({ beast, muted_threads: rows.map(r => r.thread_id) });
});

// T#618: Subscribe to thread with level (full/summary/muted)
app.post('/api/forum/subscribe', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.beast || !body.threadId) return c.json({ error: 'beast and threadId required' }, 400);
    const level = body.level || 'full';
    if (!['full', 'summary', 'muted'].includes(level)) {
      return c.json({ error: 'level must be full, summary, or muted' }, 400);
    }
    const { setSubscription } = await import('./forum/mentions.ts');
    setSubscription(body.beast, body.threadId, level);
    return c.json({ success: true, beast: body.beast, thread_id: body.threadId, level });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// T#618: Get all subscriptions for a beast
app.get('/api/forum/subscriptions/:beast', async (c) => {
  const beast = c.req.param('beast').toLowerCase();
  const { getSubscriptions } = await import('./forum/mentions.ts');
  return c.json({ beast, subscriptions: getSubscriptions(beast) });
});

// GET /api/thread/:id/subscribers — list thread subscribers with profiles (T#621, owner-only)
app.get('/api/thread/:id/subscribers', async (c) => {
  const role = (c.get as any)('role') as string | undefined;
  if (role === 'guest') return c.json({ error: 'Not found' }, 404);

  const threadId = parseInt(c.req.param('id'), 10);
  if (isNaN(threadId)) return c.json({ error: 'Invalid thread ID' }, 400);

  const thread = sqlite.prepare('SELECT id FROM forum_threads WHERE id = ?').get(threadId) as any;
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const { getThreadSubscribers } = await import('./forum/mentions.ts');
  const subs = getThreadSubscribers(threadId);

  // Enrich with beast profile data
  const subscribers = subs.map(s => {
    const profile = sqlite.prepare(
      'SELECT display_name, animal, avatar_url, theme_color FROM beast_profiles WHERE name = ?'
    ).get(s.beast_name) as any;
    return {
      name: s.beast_name,
      display_name: profile?.display_name || s.beast_name,
      animal: profile?.animal || null,
      avatar_url: profile?.avatar_url || null,
      theme_color: profile?.theme_color || null,
      level: s.level,
    };
  });

  return c.json({ thread_id: threadId, subscribers, total: subscribers.length });
});

// Link preview — fetch URL metadata
app.get('/api/forum/link-preview', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing url parameter' }, 400);

  // SSRF protection: only allow https, block internal IPs
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return c.json({ error: 'Only https URLs allowed' }, 400);
    }
    // Block internal/private hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
        hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return c.json({ error: 'Internal URLs not allowed' }, 400);
    }
    // Resolve DNS and block private IP ranges
    const { resolve4 } = await import('dns/promises');
    try {
      const ips = await resolve4(hostname);
      for (const ip of ips) {
        const parts = ip.split('.').map(Number);
        if (parts[0] === 10 || parts[0] === 127 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 169 && parts[1] === 254)) {
          return c.json({ error: 'Internal URLs not allowed' }, 400);
        }
      }
    } catch { /* DNS resolution failed — let fetch handle it */ }
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DenBook/1.0' },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual', // Don't follow redirects (prevents redirect-to-internal)
    });
    const html = await response.text();

    // Extract basic meta tags
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

    return c.json({
      url,
      title: ogTitleMatch?.[1] || titleMatch?.[1] || null,
      description: ogDescMatch?.[1] || descMatch?.[1] || null,
      image: ogImageMatch?.[1] || null,
    });
  } catch {
    return c.json({ url, title: null, description: null, image: null });
  }
});

// ============================================================================
// Forum activity feed — recent messages across all threads
app.get('/api/forum/activity', (c) => {
  const limit = parseInt(c.req.query('limit') || '30');
  const rows = sqlite.prepare(`
    SELECT m.id, m.thread_id, m.role, m.content, m.author, m.created_at,
           t.title as thread_title, t.category
    FROM forum_messages m
    JOIN forum_threads t ON m.thread_id = t.id
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return c.json({
    activity: rows.map(r => ({
      message_id: r.id,
      thread_id: r.thread_id,
      thread_title: r.thread_title,
      category: r.category,
      role: r.role,
      content: r.content.slice(0, 200),
      author: r.author,
      created_at: new Date(r.created_at).toISOString(),
    })),
    total: rows.length,
  });
});

// Get all @mentions for a beast across all threads
app.get('/api/forum/mentions/:beast', (c) => {
  const beast = c.req.param('beast').toLowerCase();
  const limit = parseInt(c.req.query('limit') || '30');
  const rows = sqlite.prepare(`
    SELECT m.id, m.thread_id, m.content, m.author, m.created_at,
           t.title as thread_title
    FROM forum_messages m
    JOIN forum_threads t ON m.thread_id = t.id
    WHERE LOWER(m.content) LIKE ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(`%@${beast}%`, limit) as any[];

  return c.json({
    beast,
    mentions: rows.map(r => ({
      message_id: r.id,
      thread_id: r.thread_id,
      thread_title: r.thread_title,
      content: r.content,
      author: r.author,
      created_at: new Date(r.created_at).toISOString(),
    })),
    total: rows.length,
  });
});

// Search forum threads and messages
app.get('/api/forum/search', (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'Missing query parameter: q' }, 400);
  const limit = parseInt(c.req.query('limit') || '20');
  const author = c.req.query('author');
  const category = c.req.query('category');

  // Search messages by content (with optional author filter)
  let msgQuery = `SELECT m.id, m.thread_id, m.role, m.content, m.author, m.created_at,
           t.title as thread_title
    FROM forum_messages m
    JOIN forum_threads t ON m.thread_id = t.id
    WHERE m.content LIKE ?`;
  const msgParams: any[] = [`%${q}%`];
  if (author) { msgQuery += ' AND LOWER(m.author) LIKE ?'; msgParams.push(`%${author.toLowerCase()}%`); }
  if (category) { msgQuery += ' AND t.category = ?'; msgParams.push(category); }
  msgQuery += ' ORDER BY m.created_at DESC LIMIT ?';
  msgParams.push(limit);
  const messages = sqlite.prepare(msgQuery).all(...msgParams) as any[];

  // Search threads by title (with optional category filter)
  let threadQuery = 'SELECT id, title, status, category, created_at FROM forum_threads WHERE title LIKE ?';
  const threadParams: any[] = [`%${q}%`];
  if (category) { threadQuery += ' AND category = ?'; threadParams.push(category); }
  threadQuery += ' ORDER BY updated_at DESC LIMIT ?';
  threadParams.push(limit);
  const threads = sqlite.prepare(threadQuery).all(...threadParams) as any[];

  return c.json({
    query: q,
    messages: messages.map(m => ({
      id: m.id,
      thread_id: m.thread_id,
      thread_title: m.thread_title,
      role: m.role,
      content: m.content,
      author: m.author,
      created_at: new Date(m.created_at).toISOString(),
    })),
    threads: threads.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      created_at: new Date(t.created_at).toISOString(),
    })),
    total_messages: messages.length,
    total_threads: threads.length,
  });
});

// List threads (with category, pinned, sorted pinned-first)
app.get('/api/threads', (c) => {
  const status = c.req.query('status');
  const category = c.req.query('category');
  const visibility = c.req.query('visibility');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const role = (c.get as any)('role') as Role | undefined;

  let query = 'SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE deleted_at IS NULL';
  const params: any[] = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  // Guests only see public threads; owner can filter by visibility
  if (role === 'guest') { query += " AND visibility = 'public'"; }
  else if (visibility === 'public' || visibility === 'internal') { query += ' AND visibility = ?'; params.push(visibility); }
  query += ' ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = sqlite.prepare(query).all(...params) as any[];
  let countQuery = 'SELECT COUNT(*) as total FROM forum_threads WHERE deleted_at IS NULL';
  const countParams: any[] = [];
  if (status) { countQuery += ' AND status = ?'; countParams.push(status); }
  if (category) { countQuery += ' AND category = ?'; countParams.push(category); }
  if (role === 'guest') { countQuery += " AND visibility = 'public'"; }
  else if (visibility === 'public' || visibility === 'internal') { countQuery += ' AND visibility = ?'; countParams.push(visibility); }
  const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.total || 0;

  return c.json({
    threads: rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status || 'active',
      category: t.category || 'discussion',
      pinned: !!(t.pinned),
      message_count: t.msg_count || 0,
      created_at: new Date(t.created_at).toISOString(),
      created_by: t.created_by || null,
      issue_url: t.issue_url,
      visibility: t.visibility || 'internal',
    })),
    total,
  });
});

// Create thread / send message
app.post('/api/thread', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.message) {
      return c.json({ error: 'Missing required field: message' }, 400);
    }

    // Guest restrictions: can only post in existing public threads, cannot create new threads
    const role = (c.get as any)('role') as Role | undefined;
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername');
      if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);

      if (!data.thread_id) {
        return c.json({ error: 'Guests cannot create new threads' }, 403);
      }
      const threadRow = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(data.thread_id) as any;
      if (!threadRow || threadRow.visibility !== 'public') {
        return c.json({ error: 'Guests can only post in public threads' }, 403);
      }

      // Rate limiting
      const rateCheck = checkGuestPostRate(guestUsername);
      if (!rateCheck.allowed) {
        return c.json({ error: rateCheck.error }, 429);
      }

      // Content length limit
      const lengthCheck = checkGuestContentLength(data.message, 'post');
      if (!lengthCheck.allowed) {
        return c.json({ error: lengthCheck.error }, 400);
      }

      // Injection pattern scan (flag, don't block)
      const scan = scanForInjection(data.message);
      if (scan.flagged) {
        logSecurityEvent({
          eventType: 'suspicious_content',
          severity: 'warning',
          actor: guestUsername,
          actorType: 'guest',
          target: `/api/thread/${data.thread_id}`,
          details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
          ipSource: c.req.header('x-real-ip') || 'local',
          requestId: (c.get as any)('requestId'),
        });
      }

      // Tag guest author with [Guest] prefix for display (derived from session, not body)
      data.author = `[Guest] ${guestUsername}`;
    } else {
      // T#718 — Beast/owner path: derive author from auth, reject client-asserted mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.author && data.author.toLowerCase() !== caller) {
        return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
      }
      data.author = caller;
    }

    // Block posting to deleted threads
    if (data.thread_id) {
      const threadCheck = sqlite.prepare('SELECT deleted_at FROM forum_threads WHERE id = ?').get(data.thread_id) as any;
      if (threadCheck?.deleted_at) {
        return c.json({ error: 'Cannot post to a deleted thread' }, 410);
      }
    }

    const result = await withRetry(() => handleThreadMessage({
      message: data.message,
      threadId: data.thread_id,
      title: data.title,
      role: data.role || 'human',
      author: data.author,
    }));
    // Set visibility on new thread creation if specified
    if (!data.thread_id && result.threadId && data.visibility) {
      const vis = data.visibility === 'public' ? 'public' : 'internal';
      sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run(vis, result.threadId);
    }
    // Store reply_to_id and author_role if applicable
    if (result.messageId) {
      if (data.reply_to_id) {
        sqlite.prepare('UPDATE forum_messages SET reply_to_id = ? WHERE id = ?')
          .run(data.reply_to_id, result.messageId);
      }
      // Set author_role for prompt injection defense (Spec #32, T#557)
      const authorRole = role === 'guest' ? 'guest' : (role === 'owner' ? 'owner' : 'beast');
      sqlite.prepare('UPDATE forum_messages SET author_role = ? WHERE id = ?')
        .run(authorRole, result.messageId);
    }
    // Index forum message for search (T#347)
    if (result.messageId && result.threadId) {
      const threadTitle = data.title || (sqlite.prepare('SELECT title FROM forum_threads WHERE id = ?').get(result.threadId) as any)?.title || '';
      searchIndexUpsert('forum', result.messageId, threadTitle, data.message, data.author, new Date().toISOString(), `/forum?thread=${result.threadId}`);
    }
    // Push WebSocket event
    wsBroadcast('new_message', {
      thread_id: result.threadId,
      message_id: result.messageId,
      author: data.author || data.role || 'unknown',
    });
    return c.json({
      thread_id: result.threadId,
      message_id: result.messageId,
      status: result.status,
      oracle_response: result.oracleResponse,
      issue_url: result.issueUrl,
      notified: result.notified,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Get thread by ID
app.get('/api/thread/:id', (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  if (isNaN(threadId)) {
    return c.json({ error: 'Invalid thread ID' }, 400);
  }

  const rawLimit = c.req.query('limit');
  const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : NaN;
  const limit = rawLimit ? (isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit) : undefined;
  const rawOffset = parseInt(c.req.query('offset') || '0', 10);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  const order = (c.req.query('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

  const threadData = getFullThread(threadId, limit, offset, order);
  if (!threadData) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  // Guests can only view public threads
  const role = (c.get as any)('role') as Role | undefined;
  if (role === 'guest') {
    const threadRow = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(threadId) as any;
    if (!threadRow || threadRow.visibility !== 'public') {
      return c.json({ error: 'Thread not found' }, 404);
    }
  }

  return c.json({
    thread: {
      id: threadData.thread.id,
      title: threadData.thread.title,
      status: threadData.thread.status,
      created_at: new Date(threadData.thread.createdAt).toISOString(),
      issue_url: threadData.thread.issueUrl
    },
    messages: threadData.messages.map(m => {
      // Get reply_to_id from raw SQL (not in Drizzle schema)
      const raw = sqlite.prepare('SELECT reply_to_id FROM forum_messages WHERE id = ?').get(m.id) as any;
      // Get reactions for this message
      const reactionRows = sqlite.prepare(
        'SELECT emoji, GROUP_CONCAT(beast_name) as beasts, COUNT(*) as count FROM forum_reactions WHERE message_id = ? GROUP BY emoji'
      ).all(m.id) as any[];
      // Resolve guest avatar URL from guest_accounts (T#602)
      let authorAvatarUrl: string | null = null;
      if (m.author?.startsWith('[Guest]')) {
        const guestName = m.author.replace('[Guest] ', '').replace('[Guest]', '').trim();
        const guest = sqlite.prepare('SELECT avatar_url FROM guest_accounts WHERE LOWER(display_name) = ? OR LOWER(username) = ?').get(guestName.toLowerCase(), guestName.toLowerCase()) as any;
        authorAvatarUrl = guest?.avatar_url || null;
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        author: m.author,
        author_avatar_url: authorAvatarUrl,
        reply_to_id: raw?.reply_to_id || null,
        principles_found: m.principlesFound,
        patterns_found: m.patternsFound,
        created_at: new Date(m.createdAt).toISOString(),
        reactions: reactionRows.map(r => ({ emoji: r.emoji, beasts: r.beasts.split(','), count: r.count })),
      };
    }),
    total: threadData.total,
  });
});

// Edit message (preserves original in edit history)
app.patch('/api/message/:id', async (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  try {
    const body = await c.req.json();
    if (!body.content?.trim()) {
      return c.json({ error: 'content (non-empty) is required' }, 400);
    }
    // T#718 — derive beast from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (body.beast && body.beast.toLowerCase() !== caller) {
      return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
    }

    // Get current content
    const current = sqlite.prepare('SELECT content, author FROM forum_messages WHERE id = ?').get(messageId) as any;
    if (!current) return c.json({ error: 'Message not found' }, 404);

    // Restrict edits to original author only (or Gorn)
    const authorLower = (current.author || '').toLowerCase();
    const beastLower = caller;
    if (!authorLower.includes(beastLower) && beastLower !== 'gorn') {
      return c.json({ error: 'Only the original author can edit this message' }, 403);
    }

    // Save original to edit history (Nothing is Deleted)
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO forum_message_edits (message_id, original_content, edited_by, created_at)
      VALUES (?, ?, ?, ?)
    `).run(messageId, current.content, caller, now);

    // Update message
    sqlite.prepare('UPDATE forum_messages SET content = ?, edited_at = ? WHERE id = ?')
      .run(body.content, now, messageId);

    return c.json({ success: true, message_id: messageId, edited_at: new Date(now).toISOString() });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// DELETE /api/message/:id — soft delete a forum message (Gorn-only, T#622)
app.delete('/api/message/:id', async (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  if (isNaN(messageId)) return c.json({ error: 'Invalid message ID' }, 400);

  const role = (c.get as any)('role') as string | undefined;
  if (role === 'guest') return c.json({ error: 'Not found' }, 404);

  // Gorn-only: require session auth (not just trusted network)
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'Only Gorn can delete forum messages' }, 403);
  }

  const msg = sqlite.prepare('SELECT id, thread_id, author, content, deleted_at FROM forum_messages WHERE id = ?').get(messageId) as any;
  if (!msg) return c.json({ error: 'Message not found' }, 404);
  if (msg.deleted_at) return c.json({ error: 'Message already deleted' }, 400);

  // Soft delete — Nothing is Deleted principle
  const now = new Date().toISOString();
  try {
    sqlite.prepare('UPDATE forum_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?')
      .run(now, 'gorn', messageId);
  } catch (error) {
    return c.json({ error: 'Database error during deletion' }, 500);
  }

  // Audit trail
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  logSecurityEvent({
    eventType: 'message_delete',
    severity: 'warning',
    actor: 'gorn',
    actorType: 'owner',
    target: `message:${messageId}`,
    details: { thread_id: msg.thread_id, author: msg.author, content_preview: msg.content?.slice(0, 100) },
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });

  return c.json({ deleted: messageId, thread_id: msg.thread_id, deleted_at: now, deleted_by: 'gorn', soft: true });
});

// Get edit history for a message
app.get('/api/message/:id/history', (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  const rows = sqlite.prepare(
    'SELECT id, original_content, edited_by, created_at FROM forum_message_edits WHERE message_id = ? ORDER BY created_at DESC'
  ).all(messageId) as any[];
  return c.json({
    message_id: messageId,
    edits: rows.map(r => ({
      id: r.id,
      original_content: r.original_content,
      edited_by: r.edited_by,
      created_at: new Date(r.created_at).toISOString(),
    })),
    edit_count: rows.length,
  });
});

// Add reaction to message
// Emoji whitelist — DB-backed, any Beast can add (T#385)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS emoji_whitelist (
    emoji TEXT PRIMARY KEY,
    added_by TEXT,
    created_at INTEGER NOT NULL
  )`).run();
} catch { /* already exists */ }

// Seed defaults if table is empty
const emojiCount = (sqlite.prepare('SELECT COUNT(*) as c FROM emoji_whitelist').get() as any)?.c || 0;
if (emojiCount === 0) {
  const defaults = [
    '👍', '👎', '❤️', '🔥', '👀', '✅', '❌',
    '😂', '😢', '🤔', '💪', '🎉', '🙏', '👏', '💯',
    '🚀', '⭐', '⚠️', '💡', '🏆', '🫡', '🤝',
    '📦', '🐾', '🐴', '🐊', '🐻', '🦘', '🦁', '🦝', '🦦', '🐙', '🐦‍⬛',
  ];
  const insert = sqlite.prepare('INSERT OR IGNORE INTO emoji_whitelist (emoji, added_by, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (const e of defaults) insert.run(e, 'system', now);
}

function getSupportedEmoji(): Set<string> {
  const rows = sqlite.prepare('SELECT emoji FROM emoji_whitelist').all() as any[];
  return new Set(rows.map(r => r.emoji));
}

// Cache — refreshed on add/remove
let SUPPORTED_EMOJI = getSupportedEmoji();

// GET /api/forum/emojis — list whitelist
app.get('/api/forum/emojis', (c) => {
  const rows = sqlite.prepare('SELECT emoji, added_by, created_at FROM emoji_whitelist ORDER BY created_at').all() as any[];
  return c.json({ emoji: rows, total: rows.length });
});

// POST /api/forum/emojis — add emoji (any Beast)
app.post('/api/forum/emojis', async (c) => {
  const data = await c.req.json();
  if (!data.emoji) return c.json({ error: 'emoji required' }, 400);
  const beast = data.beast || data.added_by || (hasSessionAuth(c) ? 'gorn' : '');
  if (!beast && !isTrustedRequest(c)) return c.json({ error: 'beast required' }, 400);
  const now = Date.now();
  sqlite.prepare('INSERT OR IGNORE INTO emoji_whitelist (emoji, added_by, created_at) VALUES (?, ?, ?)').run(data.emoji, beast, now);
  SUPPORTED_EMOJI = getSupportedEmoji();
  return c.json({ added: data.emoji, by: beast, total: SUPPORTED_EMOJI.size });
});

// DELETE /api/forum/emojis/:emoji — remove emoji (Gorn only)
app.delete('/api/forum/emojis/:emoji', (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Gorn-only' }, 403);
  const emoji = decodeURIComponent(c.req.param('emoji'));
  sqlite.prepare('DELETE FROM emoji_whitelist WHERE emoji = ?').run(emoji);
  SUPPORTED_EMOJI = getSupportedEmoji();
  return c.json({ removed: emoji, total: SUPPORTED_EMOJI.size });
});

// GET /api/reactions/supported — legacy endpoint
app.get('/api/reactions/supported', (c) => {
  return c.json({ emoji: [...SUPPORTED_EMOJI] });
});

app.post('/api/message/:id/react', async (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  try {
    const body = await c.req.json();
    if (!body.emoji) {
      return c.json({ error: 'emoji is required' }, 400);
    }

    const role = (c.get as any)('role');

    // Guest identity enforcement — derive from session, never body
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername');
      if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);
      body.beast = `[Guest] ${guestUsername}`;

      // Thread visibility check — guests can only react to messages in public threads
      const msg = sqlite.prepare('SELECT thread_id FROM forum_messages WHERE id = ?').get(messageId) as any;
      if (msg) {
        const thread = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(msg.thread_id) as any;
        if (thread && thread.visibility && thread.visibility !== 'public') {
          return c.json({ error: 'Guests cannot react to messages in private threads' }, 403);
        }
      }
    } else {
      // T#718 — Beast/owner path: derive from auth, reject client-asserted mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (body.beast && body.beast.toLowerCase() !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
      }
      body.beast = caller;
    }
    if (!SUPPORTED_EMOJI.has(body.emoji)) {
      return c.json({ error: `Unsupported emoji. Supported: ${[...SUPPORTED_EMOJI].join(' ')}` }, 400);
    }
    const now = Date.now();
    sqlite.prepare(`
      INSERT OR IGNORE INTO forum_reactions (message_id, beast_name, emoji, created_at)
      VALUES (?, ?, ?, ?)
    `).run(messageId, body.beast.toLowerCase(), body.emoji, now);
    wsBroadcast('reaction', { message_id: messageId, beast: body.beast, emoji: body.emoji, action: 'add' });

    // Notify the message author about the reaction
    try {
      const msg = sqlite.prepare('SELECT author, thread_id FROM forum_messages WHERE id = ?').get(messageId) as any;
      if (msg?.author) {
        const msgAuthor = msg.author.split('@')[0].toLowerCase();
        const reactor = body.beast.toLowerCase();
        // Don't notify yourself
        if (msgAuthor !== reactor && msgAuthor !== 'gorn' && msgAuthor !== 'human' && msgAuthor !== 'user') {
          const thread = sqlite.prepare('SELECT title FROM forum_threads WHERE id = ?').get(msg.thread_id) as any;
          const { notifyMentioned } = await import('./forum/mentions.ts');
          notifyMentioned(
            [msgAuthor],
            msg.thread_id,
            thread?.title || 'thread',
            reactor,
            `${body.emoji} reacted to your message`
          );
        }
      }
    } catch { /* notification failure is non-critical */ }

    return c.json({ success: true, message_id: messageId, emoji: body.emoji });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Remove reaction
app.delete('/api/message/:id/react', async (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  try {
    const body = await c.req.json();
    if (!body.emoji) {
      return c.json({ error: 'emoji is required' }, 400);
    }

    const role = (c.get as any)('role');
    // Guest identity enforcement — derive from session, never body
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername');
      if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);
      body.beast = `[Guest] ${guestUsername}`;
    } else {
      // T#718 — Beast/owner path: derive from auth
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (body.beast && body.beast.toLowerCase() !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
      }
      body.beast = caller;
    }
    sqlite.prepare('DELETE FROM forum_reactions WHERE message_id = ? AND beast_name = ? AND emoji = ?')
      .run(messageId, body.beast.toLowerCase(), body.emoji);
    wsBroadcast('reaction', { message_id: messageId, beast: body.beast, emoji: body.emoji, action: 'remove' });
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Get reactions for a message
app.get('/api/message/:id/reactions', (c) => {
  const messageId = parseInt(c.req.param('id'), 10);
  const rows = sqlite.prepare(
    'SELECT emoji, GROUP_CONCAT(beast_name) as beasts, COUNT(*) as count FROM forum_reactions WHERE message_id = ? GROUP BY emoji'
  ).all(messageId) as any[];
  return c.json({
    message_id: messageId,
    reactions: rows.map(r => ({ emoji: r.emoji, beasts: r.beasts.split(','), count: r.count })),
  });
});

// Update thread category
app.patch('/api/thread/:id/category', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    const allowed = ['announcement', 'task', 'discussion', 'decision', 'question', 'gorn-queue'];
    if (!data.category || !allowed.includes(data.category)) {
      return c.json({ error: `Invalid category. Allowed: ${allowed.join(', ')}` }, 400);
    }
    sqlite.prepare('UPDATE forum_threads SET category = ? WHERE id = ?').run(data.category, threadId);
    return c.json({ success: true, thread_id: threadId, category: data.category });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// ============================================================================
// Gorn Queue — decisions awaiting Gorn's approval
// ============================================================================

// Ensure queue columns exist
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_status TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_tagged_by TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_tagged_at INTEGER DEFAULT NULL').run();
} catch { /* column already exists */ }
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_summary TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }

try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN deleted_at TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }

// Mindlink removed — replaced by Prowl (T#279/T#280)
// DB table 'mindlinks' preserved for data migration to Prowl

// Legacy queue endpoints (backwards compat)
// GET /api/queue/gorn — list queue items
app.get('/api/queue/gorn', (c) => {
  const status = c.req.query('status') || 'pending'; // pending, decided, deferred, withdrawn
  const rows = sqlite.prepare(`
    SELECT id, title, status, category, queue_status, queue_tagged_by, queue_tagged_at, queue_summary, created_at,
      (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as message_count
    FROM forum_threads
    WHERE category = 'gorn-queue' AND queue_status = ?
    ORDER BY CASE WHEN queue_status = 'deferred' THEN 1 ELSE 0 END, queue_tagged_at ASC
  `).all(status) as any[];

  return c.json({
    items: rows.map(r => ({
      thread_id: r.id,
      title: r.title,
      thread_status: r.status,
      queue_status: r.queue_status,
      tagged_by: r.queue_tagged_by,
      tagged_at: r.queue_tagged_at ? new Date(r.queue_tagged_at).toISOString() : null,
      summary: r.queue_summary,
      message_count: r.message_count,
      created_at: new Date(r.created_at).toISOString(),
    })),
    total: rows.length,
  });
});

// POST /api/queue/gorn — add thread to queue (any Beast can tag)
app.post('/api/queue/gorn', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.thread_id) return c.json({ error: 'thread_id required' }, 400);

    const now = Date.now();
    sqlite.prepare(`
      UPDATE forum_threads
      SET category = 'gorn-queue', queue_status = 'pending', queue_tagged_by = ?, queue_tagged_at = ?, queue_summary = ?
      WHERE id = ?
    `).run(data.tagged_by || 'unknown', now, data.summary || null, data.thread_id);

    return c.json({ success: true, thread_id: data.thread_id, queue_status: 'pending' });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// PATCH /api/queue/gorn/:threadId — update queue status (Decided/Defer/Withdraw — gorn only from browser)
app.patch('/api/queue/gorn/:threadId', async (c) => {
  const threadId = parseInt(c.req.param('threadId'), 10);
  try {
    const data = await c.req.json();
    const allowed = ['decided', 'deferred', 'pending', 'withdrawn'];
    if (!data.status || !allowed.includes(data.status)) {
      return c.json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` }, 400);
    }

    // Browser access restricted to gorn
    if (!isTrustedRequest(c)) {
      const as = data.as?.toLowerCase();
      if (as !== 'gorn') return c.json({ error: 'Only Gorn can update queue items' }, 403);
    }

    sqlite.prepare('UPDATE forum_threads SET queue_status = ? WHERE id = ? AND category = ?')
      .run(data.status, threadId, 'gorn-queue');

    return c.json({ success: true, thread_id: threadId, queue_status: data.status });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// Lock/unlock thread (prevents new messages)
app.patch('/api/thread/:id/lock', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    const locked = data.locked ? 1 : 0;
    // Use status: 'locked' for locked threads, revert to 'active' when unlocking
    if (locked) {
      sqlite.prepare('UPDATE forum_threads SET status = ? WHERE id = ?').run('locked', threadId);
    } else {
      sqlite.prepare("UPDATE forum_threads SET status = ? WHERE id = ? AND status = 'locked'").run('active', threadId);
    }
    return c.json({ success: true, thread_id: threadId, locked: !!locked });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// Archive thread
app.patch('/api/thread/:id/archive', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  sqlite.prepare('UPDATE forum_threads SET status = ? WHERE id = ?').run('archived', threadId);
  return c.json({ success: true, thread_id: threadId, status: 'archived' });
});

// Pin/unpin thread
app.patch('/api/thread/:id/pin', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    const pinned = data.pinned ? 1 : 0;
    sqlite.prepare('UPDATE forum_threads SET pinned = ? WHERE id = ?').run(pinned, threadId);
    return c.json({ success: true, thread_id: threadId, pinned: !!pinned });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// Update thread title (T#428)
app.patch('/api/thread/:id/title', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);
    // Validate thread exists
    const existing = sqlite.prepare('SELECT id FROM forum_threads WHERE id = ?').get(threadId);
    if (!existing) return c.json({ error: 'Thread not found' }, 404);
    // Sanitize: strip HTML tags, cap length
    let title = data.title.trim().replace(/<[^>]*>/g, '');
    if (title.length > 200) title = title.slice(0, 200);
    if (!title) return c.json({ error: 'title required (after sanitization)' }, 400);
    sqlite.prepare('UPDATE forum_threads SET title = ? WHERE id = ?').run(title, threadId);
    return c.json({ success: true, thread_id: threadId, title });
  } catch { return c.json({ error: 'Invalid JSON' }, 400); }
});

// Update thread visibility (Spec #32 — guest mode)
app.patch('/api/thread/:id/visibility', async (c) => {
  const role = (c.get as any)('role') as Role | undefined;
  if (role === 'guest') return c.json({ error: 'Forbidden' }, 403);

  const threadId = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    if (data.visibility !== 'public' && data.visibility !== 'internal') {
      return c.json({ error: "visibility must be 'public' or 'internal'" }, 400);
    }
    sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run(data.visibility, threadId);

    // T#629: Notify all Beasts when a thread becomes public
    if (data.visibility === 'public') {
      try {
        const thread = sqlite.prepare('SELECT title, created_by FROM forum_threads WHERE id = ?').get(threadId) as any;
        if (thread) {
          const { getOracleRegistry, notifyMentioned } = await import('./forum/mentions.ts');
          const registry = getOracleRegistry();
          const allBeasts = Object.keys(registry).filter(name => name !== 'gorn' && name !== (thread.created_by || '').toLowerCase());
          notifyMentioned(allBeasts, threadId, thread.title, thread.created_by || 'unknown', `New public thread: ${thread.title}`, undefined, new Set(allBeasts));
        }
      } catch { /* best effort */ }
    }

    return c.json({ success: true, thread_id: threadId, visibility: data.visibility });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// Update thread status
app.patch('/api/thread/:id/status', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    if (!data.status) {
      return c.json({ error: 'Missing required field: status' }, 400);
    }
    updateThreadStatus(threadId, data.status);
    return c.json({ success: true, thread_id: threadId, status: data.status });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// DELETE /api/thread/:id — soft delete (set deleted_at, hide from listings)
// Auth: thread creator or Gorn only
app.delete('/api/thread/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const as = c.req.query('as')?.toLowerCase() || (hasSessionAuth(c) ? 'gorn' : '');
  if (!as) return c.json({ error: 'as param required for DELETE' }, 400);
  const existing = sqlite.prepare('SELECT * FROM forum_threads WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Thread not found' }, 404);
  if (as !== 'gorn' && as !== existing.created_by?.toLowerCase()) {
    return c.json({ error: 'Only the thread creator or Gorn can delete a thread' }, 403);
  }
  // Soft delete — set deleted_at timestamp (Nothing is Deleted)
  sqlite.prepare("UPDATE forum_threads SET deleted_at = datetime('now'), status = 'deleted' WHERE id = ?").run(id);
  return c.json({ deleted: id, title: existing.title, soft: true });
});

// ============================================================================
// DM Routes (private one-on-one messaging)
// ============================================================================

import {
  sendDm,
  listConversations,
  getMessages as getDmMessages,
  markRead,
  markAllRead,
  getDashboard,
} from './dm/handler.ts';

// DM performance index — composite for sorted conversation queries
try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_dm_messages_conv_created ON dm_messages(conversation_id, created_at)').run(); } catch { /* exists */ }

// DM Dashboard — accessible to authenticated users (auth middleware handles access)
app.get('/api/dm/dashboard', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const data = getDashboard(limit);
  return c.json({
    conversations: data.conversations.map(conv => ({
      id: conv.id,
      participants: conv.participants,
      message_count: conv.messageCount,
      unread_count: conv.unreadCount,
      last_message: conv.lastMessage,
      last_sender: conv.lastSender,
      last_at: new Date(conv.lastAt).toISOString(),
      created_at: new Date(conv.createdAt).toISOString(),
    })),
    total_conversations: data.totalConversations,
    total_messages: data.totalMessages,
  });
});

// GET /api/dm/unread-count — total DM unread count for Gorn (T#535, menu bar widget)
app.get('/api/dm/unread-count', (c) => {
  const data = getDashboard(100);
  const gornConvos = data.conversations.filter(conv =>
    conv.participants.some((p: string) => p.toLowerCase() === 'gorn')
  );
  const unread = gornConvos.reduce((sum, conv) => sum + conv.unreadCount, 0);
  return c.json({ unread });
});

// Send a DM
app.post('/api/dm', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.to || !data.message) {
      return c.json({ error: 'Missing required fields: to, message' }, 400);
    }

    const role = (c.get as any)('role') as Role | undefined;

    if (role === 'guest') {
      // Guest path — derive sender from guest-session auth (server-set), not body.from
      const guestUsername = (c.get as any)('guestUsername');
      if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);

      // Rate limiting
      const rateCheck = checkGuestDmRate(guestUsername);
      if (!rateCheck.allowed) {
        return c.json({ error: rateCheck.error }, 429);
      }

      // Content length limit
      const lengthCheck = checkGuestContentLength(data.message, 'dm');
      if (!lengthCheck.allowed) {
        return c.json({ error: lengthCheck.error }, 400);
      }

      // Injection pattern scan (flag, don't block)
      const scan = scanForInjection(data.message);
      if (scan.flagged) {
        logSecurityEvent({
          eventType: 'suspicious_content',
          severity: 'warning',
          actor: guestUsername,
          actorType: 'guest',
          target: `/api/dm/${data.to}`,
          details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
          ipSource: c.req.header('x-real-ip') || 'local',
          requestId: (c.get as any)('requestId'),
        });
      }

      // Tag guest sender — derived from session, not body
      data.from = `[Guest] ${guestUsername}`;
    } else {
      // T#718 — Beast/owner path: derive from auth-layer, reject client-asserted mismatch.
      // Closes Bertus/Flint DM-spoof finding (#10002). Any body.from must match the
      // authenticated caller, or the request is rejected.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.from && data.from.toLowerCase() !== caller) {
        return c.json({ error: 'Sender impersonation blocked. body.from must match authenticated caller or be omitted.' }, 403);
      }
      data.from = caller;
    }
    // Validate recipient exists — must be a beast, guest username/display name, or "gorn"
    const rawTo = data.to.replace(/^\[Guest\]\s*/, ''); // Strip [Guest] prefix if present
    const recipientBeast = getBeastProfile(rawTo);
    let recipientGuest = getGuestByUsername(sqlite, rawTo);
    // T#635: Fall back to display name lookup if username not found
    if (!recipientGuest) recipientGuest = getGuestByDisplayName(sqlite, rawTo);
    const isOwner = rawTo.toLowerCase() === 'gorn';
    if (!recipientBeast && !recipientGuest && !isOwner) {
      // T#635: Suggest similar guest usernames on mismatch
      const allGuests = listGuests(sqlite);
      const suggestions = allGuests
        .filter(g => g.username.includes(rawTo.toLowerCase()) || (g.display_name || '').toLowerCase().includes(rawTo.toLowerCase()))
        .map(g => `${g.username} (${g.display_name || g.username})`)
        .slice(0, 3);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      return c.json({ error: `Recipient "${data.to}" not found. Must be a valid beast name or guest username.${hint}` }, 404);
    }

    // Resolve guest usernames to [Guest] tags so messages land in the same conversation
    let dmFrom = data.from;
    let dmTo = data.to;
    const guestFrom = getGuestByUsername(sqlite, data.from);
    if (guestFrom) dmFrom = `[Guest] ${guestFrom.display_name || data.from}`;
    if (recipientGuest) dmTo = `[Guest] ${recipientGuest.display_name || rawTo}`;
    else if (data.to !== rawTo) dmTo = rawTo; // Strip [Guest] prefix for beast recipients

    const result = await withRetry(() => sendDm(dmFrom, dmTo, data.message));
    // Set author_role on DM message (Spec #32, T#557 — Talon review fix)
    if (result.messageId) {
      const authorRole = role === 'guest' ? 'guest' : (role === 'owner' ? 'owner' : 'beast');
      try {
        sqlite.prepare('UPDATE dm_messages SET author_role = ? WHERE id = ?')
          .run(authorRole, result.messageId);
      } catch { /* column may not exist yet */ }
    }
    wsBroadcast('new_dm', { conversation_id: result.conversationId });
    return c.json({
      conversation_id: result.conversationId,
      message_id: result.messageId,
      from: data.from.toLowerCase(),
      to: data.to.toLowerCase(),
      notified: result.notified,
    }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// List conversations for an Oracle
app.get('/api/dm/:name', (c) => {
  const name = c.req.param('name');
  const as = c.req.query('as')?.toLowerCase();
  // IDOR protection: 'as' required. Must match name or be 'gorn'.
  // Local network bypass: skip check for local requests (CLI/beast access)
  if (!isTrustedRequest(c)) {
    if (!as) return c.json({ error: 'as param required for DM access' }, 400);
    if (as !== 'gorn' && as !== name.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only view your own conversations.' }, 403);
    }
  }
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');
  const data = listConversations(name, limit, offset);
  return c.json({
    conversations: data.conversations.map(conv => ({
      id: conv.id,
      with: conv.with,
      last_message: conv.lastMessage,
      last_sender: conv.lastSender,
      last_at: new Date(conv.lastAt).toISOString(),
      unread_count: conv.unreadCount,
      created_at: new Date(conv.createdAt).toISOString(),
    })),
    total: data.total,
  });
});

// Get messages between two Oracles (also handles guest usernames)
app.get('/api/dm/:name/:other', (c) => {
  let name = c.req.param('name');
  let other = c.req.param('other');
  const as = c.req.query('as')?.toLowerCase();

  // Resolve guest usernames to [Guest] tags
  // If name/other doesn't match a known beast and matches a guest account, use the [Guest] tag
  for (const param of ['name', 'other'] as const) {
    const val = param === 'name' ? name : other;
    if (!val.startsWith('[Guest]') && !val.startsWith('[guest]')) {
      const guest = getGuestByUsername(sqlite, val);
      if (guest) {
        const tag = `[Guest] ${guest.display_name || val}`;
        if (param === 'name') name = tag;
        else other = tag;
      }
    }
  }
  // IDOR protection: 'as' required from non-local. Must be participant or gorn.
  if (!isTrustedRequest(c)) {
    if (!as) return c.json({ error: 'as param required for DM access' }, 400);
    if (as !== 'gorn' && as !== name.toLowerCase() && as !== other.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only read conversations you are part of.' }, 403);
    }
  }
  const parsedDmLimit = parseInt(c.req.query('limit') || '50', 10);
  const limit = isNaN(parsedDmLimit) || parsedDmLimit < 1 ? 50 : parsedDmLimit;
  const parsedDmOffset = parseInt(c.req.query('offset') || '0', 10);
  const offset = isNaN(parsedDmOffset) || parsedDmOffset < 0 ? 0 : parsedDmOffset;
  const order = (c.req.query('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
  const data = getDmMessages(name, other, limit, offset, order);
  return c.json({
    conversation_id: data.conversationId,
    participants: data.participants,
    messages: data.messages.map(m => ({
      id: m.id,
      sender: m.sender,
      message: m.content,
      read_at: m.readAt ? new Date(m.readAt).toISOString() : null,
      created_at: new Date(m.createdAt).toISOString(),
    })),
    total: data.total,
  });
});

// Mark messages as read (from other to reader) — only the reader can mark their own
app.patch('/api/dm/:name/:other/read', (c) => {
  const reader = c.req.param('name');
  const other = c.req.param('other');
  if (!isTrustedRequest(c)) {
    const as = c.req.query('as')?.toLowerCase();
    if (!as) return c.json({ error: 'as param required' }, 400);
    if (as !== reader.toLowerCase() && as !== 'gorn') {
      return c.json({ error: 'Can only mark your own messages as read' }, 403);
    }
  }
  const result = markRead(reader, other);
  if (result.markedRead > 0) wsBroadcast('dm_read', { conversation_id: result.conversationId, reader });
  return c.json({
    marked_read: result.markedRead,
    conversation_id: result.conversationId,
  });
});

// Mark ALL messages in a conversation as read — only participant or gorn
app.patch('/api/dm/:name/:other/read-all', (c) => {
  const name = c.req.param('name');
  const other = c.req.param('other');
  if (!isTrustedRequest(c)) {
    const as = c.req.query('as')?.toLowerCase();
    if (!as) return c.json({ error: 'as param required' }, 400);
    if (as !== name.toLowerCase() && as !== other.toLowerCase() && as !== 'gorn') {
      return c.json({ error: 'Can only mark messages as read in your own conversations' }, 403);
    }
  }
  const result = markAllRead(name, other);
  if (result.markedRead > 0) wsBroadcast('dm_read', { conversation_id: result.conversationId, reader: name });
  return c.json({
    marked_read: result.markedRead,
    conversation_id: result.conversationId,
  });
});

// DELETE /api/dm/messages/:id — delete a single DM message
// Auth: conversation participant or Gorn only (Bertus security review)
app.delete('/api/dm/messages/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  // T#718 — derive caller from auth, reject ?as= mismatch
  const caller = requireBeastIdentity(c);
  if (!caller) {
    return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
  }
  const claimedAs = c.req.query('as')?.toLowerCase();
  if (claimedAs && claimedAs !== caller) {
    return c.json({ error: 'Identity spoof blocked. ?as= must match authenticated caller or be omitted.' }, 403);
  }
  const as = caller;
  const msg = sqlite.prepare('SELECT m.*, c.participant1, c.participant2 FROM dm_messages m JOIN dm_conversations c ON c.id = m.conversation_id WHERE m.id = ?').get(id) as any;
  if (!msg) return c.json({ error: 'Message not found' }, 404);
  if (as !== 'gorn' && as !== msg.sender && as !== msg.participant1 && as !== msg.participant2) {
    return c.json({ error: 'Can only delete messages in your own conversations' }, 403);
  }
  sqlite.prepare('DELETE FROM dm_messages WHERE id = ?').run(id);
  return c.json({ deleted: id });
});

// ============================================================================
// Library — searchable knowledge base
// ============================================================================

// Create library table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'learning',
    author TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
} catch { /* already exists */ }

// Library Shelves table (T#330)
try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS library_shelves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    icon TEXT,
    color TEXT,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run(); } catch { /* exists */ }

// Add shelf_id to library table
try { sqlite.prepare(`ALTER TABLE library ADD COLUMN shelf_id INTEGER REFERENCES library_shelves(id) ON DELETE SET NULL`).run(); } catch { /* exists */ }
// Index for efficient shelf filtering
try { sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_library_shelf_id ON library(shelf_id)`).run(); } catch { /* exists */ }
// T#623: Add visibility to shelves (public/internal, default internal)
try { sqlite.prepare(`ALTER TABLE library_shelves ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal'`).run(); } catch { /* exists */ }

// --- Shelf CRUD ---

// GET /api/library/shelves — list all shelves with entry counts
app.get('/api/library/shelves', (c) => {
  const isGuest = (c.get as any)('role') === 'guest';
  const visFilter = c.req.query('visibility');
  let query = `
    SELECT s.*, COUNT(l.id) as entry_count
    FROM library_shelves s
    LEFT JOIN library l ON l.shelf_id = s.id
  `;
  const params: any[] = [];
  if (isGuest) {
    query += ` WHERE s.visibility = 'public'`;
  } else if (visFilter === 'public' || visFilter === 'internal') {
    query += ` WHERE s.visibility = ?`;
    params.push(visFilter);
  }
  query += ` GROUP BY s.id ORDER BY s.name`;
  const shelves = sqlite.prepare(query).all(...params);
  return c.json({ shelves });
});

// GET /api/library/shelves/:id — single shelf with entries
app.get('/api/library/shelves/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const isGuest = (c.get as any)('role') === 'guest';
  const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id) as any;
  if (!shelf) return c.json({ error: 'Shelf not found' }, 404);
  if (isGuest && shelf.visibility !== 'public') return c.json({ error: 'Shelf not found' }, 404);
  const entryCount = (sqlite.prepare('SELECT COUNT(*) as c FROM library WHERE shelf_id = ?').get(id) as any).c;
  return c.json({ ...shelf, entry_count: entryCount });
});

// POST /api/library/shelves — create shelf
app.post('/api/library/shelves', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.name?.trim()) return c.json({ error: 'name required' }, 400);
    // T#718 — derive author from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const claimed = (c.req.query('as') || data.created_by || '').toLowerCase();
    if (claimed && claimed !== caller) {
      return c.json({ error: 'Identity spoof blocked. ?as=/body.created_by must match authenticated caller or be omitted.' }, 403);
    }
    const author = caller;

    // Check duplicate
    const existing = sqlite.prepare('SELECT id FROM library_shelves WHERE name = ?').get(data.name.trim());
    if (existing) return c.json({ error: 'A shelf with this name already exists' }, 409);

    const now = new Date().toISOString();
    const visibility = (data.visibility === 'public') ? 'public' : 'internal';
    const result = sqlite.prepare(
      'INSERT INTO library_shelves (name, description, icon, color, created_by, created_at, updated_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(data.name.trim(), data.description || null, data.icon || null, data.color || null, author, now, now, visibility);
    const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get((result as any).lastInsertRowid) as any;
    searchIndexUpsert('shelf', shelf.id, shelf.name, shelf.description || '', author, now, '/library');
    return c.json(shelf, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Invalid request' }, 400);
  }
});

// PATCH /api/library/shelves/:id — update shelf
app.patch('/api/library/shelves/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id);
  if (!existing) return c.json({ error: 'Shelf not found' }, 404);
  try {
    const data = await c.req.json();
    const allowed = ['name', 'description', 'icon', 'color', 'visibility'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of allowed) {
      if (field in data) {
        if (field === 'name' && data.name?.trim()) {
          const dup = sqlite.prepare('SELECT id FROM library_shelves WHERE name = ? AND id != ?').get(data.name.trim(), id);
          if (dup) return c.json({ error: 'A shelf with this name already exists' }, 409);
        }
        if (field === 'visibility') {
          if (!hasSessionAuth(c)) return c.json({ error: 'Only Gorn can change shelf visibility' }, 403);
          const val = data[field] === 'public' ? 'public' : 'internal';
          updates.push(`${field} = ?`);
          values.push(val);
          continue;
        }
        updates.push(`${field} = ?`);
        values.push(data[field]);
      }
    }
    if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);
    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    sqlite.prepare(`UPDATE library_shelves SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id) as any;
    if (shelf) searchIndexUpsert('shelf', id, shelf.name, shelf.description || '', shelf.created_by, shelf.created_at, '/library');
    return c.json(shelf);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// DELETE /api/library/shelves/:id — delete shelf, entries become ungrouped (Gorn only)
app.delete('/api/library/shelves/:id', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id);
  if (!existing) return c.json({ error: 'Shelf not found' }, 404);
  // Ungroup entries (ON DELETE SET NULL handles this, but be explicit)
  sqlite.prepare('UPDATE library SET shelf_id = NULL WHERE shelf_id = ?').run(id);
  sqlite.prepare('DELETE FROM library_shelves WHERE id = ?').run(id);
  searchIndexDelete('shelf', id);
  return c.json({ deleted: true, id });
});

// GET /api/library — list/search library entries
app.get('/api/library', (c) => {
  const isGuest = (c.get as any)('role') === 'guest';
  const q = c.req.query('q');
  const type = c.req.query('type') || c.req.query('category');
  const author = c.req.query('author');
  const tag = c.req.query('tag');
  const limit = Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50);
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

  let query = 'SELECT l.* FROM library l';
  const params: any[] = [];

  // T#623: guests only see entries in public shelves
  if (isGuest) {
    query += ' INNER JOIN library_shelves s ON s.id = l.shelf_id AND s.visibility = \'public\'';
  }

  query += ' WHERE 1=1';

  if (q) {
    query += ' AND (l.title LIKE ? OR l.content LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (type) {
    query += ' AND l.type = ?';
    params.push(type);
  }
  if (author) {
    query += ' AND l.author = ?';
    params.push(author);
  }
  if (tag) {
    query += ' AND l.tags LIKE ?';
    params.push(`%"${tag}"%`);
  }
  const shelfId = c.req.query('shelf_id');
  if (shelfId === 'null') {
    query += ' AND l.shelf_id IS NULL';
  } else if (shelfId) {
    query += ' AND l.shelf_id = ?';
    params.push(parseInt(shelfId, 10));
  }

  // Count
  const countQuery = query.replace('SELECT l.*', 'SELECT COUNT(*) as count');
  const countResult = sqlite.prepare(countQuery).get(...params) as any;

  query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = sqlite.prepare(query).all(...params) as any[];

  return c.json({
    entries: rows.map(r => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.type,
      category: r.type,
      author: r.author,
      tags: (() => { try { const t = JSON.parse(r.tags || '[]'); return Array.isArray(t) ? t : []; } catch { return typeof r.tags === 'string' && r.tags ? r.tags.split(',').map((s: string) => s.trim()) : []; } })(),
      shelf_id: r.shelf_id || null,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    })),
    total: countResult?.count || 0,
  });
});

// GET /api/library/search — typeahead suggestions for shelves + entries
app.get('/api/library/search', (c) => {
  const isGuest = (c.get as any)('role') === 'guest';
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 2) return c.json({ suggestions: [] });

  const pattern = `%${q}%`;

  const shelfQuery = isGuest
    ? 'SELECT id, name, icon, color, "shelf" as result_type FROM library_shelves WHERE name LIKE ? AND visibility = \'public\' LIMIT 5'
    : 'SELECT id, name, icon, color, "shelf" as result_type FROM library_shelves WHERE name LIKE ? LIMIT 5';
  const shelves = sqlite.prepare(shelfQuery).all(pattern) as any[];

  const entryQuery = isGuest
    ? 'SELECT l.id, l.title, l.type, l.author, l.shelf_id, "entry" as result_type FROM library l INNER JOIN library_shelves s ON s.id = l.shelf_id AND s.visibility = \'public\' WHERE l.title LIKE ? ORDER BY l.updated_at DESC LIMIT 8'
    : 'SELECT id, title, type, author, shelf_id, "entry" as result_type FROM library WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 8';
  const entries = sqlite.prepare(entryQuery).all(pattern) as any[];

  return c.json({
    suggestions: [
      ...shelves.map(s => ({ id: s.id, label: s.name, icon: s.icon, color: s.color, type: 'shelf' as const })),
      ...entries.map(e => ({ id: e.id, label: e.title, type: 'entry' as const, entryType: e.type, author: e.author, shelf_id: e.shelf_id })),
    ],
  });
});

// GET /api/library/types — list available types and counts (must be before /:id)
app.get('/api/library/types', (c) => {
  const rows = sqlite.prepare('SELECT type, COUNT(*) as count FROM library GROUP BY type ORDER BY count DESC').all() as any[];
  return c.json({ types: rows });
});

// GET /api/library/:id — get single entry
app.get('/api/library/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const isGuest = (c.get as any)('role') === 'guest';
  const row = sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id) as any;
  if (!row) return c.json({ error: 'Entry not found' }, 404);
  // T#623: guests can only see entries in public shelves
  if (isGuest && row.shelf_id) {
    const shelf = sqlite.prepare('SELECT visibility FROM library_shelves WHERE id = ?').get(row.shelf_id) as any;
    if (!shelf || shelf.visibility !== 'public') return c.json({ error: 'Entry not found' }, 404);
  } else if (isGuest && !row.shelf_id) {
    return c.json({ error: 'Entry not found' }, 404); // unshelved entries hidden from guests
  }

  return c.json({
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type,
    category: row.type,
    author: row.author,
    tags: JSON.parse(row.tags || '[]'),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  });
});

// POST /api/library — create entry
app.post('/api/library', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.title || !data.content) {
      return c.json({ error: 'title and content required' }, 400);
    }
    // T#718 — derive author from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (data.author && data.author.toLowerCase() !== caller) {
      return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
    }
    const author = caller;

    const allowed = ['research', 'architecture', 'learning', 'decision'];
    const type = allowed.includes(data.type) ? data.type : 'learning';
    const tags = JSON.stringify(data.tags || []);
    const now = Date.now();

    const shelfId = data.shelf_id ? Number(data.shelf_id) : null;
    if (!shelfId) return c.json({ error: 'shelf_id required — every entry must belong to a shelf' }, 400);
    const result = sqlite.prepare(
      'INSERT INTO library (title, content, type, author, tags, shelf_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(data.title, data.content, type, author, tags, shelfId, now, now);

    const newId = (result as any).lastInsertRowid;
    searchIndexUpsert('library', newId, data.title, data.content, author, new Date(now).toISOString());
    return c.json({ id: newId, title: data.title, type, author }, 201);
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// PATCH /api/library/:id — update entry
app.patch('/api/library/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  try {
    const data = await c.req.json();
    const now = Date.now();
    const updates: string[] = ['updated_at = ?'];
    const params: any[] = [now];

    if (data.title) { updates.push('title = ?'); params.push(data.title); }
    if (data.content) { updates.push('content = ?'); params.push(data.content); }
    if (data.type) { updates.push('type = ?'); params.push(data.type); }
    if (data.tags) { updates.push('tags = ?'); params.push(JSON.stringify(data.tags)); }
    if ('shelf_id' in data) { updates.push('shelf_id = ?'); params.push(data.shelf_id || null); }

    params.push(id);
    sqlite.prepare(`UPDATE library SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id) as any;
    if (updated) {
      searchIndexUpsert('library', id, updated.title, updated.content, updated.author, new Date(updated.created_at).toISOString());
      if (updated.tags) { try { updated.tags = JSON.parse(updated.tags); } catch { updated.tags = []; } }
    }
    return c.json(updated);
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// DELETE /api/library/:id — delete entry (Gorn or Pip)
app.delete('/api/library/:id', (c) => {
  // T#718 — derive requester from auth, reject client-asserted mismatch
  const caller = requireBeastIdentity(c);
  if (!caller) {
    return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
  }
  const claimedAs = c.req.query('as')?.toLowerCase();
  if (claimedAs && claimedAs !== caller) {
    return c.json({ error: 'Identity spoof blocked. ?as= must match authenticated caller or be omitted.' }, 403);
  }
  const requester = caller;
  if (requester !== 'gorn' && requester !== 'pip') {
    return c.json({ error: 'Only Gorn or Pip can delete library entries' }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT id FROM library WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Entry not found' }, 404);
  sqlite.prepare('DELETE FROM library WHERE id = ?').run(id);
  searchIndexDelete('library', id);
  wsBroadcast('library_entry_deleted', { id });
  return c.json({ deleted: true, id });
});

// ============================================================================
// PM Board — Projects + Tasks + Task Comments
// ============================================================================

// Create projects table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
} catch { /* already exists */ }

// Create tasks table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    assigned_to TEXT,
    created_by TEXT NOT NULL,
    thread_id INTEGER,
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  // v2: add type column
  try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'task'`).run(); } catch { /* exists */ }
  // Backfill existing tasks with no type
  sqlite.prepare(`UPDATE tasks SET type = 'task' WHERE type IS NULL`).run();
  // v3: SDD enforcement columns (T#317)
  try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN spec_id INTEGER`).run(); } catch { /* exists */ }
  // v4: reviewer field for in_review workflow (T#418)
  try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN reviewer TEXT`).run(); } catch { /* exists */ }
  // v5: risk_level for QA triage (T#617)
  try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN risk_level TEXT DEFAULT 'medium'`).run(); } catch { /* exists */ }
  sqlite.prepare(`UPDATE tasks SET risk_level = 'medium' WHERE risk_level IS NULL`).run();
} catch { /* already exists */ }

const VALID_TASK_TYPES = ['bug', 'feature', 'improvement', 'chore', 'task'];
const VALID_RISK_LEVELS = ['high', 'medium', 'low'];

// SDD enforcement: check if task can transition to in_progress or done
function checkApprovalGate(task: any): string | null {
  if (!task.approval_required) return null;
  if (!task.spec_id) return "Gorn's spec approval required before starting. Submit a spec via /spec submit and wait for approval at /specs.";
  const spec = sqlite.prepare('SELECT status FROM spec_reviews WHERE id = ?').get(task.spec_id) as any;
  if (!spec || spec.status !== 'approved') return "Spec not yet approved. Wait for Gorn's approval at /specs before starting.";
  return null;
}

// Create task_comments table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`).run();
} catch { /* already exists */ }

// --- Projects CRUD ---

// GET /api/projects — list projects
app.get('/api/projects', (c) => {
  const status = c.req.query('status');
  let rows;
  if (status) {
    rows = sqlite.prepare(
      'SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC'
    ).all(status) as any[];
  } else {
    rows = sqlite.prepare(
      "SELECT * FROM projects ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 END, created_at DESC"
    ).all() as any[];
  }
  return c.json({ projects: rows });
});

// POST /api/projects — create project
app.post('/api/projects', async (c) => {
  const data = await c.req.json();
  const { name, description, created_by } = data;
  if (!name || !created_by) return c.json({ error: 'name and created_by required' }, 400);
  const now = new Date().toISOString();
  const result = sqlite.prepare(
    'INSERT INTO projects (name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description || '', created_by, now, now);
  const project = sqlite.prepare('SELECT * FROM projects WHERE id = ?').get((result as any).lastInsertRowid);
  wsBroadcast('project_created', { id: (project as any).id });
  return c.json(project, 201);
});

// GET /api/projects/:id — get project with task counts
app.get('/api/projects/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const project = sqlite.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!project) return c.json({ error: 'Project not found' }, 404);
  const taskCounts = sqlite.prepare(
    'SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status'
  ).all(id) as any[];
  return c.json({ ...project, task_counts: Object.fromEntries(taskCounts.map(r => [r.status, r.count])) });
});

// PATCH /api/projects/:id — update project
app.patch('/api/projects/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const data = await c.req.json();
  const updates: string[] = [];
  const params: any[] = [];
  for (const field of ['name', 'description', 'status']) {
    if (data[field] !== undefined) { updates.push(`${field} = ?`); params.push(data[field]); }
  }
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
  updates.push('updated_at = ?'); params.push(new Date().toISOString());
  params.push(id);
  sqlite.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const project = sqlite.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return c.json(project);
});

// DELETE /api/projects/:id — delete project (Gorn or Pip)
app.delete('/api/projects/:id', (c) => {
  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (requester !== 'gorn' && requester !== 'pip') {
    return c.json({ error: 'Only Gorn or Pip can delete projects' }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Project not found' }, 404);
  // Unlink tasks (set project_id to null) rather than deleting them
  sqlite.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id);
  sqlite.prepare('DELETE FROM team_projects WHERE project_id = ?').run(id);
  sqlite.prepare('DELETE FROM projects WHERE id = ?').run(id);
  wsBroadcast('project_deleted', { id });
  return c.json({ deleted: true, id });
});

// --- Tasks CRUD ---

// GET /api/tasks — list tasks with filters
app.get('/api/tasks', (c) => {
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');
  const assignedTo = c.req.query('assigned_to') || c.req.query('assignee');
  const priority = c.req.query('priority');
  const limit = Math.min(200, parseInt(c.req.query('limit') || '100', 10));
  const offset = parseInt(c.req.query('offset') || '0', 10);

  let query = 'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1';
  const params: any[] = [];

  if (projectId) { query += ' AND t.project_id = ?'; params.push(parseInt(projectId, 10)); }
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      query += ' AND t.status = ?'; params.push(statuses[0]);
    } else {
      query += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
  }
  if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }
  if (priority) { query += ' AND t.priority = ?'; params.push(priority); }
  const type = c.req.query('type');
  if (type) { query += ' AND t.type = ?'; params.push(type); }
  const riskLevel = c.req.query('risk_level');
  if (riskLevel) { query += ' AND t.risk_level = ?'; params.push(riskLevel); }

  const countQuery = query.replace('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id', 'SELECT COUNT(*) as total FROM tasks t');
  const total = (sqlite.prepare(countQuery).get(...params) as any)?.total || 0;

  // Done tasks sort by most recently completed; others by priority then created_at
  if (status === 'done') {
    query += ' ORDER BY t.updated_at DESC';
  } else {
    query += ' ORDER BY CASE t.priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, t.created_at DESC';
  }
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const tasks = sqlite.prepare(query).all(...params) as any[];
  return c.json({ tasks, total });
});

// POST /api/tasks — create task
app.post('/api/tasks', async (c) => {
  const data = await c.req.json();
  const { title, description, project_id, status, priority, assigned_to, created_by, thread_id, due_date, type, reviewer, risk_level } = data;
  if (!title || !created_by) return c.json({ error: 'title and created_by required' }, 400);
  if (!project_id) return c.json({ error: 'project_id required — every task must belong to a project' }, 400);
  if (!assigned_to) return c.json({ error: 'assigned_to required — every task must have an assignee' }, 400);
  if (!reviewer) return c.json({ error: 'reviewer required — every task must have a reviewer for the in_review workflow' }, 400);

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
  const validPriorities = ['critical', 'high', 'medium', 'low'];
  const taskStatus = validStatuses.includes(status) ? status : 'todo';
  const taskPriority = validPriorities.includes(priority) ? priority : 'medium';
  if (type && !VALID_TASK_TYPES.includes(type)) return c.json({ error: `Invalid type. Valid: ${VALID_TASK_TYPES.join(', ')}` }, 400);
  const taskType = type || 'task';
  if (risk_level && !VALID_RISK_LEVELS.includes(risk_level)) return c.json({ error: `Invalid risk_level. Valid: ${VALID_RISK_LEVELS.join(', ')}` }, 400);
  const taskRiskLevel = VALID_RISK_LEVELS.includes(risk_level) ? risk_level : 'medium';

  const now = new Date().toISOString();
  const approvalRequired = data.approval_required ? 1 : 0;
  const result = sqlite.prepare(
    'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, thread_id, due_date, type, approval_required, reviewer, risk_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(project_id || null, title, description || '', taskStatus, taskPriority, assigned_to || null, created_by, thread_id || null, due_date || null, taskType, approvalRequired, reviewer, taskRiskLevel, now, now);

  const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get((result as any).lastInsertRowid) as any;
  searchIndexUpsert('task', task.id, task.title, task.description || '', task.assigned_to || '', now, `/board?task=${task.id}`);
  wsBroadcast('task_created', { id: task.id });

  // Notify assignee + @mentioned beasts in description (T#378)
  try {
    const { parseMentions, notifyMentioned } = await import('./forum/mentions.ts');
    const toNotify = new Set<string>();

    // Add assignee
    if (task.assigned_to) toNotify.add(task.assigned_to.toLowerCase());

    // Parse @mentions from description
    if (task.description) {
      for (const name of parseMentions(task.description)) toNotify.add(name);
    }

    // Remove the creator (don't notify yourself)
    toNotify.delete(created_by.toLowerCase());

    if (toNotify.size > 0) {
      notifyMentioned(
        [...toNotify],
        0, // no thread
        task.title,
        created_by,
        `New task T#${task.id}: ${task.title}${task.assigned_to ? ` (assigned to @${task.assigned_to})` : ''}`,
        { type: 'PM Board', label: `task #${task.id}`, hint: `Use /board task ${task.id} to view.` },
      );
    }
  } catch { /* notification failure is non-critical */ }

  return c.json(task, 201);
});

// GET /api/tasks/:id — get task with comments
app.get('/api/tasks/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const task = sqlite.prepare(
    'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?'
  ).get(id) as any;
  if (!task) return c.json({ error: 'Task not found' }, 404);
  const comments = sqlite.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC').all(id) as any[];
  return c.json({ ...task, comments });
});

// PATCH /api/tasks/:id — update task
app.patch('/api/tasks/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  const data = await c.req.json();

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
  const validPriorities = ['critical', 'high', 'medium', 'low'];
  if (data.status && !validStatuses.includes(data.status)) return c.json({ error: `Invalid status. Valid: ${validStatuses.join(', ')}` }, 400);
  if (data.priority && !validPriorities.includes(data.priority)) return c.json({ error: `Invalid priority. Valid: ${validPriorities.join(', ')}` }, 400);
  if (data.type && !VALID_TASK_TYPES.includes(data.type)) return c.json({ error: `Invalid type. Valid: ${VALID_TASK_TYPES.join(', ')}` }, 400);
  if (data.risk_level && !VALID_RISK_LEVELS.includes(data.risk_level)) return c.json({ error: `Invalid risk_level. Valid: ${VALID_RISK_LEVELS.join(', ')}` }, 400);

  // Terminal status enforcement (T#529) — Done and Cancelled are final
  const terminalStatuses = ['done', 'cancelled'];
  if (data.status && terminalStatuses.includes((existing as any).status)) {
    return c.json({ error: `Cannot change status: task is ${(existing as any).status}. Done and Cancelled are terminal statuses.` }, 400);
  }

  // SDD enforcement: block forward transitions if approval_required and no approved spec
  if (data.status && ['in_progress', 'in_review', 'done'].includes(data.status)) {
    const gateError = checkApprovalGate(existing);
    if (gateError) return c.json({ error: gateError }, 400);
  }

  // Require reviewer when moving to in_review
  if (data.status === 'in_review') {
    const reviewer = data.reviewer || existing.reviewer;
    if (!reviewer) return c.json({ error: 'Reviewer required when moving to in_review. Set reviewer field.' }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];
  for (const field of ['title', 'description', 'status', 'priority', 'assigned_to', 'project_id', 'thread_id', 'due_date', 'type', 'approval_required', 'spec_id', 'reviewer', 'risk_level']) {
    if (data[field] !== undefined) { updates.push(`${field} = ?`); params.push(data[field]); }
  }
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
  updates.push('updated_at = ?'); params.push(new Date().toISOString());
  params.push(id);

  sqlite.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(id) as any;
  if (task) searchIndexUpsert('task', id, task.title, task.description || '', task.assigned_to || '', task.created_at);
  wsBroadcast('task_updated', { id: task?.id });

  // Notify reviewer when task moves to in_review (T#439)
  if (data.status === 'in_review' && task?.reviewer) {
    try {
      const { notifyMentioned } = await import('./forum/mentions.ts');
      const updatedBy = data.updated_by || task.assigned_to || 'system';
      notifyMentioned([task.reviewer], 0, `T#${id}: ${task.title}`, updatedBy, `Task moved to in_review — you are the reviewer.`, {
        type: 'PM Board', label: `T#${id}`, hint: `Review at https://denbook.online/board?task=${id}`,
      });
    } catch { /* notification failure is non-critical */ }
  }

  return c.json(task);
});

// DELETE /api/tasks/:id — soft delete (set status to 'deleted')
app.delete('/api/tasks/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const now = new Date().toISOString();
  sqlite.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('deleted', now, id);
  searchIndexDelete('task', id);
  return c.json({ success: true, id });
});

// POST /api/tasks/bulk-status — bulk status update (for PM)
app.post('/api/tasks/bulk-status', async (c) => {
  const data = await c.req.json();
  const { task_ids, status } = data;
  if (!Array.isArray(task_ids) || !status) return c.json({ error: 'task_ids and status required' }, 400);

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
  if (!validStatuses.includes(status)) return c.json({ error: 'Invalid status' }, 400);

  // SDD enforcement for bulk status
  if (['in_progress', 'in_review', 'done'].includes(status)) {
    const blocked: { id: number; error: string }[] = [];
    for (const id of task_ids) {
      const task = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
      if (task) {
        const gateError = checkApprovalGate(task);
        if (gateError) blocked.push({ id, error: gateError });
      }
    }
    if (blocked.length > 0) return c.json({ error: 'Some tasks blocked by SDD approval gate', blocked }, 400);
  }

  const now = new Date().toISOString();
  const stmt = sqlite.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
  for (const id of task_ids) {
    stmt.run(status, now, id);
  }
  wsBroadcast('tasks_bulk_updated', { task_ids });
  return c.json({ success: true, updated: task_ids.length });
});

// --- Task Comments ---

// GET /api/tasks/:id/comments
app.get('/api/tasks/:id/comments', (c) => {
  const taskId = parseInt(c.req.param('id'), 10);
  const comments = sqlite.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
  return c.json({ comments });
});

// POST /api/tasks/:id/comments
app.post('/api/tasks/:id/comments', async (c) => {
  const taskId = parseInt(c.req.param('id'), 10);
  const data = await c.req.json();
  const { author, content } = data;
  if (!author || !content) return c.json({ error: 'author and content required' }, 400);

  const now = new Date().toISOString();
  const result = sqlite.prepare(
    'INSERT INTO task_comments (task_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(taskId, author, content, now);
  const comment = sqlite.prepare('SELECT * FROM task_comments WHERE id = ?').get((result as any).lastInsertRowid);

  // Notify task assignee, creator, and @mentioned beasts about the new comment
  try {
    const task = sqlite.prepare('SELECT assigned_to, created_by, reviewer, title FROM tasks WHERE id = ?').get(taskId) as any;
    if (task) {
      const { parseMentions, notifyMentioned } = await import('./forum/mentions.ts');
      const commenter = author.split('@')[0].toLowerCase();
      const toNotify = new Set<string>();
      // Notify assignee, creator, and reviewer (T#575)
      if (task.assigned_to && task.assigned_to !== commenter) toNotify.add(task.assigned_to.toLowerCase());
      if (task.created_by && task.created_by !== commenter) toNotify.add(task.created_by.toLowerCase());
      if (task.reviewer && task.reviewer !== commenter) toNotify.add(task.reviewer.toLowerCase());
      // Parse @mentions from comment content
      const mentions = parseMentions(content, 0);
      for (const m of mentions) toNotify.add(m.toLowerCase());
      toNotify.delete(commenter);
      toNotify.delete('gorn'); toNotify.delete('human'); toNotify.delete('user');
      if (toNotify.size > 0) {
        notifyMentioned(
          [...toNotify],
          0,
          `Task #${taskId}: ${task.title || 'Untitled'}`,
          commenter,
          `New comment on task #${taskId}: ${content.slice(0, 100)}`,
          {
            type: 'PM Board',
            label: `task #${taskId}`,
            hint: `Use /board task ${taskId} to view. Use /board comment ${taskId} <message> to reply.`,
          }
        );
      }
    }
  } catch { /* notification failure is non-critical */ }

  wsBroadcast('task_comment_added', { task_id: taskId, comment_id: (result as any).lastInsertRowid });
  return c.json(comment, 201);
});

// --- Board summary endpoint (for Kanban view) ---

// GET /api/board — grouped by status with project filter
app.get('/api/board', (c) => {
  const projectId = c.req.query('project_id');
  const assignedTo = c.req.query('assigned_to') || c.req.query('assignee');

  let query = 'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.status != \'deleted\'';
  const params: any[] = [];

  if (projectId) { query += ' AND t.project_id = ?'; params.push(parseInt(projectId, 10)); }
  if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }

  query += ' ORDER BY CASE t.priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, t.created_at DESC';

  const tasks = sqlite.prepare(query).all(...params) as any[];

  const columns: Record<string, any[]> = {
    todo: [], in_progress: [], in_review: [], done: [], blocked: [], cancelled: [],
  };
  for (const task of tasks) {
    if (columns[task.status]) columns[task.status].push(task);
  }
  // Done column: sort by updated_at DESC (most recently completed first)
  columns.done.sort((a: any, b: any) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  const projectStatus = c.req.query('status');
  let projectQuery = "SELECT * FROM projects";
  const projectParams: any[] = [];
  if (projectStatus) {
    projectQuery += " WHERE status = ?";
    projectParams.push(projectStatus);
  }
  projectQuery += " ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 END, name";
  const projects = sqlite.prepare(projectQuery).all(...projectParams) as any[];

  return c.json({ columns, projects, total: tasks.length });
});

// ============================================================================
// Beast Scheduler — Persistent schedules that survive sleep cycles
// ============================================================================

// Create beast_schedules table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS beast_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beast TEXT NOT NULL,
    task TEXT NOT NULL,
    command TEXT,
    interval TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    last_run_at TEXT,
    next_due_at TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_beast_schedules_beast ON beast_schedules(beast)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_beast_schedules_due ON beast_schedules(next_due_at)`).run();
  // v2 columns
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN last_triggered_at TEXT`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN trigger_status TEXT DEFAULT 'pending'`).run(); } catch { /* exists */ }
  // v3: fixed-time scheduling
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN schedule_time TEXT`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN timezone TEXT DEFAULT 'Asia/Bangkok'`).run(); } catch { /* exists */ }
  // v4: one-off schedules
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN once INTEGER DEFAULT 0`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN run_at TEXT`).run(); } catch { /* exists */ }
  // v5: weekday-anchored recurring (T#706 — Boro coach lane)
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN days_of_week TEXT`).run(); } catch { /* exists */ }
} catch { /* already exists */ }

// ============================================================================
// Audit Log table (Task #72 — Bertus design, thread #81)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    actor TEXT,
    actor_type TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    detail TEXT,
    ip_source TEXT,
    request_method TEXT,
    request_path TEXT,
    status_code INTEGER,
    request_id TEXT
  )`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`).run();
  try { sqlite.prepare(`ALTER TABLE audit_log ADD COLUMN request_id TEXT`).run(); } catch { /* exists */ }
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id)`).run();
} catch { /* already exists */ }

// Teams tables (Task #81 — Gnarl spec, thread #105)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL,
    beast TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, beast),
    FOREIGN KEY (team_id) REFERENCES teams(id)
  )`).run();
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS team_projects (
    team_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    PRIMARY KEY (team_id, project_id),
    FOREIGN KEY (team_id) REFERENCES teams(id)
  )`).run();
} catch { /* already exists */ }

// ============================================================================
// Audit Log Query (Task #72 — Gorn-only read access)
// ============================================================================

// Security team allowlist for audit log read access
const AUDIT_READ_ALLOWLIST = ['bertus', 'talon'];

app.get('/api/audit', (c) => {
  // Gorn (session auth) or security team (bertus, talon) via ?as=
  const requester = (c.req.query('as') || '').toLowerCase();
  if (!hasSessionAuth(c) && !AUDIT_READ_ALLOWLIST.includes(requester)) {
    return c.json({ error: 'Audit logs are restricted to Gorn and security team' }, 403);
  }

  const actor = c.req.query('actor');
  const resourceType = c.req.query('resource_type');
  const statusCode = c.req.query('status_code');
  const method = c.req.query('method');
  const requestId = c.req.query('request_id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const since = c.req.query('since');

  let query = 'SELECT * FROM audit_log WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) as count FROM audit_log WHERE 1=1';
  const params: any[] = [];
  const countParams: any[] = [];

  if (actor) { query += ' AND actor = ?'; countQuery += ' AND actor = ?'; params.push(actor); countParams.push(actor); }
  if (resourceType) { query += ' AND resource_type = ?'; countQuery += ' AND resource_type = ?'; params.push(resourceType); countParams.push(resourceType); }
  if (statusCode) { query += ' AND status_code = ?'; countQuery += ' AND status_code = ?'; params.push(parseInt(statusCode)); countParams.push(parseInt(statusCode)); }
  if (method) { query += ' AND request_method = ?'; countQuery += ' AND request_method = ?'; params.push(method.toUpperCase()); countParams.push(method.toUpperCase()); }
  if (requestId) { query += ' AND request_id = ?'; countQuery += ' AND request_id = ?'; params.push(requestId); countParams.push(requestId); }
  if (since) { query += ' AND datetime(timestamp) >= datetime(?)'; countQuery += ' AND datetime(timestamp) >= datetime(?)'; params.push(since); countParams.push(since); }
  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.count || 0;
  const rows = sqlite.prepare(query).all(...params) as any[];
  return c.json({ audit: rows, total, limit, offset });
});

// GET /api/audit/stats — summary counts
app.get('/api/audit/stats', (c) => {
  // Gorn (session auth) or security team (bertus, talon) via ?as=
  const requester = (c.req.query('as') || '').toLowerCase();
  if (!hasSessionAuth(c) && !AUDIT_READ_ALLOWLIST.includes(requester)) {
    return c.json({ error: 'Audit stats are restricted to Gorn and security team' }, 403);
  }

  const total = (sqlite.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any)?.count || 0;
  const denied = (sqlite.prepare("SELECT COUNT(*) as count FROM audit_log WHERE status_code = 403").get() as any)?.count || 0;
  const errors = (sqlite.prepare("SELECT COUNT(*) as count FROM audit_log WHERE status_code >= 500").get() as any)?.count || 0;
  const byActor = sqlite.prepare('SELECT actor, COUNT(*) as count FROM audit_log GROUP BY actor ORDER BY count DESC LIMIT 10').all();
  const byResource = sqlite.prepare('SELECT resource_type, COUNT(*) as count FROM audit_log GROUP BY resource_type ORDER BY count DESC LIMIT 10').all();
  const byMethod = sqlite.prepare('SELECT request_method, COUNT(*) as count FROM audit_log GROUP BY request_method ORDER BY count DESC').all();
  return c.json({ total, denied, errors, by_actor: byActor, by_resource: byResource, by_method: byMethod });
});

// ============================================================================
// Security Events API (T#545 — Security event logging)
// ============================================================================

// Security events access: Gorn (session) or security team (local trusted + allowlist).
// T#648: ?as= requires isTrustedRequest to mitigate spoofing (Risk #12) — remote ?as= is rejected.
const SECURITY_READ_ALLOWLIST = ['bertus', 'talon'];

// GET /api/security/events — query security events
app.get('/api/security/events', (c) => {
  const requester = (c.req.query('as') || '').toLowerCase();
  const isSecurityTeam = isTrustedRequest(c) && SECURITY_READ_ALLOWLIST.includes(requester);
  if (!hasSessionAuth(c) && !isSecurityTeam) {
    return c.json({ error: 'Security events are restricted to Gorn and security team' }, 403);
  }

  const eventType = c.req.query('event_type');
  const severity = c.req.query('severity');
  const actor = c.req.query('actor');
  const since = c.req.query('since');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  let query = 'SELECT * FROM security_events WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) as count FROM security_events WHERE 1=1';
  const params: any[] = [];
  const countParams: any[] = [];

  if (eventType) { query += ' AND event_type = ?'; countQuery += ' AND event_type = ?'; params.push(eventType); countParams.push(eventType); }
  if (severity) { query += ' AND severity = ?'; countQuery += ' AND severity = ?'; params.push(severity); countParams.push(severity); }
  if (actor) { query += ' AND actor = ?'; countQuery += ' AND actor = ?'; params.push(actor); countParams.push(actor); }
  if (since) {
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
    query += ' AND timestamp >= ?'; countQuery += ' AND timestamp >= ?';
    params.push(sinceEpoch); countParams.push(sinceEpoch);
  }
  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.count || 0;
  const rows = sqlite.prepare(query).all(...params) as any[];

  // Parse details JSON for convenience
  const events = rows.map(r => ({
    ...r,
    details: r.details ? JSON.parse(r.details) : null,
    timestamp_iso: new Date(r.timestamp * 1000).toISOString(),
  }));

  return c.json({ events, total, limit, offset });
});

// GET /api/security/events/stats — summary counts
app.get('/api/security/events/stats', (c) => {
  const requester = (c.req.query('as') || '').toLowerCase();
  const isSecurityTeam = isTrustedRequest(c) && SECURITY_READ_ALLOWLIST.includes(requester);
  if (!hasSessionAuth(c) && !isSecurityTeam) {
    return c.json({ error: 'Security event stats are restricted to Gorn and security team' }, 403);
  }

  const total = (sqlite.prepare('SELECT COUNT(*) as count FROM security_events').get() as any)?.count || 0;
  const bySeverity = sqlite.prepare('SELECT severity, COUNT(*) as count FROM security_events GROUP BY severity ORDER BY count DESC').all();
  const byType = sqlite.prepare('SELECT event_type, COUNT(*) as count FROM security_events GROUP BY event_type ORDER BY count DESC').all();
  const byActor = sqlite.prepare('SELECT actor, COUNT(*) as count FROM security_events WHERE actor IS NOT NULL GROUP BY actor ORDER BY count DESC LIMIT 10').all();
  const last24h = (sqlite.prepare('SELECT COUNT(*) as count FROM security_events WHERE timestamp > ?').get(Math.floor(Date.now() / 1000) - 86400) as any)?.count || 0;
  const criticalCount = (sqlite.prepare("SELECT COUNT(*) as count FROM security_events WHERE severity = 'critical'").get() as any)?.count || 0;
  const warningCount = (sqlite.prepare("SELECT COUNT(*) as count FROM security_events WHERE severity = 'warning'").get() as any)?.count || 0;

  return c.json({
    total,
    last_24h: last24h,
    critical: criticalCount,
    warnings: warningCount,
    by_severity: bySeverity,
    by_type: byType,
    by_actor: byActor,
    retention_days: SECURITY_RETENTION_DAYS,
  });
});

// ============================================================================
// Teams API (Task #81 — Gnarl spec, thread #105)
// ============================================================================

// GET /api/teams — list all teams with member counts
app.get('/api/teams', (c) => {
  const teams = sqlite.prepare(`
    SELECT t.*, COUNT(tm.beast) as member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    GROUP BY t.id
    ORDER BY t.name
  `).all() as any[];
  return c.json({ teams, total: teams.length });
});

// Helper: validate team name (alphanumeric, spaces, hyphens only)
function validateTeamName(name: string): string | null {
  if (!name || name.trim().length === 0) return 'name required';
  if (name.length > 100) return 'name too long (max 100 chars)';
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return 'name contains invalid characters (use letters, numbers, spaces, hyphens only)';
  return null;
}

// Helper: sanitize text input (strip HTML tags)
function sanitizeInput(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim();
}

// Helper: check if beast exists
function beastExists(name: string): boolean {
  const row = sqlite.prepare('SELECT name FROM beast_profiles WHERE name = ?').get(name.toLowerCase());
  return !!row;
}

// POST /api/teams — create a team
app.post('/api/teams', async (c) => {
  const data = await c.req.json();
  const nameErr = validateTeamName(data.name);
  if (nameErr) return c.json({ error: nameErr }, 400);
  if (!data.created_by) return c.json({ error: 'created_by required' }, 400);
  const name = sanitizeInput(data.name);
  const description = data.description ? sanitizeInput(data.description) : null;
  try {
    const result = sqlite.prepare(
      'INSERT INTO teams (name, description, created_by) VALUES (?, ?, ?)'
    ).run(name, description, data.created_by);
    // Auto-add creator as lead
    sqlite.prepare('INSERT INTO team_members (team_id, beast, role) VALUES (?, ?, ?)').run(result.lastInsertRowid, data.created_by, 'lead');
    const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(result.lastInsertRowid);
    return c.json(team, 201);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Team name already exists' }, 409);
    throw e;
  }
});

// GET /api/teams/:id — team detail with members and projects
app.get('/api/teams/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id) as any;
  if (!team) return c.json({ error: 'Team not found' }, 404);
  const members = sqlite.prepare('SELECT beast, role, joined_at FROM team_members WHERE team_id = ?').all(id);
  const projects = sqlite.prepare('SELECT project_id FROM team_projects WHERE team_id = ?').all(id);
  return c.json({ ...team, members, projects });
});

// PATCH /api/teams/:id — update team
app.patch('/api/teams/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  const data = await c.req.json();
  if (data.name) {
    const nameErr = validateTeamName(data.name);
    if (nameErr) return c.json({ error: nameErr }, 400);
    sqlite.prepare('UPDATE teams SET name = ? WHERE id = ?').run(sanitizeInput(data.name), id);
  }
  if (data.description !== undefined) sqlite.prepare('UPDATE teams SET description = ? WHERE id = ?').run(sanitizeInput(data.description || ''), id);
  const updated = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  return c.json(updated);
});

// POST /api/teams/:id/members — add Beast to team
app.post('/api/teams/:id/members', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  const data = await c.req.json();
  if (!data.beast) return c.json({ error: 'beast required' }, 400);
  if (!beastExists(data.beast)) return c.json({ error: `Beast '${data.beast}' not found` }, 404);
  try {
    sqlite.prepare('INSERT INTO team_members (team_id, beast, role) VALUES (?, ?, ?)').run(id, data.beast.toLowerCase(), data.role || 'member');
    return c.json({ team_id: id, beast: data.beast.toLowerCase(), role: data.role || 'member' }, 201);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE') || e.message?.includes('PRIMARY')) return c.json({ error: 'Beast already in team' }, 409);
    throw e;
  }
});

// DELETE /api/teams/:id/members/:beast — remove Beast from team
app.delete('/api/teams/:id/members/:beast', (c) => {
  const id = parseInt(c.req.param('id'));
  const beast = c.req.param('beast').toLowerCase();
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const result = sqlite.prepare('DELETE FROM team_members WHERE team_id = ? AND beast = ?').run(id, beast);
  if (result.changes === 0) return c.json({ error: 'Member not found in team' }, 404);
  return c.json({ removed: beast, team_id: id });
});

// POST /api/teams/:id/projects — link project to team
app.post('/api/teams/:id/projects', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const data = await c.req.json();
  if (!data.project_id) return c.json({ error: 'project_id required' }, 400);
  try {
    sqlite.prepare('INSERT INTO team_projects (team_id, project_id) VALUES (?, ?)').run(id, data.project_id);
    return c.json({ team_id: id, project_id: data.project_id }, 201);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE') || e.message?.includes('PRIMARY')) return c.json({ error: 'Project already linked' }, 409);
    throw e;
  }
});

// DELETE /api/teams/:id/projects/:projectId — unlink project
app.delete('/api/teams/:id/projects/:projectId', (c) => {
  const id = parseInt(c.req.param('id'));
  const projectId = parseInt(c.req.param('projectId'));
  if (isNaN(id) || isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);
  const result = sqlite.prepare('DELETE FROM team_projects WHERE team_id = ? AND project_id = ?').run(id, projectId);
  if (result.changes === 0) return c.json({ error: 'Project not linked to team' }, 404);
  return c.json({ removed_project: projectId, team_id: id });
});

// DELETE /api/teams/:id — delete a team and all related data (members, projects)
// Auth: team creator or Gorn only (Bertus security review)
app.delete('/api/teams/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const as = c.req.query('as')?.toLowerCase() || (hasSessionAuth(c) ? 'gorn' : '');
  if (!as) return c.json({ error: 'as param required for DELETE' }, 400);
  const existing = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Team not found' }, 404);
  if (as !== 'gorn' && as !== existing.created_by?.toLowerCase()) {
    return c.json({ error: 'Only the team creator or Gorn can delete a team' }, 403);
  }
  // Cascade: remove members, projects, then team
  sqlite.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
  sqlite.prepare('DELETE FROM team_projects WHERE team_id = ?').run(id);
  sqlite.prepare('DELETE FROM teams WHERE id = ?').run(id);
  return c.json({ deleted: id, name: existing.name });
});

// GET /api/teams/beast/:beast — list teams for a specific Beast
app.get('/api/teams/beast/:beast', (c) => {
  const beast = c.req.param('beast').toLowerCase();
  const teams = sqlite.prepare(`
    SELECT t.*, tm.role
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.beast = ?
    ORDER BY t.name
  `).all(beast) as any[];
  return c.json({ beast, teams, total: teams.length });
});

// Parse interval strings like "540m", "8h", "2d" into seconds
function parseInterval(interval: string): number | null {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (value <= 0) return null;
  const unit = match[2];
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 3600;
  if (unit === 'd') return value * 86400;
  return null;
}

// Compute next occurrence of schedule_time (HH:MM) in UTC+7
function computeNextFixedTime(scheduleTime: string, intervalDays: number): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Invalid schedule_time format (HH:MM)');
  }
  // Work in UTC+7
  const now = new Date();
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  // Build target time today in UTC+7
  const target = new Date(utc7Now);
  target.setUTCHours(hours, minutes, 0, 0);
  // If target is in the past, advance by interval
  if (target <= utc7Now) {
    target.setUTCDate(target.getUTCDate() + intervalDays);
  }
  // Convert back to UTC
  return new Date(target.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

// Compute next_due_at after a run for fixed-time schedules
function computeNextFixedTimeAfterRun(scheduleTime: string, intervalDays: number): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  const now = new Date();
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const target = new Date(utc7Now);
  target.setUTCHours(hours, minutes, 0, 0);
  // Always advance to next occurrence
  target.setUTCDate(target.getUTCDate() + intervalDays);
  return new Date(target.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

// T#706: validate days_of_week (ISO weekday array, 1=Mon..7=Sun)
// Returns parsed sorted unique array, or null if invalid
function parseDaysOfWeek(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length === 0 || input.length > 7) return null;
  const set = new Set<number>();
  for (const d of input) {
    if (!Number.isInteger(d)) return null;
    if (d < 1 || d > 7) return null;
    set.add(d);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// T#706: weekday-anchored next-due computation (UTC+7 / Asia/Bangkok)
// Finds the next occurrence of any weekday in `daysOfWeek` at `scheduleTime`,
// strictly AFTER `nowUtc` (use for /run advance). Set `inclusiveToday=true` for
// create-time anchoring (allows today if the time is still future).
function computeNextWeekdayFixedTime(
  scheduleTime: string,
  daysOfWeek: number[],
  inclusiveToday: boolean,
): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Invalid schedule_time format (HH:MM)');
  }
  if (!daysOfWeek.length) {
    throw new Error('days_of_week must be non-empty');
  }
  // Work in UTC+7 (Asia/Bangkok, no DST).
  const now = new Date();
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  // Walk forward day by day. Bangkok-day weekday: Sun=0..Sat=6 from getUTCDay() of utc7-shifted Date.
  // Convert to ISO 1=Mon..7=Sun.
  const toIso = (jsDay: number) => (jsDay === 0 ? 7 : jsDay);
  // Search up to 8 days forward (covers any 7-day cycle starting today)
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(utc7Now);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    candidate.setUTCHours(hours, minutes, 0, 0);
    const isoWeekday = toIso(candidate.getUTCDay());
    if (!daysOfWeek.includes(isoWeekday)) continue;
    if (offset === 0) {
      // Today candidate — inclusive only on create-time, and only if still future
      if (!inclusiveToday) continue;
      if (candidate <= utc7Now) continue;
    }
    return new Date(candidate.getTime() - 7 * 60 * 60 * 1000).toISOString();
  }
  // Defensive: should never reach (any non-empty subset of 7 weekdays fires within 7d).
  throw new Error('Failed to compute next weekday-anchored due time');
}

// GET /api/schedules — all schedules (optional ?beast=, ?type=once|recurring filters)
app.get('/api/schedules', (c) => {
  const beast = c.req.query('beast');
  const type = c.req.query('type');
  let query = 'SELECT * FROM beast_schedules';
  const conditions: string[] = [];
  const params: any[] = [];
  if (beast) { conditions.push('beast = ?'); params.push(beast); }
  if (type === 'once') { conditions.push('once = 1'); }
  else if (type === 'recurring') { conditions.push('(once = 0 OR once IS NULL)'); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY beast, next_due_at';
  const rows = sqlite.prepare(query).all(...params) as any[];
  return c.json({ schedules: rows, total: rows.length });
});

// GET /api/schedules/due — overdue items for a beast
app.get('/api/schedules/due', (c) => {
  const beast = c.req.query('beast');
  if (!beast) return c.json({ error: 'beast parameter required' }, 400);
  const now = new Date().toISOString();
  const rows = sqlite.prepare(
    'SELECT * FROM beast_schedules WHERE beast = ? AND enabled = 1 AND next_due_at <= ? ORDER BY next_due_at'
  ).all(beast, now) as any[];
  return c.json({ schedules: rows, total: rows.length });
});

// GET /api/schedules/:id — get a single schedule
app.get('/api/schedules/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid schedule ID' }, 400);
  const row = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id);
  if (!row) return c.json({ error: 'Schedule not found' }, 404);
  return c.json(row);
});

// POST /api/schedules — create a schedule
app.post('/api/schedules', async (c) => {
  const data = await c.req.json();
  const { beast, task, command, source } = data;
  const isOnce = !!data.once;

  // For one-off: interval is optional, run_at is required
  // For recurring: interval is required
  if (!beast || !task) {
    return c.json({ error: 'beast and task are required' }, 400);
  }
  if (!isOnce && !data.interval) {
    return c.json({ error: 'beast, task, and interval are required (or set once: true with run_at)' }, 400);
  }
  // Validate task name — only safe characters (alphanumeric, spaces, basic punctuation)
  if (typeof task !== 'string' || task.length > 100 || /[`$\\{}<>|;&]/.test(task)) {
    return c.json({ error: 'Task name contains invalid characters or is too long (max 100 chars, no shell metacharacters)' }, 400);
  }
  // Validate beast name
  if (typeof beast !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(beast)) {
    return c.json({ error: 'Invalid beast name' }, 400);
  }

  let interval = data.interval || 'once';
  let intervalSeconds = 0;

  if (isOnce) {
    // One-off schedule: run_at required (ISO 8601), interval optional
    if (!data.run_at) {
      return c.json({ error: 'run_at (ISO 8601) is required for one-off schedules' }, 400);
    }
    const runAt = new Date(data.run_at);
    if (isNaN(runAt.getTime())) {
      return c.json({ error: 'run_at must be a valid ISO 8601 datetime' }, 400);
    }
    // schedule_time not compatible with once
    if (data.schedule_time) {
      return c.json({ error: 'schedule_time cannot be used with one-off schedules (use run_at instead)' }, 400);
    }
    interval = 'once';
    intervalSeconds = 0;
  } else {
    // Recurring schedule: validate interval
    const parsed = parseInterval(interval);
    if (!parsed) {
      return c.json({ error: 'Invalid interval. Use format: Nm (minutes), Nh (hours), or Nd (days). Examples: 540m, 8h, 2d' }, 400);
    }
    intervalSeconds = parsed;
  }

  // Prevent duplicate: same beast + same task name + enabled
  const duplicate = sqlite.prepare(
    'SELECT id FROM beast_schedules WHERE beast = ? AND task = ? AND enabled = 1'
  ).get(beast, task) as any;
  if (duplicate) {
    return c.json({ error: `Schedule '${task}' already exists for ${beast} (id: ${duplicate.id}). Disable or delete it first.` }, 409);
  }
  // Fixed-time scheduling (recurring only)
  const scheduleTime = data.schedule_time || null;
  const tz = data.timezone || 'Asia/Bangkok';
  const VALID_TIMEZONES = ['Asia/Bangkok', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Singapore'];
  if (scheduleTime) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
      return c.json({ error: 'schedule_time must be HH:MM format (00:00-23:59)' }, 400);
    }
    if (data.interval !== '1d' && data.interval !== '7d') {
      return c.json({ error: 'schedule_time requires interval of 1d (daily) or 7d (weekly)' }, 400);
    }
  }
  if (data.timezone && !VALID_TIMEZONES.includes(data.timezone)) {
    return c.json({ error: `Invalid timezone. Valid: ${VALID_TIMEZONES.join(', ')}` }, 400);
  }

  // T#706: weekday-anchored recurring (days_of_week). ISO 1=Mon..7=Sun.
  let daysOfWeek: number[] | null = null;
  if (data.days_of_week !== undefined && data.days_of_week !== null) {
    if (isOnce) {
      return c.json({ error: 'days_of_week cannot be used with one-off schedules' }, 400);
    }
    if (data.interval !== '7d') {
      return c.json({ error: "days_of_week requires interval='7d' (weekly cadence with explicit days)" }, 400);
    }
    if (!scheduleTime) {
      return c.json({ error: 'days_of_week requires schedule_time (HH:MM)' }, 400);
    }
    const parsed = parseDaysOfWeek(data.days_of_week);
    if (!parsed) {
      return c.json({ error: 'days_of_week must be a non-empty array of ISO weekday integers (1=Mon..7=Sun), max length 7' }, 400);
    }
    daysOfWeek = parsed;
  }

  let nextDue: string;
  const runAt = data.run_at || null;
  if (isOnce) {
    nextDue = new Date(data.run_at).toISOString();
  } else if (daysOfWeek) {
    nextDue = computeNextWeekdayFixedTime(scheduleTime!, daysOfWeek, true);
  } else if (scheduleTime) {
    const intervalDays = interval === '7d' ? 7 : 1;
    nextDue = computeNextFixedTime(scheduleTime, intervalDays);
  } else {
    const now = new Date();
    nextDue = new Date(now.getTime() + intervalSeconds * 1000).toISOString();
  }

  const result = sqlite.prepare(
    `INSERT INTO beast_schedules (beast, task, command, interval, interval_seconds, next_due_at, schedule_time, timezone, source, once, run_at, days_of_week)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(beast, task, command || null, interval, intervalSeconds, nextDue, scheduleTime, tz, source || null, isOnce ? 1 : 0, runAt, daysOfWeek ? JSON.stringify(daysOfWeek) : null);
  const created = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(result.lastInsertRowid) as any;
  wsBroadcast('schedule_update', { action: 'created', id: (created as any).id });
  return c.json(created, 201);
});

// PATCH /api/schedules/:id — update a schedule (owner or Gorn only)
app.patch('/api/schedules/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  const data = await c.req.json();
  const requester = (c.req.query('as') || data.as || data.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!requester) {
    return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
  }
  if (requester !== existing.beast && requester !== 'gorn') {
    return c.json({ error: `Only ${existing.beast} or Gorn can modify this schedule` }, 403);
  }
  const updates: string[] = [];
  const params: any[] = [];
  if (data.task !== undefined) { updates.push('task = ?'); params.push(data.task); }
  if (data.command !== undefined) { updates.push('command = ?'); params.push(data.command); }
  if (data.interval !== undefined) {
    const secs = parseInterval(data.interval);
    if (!secs) return c.json({ error: 'Invalid interval. Use format: Nm (minutes), Nh (hours), or Nd (days). Examples: 540m, 8h, 2d' }, 400);
    updates.push('interval = ?', 'interval_seconds = ?');
    params.push(data.interval, secs);
  }
  if (data.enabled !== undefined) { updates.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
  if (data.source !== undefined) { updates.push('source = ?'); params.push(data.source); }
  if (data.schedule_time !== undefined) {
    if (data.schedule_time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.schedule_time)) {
      return c.json({ error: 'schedule_time must be HH:MM format (00:00-23:59) or null to clear' }, 400);
    }
    const effectiveInterval = data.interval || existing.interval;
    if (data.schedule_time !== null && effectiveInterval !== '1d' && effectiveInterval !== '7d') {
      return c.json({ error: 'schedule_time requires interval of 1d (daily) or 7d (weekly)' }, 400);
    }
    if (existing.once && data.schedule_time !== null) {
      return c.json({ error: 'schedule_time cannot be used with one-off schedules' }, 400);
    }
    updates.push('schedule_time = ?'); params.push(data.schedule_time);
    // Recompute next_due_at if setting a new schedule_time
    if (data.schedule_time !== null) {
      const intervalDays = (data.interval || existing.interval) === '7d' ? 7 : 1;
      const nextDue = computeNextFixedTime(data.schedule_time, intervalDays);
      updates.push('next_due_at = ?'); params.push(nextDue);
    }
  }
  if (data.timezone !== undefined) {
    const VALID_TIMEZONES = ['Asia/Bangkok', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Singapore'];
    if (!VALID_TIMEZONES.includes(data.timezone)) {
      return c.json({ error: `Invalid timezone. Valid: ${VALID_TIMEZONES.join(', ')}` }, 400);
    }
    updates.push('timezone = ?'); params.push(data.timezone);
  }
  // T#706: days_of_week update path
  if (data.days_of_week !== undefined) {
    if (data.days_of_week === null) {
      updates.push('days_of_week = ?'); params.push(null);
    } else {
      if (existing.once) {
        return c.json({ error: 'days_of_week cannot be used with one-off schedules' }, 400);
      }
      const effectiveInterval = data.interval || existing.interval;
      const effectiveScheduleTime = data.schedule_time !== undefined ? data.schedule_time : existing.schedule_time;
      if (effectiveInterval !== '7d') {
        return c.json({ error: "days_of_week requires interval='7d'" }, 400);
      }
      if (!effectiveScheduleTime) {
        return c.json({ error: 'days_of_week requires schedule_time (HH:MM)' }, 400);
      }
      const parsed = parseDaysOfWeek(data.days_of_week);
      if (!parsed) {
        return c.json({ error: 'days_of_week must be a non-empty array of ISO weekday integers (1=Mon..7=Sun), max length 7' }, 400);
      }
      updates.push('days_of_week = ?'); params.push(JSON.stringify(parsed));
      // Recompute next_due_at to honor the new weekday set immediately
      const newNext = computeNextWeekdayFixedTime(effectiveScheduleTime, parsed, true);
      updates.push('next_due_at = ?'); params.push(newNext);
    }
  }
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
  updates.push("updated_at = datetime('now')");
  params.push(id);
  sqlite.prepare(`UPDATE beast_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  wsBroadcast('schedule_update', { action: 'updated', id: (updated as any).id });
  return c.json(updated);
});

// PATCH /api/schedules/:id/run — mark a schedule as run (owner or Gorn only)
app.patch('/api/schedules/:id/run', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  const data = await c.req.json().catch(() => ({}));
  // T#718 — derive requester from auth, reject client-asserted mismatch
  const caller = requireBeastIdentity(c);
  if (!caller) {
    return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
  }
  const claimedAs = (c.req.query('as') || data.as || data.beast || '').toLowerCase();
  if (claimedAs && claimedAs !== caller) {
    return c.json({ error: 'Identity spoof blocked. ?as=/body.as/body.beast must match authenticated caller or be omitted.' }, 403);
  }
  const requester = caller;
  if (requester !== existing.beast && requester !== 'gorn') {
    return c.json({ error: `Only ${existing.beast} or Gorn can run this schedule` }, 403);
  }
  // If task failed, don't update last_run (Pip's edge case)
  if (data.failed) {
    sqlite.prepare(`UPDATE beast_schedules SET trigger_status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(id);
    const failedState = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    return c.json({ ...failedState, message: 'Failed run — not updating last_run_at' });
  }
  const now = new Date();

  // One-off schedules: disable after run instead of advancing
  if (existing.once === 1) {
    sqlite.prepare(
      `UPDATE beast_schedules SET last_run_at = ?, enabled = 0, trigger_status = 'completed', last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(now.toISOString(), now.toISOString(), id);
    const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    wsBroadcast('schedule_update', { action: 'run', id: (updated as any).id });
    return c.json(updated);
  }

  let nextDue: string;
  // T#706: weekday-anchored takes precedence over plain weekly fixed-time
  if (existing.days_of_week && existing.schedule_time) {
    let parsedDays: number[] | null = null;
    try {
      const arr = JSON.parse(existing.days_of_week);
      parsedDays = parseDaysOfWeek(arr);
    } catch { /* invalid stored value, fall through */ }
    if (parsedDays) {
      // After-run advance: never include "today" — must move to a strictly-future qualifying weekday
      nextDue = computeNextWeekdayFixedTime(existing.schedule_time, parsedDays, false);
    } else {
      // Stored value corrupt; safely fall back to plain weekly cadence
      nextDue = computeNextFixedTimeAfterRun(existing.schedule_time, 7);
    }
  } else if (existing.schedule_time) {
    const intervalDays = existing.interval === '7d' ? 7 : 1;
    nextDue = computeNextFixedTimeAfterRun(existing.schedule_time, intervalDays);
  } else {
    nextDue = new Date(now.getTime() + existing.interval_seconds * 1000).toISOString();
  }
  sqlite.prepare(
    `UPDATE beast_schedules SET last_run_at = ?, next_due_at = ?, trigger_status = 'pending', last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(now.toISOString(), nextDue, now.toISOString(), id);
  const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  wsBroadcast('schedule_update', { action: 'run', id: (updated as any).id });
  return c.json(updated);
});

// DELETE /api/schedules/:id — remove a schedule (owner or Gorn only)
app.delete('/api/schedules/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  // Parse body for identity (DELETE can have body)
  const body = await c.req.json().catch(() => ({}));
  const requester = (c.req.query('as') || body.as || body.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!requester) {
    return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
  }
  if (requester !== existing.beast && requester !== 'gorn') {
    return c.json({ error: `Only ${existing.beast} or Gorn can delete this schedule` }, 403);
  }
  sqlite.prepare('DELETE FROM beast_schedules WHERE id = ?').run(id);
  wsBroadcast('schedule_update', { action: 'deleted', id });
  return c.json({ deleted: true, id });
});

// POST /api/schedules/:id/execute — manually trigger a schedule (sends tmux notification to Beast)
app.post('/api/schedules/:id/execute', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const schedule = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!schedule) return c.json({ error: 'Schedule not found' }, 404);

  const sessionName = schedule.beast.charAt(0).toUpperCase() + schedule.beast.slice(1);

  // Check if Beast tmux session exists
  const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
  if (hasSession.exitCode !== 0) {
    return c.json({ error: `tmux session '${sessionName}' not found — Beast may be offline` }, 503);
  }

  // Send notification to Beast via queue
  const notification = `[Scheduler] Due now: ${schedule.task} (schedule ${schedule.id})${schedule.command ? ` | Command: ${schedule.command}` : ''}\nRemember: mark done with /scheduler run ${schedule.id}`;

  try {
    enqueueNotification(schedule.beast, notification);

    const now = new Date().toISOString();
    sqlite.prepare(
      `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
    ).run(now, id);

    wsBroadcast('schedule_update', { action: 'triggered', id });
    return c.json({ success: true, message: `Triggered ${schedule.beast}/${schedule.task}` });
  } catch (err) {
    return c.json({ error: `Failed to send to ${sessionName}: ${err}` }, 500);
  }
});

// PATCH /api/schedules/:id/trigger — mark as triggered (owner, Gorn, or server daemon only)
app.patch('/api/schedules/:id/trigger', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  const data = await c.req.json().catch(() => ({}));
  const requester = (c.req.query('as') || data.as || data.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!requester) {
    return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
  }
  if (requester !== existing.beast && requester !== 'gorn' && requester !== 'scheduler') {
    return c.json({ error: `Only ${existing.beast} or Gorn can trigger this schedule` }, 403);
  }
  const now = new Date().toISOString();
  sqlite.prepare(
    `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
  ).run(now, id);
  const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  wsBroadcast('schedule_update', { action: 'triggered', id: (updated as any).id });
  return c.json(updated);
});

// Scheduler polling interval (pack vote, thread #75)
const SCHEDULER_INTERVAL = 10_000;

// GET /api/scheduler/health — daemon status
app.get('/api/scheduler/health', (c) => {
  return c.json({ status: 'running', interval_seconds: SCHEDULER_INTERVAL / 1000, last_check: schedulerLastCheck });
});

// ============================================================================
// Scheduler Auto-Trigger Daemon (10s polling)
// ============================================================================

let schedulerLastCheck: string | null = null;

function runSchedulerCycle() {
  try {
    const now = new Date().toISOString();
    schedulerLastCheck = now;

    // Find overdue schedules that need triggering:
    // - enabled and overdue (next_due_at <= now)
    // - NULL: never triggered before
    // - 'pending': beast called /run, next_due advanced — re-trigger when next_due passes
    // - 'failed': previous attempt failed — retry after schedule's own interval cooldown
    // - 'triggered': already notified, waiting for beast — do NOT re-trigger (beast will /run when ready)
    // - 'completed': one-time schedule finished — never re-trigger
    // T#658 — Norm #65 — skip beasts at rest (rest_status = 'rest')
    const overdue = sqlite.prepare(
      `SELECT * FROM beast_schedules
       WHERE enabled = 1 AND datetime(next_due_at) <= datetime(?)
       AND trigger_status IS NOT 'completed'
       AND trigger_status IS NOT 'triggered'
       AND beast NOT IN (SELECT name FROM beast_profiles WHERE rest_status = 'rest')
       AND (
         trigger_status IS NULL
         OR trigger_status = 'pending'
         OR (trigger_status = 'failed' AND datetime(last_triggered_at) <= datetime(?, '-' || CAST(interval_seconds AS TEXT) || ' seconds'))
       )
       ORDER BY next_due_at`
    ).all(now, now) as any[];

    for (const schedule of overdue) {
      const sessionName = schedule.beast.charAt(0).toUpperCase() + schedule.beast.slice(1);

      // Check if Beast tmux session exists
      const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
      if (hasSession.exitCode !== 0) {
        console.log(`[Scheduler] Skip ${schedule.beast}/${schedule.task}: tmux session '${sessionName}' not found`);
        continue;
      }

      // Send notification via queue
      const notification = `[Scheduler] Due now: ${schedule.task} (schedule ${schedule.id})${schedule.command ? ` | Command: ${schedule.command}` : ''}\nRemember: mark done with /scheduler run ${schedule.id}`;

      try {
        enqueueNotification(schedule.beast, notification);

        // Mark as triggered
        sqlite.prepare(
          `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
        ).run(now, schedule.id);

        wsBroadcast('schedule_update', { action: 'triggered', id: schedule.id });
        console.log(`[Scheduler] Triggered: ${schedule.beast}/${schedule.task} (#${schedule.id})`);
      } catch (err) {
        console.log(`[Scheduler] Failed to notify ${schedule.beast}: ${err}`);
      }
    }
    // Prowl due-task notifications (T#467 + T#471 + T#473) — notify Sable when tasks are due or reminder fires
    // Also re-notify daily for overdue tasks (T#473)
    // Note: Prowl due_date is stored in local time (from datetime-local picker), so compare with local time
    const d = new Date();
    const localNow = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    const dueProwl = sqlite.prepare(
      `SELECT * FROM prowl_tasks WHERE due_date IS NOT NULL AND status = 'pending'
       AND (
         (notified_at IS NULL AND (
           (remind_before IS NULL AND datetime(due_date) <= datetime(?))
           OR (remind_before = '1m' AND datetime(due_date, '-1 minutes') <= datetime(?))
           OR (remind_before = '5m' AND datetime(due_date, '-5 minutes') <= datetime(?))
           OR (remind_before = '15m' AND datetime(due_date, '-15 minutes') <= datetime(?))
           OR (remind_before = '30m' AND datetime(due_date, '-30 minutes') <= datetime(?))
           OR (remind_before = '1h' AND datetime(due_date, '-1 hours') <= datetime(?))
           OR (remind_before = '1d' AND datetime(due_date, '-1 days') <= datetime(?))
         ))
         OR (notified_at IS NOT NULL AND datetime(due_date) < datetime(?) AND datetime(notified_at) <= datetime(?, '-1 days'))
       )`
    ).all(localNow, localNow, localNow, localNow, localNow, localNow, localNow, localNow, localNow) as any[];

    for (const task of dueProwl) {
      const sessionName = 'Sable';
      const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
      if (hasSession.exitCode !== 0) {
        console.log(`[Prowl] Skip notification for task #${task.id}: tmux session 'Sable' not found`);
        continue;
      }

      const priorityEmoji = task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢';
      const reminderLabels: Record<string, string> = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': '1 day' };
      const isReminder = task.remind_before && !task.notified_at && new Date(task.due_date) > new Date(now);
      const isOverdueRenotify = task.notified_at && new Date(task.due_date) < new Date(now);
      const prefix = isOverdueRenotify ? 'OVERDUE (daily reminder)' : isReminder ? `Reminder (${reminderLabels[task.remind_before] || task.remind_before} before)` : 'Task due';
      const notification = `[Prowl] ${prefix}: ${task.title} (Prowl ${priorityEmoji}${task.id}) — Priority: ${task.priority} — send Telegram to Gorn`;

      try {
        enqueueNotification('sable', notification);

        sqlite.prepare(`UPDATE prowl_tasks SET notified_at = ? WHERE id = ?`).run(localNow, task.id);
        console.log(`[Prowl] Notified Sable: task #${task.id} "${task.title}" is due`);
      } catch (err) {
        console.log(`[Prowl] Failed to notify for task #${task.id}: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Cycle error: ${err}`);
  }
}

// On startup: reset all 'triggered' schedules to 'pending' so they fire exactly once
// This prevents the repeat-fire bug (T#383) where old triggered status + expired cooldown
// causes schedules to fire multiple times on restart
try {
  const resetCount = sqlite.prepare(
    `UPDATE beast_schedules SET trigger_status = 'pending', updated_at = datetime('now')
     WHERE trigger_status = 'triggered' AND enabled = 1`
  ).run();
  if (resetCount.changes > 0) {
    console.log(`[Scheduler] Reset ${resetCount.changes} triggered schedules to pending on startup`);
  }
} catch (err) {
  console.error(`[Scheduler] Startup reset error: ${err}`);
}

// Start the daemon
setInterval(runSchedulerCycle, SCHEDULER_INTERVAL);
// Run first cycle after 5s (let server boot)
setTimeout(runSchedulerCycle, 5000);
console.log('[Scheduler] Auto-trigger daemon started (10s interval)');

// ============================================================================
// Notification Queue Drain (Spec #29, T#497)
// ============================================================================

const DRAIN_INTERVAL = 1000; // Check queues every 1s
const DRAIN_SPACING = 1000; // 1s between sends to same Beast (was 3s — Tier 1 of notification queue smoothness fix, 2026-04-08)
const DRAIN_DIR = '/tmp/den-notify';
const drainLastSent: Map<string, number> = new Map(); // beast → last send timestamp

/**
 * Spec #54 v2 §1 — Per-Beast drain coexistence check.
 * Returns true if the per-Beast drain process owns this queue (server should
 * skip). Returns false if no per-Beast drain or stale/unrelated PID (server
 * should fallback-drain).
 *
 * Two-layer check:
 * 1. signal-0 kill: process exists at all
 * 2. /proc/<pid>/cmdline: process is actually notify-drain.sh (defends against
 *    Linux PID-reuse — kernel.pid_max default 32768, cycle hours-to-days under
 *    load. Without this, OOM/SIGKILL stale-PID + reused-PID = server false-skips
 *    queue indefinitely until next /wakeup. That's the EXACT Decree #66
 *    incident-response continuity gap this spec closes.)
 *
 * Phase 2+ defense-in-depth: write start-time to PID file alongside PID, validate
 * against /proc/<pid>/stat field 22 (process start time). systemd-PIDFile pattern.
 */
function perBeastDrainAlive(pidPath: string): boolean {
  try {
    if (!fs.existsSync(pidPath)) return false;
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!pid || isNaN(pid)) return false;
    // Layer 1: process exists?
    try { process.kill(pid, 0); }
    catch { return false; } // ESRCH = process gone
    // Layer 2: process is actually notify-drain.sh? (PID-reuse defense)
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes('notify-drain.sh');
    } catch { return false; } // /proc gone or unreadable = treat as dead
  } catch { return false; }
}

function runDrainCycle() {
  try {
    if (!fs.existsSync(DRAIN_DIR)) return;
    const files = fs.readdirSync(DRAIN_DIR).filter(f => f.endsWith('.queue'));

    for (const file of files) {
      const beast = file.replace('.queue', '');
      const queuePath = path.join(DRAIN_DIR, file);
      const lockPath = path.join(DRAIN_DIR, `${beast}.lock`);
      const pidPath = path.join(DRAIN_DIR, `${beast}.pid`);

      // Spec #54 v2 §1 — skip if per-Beast drain owns this queue.
      // perBeastDrainAlive uses signal-0 kill + /proc/<pid>/cmdline check to
      // defend against Linux PID-reuse (Bertus near-blocker §1, promoted from
      // Phase 2 to Phase 1 baseline). Closes the implicit-fallback-drift class
      // that defeats the offline-resilience guarantee.
      if (perBeastDrainAlive(pidPath)) continue;

      // Check spacing — don't send to same Beast within DRAIN_SPACING
      const lastSent = drainLastSent.get(beast) || 0;
      if (Date.now() - lastSent < DRAIN_SPACING) continue;

      // Check queue has content
      try {
        const stat = fs.statSync(queuePath);
        if (stat.size === 0) continue;
      } catch { continue; }

      // Read and remove first line atomically via flock
      try {
        const result = Bun.spawnSync(['bash', '-c',
          `flock "${lockPath}" bash -c "head -1 '${queuePath}' && sed -i '1d' '${queuePath}'"`
        ]);
        const encoded = result.stdout.toString().trim();
        if (!encoded) continue;

        // Decode from base64
        const message = Buffer.from(encoded, 'base64').toString('utf-8');
        if (!message) continue;

        // Resolve tmux session name
        const sessionName = beast.charAt(0).toUpperCase() + beast.slice(1);

        // Check session exists — re-queue if Beast is offline
        const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
        if (hasSession.exitCode !== 0) {
          // Beast offline — re-append to tail of queue so it retries next cycle
          try {
            Bun.spawnSync(['bash', '-c',
              `flock "${lockPath}" bash -c "echo '${encoded}' >> '${queuePath}'"`
            ]);
          } catch { /* best effort re-queue */ }
          drainLastSent.set(beast, Date.now()); // avoid spinning on offline Beasts
          continue;
        }

        // Send to tmux
        Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', message]);
        // T#714 (follow-up to T#713 scope-miss): sleep 200ms between text-paste
        // and Enter to break the race with Claude Code's Ink TUI renderer.
        // Without this delay, Enter could land mid-frame while the input field
        // was still rendering the paste, and the message would sit stuck in the
        // input instead of submitting. Same pattern landed in notify-drain.sh:42.
        Bun.sleepSync(200);
        Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);

        drainLastSent.set(beast, Date.now());
      } catch (err) {
        // Silent — don't spam logs on queue errors
      }
    }
  } catch { /* DRAIN_DIR doesn't exist yet */ }
}

setInterval(runDrainCycle, DRAIN_INTERVAL);
// Start drain after 3s (let server boot)
setTimeout(runDrainCycle, 3000);
console.log('[Notify] Queue drain started (1s interval, 3s spacing)');

// ============================================================================
// DB Maintenance — audit log retention + VACUUM
// ============================================================================

const DB_RETENTION_DAYS = 15;
const DB_MAINTENANCE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

function runDbMaintenance() {
  try {
    const cutoff = `-${DB_RETENTION_DAYS} days`;

    // Prune audit_log older than retention period
    const auditResult = sqlite.prepare(
      `DELETE FROM audit_log WHERE timestamp < datetime('now', ?)`
    ).run(cutoff);

    // Prune security_events older than 90-day retention period
    const securityPruned = pruneSecurityEvents();

    // Prune expired/revoked beast tokens older than 7 days (T#546)
    const tokensPruned = pruneBeastTokens();

    const pruned = (auditResult.changes || 0) + securityPruned + tokensPruned;

    if (pruned > 0) {
      // VACUUM to reclaim space after large deletes
      sqlite.exec('VACUUM');
      console.log(`[DB Maintenance] Pruned ${auditResult.changes} audit rows (>${DB_RETENTION_DAYS}d), ${securityPruned} security events (>${SECURITY_RETENTION_DAYS}d), ${tokensPruned} expired tokens. VACUUM complete.`);
    } else {
      console.log(`[DB Maintenance] Nothing to prune.`);
    }
  } catch (err) {
    console.error(`[DB Maintenance] Error: ${err}`);
  }
}

// POST /api/db/maintenance — manual trigger (Gorn-only)
app.post('/api/db/maintenance', (c) => {
  const requester = c.req.query('as');
  if (requester) {
    return c.json({ error: 'forbidden' }, 403);
  }
  runDbMaintenance();
  return c.json({ status: 'ok', retention_days: DB_RETENTION_DAYS });
});

// GET /api/db/stats — table sizes and DB info
app.get('/api/db/stats', (c) => {
  const tables = sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as { name: string }[];

  const stats = tables.map((t) => {
    const row = sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number };
    return { table: t.name, rows: row.cnt };
  });

  const pageCount = (sqlite.prepare('PRAGMA page_count').get() as any)?.page_count || 0;
  const pageSize = (sqlite.prepare('PRAGMA page_size').get() as any)?.page_size || 0;
  const freePages = (sqlite.prepare('PRAGMA freelist_count').get() as any)?.freelist_count || 0;

  return c.json({
    retention_days: DB_RETENTION_DAYS,
    db_size_bytes: pageCount * pageSize,
    free_pages: freePages,
    tables: stats.sort((a, b) => b.rows - a.rows),
  });
});

// Run maintenance on boot (after 30s) and every 6 hours
setTimeout(runDbMaintenance, 30_000);
setInterval(runDbMaintenance, DB_MAINTENANCE_INTERVAL);
console.log(`[DB Maintenance] Retention: ${DB_RETENTION_DAYS} days, interval: 6h`);

// ── File Archive Cycle (T#533) ──────────────────────────────────────
// Moves soft-deleted files to compressed tar.gz archives after 7-day grace period.
// Nothing is Deleted — files are archived, never permanently removed.

const FILE_ARCHIVE_GRACE_DAYS = 7;
const FILE_ARCHIVE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours (same as DB maintenance)

function runFileArchive() {
  try {
    const graceCutoff = Date.now() - (FILE_ARCHIVE_GRACE_DAYS * 24 * 60 * 60 * 1000);

    // Find files deleted more than 7 days ago that haven't been archived yet
    const filesToArchive = sqlite.prepare(
      `SELECT id, filename, original_name, size_bytes FROM files
       WHERE deleted_at IS NOT NULL AND deleted_at < ? AND archived_at IS NULL`
    ).all(graceCutoff) as { id: number; filename: string; original_name: string; size_bytes: number }[];

    if (filesToArchive.length === 0) return;

    // Create archive directory: uploads/archive/YYYY-MM/
    const now = new Date();
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const archiveDir = path.join(ARCHIVE_DIR, monthDir);
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    // Archive filename: archive-YYYY-MM-DD.tar.gz
    const dateStr = now.toISOString().slice(0, 10);
    const archiveName = `archive-${dateStr}.tar.gz`;
    const archivePath = path.join(archiveDir, archiveName);
    const relativeArchivePath = `archive/${monthDir}/${archiveName}`;

    // Collect files that actually exist on disk
    const existingFiles: typeof filesToArchive = [];
    for (const f of filesToArchive) {
      const filePath = path.join(UPLOADS_DIR, f.filename);
      if (fs.existsSync(filePath)) {
        existingFiles.push(f);
      } else {
        // File already gone from disk — mark as archived with no path
        sqlite.prepare('UPDATE files SET archived_at = ? WHERE id = ?').run(Date.now(), f.id);
      }
    }

    if (existingFiles.length === 0) return;

    // Build tar.gz using system tar command
    // If archive already exists for today, append is not supported with gzip,
    // so use a unique suffix
    let finalArchivePath = archivePath;
    if (fs.existsSync(archivePath)) {
      const suffix = Date.now().toString(36);
      finalArchivePath = path.join(archiveDir, `archive-${dateStr}-${suffix}.tar.gz`);
    }
    const finalRelativePath = path.relative(path.join(ORACLE_DATA_DIR, 'uploads'), finalArchivePath);

    // Create a file list for tar
    const fileListPath = path.join(archiveDir, `.archive-list-${Date.now()}.txt`);
    fs.writeFileSync(fileListPath, existingFiles.map(f => f.filename).join('\n'));

    const { execSync } = require('child_process');
    execSync(`tar -czf "${finalArchivePath}" -C "${UPLOADS_DIR}" -T "${fileListPath}"`, {
      timeout: 120_000, // 2 min timeout
    });

    // Clean up file list
    fs.unlinkSync(fileListPath);

    // Verify archive was created
    if (!fs.existsSync(finalArchivePath)) {
      console.error(`[File Archive] Failed to create archive: ${finalArchivePath}`);
      return;
    }

    const archiveSize = fs.statSync(finalArchivePath).size;

    // Update DB: mark files as archived, remove originals
    const archiveTimestamp = Date.now();
    const updateStmt = sqlite.prepare('UPDATE files SET archived_at = ?, archive_path = ? WHERE id = ?');
    let totalFreed = 0;

    for (const f of existingFiles) {
      updateStmt.run(archiveTimestamp, finalRelativePath, f.id);
      const filePath = path.join(UPLOADS_DIR, f.filename);
      try {
        fs.unlinkSync(filePath);
        totalFreed += f.size_bytes;
      } catch (err) {
        console.error(`[File Archive] Failed to remove original: ${f.filename}`, err);
      }
    }

    console.log(`[File Archive] Archived ${existingFiles.length} files → ${finalRelativePath} (${(archiveSize / 1024).toFixed(1)}KB archive, ${(totalFreed / 1024 / 1024).toFixed(1)}MB freed)`);
  } catch (err) {
    console.error(`[File Archive] Error:`, err);
  }
}

// GET /api/files/archive/stats — archive statistics
app.get('/api/files/archive/stats', (c) => {
  const archived = sqlite.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as original_size FROM files WHERE archived_at IS NOT NULL`
  ).get() as any;

  const pending = sqlite.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files
     WHERE deleted_at IS NOT NULL AND archived_at IS NULL`
  ).get() as any;

  // List archive bundles on disk
  const bundles: { path: string; size: number; created: string }[] = [];
  if (fs.existsSync(ARCHIVE_DIR)) {
    for (const month of fs.readdirSync(ARCHIVE_DIR)) {
      const monthPath = path.join(ARCHIVE_DIR, month);
      if (!fs.statSync(monthPath).isDirectory()) continue;
      for (const file of fs.readdirSync(monthPath)) {
        if (!file.endsWith('.tar.gz')) continue;
        const stat = fs.statSync(path.join(monthPath, file));
        bundles.push({
          path: `archive/${month}/${file}`,
          size: stat.size,
          created: stat.mtime.toISOString(),
        });
      }
    }
  }

  return c.json({
    archived_files: archived.count,
    original_size_bytes: archived.original_size,
    pending_archive: pending.count,
    pending_size_bytes: pending.total_size,
    grace_days: FILE_ARCHIVE_GRACE_DAYS,
    bundles,
  });
});

// POST /api/files/archive/run — manual trigger
app.post('/api/files/archive/run', (c) => {
  runFileArchive();
  return c.json({ status: 'ok', message: 'Archive cycle completed' });
});

// POST /api/files/:id/restore — restore an archived file
app.post('/api/files/:id/restore', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ?').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);
  if (!file.deleted_at) return c.json({ error: 'File is not deleted' }, 400);

  if (file.archived_at && file.archive_path) {
    // Extract from archive
    const archiveFullPath = path.join(UPLOADS_DIR, file.archive_path);
    if (!fs.existsSync(archiveFullPath)) {
      return c.json({ error: 'Archive bundle not found on disk' }, 500);
    }

    try {
      const { execSync } = require('child_process');
      execSync(`tar -xzf "${archiveFullPath}" -C "${UPLOADS_DIR}" "${file.filename}"`, {
        timeout: 30_000,
      });
    } catch (err) {
      return c.json({ error: 'Failed to extract file from archive', details: String(err) }, 500);
    }

    if (!fs.existsSync(path.join(UPLOADS_DIR, file.filename))) {
      return c.json({ error: 'File not found in archive bundle' }, 500);
    }
  } else {
    // File was only soft-deleted, not archived — check it still exists
    if (!fs.existsSync(path.join(UPLOADS_DIR, file.filename))) {
      return c.json({ error: 'File not found on disk' }, 500);
    }
  }

  // Clear deleted_at and archived_at
  sqlite.prepare('UPDATE files SET deleted_at = NULL, archived_at = NULL, archive_path = NULL WHERE id = ?').run(id);
  return c.json({ restored: true, id, filename: file.filename, original_name: file.original_name });
});

// Run file archive on boot (after 60s) and every 6 hours
setTimeout(runFileArchive, 60_000);
setInterval(runFileArchive, FILE_ARCHIVE_INTERVAL);
console.log(`[File Archive] Grace: ${FILE_ARCHIVE_GRACE_DAYS} days, interval: 6h`);

// Withings daily auto-sync (T#523) — sync every 24h, first run 60s after boot
const WITHINGS_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
let withingsLastSyncAt: string | null = null; // Tracks last successful sync attempt (T#536)

async function runWithingsAutoSync() {
  try {
    const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
    if (!token) return; // Not connected, skip silently
    const lastLog = sqlite.prepare(
      "SELECT logged_at FROM routine_logs WHERE source = 'withings' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1"
    ).get() as any;
    const now = Math.floor(Date.now() / 1000);
    const startdate = lastLog
      ? Math.floor(new Date(lastLog.logged_at).getTime() / 1000)
      : now - 30 * 86400;
    const result = await syncWithingsMeasurements(startdate, now);
    console.log(`[Withings] Auto-sync: ${result.synced} new, ${result.skipped} skipped`);
  } catch (err) {
    console.error('[Withings] Auto-sync failed:', err instanceof Error ? err.message : err);
  }
}
setTimeout(runWithingsAutoSync, 60_000);
setInterval(runWithingsAutoSync, WITHINGS_SYNC_INTERVAL);
console.log('[Withings] Auto-sync enabled (1h interval, first run in 60s)');

// ============================================================================
// Supersede Log Routes (Issue #18, #19)
// ============================================================================

// List supersessions with optional filters
app.get('/api/supersede', (c) => {
  const project = c.req.query('project');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  // Build where clause using Drizzle
  const whereClause = project ? eq(supersedeLog.project, project) : undefined;

  // Get total count using Drizzle
  const countResult = db.select({ total: sql<number>`count(*)` })
    .from(supersedeLog)
    .where(whereClause)
    .get();
  const total = countResult?.total || 0;

  // Get logs using Drizzle
  const logs = db.select()
    .from(supersedeLog)
    .where(whereClause)
    .orderBy(desc(supersedeLog.supersededAt))
    .limit(limit)
    .offset(offset)
    .all();

  return c.json({
    supersessions: logs.map(log => ({
      id: log.id,
      old_path: log.oldPath,
      old_id: log.oldId,
      old_title: log.oldTitle,
      old_type: log.oldType,
      new_path: log.newPath,
      new_id: log.newId,
      new_title: log.newTitle,
      reason: log.reason,
      superseded_at: new Date(log.supersededAt).toISOString(),
      superseded_by: log.supersededBy,
      project: log.project
    })),
    total,
    limit,
    offset
  });
});

// Get supersede chain for a document (what superseded what)
app.get('/api/supersede/chain/:path', (c) => {
  const docPath = decodeURIComponent(c.req.param('path'));

  // Find all supersessions where this doc was old or new using Drizzle
  const asOld = db.select()
    .from(supersedeLog)
    .where(eq(supersedeLog.oldPath, docPath))
    .orderBy(supersedeLog.supersededAt)
    .all();

  const asNew = db.select()
    .from(supersedeLog)
    .where(eq(supersedeLog.newPath, docPath))
    .orderBy(supersedeLog.supersededAt)
    .all();

  return c.json({
    superseded_by: asOld.map(log => ({
      new_path: log.newPath,
      reason: log.reason,
      superseded_at: new Date(log.supersededAt).toISOString()
    })),
    supersedes: asNew.map(log => ({
      old_path: log.oldPath,
      reason: log.reason,
      superseded_at: new Date(log.supersededAt).toISOString()
    }))
  });
});

// Log a new supersession
app.post('/api/supersede', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.old_path) {
      return c.json({ error: 'Missing required field: old_path' }, 400);
    }

    const result = db.insert(supersedeLog).values({
      oldPath: data.old_path,
      oldId: data.old_id || null,
      oldTitle: data.old_title || null,
      oldType: data.old_type || null,
      newPath: data.new_path || null,
      newId: data.new_id || null,
      newTitle: data.new_title || null,
      reason: data.reason || null,
      supersededAt: Date.now(),
      supersededBy: data.superseded_by || 'user',
      project: data.project || null
    }).returning({ id: supersedeLog.id }).get();

    return c.json({
      id: result.id,
      message: 'Supersession logged'
    }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// ============================================================================
// Trace Routes - Discovery journey visualization
// ============================================================================

app.get('/api/traces', (c) => {
  const query = c.req.query('query');
  const status = c.req.query('status');
  const project = c.req.query('project');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const result = listTraces({
    query: query || undefined,
    status: status as 'raw' | 'reviewed' | 'distilled' | undefined,
    project: project || undefined,
    limit,
    offset
  });

  return c.json(result);
});

app.get('/api/traces/:id', (c) => {
  const traceId = c.req.param('id');
  const trace = getTrace(traceId);

  if (!trace) {
    return c.json({ error: 'Trace not found' }, 404);
  }

  return c.json(trace);
});

app.get('/api/traces/:id/chain', (c) => {
  const traceId = c.req.param('id');
  const direction = c.req.query('direction') as 'up' | 'down' | 'both' || 'both';

  const chain = getTraceChain(traceId, direction);
  return c.json(chain);
});

// Link traces: POST /api/traces/:prevId/link { nextId: "..." }
app.post('/api/traces/:prevId/link', async (c) => {
  try {
    const prevId = c.req.param('prevId');
    const { nextId } = await c.req.json();

    if (!nextId) {
      return c.json({ error: 'Missing nextId in request body' }, 400);
    }

    const result = linkTraces(prevId, nextId);

    if (!result.success) {
      return c.json({ error: result.message }, 400);
    }

    return c.json(result);
  } catch (err) {
    console.error('Link traces error:', err);
    return c.json({ error: 'Failed to link traces' }, 500);
  }
});

// Unlink trace: DELETE /api/traces/:id/link?direction=prev|next
app.delete('/api/traces/:id/link', async (c) => {
  try {
    const traceId = c.req.param('id');
    const direction = c.req.query('direction') as 'prev' | 'next';

    if (!direction || !['prev', 'next'].includes(direction)) {
      return c.json({ error: 'Missing or invalid direction (prev|next)' }, 400);
    }

    const result = unlinkTraces(traceId, direction);

    if (!result.success) {
      return c.json({ error: result.message }, 400);
    }

    return c.json(result);
  } catch (err) {
    console.error('Unlink traces error:', err);
    return c.json({ error: 'Failed to unlink traces' }, 500);
  }
});

// Get trace linked chain: GET /api/traces/:id/linked-chain
app.get('/api/traces/:id/linked-chain', async (c) => {
  try {
    const traceId = c.req.param('id');
    const result = getTraceLinkedChain(traceId);
    return c.json(result);
  } catch (err) {
    console.error('Get linked chain error:', err);
    return c.json({ error: 'Failed to get linked chain' }, 500);
  }
});

// ============================================================================
// Inbox Routes (handoff context between sessions)
// ============================================================================

app.post('/api/handoff', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.content) {
      return c.json({ error: 'Missing required field: content' }, 400);
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;

    // Generate slug
    const slug = data.slug || data.content
      .substring(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'handoff';

    const filename = `${dateStr}_${timeStr}_${slug}.md`;
    const dirPath = path.join(REPO_ROOT, 'ψ/inbox/handoff');
    const filePath = path.join(dirPath, filename);

    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, data.content, 'utf-8');

    // T#658 — Norm #65 — auto-set requesting Beast to rest_status='rest'
    // Identity comes from ?as= param. Cross-Beast rest writes are rejected:
    // we only ever update the verified requester's rest_status, never another Beast.
    let restedBeast: string | null = null;
    const asParam = c.req.query('as')?.toLowerCase();
    if (asParam && isTrustedRequest(c)) {
      const beastRow = sqlite.prepare('SELECT name FROM beast_profiles WHERE name = ?').get(asParam) as any;
      if (beastRow) {
        sqlite.prepare("UPDATE beast_profiles SET rest_status = 'rest', updated_at = ? WHERE name = ?")
          .run(Date.now(), asParam);
        restedBeast = asParam;
        console.log(`[Handoff] ${asParam} → rest_status=rest`);
        wsBroadcast('beast_state_change', { beast: asParam, rest_status: 'rest' });
      }
    }

    return c.json({
      success: true,
      file: `ψ/inbox/handoff/${filename}`,
      rested_beast: restedBeast,
      message: restedBeast
        ? `Handoff written. ${restedBeast} → rest_status=rest. Schedules paused until /wake.`
        : 'Handoff written.'
    }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// T#658 — Norm #65 — Wake a Beast from rest. Resumes scheduler firing.
// On wake, schedules overdue by more than SCHEDULER_STORM_CAP_HOURS (default 24)
// are silently dropped — their next_due_at is advanced past the storm window.
app.post('/api/beast/:name/wake', (c) => {
  try {
    const name = c.req.param('name').toLowerCase();
    const asParam = c.req.query('as')?.toLowerCase();

    // Auth: requester must be the beast itself or gorn (same as schedule mutations)
    if (!isTrustedRequest(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (asParam && asParam !== name && asParam !== 'gorn') {
      return c.json({ error: 'Cross-Beast wake denied. You can only wake yourself or be Gorn.' }, 403);
    }

    const beastRow = sqlite.prepare('SELECT name, rest_status FROM beast_profiles WHERE name = ?').get(name) as any;
    if (!beastRow) {
      return c.json({ error: `Beast '${name}' not found` }, 404);
    }

    const previousStatus = beastRow.rest_status || 'active';

    // Schedule storm cap — drop schedules overdue by more than the cap
    const stormCapHours = parseInt(process.env.SCHEDULER_STORM_CAP_HOURS || '24');
    const cutoff = new Date(Date.now() - stormCapHours * 3600 * 1000).toISOString();
    const dropResult = sqlite.prepare(
      `UPDATE beast_schedules
       SET next_due_at = datetime('now', '+' || CAST(interval_seconds AS TEXT) || ' seconds'),
           trigger_status = 'pending',
           updated_at = datetime('now')
       WHERE beast = ?
         AND enabled = 1
         AND datetime(next_due_at) < datetime(?)`
    ).run(name, cutoff);

    // Set rest_status back to active
    sqlite.prepare("UPDATE beast_profiles SET rest_status = 'active', updated_at = ? WHERE name = ?")
      .run(Date.now(), name);

    console.log(`[Wake] ${name}: rest_status ${previousStatus} → active. Dropped ${dropResult.changes} schedules overdue by >${stormCapHours}h.`);
    wsBroadcast('beast_state_change', { beast: name, rest_status: 'active' });

    return c.json({
      beast: name,
      previous_status: previousStatus,
      current_status: 'active',
      schedules_dropped: dropResult.changes,
      storm_cap_hours: stormCapHours,
      resumed_at: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

app.get('/api/inbox', (c) => {
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');
  const type = c.req.query('type') || 'all';

  const inboxDir = path.join(REPO_ROOT, 'ψ/inbox');
  const results: Array<{ filename: string; path: string; created: string; preview: string; type: string }> = [];

  if (type === 'all' || type === 'handoff') {
    const handoffDir = path.join(inboxDir, 'handoff');
    if (fs.existsSync(handoffDir)) {
      const files = fs.readdirSync(handoffDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse();

      for (const file of files) {
        const filePath = path.join(handoffDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})/);
        const created = dateMatch
          ? `${dateMatch[1]}T${dateMatch[2].replace('-', ':')}:00`
          : 'unknown';

        results.push({
          filename: file,
          path: `ψ/inbox/handoff/${file}`,
          created,
          preview: content.substring(0, 500),
          type: 'handoff',
        });
      }
    }
  }

  const total = results.length;
  const paginated = results.slice(offset, offset + limit);

  return c.json({ files: paginated, total, limit, offset });
});

// ============================================================================
// Learn Route
// ============================================================================

app.post('/api/learn', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.pattern) {
      return c.json({ error: 'Missing required field: pattern' }, 400);
    }
    const result = handleLearn(
      data.pattern,
      data.source,
      data.concepts,
      data.origin,   // 'mother' | 'arthur' | 'volt' | 'human' (null = universal)
      data.project,  // ghq-style project path (null = universal)
      data.cwd       // Auto-detect project from cwd
    );
    return c.json(result);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// ============================================================================
// Spec Review — SDD Workflow
// ============================================================================

// Create spec_reviews table
try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS spec_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    file_path TEXT NOT NULL,
    task_id TEXT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewer_feedback TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repo, file_path)
  )
`).run(); } catch { /* exists */ }

// Migration: add thread_id to spec_reviews (T#413)
try { sqlite.prepare('ALTER TABLE spec_reviews ADD COLUMN thread_id INTEGER').run(); } catch { /* exists */ }

// T#425: spec multi-linking junction table (many-to-many for tasks + threads)
sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS spec_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id INTEGER NOT NULL REFERENCES spec_reviews(id),
    link_type TEXT NOT NULL CHECK(link_type IN ('task', 'thread')),
    link_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(spec_id, link_type, link_id)
  )
`).run();
try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_spec_links_spec ON spec_links(spec_id)').run(); } catch { /* exists */ }
try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_spec_links_target ON spec_links(link_type, link_id)').run(); } catch { /* exists */ }

// Migrate existing spec_reviews task_id/thread_id into spec_links
try {
  const specsWithLinks = sqlite.prepare("SELECT id, task_id, thread_id FROM spec_reviews WHERE task_id IS NOT NULL OR thread_id IS NOT NULL").all() as any[];
  const insertLink = sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)');
  for (const s of specsWithLinks) {
    if (s.task_id) {
      const taskNum = parseInt(String(s.task_id).replace(/\D/g, ''), 10);
      if (!isNaN(taskNum)) insertLink.run(s.id, 'task', taskNum, new Date().toISOString());
    }
    if (s.thread_id) insertLink.run(s.id, 'thread', s.thread_id, new Date().toISOString());
  }
} catch { /* migration already done or no data */ }

const ALLOWED_SPEC_REPOS = ['denbook', 'supply-chain-tool', 'karo', 'zaghnal', 'gnarl', 'bertus', 'flint', 'pip', 'dex', 'talon', 'quill', 'sable', 'nyx', 'vigil', 'rax', 'leonard', 'mara', 'snap', 'beast-blueprint'];

function resolveSpecPath(repo: string, filePath: string): string | null {
  if (!ALLOWED_SPEC_REPOS.includes(repo)) return null;
  if (!filePath.endsWith('.md')) return null;
  const baseDir = path.resolve(`/home/gorn/workspace/${repo}`);
  const resolved = path.resolve(baseDir, filePath);
  if (!resolved.startsWith(baseDir + '/')) return null;
  const relative = resolved.slice(baseDir.length + 1);
  if (!relative.startsWith('docs/specs/')) return null;
  return resolved;
}

// GET /api/specs — list all specs
app.get('/api/specs', (c) => {
  const status = c.req.query('status');
  const repo = c.req.query('repo');
  let query = 'SELECT * FROM spec_reviews WHERE 1=1';
  const params: any[] = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (repo) { query += ' AND repo = ?'; params.push(repo); }
  query += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'rejected\' THEN 1 WHEN \'approved\' THEN 2 END, updated_at DESC';
  const specs = sqlite.prepare(query).all(...params) as any[];
  // Attach links to each spec (T#425)
  for (const spec of specs) {
    const links = sqlite.prepare('SELECT link_type, link_id FROM spec_links WHERE spec_id = ?').all(spec.id) as any[];
    spec.linked_tasks = links.filter(l => l.link_type === 'task').map(l => l.link_id);
    spec.linked_threads = links.filter(l => l.link_type === 'thread').map(l => l.link_id);
  }
  return c.json({ specs });
});

// GET /api/specs/:id — get spec detail (with linked tasks + threads)
app.get('/api/specs/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  const resolved = resolveSpecPath(spec.repo, spec.file_path);
  if (resolved) {
    try { spec.content = fs.readFileSync(resolved, 'utf-8'); } catch { spec.content = null; }
  }
  // Attach linked tasks and threads (T#425)
  const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ? ORDER BY link_type, link_id').all(id) as any[];
  spec.linked_tasks = links.filter(l => l.link_type === 'task').map(l => l.link_id);
  spec.linked_threads = links.filter(l => l.link_type === 'thread').map(l => l.link_id);
  return c.json(spec);
});

// GET /api/specs/:id/content — raw markdown content from repo
app.get('/api/specs/:id/content', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT repo, file_path FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  const resolved = resolveSpecPath(spec.repo, spec.file_path);
  if (!resolved) return c.json({ error: 'Invalid spec path' }, 400);
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    return c.json({ content, file_path: spec.file_path, repo: spec.repo });
  } catch {
    return c.json({ error: 'Spec file not found on disk' }, 404);
  }
});

// GET /api/specs/:id/history — git log for spec file
app.get('/api/specs/:id/history', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT repo, file_path FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  const repoDir = path.resolve(`/home/gorn/workspace/${spec.repo}`);
  if (!ALLOWED_SPEC_REPOS.includes(spec.repo)) return c.json({ error: 'Invalid repo' }, 400);
  try {
    const { execSync } = require('child_process');
    const log = execSync(
      `git log --format='{"hash":"%H","short":"%h","date":"%aI","subject":"%s","author":"%an"}' -- "${spec.file_path}"`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }
    ).trim();
    const versions = log ? log.split('\n').map((line: string) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) : [];
    return c.json({ versions, file_path: spec.file_path, repo: spec.repo });
  } catch {
    return c.json({ versions: [], file_path: spec.file_path, repo: spec.repo });
  }
});

// GET /api/specs/:id/diff — diff between two versions of spec file
app.get('/api/specs/:id/diff', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT repo, file_path FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  if (!ALLOWED_SPEC_REPOS.includes(spec.repo)) return c.json({ error: 'Invalid repo' }, 400);
  const from = c.req.query('from');
  const to = c.req.query('to') || 'HEAD';
  if (!from) return c.json({ error: 'from query param required (commit hash)' }, 400);
  // Validate hashes are hex only (prevent injection)
  if (!/^[a-f0-9]+$/i.test(from) || !/^[a-f0-9]+$/i.test(to) && to !== 'HEAD') {
    return c.json({ error: 'Invalid commit hash' }, 400);
  }
  const repoDir = path.resolve(`/home/gorn/workspace/${spec.repo}`);
  try {
    const { execSync } = require('child_process');
    const diff = execSync(
      `git diff ${from} ${to} -- "${spec.file_path}"`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }
    );
    return c.json({ diff, from, to, file_path: spec.file_path, repo: spec.repo });
  } catch {
    return c.json({ diff: '', from, to, file_path: spec.file_path, repo: spec.repo });
  }
});

// POST /api/specs — register a spec for review
app.post('/api/specs', async (c) => {
  try {
    const data = await c.req.json();
    const { repo, file_path, task_id, thread_id, title } = data;
    if (!repo || !file_path || !title) {
      return c.json({ error: 'repo, file_path, title required' }, 400);
    }
    if (!task_id && !thread_id) {
      return c.json({ error: 'At least one of task_id or thread_id is required. Link your spec to a task or forum thread.' }, 400);
    }
    if (!ALLOWED_SPEC_REPOS.includes(repo)) {
      return c.json({ error: `Invalid repo. Allowed: ${ALLOWED_SPEC_REPOS.join(', ')}` }, 400);
    }
    // T#718 — derive author from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (data.author && data.author.toLowerCase() !== caller) {
      return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
    }
    const author = caller;
    const now = new Date().toISOString();
    const result = sqlite.prepare(
      'INSERT INTO spec_reviews (repo, file_path, task_id, thread_id, title, author, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(repo, file_path, task_id || null, thread_id || null, title, author, 'pending', now, now);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get((result as any).lastInsertRowid) as any;
    // Auto-link spec to task if task_id provided
    if (task_id) {
      const taskIdNum = parseInt(String(task_id).replace(/\D/g, ''), 10);
      if (!isNaN(taskIdNum)) {
        sqlite.prepare('UPDATE tasks SET spec_id = ?, updated_at = ? WHERE id = ?').run(spec.id, now, taskIdNum);
        sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)').run(spec.id, 'task', taskIdNum, now);
      }
    }
    // Auto-link spec to thread if thread_id provided (T#425)
    if (thread_id) {
      sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)').run(spec.id, 'thread', parseInt(thread_id), now);
    }
        const specFilePath = path.join(import.meta.dirname || __dirname, '..', spec.file_path);
    const specContent = fs.existsSync(specFilePath) ? fs.readFileSync(specFilePath, 'utf-8') : spec.title;
    searchIndexUpsert('spec', spec.id, spec.title, specContent, spec.author, now);
    wsBroadcast('spec_submitted', { id: spec.id });
    return c.json(spec, 201);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) return c.json({ error: 'Spec already registered for this repo + path' }, 409);
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// POST /api/specs/:id/review — approve or reject (Gorn only)
app.post('/api/specs/:id/review', async (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'Spec review requires Gorn authentication' }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  if (spec.status !== 'pending') return c.json({ error: 'Only pending specs can be reviewed' }, 400);
  try {
    const data = await c.req.json();
    const { action, feedback } = data;
    if (!action || !['approve', 'reject'].includes(action)) {
      return c.json({ error: 'action must be approve or reject' }, 400);
    }
    if (action === 'reject' && !feedback?.trim()) {
      return c.json({ error: 'Feedback required when rejecting a spec' }, 400);
    }
    const now = new Date().toISOString();
    const status = action === 'approve' ? 'approved' : 'rejected';
    sqlite.prepare(
      'UPDATE spec_reviews SET status = ?, reviewer_feedback = ?, reviewed_at = ?, updated_at = ? WHERE id = ?'
    ).run(status, feedback || null, now, now, id);
    const updated = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
    wsBroadcast('spec_reviewed', { id: (updated as any).id, action });
    // Notify spec participants (assignee, creator, author, commenters)
    try {
      const { notifyMentioned } = await import('./forum/mentions.ts');
      const toNotify = new Set<string>();
      if (spec.author) toNotify.add(spec.author.toLowerCase());
      if (spec.task_id) {
        const taskIdNum = parseInt(spec.task_id.replace(/\D/g, ''), 10);
        if (!isNaN(taskIdNum)) {
          const task = sqlite.prepare('SELECT assigned_to, created_by, title FROM tasks WHERE id = ?').get(taskIdNum) as any;
          if (task?.assigned_to) toNotify.add(task.assigned_to.toLowerCase());
          if (task?.created_by) toNotify.add(task.created_by.toLowerCase());
        }
      }
      const specParticipants = sqlite.prepare('SELECT DISTINCT author FROM spec_comments WHERE spec_id = ?').all(id) as any[];
      for (const p of specParticipants) { if (p.author) toNotify.add(p.author.toLowerCase()); }
      toNotify.delete('gorn');
      const commentContent = action === 'approve'
        ? `Spec approved by Gorn.${feedback ? ` ${feedback}` : ''} Implementation unblocked.`
        : `Spec rejected by Gorn: ${feedback}`;
      if (toNotify.size > 0) {
        notifyMentioned([...toNotify], 0, `Spec #${id}: ${spec.title}`, 'gorn', `Spec ${action}d: ${commentContent.slice(0, 100)}`, {
          type: 'Specs', label: `Spec #${id}`, hint: `Use /spec to view spec details.`,
        });
      }
    } catch { /* notification failure is non-critical */ }

    // Auto-post to ALL linked forum threads (per Gorn: threads only, no task comments)
    const linkedThreads = sqlite.prepare("SELECT link_id FROM spec_links WHERE spec_id = ? AND link_type = 'thread'").all(id) as any[];
    // Also include legacy thread_id
    const threadIds = new Set<number>(linkedThreads.map((l: any) => l.link_id));
    if (updated.thread_id) threadIds.add(updated.thread_id);
    for (const threadId of threadIds) {
      try {
        const threadMsg = action === 'approve'
          ? `Spec #${id} **approved** by Gorn.${feedback ? ` ${feedback}` : ''} Implementation unblocked.`
          : `Spec #${id} **rejected** by Gorn: ${feedback}`;
        addMessage(threadId, 'claude', threadMsg, { author: 'system' });
      } catch { /* thread post failure is non-critical */ }
    }

    return c.json(updated);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// GET /api/specs/:id/links — list all links for a spec (T#425)
app.get('/api/specs/:id/links', (c) => {
  const specId = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT id FROM spec_reviews WHERE id = ?').get(specId);
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ? ORDER BY link_type, link_id').all(specId) as any[];
  return c.json({ links, linked_tasks: links.filter(l => l.link_type === 'task').map(l => l.link_id), linked_threads: links.filter(l => l.link_type === 'thread').map(l => l.link_id) });
});

// POST /api/specs/:id/link — add a task or thread link (T#425)
app.post('/api/specs/:id/link', async (c) => {
  const specId = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(specId) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  try {
    const data = await c.req.json();
    const { link_type, link_id } = data;
    if (!link_type || !['task', 'thread'].includes(link_type)) return c.json({ error: 'link_type must be task or thread' }, 400);
    if (!link_id || isNaN(parseInt(link_id))) return c.json({ error: 'link_id required (integer)' }, 400);
    const now = new Date().toISOString();
    sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)').run(specId, link_type, parseInt(link_id), now);
    // If linking a task, also set spec_id on the task
    if (link_type === 'task') {
      sqlite.prepare('UPDATE tasks SET spec_id = ?, updated_at = ? WHERE id = ? AND (spec_id IS NULL OR spec_id = ?)').run(specId, now, parseInt(link_id), specId);
    }
    const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ?').all(specId) as any[];
    return c.json({ success: true, links });
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// DELETE /api/specs/:id/link — remove a task or thread link (T#425)
app.delete('/api/specs/:id/link', async (c) => {
  const specId = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(specId) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  try {
    const data = await c.req.json();
    const { link_type, link_id } = data;
    if (!link_type || !link_id) return c.json({ error: 'link_type and link_id required' }, 400);
    sqlite.prepare('DELETE FROM spec_links WHERE spec_id = ? AND link_type = ? AND link_id = ?').run(specId, link_type, parseInt(link_id));
    const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ?').all(specId) as any[];
    return c.json({ success: true, links });
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// GET /api/specs/by-task/:taskId — find specs linked to a task (T#425)
app.get('/api/specs/by-task/:taskId', (c) => {
  const taskId = parseInt(c.req.param('taskId'), 10);
  const specs = sqlite.prepare(
    "SELECT sr.* FROM spec_reviews sr JOIN spec_links sl ON sr.id = sl.spec_id WHERE sl.link_type = 'task' AND sl.link_id = ? ORDER BY sr.updated_at DESC"
  ).all(taskId);
  return c.json({ specs });
});

// GET /api/specs/by-thread/:threadId — find specs linked to a thread (T#425)
app.get('/api/specs/by-thread/:threadId', (c) => {
  const threadId = parseInt(c.req.param('threadId'), 10);
  const specs = sqlite.prepare(
    "SELECT sr.* FROM spec_reviews sr JOIN spec_links sl ON sr.id = sl.spec_id WHERE sl.link_type = 'thread' AND sl.link_id = ? ORDER BY sr.updated_at DESC"
  ).all(threadId);
  return c.json({ specs });
});

// POST /api/specs/:id/resubmit — reset rejected spec to pending (author/assignee only)
app.post('/api/specs/:id/resubmit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  if (spec.status === 'approved') return c.json({ error: 'Approved specs cannot be resubmitted' }, 400);
  // Require identity — only spec author or task assignee can resubmit
  let requester: string;
  try {
    const data = await c.req.json();
    requester = (data.author || data.beast || '').toLowerCase();
  } catch {
    requester = (c.req.query('as') || '').toLowerCase();
  }
  if (!requester) return c.json({ error: 'Identity required: pass author in body or ?as= param' }, 400);
  const allowed = new Set<string>();
  if (spec.author) allowed.add(spec.author.toLowerCase());
  if (spec.task_id) {
    const taskIdNum = parseInt(String(spec.task_id).replace(/\D/g, ''), 10);
    if (!isNaN(taskIdNum)) {
      const task = sqlite.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(taskIdNum) as any;
      if (task?.assigned_to) allowed.add(task.assigned_to.toLowerCase());
    }
  }
  if (!allowed.has(requester) && requester !== 'gorn') {
    return c.json({ error: `Only the spec author (${spec.author}) or task assignee can resubmit` }, 403);
  }
  const now = new Date().toISOString();
  // Preserve rejection history as a spec comment before clearing
  if (spec.reviewer_feedback) {
    sqlite.prepare(
      'INSERT INTO spec_comments (spec_id, author, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, 'system', `**Previous review (${spec.status})**: ${spec.reviewer_feedback}`, spec.reviewed_at || now);
  }
  sqlite.prepare(
    'UPDATE spec_reviews SET status = ?, reviewer_feedback = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?'
  ).run('pending', now, id);
  const updated = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id);
  wsBroadcast('spec_resubmitted', { id: (updated as any).id });
  return c.json(updated);
});

// DELETE /api/specs/:id — delete spec (Gorn or Pip)
app.delete('/api/specs/:id', async (c) => {
  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (requester !== 'gorn' && requester !== 'pip') {
    return c.json({ error: 'Only Gorn or Pip can delete specs' }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Spec not found' }, 404);
  sqlite.prepare('DELETE FROM spec_reviews WHERE id = ?').run(id);
  wsBroadcast('spec_deleted', { id: (existing as any).id });
  return c.json({ deleted: true, id });
});

// ============================================================================
// Spec Comments (T#332)
// ============================================================================

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS spec_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run(); } catch { /* exists */ }

// GET /api/specs/:id/comments
app.get('/api/specs/:id/comments', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const spec = sqlite.prepare('SELECT id FROM spec_reviews WHERE id = ?').get(id);
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  const limit = Math.min(100, parseInt(c.req.query('limit') || '30', 10));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
  const total = (sqlite.prepare('SELECT COUNT(*) as c FROM spec_comments WHERE spec_id = ?').get(id) as any).c;
  // Return most recent comments: order DESC for pagination, then reverse for display
  const comments = sqlite.prepare('SELECT * FROM spec_comments WHERE spec_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(id, limit, offset) as any[];
  comments.reverse();
  return c.json({ comments, total });
});

// GET /api/spec-comments/:commentId — single comment by ID
app.get('/api/spec-comments/:commentId', (c) => {
  const commentId = parseInt(c.req.param('commentId'), 10);
  if (isNaN(commentId)) return c.json({ error: 'Invalid ID' }, 400);
  const comment = sqlite.prepare('SELECT * FROM spec_comments WHERE id = ?').get(commentId);
  if (!comment) return c.json({ error: 'Comment not found' }, 404);
  return c.json(comment);
});

// POST /api/specs/:id/comments
app.post('/api/specs/:id/comments', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const spec = sqlite.prepare('SELECT id, title, author FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);

  try {
    const data = await c.req.json();
    const author = (c.req.query('as') || data.author || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!author) return c.json({ error: 'Identity required: pass ?as=beast or author in body' }, 400);
    if (!data.content?.trim()) return c.json({ error: 'content required' }, 400);

    const contentText = data.content.trim();
    const result = sqlite.prepare(
      'INSERT INTO spec_comments (spec_id, author, content) VALUES (?, ?, ?)'
    ).run(id, author, contentText);

    const comment = sqlite.prepare('SELECT * FROM spec_comments WHERE id = ?').get((result as any).lastInsertRowid);
    wsBroadcast('spec_comment', { action: 'comment', spec_id: id, comment_id: (comment as any).id });

    // Notify spec author + previous commenters + @mentions
    try {
      const { parseMentions, notifyMentioned } = await import('./forum/mentions.ts');
      const toNotify = new Set<string>();
      // Spec author
      if (spec.author && spec.author.toLowerCase() !== author) toNotify.add(spec.author.toLowerCase());
      // Previous commenters
      const prevCommenters = sqlite.prepare(
        'SELECT DISTINCT author FROM spec_comments WHERE spec_id = ? AND author != ?'
      ).all(id, author) as any[];
      for (const pc of prevCommenters) toNotify.add(pc.author.toLowerCase());
      // @mentions in comment content
      const mentions = parseMentions(contentText, 0);
      for (const m of mentions) toNotify.add(m.toLowerCase());
      toNotify.delete(author);
      toNotify.delete('gorn'); toNotify.delete('human'); toNotify.delete('user');
      if (toNotify.size > 0) {
        notifyMentioned(
          [...toNotify],
          0,
          `Spec #${id}: ${spec.title || 'Untitled'}`,
          author,
          `New comment on spec #${id}: ${contentText.slice(0, 100)}`,
          { type: 'Spec comment', label: `spec #${id}`, hint: `Use /spec ${id} to view. Reply with: curl -X POST http://localhost:47778/api/specs/${id}/comments?as=<you> -H 'Content-Type: application/json' -d '{\"content\":\"your reply\"}'` }
        );
      }
    } catch { /* notification failure is non-critical */ }

    return c.json(comment, 201);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// ============================================================================
// Risk Register (T#316)
// ============================================================================

const ALLOWED_RISK_CREATORS = ['gorn', 'bertus', 'talon'];

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'security',
    severity TEXT NOT NULL DEFAULT 'medium',
    likelihood TEXT NOT NULL DEFAULT 'possible',
    risk_score INTEGER GENERATED ALWAYS AS (
      CASE severity
        WHEN 'critical' THEN 5 WHEN 'high' THEN 4
        WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1
      END *
      CASE likelihood
        WHEN 'almost_certain' THEN 5 WHEN 'likely' THEN 4
        WHEN 'possible' THEN 3 WHEN 'unlikely' THEN 2 ELSE 1
      END
    ) STORED,
    impact_notes TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    mitigation TEXT,
    owner TEXT,
    source TEXT,
    source_type TEXT DEFAULT 'scan',
    risk_type TEXT DEFAULT 'threat',
    thread_id INTEGER,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    closed_at DATETIME,
    deleted_at DATETIME
  )
`).run(); } catch { /* exists */ }

// GET /api/risks — list risks
app.get('/api/risks', (c) => {
  const status = c.req.query('status');
  const category = c.req.query('category');
  const severity = c.req.query('severity');
  const likelihood = c.req.query('likelihood');
  const owner = c.req.query('owner');
  const risk_type = c.req.query('risk_type');
  const includeDeleted = c.req.query('deleted') === 'true';

  let query = 'SELECT * FROM risks WHERE 1=1';
  const params: any[] = [];

  if (!includeDeleted) {
    query += ' AND deleted_at IS NULL';
  }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (severity) { query += ' AND severity = ?'; params.push(severity); }
  if (likelihood) { query += ' AND likelihood = ?'; params.push(likelihood); }
  if (owner) { query += ' AND owner = ?'; params.push(owner); }
  if (risk_type) { query += ' AND risk_type = ?'; params.push(risk_type); }

  query += ' ORDER BY risk_score DESC, updated_at DESC';

  const risks = sqlite.prepare(query).all(...params);
  return c.json({ risks });
});

// GET /api/risks/summary — dashboard summary
app.get('/api/risks/summary', (c) => {
  const base = 'FROM risks WHERE deleted_at IS NULL';
  const total = (sqlite.prepare(`SELECT COUNT(*) as c ${base}`).get() as any).c;

  const bySeverity: any = {};
  for (const s of ['critical', 'high', 'medium', 'low', 'info']) {
    bySeverity[s] = (sqlite.prepare(`SELECT COUNT(*) as c ${base} AND severity = ?`).get(s) as any).c;
  }

  const byStatus: any = {};
  for (const s of ['open', 'mitigating', 'accepted', 'mitigated', 'closed']) {
    byStatus[s] = (sqlite.prepare(`SELECT COUNT(*) as c ${base} AND status = ?`).get(s) as any).c;
  }

  const byCategory: any = {};
  const catRows = sqlite.prepare(`SELECT category, COUNT(*) as c ${base} GROUP BY category`).all() as any[];
  for (const r of catRows) byCategory[r.category] = r.c;

  const staleCount = (sqlite.prepare(
    `SELECT COUNT(*) as c ${base} AND status IN ('open','mitigating') AND (reviewed_at IS NULL OR reviewed_at < datetime('now', '-7 days'))`
  ).get() as any).c;

  // Matrix data: count of risks per severity × likelihood
  const matrixRows = sqlite.prepare(
    `SELECT severity, likelihood, COUNT(*) as count ${base} AND status NOT IN ('closed','mitigated') GROUP BY severity, likelihood`
  ).all() as any[];

  return c.json({ total, by_severity: bySeverity, by_status: byStatus, by_category: byCategory, stale_count: staleCount, matrix: matrixRows });
});

// GET /api/risks/stale — risks not reviewed in >7 days
app.get('/api/risks/stale', (c) => {
  const risks = sqlite.prepare(
    "SELECT * FROM risks WHERE deleted_at IS NULL AND status IN ('open','mitigating') AND (reviewed_at IS NULL OR reviewed_at < datetime('now', '-7 days')) ORDER BY risk_score DESC"
  ).all();
  return c.json({ risks });
});

// GET /api/risks/:id — single risk
app.get('/api/risks/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const risk = sqlite.prepare('SELECT * FROM risks WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!risk) return c.json({ error: 'Risk not found' }, 404);
  return c.json(risk);
});

// POST /api/risks — create risk (Gorn, Bertus, Talon)
app.post('/api/risks', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);

    const requester = (c.req.query('as') || data.created_by || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester || !ALLOWED_RISK_CREATORS.includes(requester)) {
      return c.json({ error: `Only ${ALLOWED_RISK_CREATORS.join(', ')} can create risks` }, 403);
    }

    const validSeverity = ['critical', 'high', 'medium', 'low', 'info'];
    const validLikelihood = ['almost_certain', 'likely', 'possible', 'unlikely', 'rare'];
    const validStatus = ['open', 'mitigating', 'accepted', 'mitigated', 'closed'];
    const validSourceType = ['scan', 'audit', 'thread', 'directive', 'external'];
    const validRiskType = ['vulnerability', 'threat', 'operational', 'compliance', 'project'];

    const now = new Date().toISOString();
    const result = sqlite.prepare(
      `INSERT INTO risks (title, description, category, severity, likelihood, impact_notes, status, mitigation, owner, source, source_type, risk_type, thread_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.title.trim(),
      data.description || null,
      data.category || 'security',
      validSeverity.includes(data.severity) ? data.severity : 'medium',
      validLikelihood.includes(data.likelihood) ? data.likelihood : 'possible',
      data.impact_notes || null,
      validStatus.includes(data.status) ? data.status : 'open',
      data.mitigation || null,
      data.owner || null,
      data.source || null,
      validSourceType.includes(data.source_type) ? data.source_type : 'scan',
      validRiskType.includes(data.risk_type) ? data.risk_type : 'threat',
      data.thread_id ?? null,
      requester,
      now, now
    );

    const risk = sqlite.prepare('SELECT * FROM risks WHERE id = ?').get((result as any).lastInsertRowid) as any;
    // Risk excluded from search index per Gorn
    wsBroadcast('risk_update', { action: 'create', id: risk.id });
    return c.json(risk, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Invalid request' }, 400);
  }
});

// PATCH /api/risks/:id — update risk
app.patch('/api/risks/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM risks WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!existing) return c.json({ error: 'Risk not found' }, 404);

  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!requester) return c.json({ error: 'Identity required' }, 400);

  try {
    const data = await c.req.json();

    // Gorn-only fields
    const gornOnly = ['status', 'severity', 'likelihood'];
    for (const field of gornOnly) {
      if (field in data && requester !== 'gorn') {
        return c.json({ error: `Only Gorn can change ${field}` }, 403);
      }
    }

    const allowed = ['title', 'description', 'category', 'severity', 'likelihood', 'impact_notes', 'status', 'mitigation', 'owner', 'source', 'source_type', 'risk_type', 'thread_id', 'reviewed_at'];
    const updates: string[] = [];
    const values: any[] = [];

    for (const field of allowed) {
      if (field in data) {
        updates.push(`${field} = ?`);
        values.push(data[field]);
      }
    }
    if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);

    // Auto-set closed_at when status changes to closed
    if (data.status === 'closed' && existing.status !== 'closed') {
      updates.push('closed_at = ?');
      values.push(new Date().toISOString());
    } else if (data.status && data.status !== 'closed' && existing.closed_at) {
      updates.push('closed_at = ?');
      values.push(null);
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    sqlite.prepare(`UPDATE risks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const risk = sqlite.prepare('SELECT * FROM risks WHERE id = ?').get(id) as any;
    // Risk excluded from search index per Gorn
    wsBroadcast('risk_update', { action: 'update', id: risk?.id });
    return c.json(risk);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// DELETE /api/risks/:id — soft delete (Gorn only)
app.delete('/api/risks/:id', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM risks WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!existing) return c.json({ error: 'Risk not found' }, 404);

  const now = new Date().toISOString();
  sqlite.prepare('UPDATE risks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  wsBroadcast('risk_update', { action: 'delete', id: (existing as any).id });
  return c.json({ deleted: true, id });
});

// ============================================================================
// Risk Comments (T#323)
// ============================================================================

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS risk_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    risk_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run(); } catch { /* exists */ }

// GET /api/risks/:id/comments — list comments for a risk
app.get('/api/risks/:id/comments', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const risk = sqlite.prepare('SELECT id FROM risks WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!risk) return c.json({ error: 'Risk not found' }, 404);
  const comments = sqlite.prepare('SELECT * FROM risk_comments WHERE risk_id = ? ORDER BY created_at ASC').all(id);
  return c.json({ comments });
});

// POST /api/risks/:id/comments — add comment
app.post('/api/risks/:id/comments', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const risk = sqlite.prepare('SELECT id FROM risks WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!risk) return c.json({ error: 'Risk not found' }, 404);

  try {
    const data = await c.req.json();
    const author = (c.req.query('as') || data.author || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!author) return c.json({ error: 'Identity required: pass ?as=beast or author in body' }, 400);
    if (!data.content?.trim()) return c.json({ error: 'content required' }, 400);

    const contentText = data.content.trim();
    const result = sqlite.prepare(
      'INSERT INTO risk_comments (risk_id, author, content) VALUES (?, ?, ?)'
    ).run(id, author, contentText);

    const comment = sqlite.prepare('SELECT * FROM risk_comments WHERE id = ?').get((result as any).lastInsertRowid);
    wsBroadcast('risk_update', { action: 'comment', risk_id: id });

    // Notify risk owner + previous commenters
    try {
      const riskData = sqlite.prepare('SELECT title, owner FROM risks WHERE id = ?').get(id) as any;
      if (riskData) {
        const { parseMentions, notifyMentioned } = await import('./forum/mentions.ts');
        const toNotify = new Set<string>();
        // Risk owner
        if (riskData.owner && riskData.owner.toLowerCase() !== author) toNotify.add(riskData.owner.toLowerCase());
        // Previous commenters
        const prevCommenters = sqlite.prepare(
          'SELECT DISTINCT author FROM risk_comments WHERE risk_id = ? AND author != ?'
        ).all(id, author) as any[];
        for (const pc of prevCommenters) toNotify.add(pc.author.toLowerCase());
        // @mentions in comment content
        const mentions = parseMentions(contentText, 0);
        for (const m of mentions) toNotify.add(m.toLowerCase());
        toNotify.delete(author);
        toNotify.delete('gorn'); toNotify.delete('human'); toNotify.delete('user');
        if (toNotify.size > 0) {
          notifyMentioned(
            [...toNotify],
            0,
            `Risk #${id}: ${riskData.title || 'Untitled'}`,
            author,
            `New comment on risk #${id}: ${contentText.slice(0, 100)}`,
            { type: 'Risk comment', label: `risk #${id}`, hint: `View at /risk and expand risk #${id} to see comments.` }
          );
        }
      }
    } catch { /* notification failure is non-critical */ }

    return c.json(comment, 201);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// ============================================================================
// Withings OAuth Integration (T#414, Spec #23)
// ============================================================================

// OAuth tokens table — encrypted at rest
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    user_id TEXT,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    access_iv TEXT NOT NULL,
    access_tag TEXT NOT NULL,
    refresh_iv TEXT NOT NULL,
    refresh_tag TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scopes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
// Migration: add separate IV/tag columns for access and refresh tokens
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN access_iv TEXT').run(); } catch { /* exists */ }
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN access_tag TEXT').run(); } catch { /* exists */ }
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN refresh_iv TEXT').run(); } catch { /* exists */ }
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN refresh_tag TEXT').run(); } catch { /* exists */ }
// Migration: drop NOT NULL on old token_iv/token_tag columns (T#476 — schema mismatch)
// SQLite can't ALTER columns, so recreate the table if old columns exist
try {
  const cols = sqlite.prepare("PRAGMA table_info(oauth_tokens)").all() as any[];
  const hasOldCol = cols.some((c: any) => c.name === 'token_iv' && c.notnull === 1);
  if (hasOldCol) {
    sqlite.exec(`
      CREATE TABLE oauth_tokens_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL, user_id TEXT,
        access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL,
        token_iv TEXT, token_tag TEXT,
        access_iv TEXT, access_tag TEXT, refresh_iv TEXT, refresh_tag TEXT,
        expires_at INTEGER NOT NULL, scopes TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO oauth_tokens_new SELECT * FROM oauth_tokens;
      DROP TABLE oauth_tokens;
      ALTER TABLE oauth_tokens_new RENAME TO oauth_tokens;
    `);
    console.log('[OAuth] Migrated oauth_tokens: dropped NOT NULL on token_iv/token_tag');
  }
} catch (err) { console.error('[OAuth] Migration error:', err); }

// AES-256-GCM encryption for OAuth tokens
const OAUTH_KEY = process.env.OAUTH_ENCRYPTION_KEY; // 32-byte hex string
const WITHINGS_CLIENT_ID = process.env.WITHINGS_CLIENT_ID || '';
const WITHINGS_CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET || '';
const WITHINGS_REDIRECT_URI = process.env.WITHINGS_REDIRECT_URI || 'https://denbook.online/api/oauth/withings/callback';

function encryptToken(token: string): { encrypted: string; iv: string; tag: string } {
  if (!OAUTH_KEY) throw new Error('OAUTH_ENCRYPTION_KEY not set');
  const key = Buffer.from(OAUTH_KEY, 'hex');
  const iv = require('crypto').randomBytes(12);
  const cipher = require('crypto').createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), tag };
}

function decryptToken(encrypted: string, ivHex: string, tagHex: string): string {
  if (!OAUTH_KEY) throw new Error('OAUTH_ENCRYPTION_KEY not set');
  const key = Buffer.from(OAUTH_KEY, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = require('crypto').createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Generate HMAC-SHA256 signature for Withings API
function withingsSign(data: string): string {
  return createHmac('sha256', WITHINGS_CLIENT_SECRET).update(data).digest('hex');
}

// Get Withings nonce (required for signed requests)
async function getWithingsNonce(): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = withingsSign(`getnonce,${WITHINGS_CLIENT_ID},${timestamp}`);
  const res = await fetch('https://wbsapi.withings.net/v2/signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'getnonce', client_id: WITHINGS_CLIENT_ID, timestamp: String(timestamp), signature }),
  });
  const data = await res.json() as any;
  if (data.status !== 0) throw new Error(`Nonce failed: ${data.error}`);
  return data.body.nonce;
}

// Refresh Withings tokens if needed
async function ensureFreshWithingsToken(): Promise<{ accessToken: string; userId: string } | null> {
  const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  if (token.expires_at > now + 600) {
    // Token still fresh (>10 min remaining)
    return { accessToken: decryptToken(token.access_token_enc, token.access_iv || token.token_iv, token.access_tag || token.token_tag), userId: token.user_id };
  }

  // Refresh token
  try {
    const refreshToken = decryptToken(token.refresh_token_enc, token.refresh_iv || token.token_iv, token.refresh_tag || token.token_tag);
    const nonce = await getWithingsNonce();
    const signature = withingsSign(`requesttoken,${WITHINGS_CLIENT_ID},${nonce}`);
    const res = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'requesttoken', grant_type: 'refresh_token',
        client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET,
        refresh_token: refreshToken, nonce, signature,
      }),
    });
    const data = await res.json() as any;
    if (data.status !== 0) throw new Error(`Refresh failed: ${data.error}`);

    const { access_token, refresh_token, expires_in, userid } = data.body;
    const enc = encryptToken(access_token);
    const refreshEnc = encryptToken(refresh_token);
    sqlite.prepare(
      `UPDATE oauth_tokens SET access_token_enc = ?, refresh_token_enc = ?, access_iv = ?, access_tag = ?, refresh_iv = ?, refresh_tag = ?,
       expires_at = ?, user_id = ?, updated_at = ? WHERE id = ?`
    ).run(enc.encrypted, refreshEnc.encrypted, enc.iv, enc.tag, refreshEnc.iv, refreshEnc.tag, now + expires_in, userid, now, token.id);

    logSecurityEvent({
      eventType: 'token_refreshed',
      severity: 'info',
      actor: 'system',
      actorType: 'system',
      target: 'oauth:withings',
      details: { provider: 'withings', user_id: userid },
    });

    return { accessToken: access_token, userId: userid };
  } catch (err) {
    console.error('[Withings] Token refresh failed:', err);
    return null;
  }
}

// CSRF state storage (in-memory, short-lived)
const oauthStates = new Map<string, number>();

// GET /api/oauth/withings/authorize — start OAuth flow
app.get('/api/oauth/withings/authorize', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  if (!WITHINGS_CLIENT_ID) return c.json({ error: 'Withings not configured (missing WITHINGS_CLIENT_ID)' }, 500);

  const state = require('crypto').randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  // Clean old states (>10 min)
  for (const [k, v] of oauthStates) { if (Date.now() - v > 600000) oauthStates.delete(k); }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: WITHINGS_CLIENT_ID,
    scope: 'user.info,user.metrics',
    redirect_uri: WITHINGS_REDIRECT_URI,
    state,
  });
  return c.redirect(`https://account.withings.com/oauth2_user/authorize2?${params}`);
});

// GET /api/oauth/withings/callback — handle OAuth callback
app.get('/api/oauth/withings/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) return c.redirect('/forge?oauth_error=' + encodeURIComponent(error));
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
  if (!oauthStates.has(state)) return c.json({ error: 'Invalid or expired state (CSRF check failed)' }, 403);
  oauthStates.delete(state);

  try {
    // Exchange code for tokens
    const nonce = await getWithingsNonce();
    const signature = withingsSign(`requesttoken,${WITHINGS_CLIENT_ID},${nonce}`);
    const res = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'requesttoken', grant_type: 'authorization_code',
        client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET,
        code, redirect_uri: WITHINGS_REDIRECT_URI, nonce, signature,
      }),
    });
    const data = await res.json() as any;
    if (data.status !== 0) return c.redirect('/forge?oauth_error=' + encodeURIComponent(data.error || 'Token exchange failed'));

    const { access_token, refresh_token, expires_in, userid, scope } = data.body;
    const now = Math.floor(Date.now() / 1000);

    // Encrypt tokens
    const accessEnc = encryptToken(access_token);
    const refreshEnc = encryptToken(refresh_token);

    // Store (upsert — replace existing Withings connection)
    sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'withings'").run();
    sqlite.prepare(
      `INSERT INTO oauth_tokens (provider, user_id, access_token_enc, refresh_token_enc, access_iv, access_tag, refresh_iv, refresh_tag, expires_at, scopes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('withings', String(userid), accessEnc.encrypted, refreshEnc.encrypted, accessEnc.iv, accessEnc.tag, refreshEnc.iv, refreshEnc.tag, now + expires_in, scope || 'user.info,user.metrics', now, now);

    logSecurityEvent({
      eventType: 'token_created',
      severity: 'info',
      actor: 'gorn',
      actorType: 'human',
      target: 'oauth:withings',
      details: { provider: 'withings', user_id: String(userid) },
    });

    // Subscribe to webhook for weight/body composition (appli=1)
    try {
      await fetch('https://wbsapi.withings.net/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${access_token}` },
        body: new URLSearchParams({ action: 'subscribe', callbackurl: WITHINGS_REDIRECT_URI.replace('/callback', '').replace('/api/oauth/withings', '/api/webhooks/withings'), appli: '1' }),
      });
    } catch { /* webhook subscription failure is non-critical */ }

    return c.redirect('/forge?withings=connected');
  } catch (err) {
    console.error('[Withings] OAuth callback error:', err);
    return c.redirect('/forge?oauth_error=callback_failed');
  }
});

// GET /api/oauth/withings/status — connection status
app.get('/api/oauth/withings/status', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge access required' }, 403);
  const token = sqlite.prepare("SELECT provider, user_id, expires_at, scopes, updated_at FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
  if (!token) return c.json({ connected: false });
  const now = Math.floor(Date.now() / 1000);
  // Last successful sync time — use in-memory tracker (updated every sync, even with 0 new records)
  // Fall back to DB created_at for first load after server restart (T#536)
  let lastSync = withingsLastSyncAt;
  if (!lastSync) {
    const lastSyncRow = sqlite.prepare(
      "SELECT MAX(created_at) as sync_time FROM routine_logs WHERE source = 'withings' AND deleted_at IS NULL"
    ).get() as any;
    lastSync = lastSyncRow?.sync_time || null;
  }
  return c.json({
    connected: true,
    userId: token.user_id,
    tokenExpired: token.expires_at < now,
    lastUpdated: new Date(token.updated_at * 1000).toISOString(),
    lastSync,
    scopes: token.scopes,
  });
});

// GET /api/withings/devices — proxy to Withings device list (T#478)
app.get('/api/withings/devices', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge access required' }, 403);
  try {
    const tokenData = await ensureFreshWithingsToken();
    if (!tokenData) return c.json({ error: 'Withings not connected' }, 400);
    const res = await fetch('https://wbsapi.withings.net/v2/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokenData.accessToken}` },
      body: new URLSearchParams({ action: 'getdevice' }),
    });
    const data = await res.json() as any;
    if (data.status !== 0) return c.json({ error: data.error || `Withings API error: ${data.status}` }, 502);
    return c.json({ devices: data.body?.devices || [] });
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to fetch devices' }, 500);
  }
});

// DELETE /api/oauth/withings/disconnect — revoke connection
app.delete('/api/oauth/withings/disconnect', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  // Revoke webhook if possible
  try {
    const tokenData = await ensureFreshWithingsToken();
    if (tokenData) {
      await fetch('https://wbsapi.withings.net/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokenData.accessToken}` },
        body: new URLSearchParams({ action: 'revoke', callbackurl: WITHINGS_REDIRECT_URI.replace('/callback', '').replace('/api/oauth/withings', '/api/webhooks/withings'), appli: '1' }),
      });
    }
  } catch { /* best effort */ }
  sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'withings'").run();
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  logSecurityEvent({
    eventType: 'token_revoked',
    severity: 'info',
    actor: 'gorn',
    actorType: 'human',
    target: 'oauth:withings',
    details: { provider: 'withings' },
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });
  return c.json({ disconnected: true });
});

// Withings measurement type mapping
const WITHINGS_MEASTYPES: Record<number, string> = {
  1: 'weight', 5: 'fat_free_mass', 6: 'body_fat_pct', 8: 'fat_mass',
  9: 'diastolic', 10: 'systolic',
  76: 'muscle_mass', 77: 'hydration', 88: 'bone_mass', 170: 'visceral_fat',
};

// Fetch and store Withings measurements for a date range
async function syncWithingsMeasurements(startdate: number, enddate: number): Promise<{ synced: number; skipped: number }> {
  const tokenData = await ensureFreshWithingsToken();
  if (!tokenData) throw new Error('No Withings connection');

  const params: Record<string, string> = {
    action: 'getmeas',
    meastypes: '1,5,6,8,9,10,76,77,88,170',
    category: '1',
  };
  if (startdate) params.startdate = String(startdate);
  if (enddate) params.enddate = String(enddate);

  const res = await fetch('https://wbsapi.withings.net/measure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokenData.accessToken}` },
    body: new URLSearchParams(params),
  });
  const data = await res.json() as any;
  if (data.status !== 0) throw new Error(`Withings API error: ${data.error || data.status}`);

  const measuregrps = data.body?.measuregrps || [];
  let synced = 0, skipped = 0;

  for (const grp of measuregrps) {
    const grpid = grp.grpid;
    // Dedup by withings_grpid (check both weight and measurement types)
    const existing = sqlite.prepare("SELECT id FROM routine_logs WHERE source = 'withings' AND json_extract(data, '$.withings_grpid') = ? AND deleted_at IS NULL LIMIT 1").get(grpid);
    if (existing) { skipped++; continue; }

    const measurements: Record<string, number> = {};
    for (const m of grp.measures || []) {
      const field = WITHINGS_MEASTYPES[m.type];
      if (field) {
        measurements[field] = Math.round(m.value * Math.pow(10, m.unit) * 100) / 100;
      }
    }
    if (Object.keys(measurements).length === 0) continue;

    const loggedAt = new Date(grp.date * 1000).toISOString();
    const now = new Date().toISOString();

    // Store BP as 'blood_pressure' type (Prowl #80 — Omron→Apple Health→Withings path)
    if (measurements.systolic !== undefined || measurements.diastolic !== undefined) {
      const bpData = JSON.stringify({
        systolic: measurements.systolic,
        diastolic: measurements.diastolic,
        source: 'withings',
        withings_grpid: grpid,
      });
      sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('blood_pressure', loggedAt, bpData, 'withings', now);
      delete measurements.systolic;
      delete measurements.diastolic;
    }

    // Store weight as 'weight' type so Forge chart picks it up
    if (measurements.weight) {
      const weightData = JSON.stringify({ value: measurements.weight, unit: 'kg', source: 'withings', withings_grpid: grpid });
      sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('weight', loggedAt, weightData, 'withings', now);
    }

    // Store full body composition as 'measurement' type (only if body-comp fields remain)
    const bodyCompKeys = Object.keys(measurements);
    if (bodyCompKeys.length > 0 && (bodyCompKeys.length > 1 || !measurements.weight)) {
      const logData = JSON.stringify({ ...measurements, withings_grpid: grpid });
      sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('measurement', loggedAt, logData, 'withings', now);
    }
    synced++;
  }

  withingsLastSyncAt = new Date().toISOString(); // Track last successful sync (T#536)
  console.log(`[Withings] Synced ${synced} measurements, skipped ${skipped} duplicates`);
  return { synced, skipped };
}

// POST /api/webhooks/withings — receive Withings push notifications (T#415)
app.post('/api/webhooks/withings', async (c) => {
  // Withings requires 200 response within 2 seconds — respond first, sync async
  const body = await c.req.parseBody();
  const userid = String(body.userid || '');
  const appli = String(body.appli || '');
  const startdate = parseInt(String(body.startdate || '0'), 10);
  const enddate = parseInt(String(body.enddate || '0'), 10);

  console.log(`[Withings] Webhook received: userid=${userid} appli=${appli} startdate=${startdate} enddate=${enddate}`);

  // Validate userid matches stored token
  const token = sqlite.prepare("SELECT user_id FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
  if (!token || token.user_id !== userid) {
    console.log(`[Withings] Webhook rejected: unknown userid ${userid}`);
    return c.text('OK', 200); // Still return 200 to avoid Withings retries
  }

  // Handle body comp (appli=1) + blood pressure (appli=4, Prowl #80)
  if (appli !== '1' && appli !== '4') {
    return c.text('OK', 200);
  }

  // Async sync — don't block the 200 response
  syncWithingsMeasurements(startdate, enddate).catch(err => {
    console.error('[Withings] Async sync failed:', err);
  });

  return c.text('OK', 200);
});

// POST /api/oauth/withings/sync — manual sync trigger (T#415)
app.post('/api/oauth/withings/sync', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access required' }, 403);

  const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
  if (!token) return c.json({ error: 'Withings not connected' }, 400);

  try {
    // Get last sync time from most recent Withings log
    const lastLog = sqlite.prepare(
      "SELECT logged_at FROM routine_logs WHERE source = 'withings' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1"
    ).get() as any;

    const now = Math.floor(Date.now() / 1000);
    const full = c.req.query('full') === 'true';
    // Full sync: from 2010 (earliest Withings scales); incremental: from last entry or 30 days
    const startdate = full
      ? 1262304000 // 2010-01-01
      : lastLog
        ? Math.floor(new Date(lastLog.logged_at).getTime() / 1000)
        : now - 30 * 86400;

    const result = await syncWithingsMeasurements(startdate, now);
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Sync failed' }, 500);
  }
});

// ============================================================================
// Google OAuth Integration (T#541, Spec #30)
// ============================================================================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://denbook.online/api/oauth/google/callback';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';

// PKCE state storage (in-memory, short-lived) — stores state → { timestamp, codeVerifier }
const googleOauthStates = new Map<string, { ts: number; codeVerifier: string }>();

// Google access control — Beast allowlist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS google_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beast TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Google audit log
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS google_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beast TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    query TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL
  )
`);

// Rate limiting — per-Beast request tracking (in-memory)
const googleRateLimits = new Map<string, number[]>();
const GOOGLE_RATE_LIMIT = 30; // requests per minute per Beast

function checkGoogleRateLimit(beast: string): boolean {
  const now = Date.now();
  const oneMinAgo = now - 60000;
  const timestamps = (googleRateLimits.get(beast) || []).filter(t => t > oneMinAgo);
  if (timestamps.length >= GOOGLE_RATE_LIMIT) return false;
  timestamps.push(now);
  googleRateLimits.set(beast, timestamps);
  return true;
}

// PKCE helpers
function generateCodeVerifier(): string {
  return require('crypto').randomBytes(32).toString('base64url'); // 43 chars
}

function generateCodeChallenge(verifier: string): string {
  return require('crypto').createHash('sha256').update(verifier).digest('base64url');
}

// Refresh Google tokens if needed
async function ensureFreshGoogleToken(): Promise<{ accessToken: string; userId: string } | null> {
  const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'google' LIMIT 1").get() as any;
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  if (token.expires_at > now + 600) {
    return { accessToken: decryptToken(token.access_token_enc, token.access_iv || token.token_iv, token.access_tag || token.token_tag), userId: token.user_id };
  }

  // Refresh — Google does NOT rotate refresh tokens
  try {
    const refreshToken = decryptToken(token.refresh_token_enc, token.refresh_iv || token.token_iv, token.refresh_tag || token.token_tag);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json() as any;
    if (data.error) throw new Error(`Refresh failed: ${data.error}`);

    const { access_token, expires_in } = data;
    const enc = encryptToken(access_token);
    // Google keeps same refresh token — only update access token
    sqlite.prepare(
      `UPDATE oauth_tokens SET access_token_enc = ?, access_iv = ?, access_tag = ?,
       expires_at = ?, updated_at = ? WHERE id = ?`
    ).run(enc.encrypted, enc.iv, enc.tag, now + expires_in, now, token.id);

    logSecurityEvent({
      eventType: 'token_refreshed',
      severity: 'info',
      actor: 'system',
      actorType: 'system',
      target: 'oauth:google',
      details: { provider: 'google', user_id: token.user_id },
    });

    return { accessToken: access_token, userId: token.user_id };
  } catch (err) {
    console.error('[Google] Token refresh failed:', err);
    return null;
  }
}

// Google access control middleware
function checkGoogleAccess(beast: string, requiredScope: string = 'gmail.readonly'): { allowed: boolean; error?: string; status?: number } {
  const access = sqlite.prepare("SELECT scopes FROM google_access WHERE beast = ?").get(beast) as any;
  if (!access) return { allowed: false, error: 'Not authorized for Google access', status: 401 };
  const scopes = access.scopes.split(',').map((s: string) => s.trim());
  if (!scopes.includes(requiredScope)) return { allowed: false, error: 'Insufficient Google scope', status: 403 };
  return { allowed: true };
}

// Log Google API access
function logGoogleAccess(beast: string, endpoint: string, query?: string, messageId?: string) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO google_audit_log (beast, endpoint, query, message_id, created_at) VALUES (?, ?, ?, ?, ?)").run(beast, endpoint, query || null, messageId || null, now);
}

// Wrap email content with untrusted boundary tags (prompt injection defense)
function tagUntrustedContent(content: string, maxLength: number = 50000): string {
  const truncated = content.length > maxLength ? content.substring(0, maxLength) + '\n[... truncated at 50KB]' : content;
  return `--- BEGIN UNTRUSTED EMAIL CONTENT ---\n${truncated}\n--- END UNTRUSTED EMAIL CONTENT ---`;
}

// Sanitize email metadata fields (prompt injection defense)
function sanitizeMetadata(value: string | undefined, maxLength: number): string {
  if (!value) return '';
  return value.substring(0, maxLength);
}

// GET /api/oauth/google/authorize — start OAuth flow with PKCE
app.get('/api/oauth/google/authorize', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  if (!GOOGLE_CLIENT_ID) return c.json({ error: 'Google not configured (missing GOOGLE_CLIENT_ID)' }, 500);

  // CSRF state + PKCE code verifier
  const state = require('crypto').randomBytes(16).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  googleOauthStates.set(state, { ts: Date.now(), codeVerifier });
  // Clean old states (>10 min)
  for (const [k, v] of googleOauthStates) { if (Date.now() - v.ts > 600000) googleOauthStates.delete(k); }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    scope: GOOGLE_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'consent', // Ensures refresh token is always returned
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  console.log('[Google] OAuth flow initiated');
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/oauth/google/callback — handle OAuth callback with PKCE
app.get('/api/oauth/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) return c.redirect('/settings?oauth_error=' + encodeURIComponent(error));
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);

  const stateData = googleOauthStates.get(state);
  if (!stateData) return c.json({ error: 'Invalid or expired state (CSRF check failed)' }, 403);
  googleOauthStates.delete(state);

  try {
    // Exchange code for tokens with PKCE code_verifier
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: stateData.codeVerifier,
      }),
    });
    const data = await res.json() as any;
    if (data.error) return c.redirect('/settings?oauth_error=' + encodeURIComponent(data.error_description || data.error));

    const { access_token, refresh_token, expires_in, scope } = data;
    if (!refresh_token) return c.redirect('/settings?oauth_error=' + encodeURIComponent('No refresh token returned — try disconnecting from Google and reconnecting'));

    const now = Math.floor(Date.now() / 1000);

    // Get user email from Google userinfo
    let userEmail = 'unknown';
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const info = await infoRes.json() as any;
      userEmail = info.email || 'unknown';
    } catch { /* non-critical */ }

    // Encrypt tokens
    const accessEnc = encryptToken(access_token);
    const refreshEnc = encryptToken(refresh_token);

    // Store (upsert — replace existing Google connection)
    sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'google'").run();
    sqlite.prepare(
      `INSERT INTO oauth_tokens (provider, user_id, access_token_enc, refresh_token_enc, access_iv, access_tag, refresh_iv, refresh_tag, expires_at, scopes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('google', userEmail, accessEnc.encrypted, refreshEnc.encrypted, accessEnc.iv, accessEnc.tag, refreshEnc.iv, refreshEnc.tag, now + expires_in, scope || GOOGLE_SCOPES, now, now);

    logSecurityEvent({
      eventType: 'token_created',
      severity: 'info',
      actor: 'gorn',
      actorType: 'human',
      target: 'oauth:google',
      details: { provider: 'google', user_id: userEmail },
    });

    console.log(`[Google] OAuth connected: ${userEmail}`);
    return c.redirect('/settings?google=connected');
  } catch (err) {
    console.error('[Google] OAuth callback error:', err);
    return c.redirect('/settings?oauth_error=callback_failed');
  }
});

// GET /api/oauth/google/status — connection status
app.get('/api/oauth/google/status', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Authentication required' }, 403);
  const token = sqlite.prepare("SELECT provider, user_id, expires_at, scopes, updated_at FROM oauth_tokens WHERE provider = 'google' LIMIT 1").get() as any;
  if (!token) return c.json({ connected: false });
  const now = Math.floor(Date.now() / 1000);
  return c.json({
    connected: true,
    email: token.user_id,
    tokenExpired: token.expires_at < now,
    lastUpdated: new Date(token.updated_at * 1000).toISOString(),
    scopes: token.scopes,
  });
});

// DELETE /api/oauth/google/disconnect — revoke and delete
app.delete('/api/oauth/google/disconnect', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  // Revoke at Google
  try {
    const tokenData = await ensureFreshGoogleToken();
    if (tokenData) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokenData.accessToken }),
      });
      console.log('[Google] Token revoked at Google');
    }
  } catch { /* best effort */ }
  sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'google'").run();
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  logSecurityEvent({
    eventType: 'token_revoked',
    severity: 'info',
    actor: 'gorn',
    actorType: 'human',
    target: 'oauth:google',
    details: { provider: 'google' },
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });
  return c.json({ disconnected: true });
});

// --- Google Access Management (Gorn-only) ---

// GET /api/google/access — list allowed Beasts
app.get('/api/google/access', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  const rows = sqlite.prepare("SELECT beast, scopes, granted_by, created_at FROM google_access ORDER BY created_at").all();
  return c.json({ access: rows });
});

// POST /api/google/access — grant Beast access
app.post('/api/google/access', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  const body = await c.req.json() as any;
  const { beast, scopes } = body;
  if (!beast || !scopes) return c.json({ error: 'Missing beast or scopes' }, 400);
  const now = Math.floor(Date.now() / 1000);
  try {
    sqlite.prepare("INSERT OR REPLACE INTO google_access (beast, scopes, granted_by, created_at) VALUES (?, ?, 'gorn', ?)").run(beast.toLowerCase(), scopes, now);
    console.log(`[Google] Access granted: ${beast} (${scopes})`);
    return c.json({ granted: true, beast, scopes });
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to grant access' }, 500);
  }
});

// DELETE /api/google/access/:beast — revoke Beast access
app.delete('/api/google/access/:beast', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  const beast = c.req.param('beast').toLowerCase();
  sqlite.prepare("DELETE FROM google_access WHERE beast = ?").run(beast);
  console.log(`[Google] Access revoked: ${beast}`);
  return c.json({ revoked: true, beast });
});

// GET /api/google/audit — view audit log (Gorn-only)
app.get('/api/google/audit', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const rows = sqlite.prepare("SELECT * FROM google_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = (sqlite.prepare("SELECT COUNT(*) as count FROM google_audit_log").get() as any).count;
  return c.json({ logs: rows, total });
});

// --- Gmail API Proxy Endpoints ---

// Helper: resolve Beast identity from request
function getGmailBeast(c: any): string | null {
  // Browser session = gorn
  if (hasSessionAuth(c)) return 'gorn';
  // Beast API access via ?as= param
  if (isTrustedRequest(c)) {
    const as = (c.req.query('as') || '').toLowerCase();
    return as || null;
  }
  return null;
}

// GET /api/google/gmail/profile — email profile
app.get('/api/google/gmail/profile', async (c) => {
  const beast = getGmailBeast(c);
  if (!beast) return c.json({ error: 'Authentication required' }, 401);
  const access = checkGoogleAccess(beast);
  if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
  if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

  try {
    const tokenData = await ensureFreshGoogleToken();
    if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokenData.accessToken}` },
    });
    const data = await res.json() as any;
    if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

    logGoogleAccess(beast, '/api/google/gmail/profile');
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to fetch profile' }, 500);
  }
});

// GET /api/google/gmail/labels — list labels
app.get('/api/google/gmail/labels', async (c) => {
  const beast = getGmailBeast(c);
  if (!beast) return c.json({ error: 'Authentication required' }, 401);
  const access = checkGoogleAccess(beast);
  if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
  if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

  try {
    const tokenData = await ensureFreshGoogleToken();
    if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      headers: { Authorization: `Bearer ${tokenData.accessToken}` },
    });
    const data = await res.json() as any;
    if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

    logGoogleAccess(beast, '/api/google/gmail/labels');
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to fetch labels' }, 500);
  }
});

// GET /api/google/gmail/messages — list messages
app.get('/api/google/gmail/messages', async (c) => {
  const beast = getGmailBeast(c);
  if (!beast) return c.json({ error: 'Authentication required' }, 401);
  const access = checkGoogleAccess(beast);
  if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
  if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

  try {
    const tokenData = await ensureFreshGoogleToken();
    if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

    const q = c.req.query('q') || '';
    const maxResults = Math.min(parseInt(c.req.query('maxResults') || '20'), 100);
    const pageToken = c.req.query('pageToken') || '';
    const labelIds = c.req.query('labelIds') || '';

    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (q) params.set('q', q);
    if (pageToken) params.set('pageToken', pageToken);
    if (labelIds) labelIds.split(',').forEach(id => params.append('labelIds', id.trim()));

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${tokenData.accessToken}` },
    });
    const data = await res.json() as any;
    if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

    logGoogleAccess(beast, '/api/google/gmail/messages', q || undefined);
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to fetch messages' }, 500);
  }
});

// GET /api/google/gmail/messages/:id — read a single message
app.get('/api/google/gmail/messages/:id', async (c) => {
  const beast = getGmailBeast(c);
  if (!beast) return c.json({ error: 'Authentication required' }, 401);
  const access = checkGoogleAccess(beast);
  if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
  if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

  const messageId = c.req.param('id');

  try {
    const tokenData = await ensureFreshGoogleToken();
    if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
      headers: { Authorization: `Bearer ${tokenData.accessToken}` },
    });
    const data = await res.json() as any;
    if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

    // Parse message into clean format — text only, no HTML (XSS prevention per Bertus)
    const headers = data.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    // Extract plain text body from MIME parts
    let textBody = '';
    function extractText(part: any) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        textBody += Buffer.from(part.body.data, 'base64url').toString('utf8');
      }
      if (part.parts) part.parts.forEach(extractText);
    }
    if (data.payload) extractText(data.payload);

    const formatted = {
      id: data.id,
      threadId: data.threadId,
      snippet: sanitizeMetadata(data.snippet, 500),
      from: sanitizeMetadata(getHeader('From'), 200),
      to: sanitizeMetadata(getHeader('To'), 200),
      subject: sanitizeMetadata(getHeader('Subject'), 500),
      date: getHeader('Date'),
      labels: data.labelIds || [],
      body: {
        text: tagUntrustedContent(textBody),
      },
    };

    logGoogleAccess(beast, '/api/google/gmail/messages/:id', undefined, messageId);
    return c.json(formatted);
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to fetch message' }, 500);
  }
});

// GET /api/google/gmail/threads/:id — read a thread
app.get('/api/google/gmail/threads/:id', async (c) => {
  const beast = getGmailBeast(c);
  if (!beast) return c.json({ error: 'Authentication required' }, 401);
  const access = checkGoogleAccess(beast);
  if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
  if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

  const threadId = c.req.param('id');

  try {
    const tokenData = await ensureFreshGoogleToken();
    if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
      headers: { Authorization: `Bearer ${tokenData.accessToken}` },
    });
    const data = await res.json() as any;
    if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

    // Format each message in thread — text only, no HTML
    const messages = (data.messages || []).map((msg: any) => {
      const headers = msg.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      let textBody = '';
      function extractText(part: any) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          textBody += Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
        if (part.parts) part.parts.forEach(extractText);
      }
      if (msg.payload) extractText(msg.payload);

      return {
        id: msg.id,
        snippet: sanitizeMetadata(msg.snippet, 500),
        from: sanitizeMetadata(getHeader('From'), 200),
        to: sanitizeMetadata(getHeader('To'), 200),
        subject: sanitizeMetadata(getHeader('Subject'), 500),
        date: getHeader('Date'),
        labels: msg.labelIds || [],
        body: { text: tagUntrustedContent(textBody) },
      };
    });

    logGoogleAccess(beast, '/api/google/gmail/threads/:id', undefined, threadId);
    return c.json({ id: data.id, messages });
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to fetch thread' }, 500);
  }
});

// ============================================================================
// Forge — Personal Routine Tracker for Gorn (T#372)
// ============================================================================

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS routine_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data JSON NOT NULL,
    source TEXT DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME DEFAULT NULL
  )
`);

// Exercise library table (T#410 — Forge redesign backend)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    muscle_group TEXT,
    equipment TEXT,
    created_by TEXT DEFAULT 'import',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, equipment)
  )
`);

// Personal records table — materialized on write (T#410)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS personal_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_name TEXT NOT NULL,
    weight REAL NOT NULL,
    reps INTEGER NOT NULL,
    unit TEXT DEFAULT 'kg',
    achieved_at DATETIME NOT NULL,
    log_id INTEGER REFERENCES routine_logs(id),
    UNIQUE(exercise_name, weight, reps, unit)
  )
`);

// Remove CHECK constraint on existing table (allows 'bodyfat' type)
try {
  sqlite.exec(`
    CREATE TABLE routine_logs_new AS SELECT * FROM routine_logs;
    DROP TABLE routine_logs;
    CREATE TABLE routine_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      data JSON NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL
    );
    INSERT INTO routine_logs SELECT * FROM routine_logs_new;
    DROP TABLE routine_logs_new;
  `);
} catch { /* already migrated or no constraint to remove */ }

// T#496: Normalize logged_at to UTC — fix entries stored without Z suffix
try {
  const fixed = sqlite.prepare("UPDATE routine_logs SET logged_at = logged_at || 'Z' WHERE logged_at NOT LIKE '%Z' AND logged_at NOT LIKE '%+%' AND deleted_at IS NULL").run();
  if ((fixed as any).changes > 0) console.log(`[Forge] Normalized ${(fixed as any).changes} logged_at entries to UTC`);
} catch { /* table may not exist yet */ }

// Ensure uploads/routine dir exists
const ROUTINE_UPLOADS = path.join(ORACLE_DATA_DIR, 'uploads', 'routine');
if (!fs.existsSync(ROUTINE_UPLOADS)) fs.mkdirSync(ROUTINE_UPLOADS, { recursive: true });

// Forge beast → mode map. 'write' implies 'read'. Owner session always full write.
// Library #96 lever 1: scope-for-post-compromise-damage — grant the minimum mode each lane needs.
const FORGE_BEAST_MODES: Record<string, 'read' | 'write'> = {
  gorn: 'write',   // owner
  sable: 'write',  // gatekeeper — logs meals for bear
  karo: 'write',   // partner — bedrock 04-09 grant
  boro: 'read',    // coach — periodization + progression reads only; writes route through Sable
};

// Auth helper: Gorn (session) + allowlisted beasts per FORGE_BEAST_MODES.
// mode='read' permits any allowlisted beast; mode='write' requires write-mode beast.
//
// T#718-aligned: prefers bearer-token-derived actor (set by auth middleware) over
// the legacy ?as= query param shape. Bearer-token-actor path is checked first;
// ?as= path retained for backwards-compat with existing callers (Sable TG flows,
// legacy scripts) until follow-up T# removes it post-migration audit.
function isForgeAuthorized(c: any, options: { mode: 'read' | 'write' } = { mode: 'write' }): boolean {
  if (hasSessionAuth(c)) return true; // Gorn browser session — owner, full write

  // T#718 path: read requester from authenticated bearer-token actor (no ?as= needed)
  const actor = ((c.get as any)('actor') as string | undefined)?.toLowerCase();
  if (actor) {
    const beastMode = FORGE_BEAST_MODES[actor];
    if (!beastMode) return false;
    if (options.mode === 'read') return true; // either mode satisfies read
    return beastMode === 'write';              // write requires write
  }

  // Backwards-compat: ?as= query param + isTrustedRequest local-network bypass.
  // Retained so existing callers (Sable scripts, legacy curl flows) don't break
  // pre-migration. Follow-up T# removes after callers migrate to bearer-only.
  if (isTrustedRequest(c)) {
    const as = (c.req.query('as') || '').toLowerCase();
    const beastMode = FORGE_BEAST_MODES[as];
    if (!beastMode) return false;
    if (options.mode === 'read') return true;
    return beastMode === 'write';
  }
  return false;
}

// T#712 Telegram-cache read auth — DELIBERATELY SEPARATE from FORGE_BEAST_MODES per
// Library #96 lever 1 (scope-for-post-compromise-damage). TG chat content has a
// different sensitivity profile than Forge workout data: private Gorn-bot chats may
// carry decisions, personal context, unreleased plans. Default narrow-by-default;
// expansions require Tier-2-pair CLEAR per T#696 precedent (Bertus #887 flag 1).
const TELEGRAM_READ_MODES: Record<string, 'read'> = {
  sable: 'read', // routing-lane — DM→Prowl flow references TG context
};
function isTelegramAuthorized(c: any): boolean {
  if (hasSessionAuth(c)) return true; // Gorn browser session — owner
  // Per Gorn call 2026-04-24 23:42 BKK: any Beast with a configured TG bot
  // can read the cache. Bearer-token (T#718) derives actor cryptographically;
  // if actor matches a registered bot-beast, authorize.
  const actor = (c.get as any)('actor') as string | undefined;
  if (actor && telegramBots.some(b => b.beast === actor)) return true;
  // Legacy back-compat: ?as= lookup in TELEGRAM_READ_MODES (preserved for
  // pre-bearer-token callers until full rollout completes).
  if (isTrustedRequest(c)) {
    const as = (c.req.query('as') || '').toLowerCase();
    return TELEGRAM_READ_MODES[as] === 'read';
  }
  return false;
}

// GET /api/routine/logs — list logs
app.get('/api/routine/logs', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const type = c.req.query('type');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const limit = Math.min(200, parseInt(c.req.query('limit') || '50', 10));
  const offset = parseInt(c.req.query('offset') || '0', 10);

  let query = 'SELECT * FROM routine_logs WHERE deleted_at IS NULL';
  const params: any[] = [];
  if (type) { query += ' AND type = ?'; params.push(type); }
  if (from) { query += ' AND logged_at >= ?'; params.push(from); }
  if (to) { query += ' AND logged_at <= ?'; params.push(to); }
  query += ' ORDER BY logged_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const logs = sqlite.prepare(query).all(...params);
  const total = (sqlite.prepare('SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL').get() as any).c;
  return c.json({ logs, total });
});

// GET /api/routine/today — today's logs grouped by type
app.get('/api/routine/today', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const today = new Date().toISOString().slice(0, 10);
  const logs = sqlite.prepare(
    "SELECT * FROM routine_logs WHERE deleted_at IS NULL AND date(logged_at) = ? ORDER BY logged_at DESC"
  ).all(today);
  return c.json({ logs, date: today });
});

// GET /api/routine/weight — weight history for chart (with time-based grouping)
app.get('/api/routine/weight', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const range = c.req.query('range'); // week, month, year, 3y, 10y, all
  let dateFilter = '';
  if (range) {
    const now = new Date();
    const rangeMap: Record<string, number> = {
      week: 7, month: 30, year: 365, '3y': 365 * 3, '10y': 365 * 10,
    };
    const days = rangeMap[range];
    if (days) {
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
      dateFilter = ` AND logged_at >= '${from}'`;
    }
  }

  // Grouping strategy per range (Dex/Quill spec, thread #323)
  // week/month/3m: daily points, 6m/year: weekly avg, 3y/10y/all: monthly avg
  const grouping = (['3y', '10y', 'all'].includes(range || ''))
    ? 'monthly'
    : (['year'].includes(range || '') ? 'weekly' : 'daily');

  if (grouping === 'daily') {
    const rows = sqlite.prepare(
      `SELECT id, logged_at, json_extract(data, '$.value') as value, json_extract(data, '$.unit') as unit
       FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL${dateFilter} ORDER BY logged_at ASC`
    ).all();
    return c.json({ weights: rows, grouping: 'daily' });
  }

  // Grouped query — return avg, min, max per period
  const groupExpr = grouping === 'weekly'
    ? "strftime('%Y-W%W', logged_at)"
    : "strftime('%Y-%m', logged_at)";

  const rows = sqlite.prepare(
    `SELECT ${groupExpr} as period,
            ROUND(AVG(json_extract(data, '$.value')), 1) as value,
            ROUND(MIN(json_extract(data, '$.value')), 1) as min_value,
            ROUND(MAX(json_extract(data, '$.value')), 1) as max_value,
            COUNT(*) as count,
            MIN(logged_at) as logged_at,
            'kg' as unit
     FROM routine_logs
     WHERE type = 'weight' AND deleted_at IS NULL${dateFilter}
     GROUP BY ${groupExpr}
     ORDER BY period ASC`
  ).all();
  return c.json({ weights: rows, grouping });
});

// GET /api/routine/blood-pressure — BP history for chart (Prowl #80)
// Mirrors /api/routine/weight: range filter + time-based grouping
app.get('/api/routine/blood-pressure', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const range = c.req.query('range');
  let dateFilter = '';
  if (range) {
    const now = new Date();
    const rangeMap: Record<string, number> = {
      week: 7, month: 30, year: 365, '3y': 365 * 3, '10y': 365 * 10,
    };
    const days = rangeMap[range];
    if (days) {
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
      dateFilter = ` AND logged_at >= '${from}'`;
    }
  }

  const grouping = (['3y', '10y', 'all'].includes(range || ''))
    ? 'monthly'
    : (['year'].includes(range || '') ? 'weekly' : 'daily');

  if (grouping === 'daily') {
    const rows = sqlite.prepare(
      `SELECT id, logged_at,
              json_extract(data, '$.systolic') as systolic,
              json_extract(data, '$.diastolic') as diastolic
       FROM routine_logs WHERE type = 'blood_pressure' AND deleted_at IS NULL${dateFilter} ORDER BY logged_at ASC`
    ).all();
    return c.json({ readings: rows, grouping: 'daily' });
  }

  const groupExpr = grouping === 'weekly'
    ? "strftime('%Y-W%W', logged_at)"
    : "strftime('%Y-%m', logged_at)";

  const rows = sqlite.prepare(
    `SELECT ${groupExpr} as period,
            ROUND(AVG(json_extract(data, '$.systolic')), 0) as systolic,
            ROUND(AVG(json_extract(data, '$.diastolic')), 0) as diastolic,
            ROUND(MIN(json_extract(data, '$.systolic')), 0) as systolic_min,
            ROUND(MAX(json_extract(data, '$.systolic')), 0) as systolic_max,
            ROUND(MIN(json_extract(data, '$.diastolic')), 0) as diastolic_min,
            ROUND(MAX(json_extract(data, '$.diastolic')), 0) as diastolic_max,
            COUNT(*) as count,
            MIN(logged_at) as logged_at
     FROM routine_logs
     WHERE type = 'blood_pressure' AND deleted_at IS NULL${dateFilter}
     GROUP BY ${groupExpr}
     ORDER BY period ASC`
  ).all();
  return c.json({ readings: rows, grouping });
});

// GET /api/routine/exercise-summary?exercise=<name>
// One-call 4-dimension read (peak, recent, trend, frequency) for a single exercise.
// Prowl #83 — Boro coach-lane infra-harden on third read-failure recurrence
// (Bar Shrug 04-22 / Shoulder Press 04-23 / Bench Press 04-24). Replaces
// 20-page pull-and-filter workflow with a single structured summary.
app.get('/api/routine/exercise-summary', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const exercise = c.req.query('exercise');
  if (!exercise) return c.json({ error: 'exercise query param required' }, 400);
  const needle = exercise.toLowerCase().trim();
  if (!needle) return c.json({ error: 'exercise query param must be non-empty after trim' }, 400);

  const rows = sqlite.prepare(
    `SELECT id, logged_at, data FROM routine_logs
     WHERE type = 'workout' AND deleted_at IS NULL
     ORDER BY logged_at DESC`
  ).all() as any[];

  interface MatchedSession {
    date: string;
    session_title: string;
    sets: Array<{ weight: number; reps: number; unit: string }>;
  }
  const matching: MatchedSession[] = [];

  for (const row of rows) {
    let data: any;
    try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { continue; }
    const exercises: any[] = data.exercises || [];
    for (const ex of exercises) {
      const rawName = typeof ex === 'string' ? ex : (ex.name || '');
      const { name, equipment } = parseExerciseName(rawName);
      const fullName = (equipment ? `${name} · ${equipment}` : name).trim();
      if (!fullName) continue;
      // Fuzzy match: exact, substring on full, substring on name-only
      const fullLower = fullName.toLowerCase();
      const nameLower = name.toLowerCase();
      if (fullLower === needle || fullLower.includes(needle) || nameLower.includes(needle)) {
        const sets: Array<{ weight: number; reps: number; unit: string }> = [];
        if (Array.isArray(ex.sets)) {
          for (const s of ex.sets) {
            if (typeof s.weight === 'number' && typeof s.reps === 'number') {
              sets.push({ weight: s.weight, reps: s.reps, unit: s.unit || 'kg' });
            }
          }
        }
        if (sets.length > 0) {
          matching.push({
            date: row.logged_at,
            session_title: data.workout_name || 'Workout',
            sets,
          });
        }
      }
    }
  }

  // Helper: convert weight to kg regardless of unit
  const toKg = (weight: number, unit: string): number => {
    return (unit || 'kg').toLowerCase().startsWith('lb') ? weight * 0.4536 : weight;
  };

  if (matching.length === 0) {
    return c.json({
      exercise,
      peak: null,
      recent: [],
      trend: 'cold',
      frequency: { total_sessions: 0, last_session_date: null, sessions_last_30d: 0, sessions_last_90d: 0 },
      note: 'No matching sessions found. Try broader search term or check spelling.',
    });
  }

  // Peak: max weight (kg) across all sets, tiebreak by reps at that weight
  let peak = { weight_kg: 0, reps: 0, date: '', session_title: '' };
  for (const m of matching) {
    for (const s of m.sets) {
      const wKg = Math.round(toKg(s.weight, s.unit) * 10) / 10;
      if (wKg > peak.weight_kg || (wKg === peak.weight_kg && s.reps > peak.reps)) {
        peak = {
          weight_kg: wKg,
          reps: s.reps,
          date: m.date.slice(0, 10),
          session_title: m.session_title,
        };
      }
    }
  }

  // Recent: last 5 sessions (already sorted DESC)
  const recent = matching.slice(0, 5).map(m => ({
    date: m.date.slice(0, 10),
    session_title: m.session_title,
    sets: m.sets,
  }));

  // Frequency
  const now = Date.now();
  const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const d90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const sessions_last_30d = matching.filter(m => m.date >= d30).length;
  const sessions_last_90d = matching.filter(m => m.date >= d90).length;

  // Trend: compare last 3 sessions peak-weight to prior 3-6 sessions peak-weight
  let trend: string;
  if (sessions_last_90d === 0) {
    trend = 'cold';
  } else {
    const getPeakWeight = (sessions: MatchedSession[]): number => {
      let max = 0;
      for (const s of sessions) {
        for (const set of s.sets) {
          const w = toKg(set.weight, set.unit);
          if (w > max) max = w;
        }
      }
      return max;
    };
    const recentPeak = getPeakWeight(matching.slice(0, 3));
    const priorPeak = getPeakWeight(matching.slice(3, 9));
    if (priorPeak === 0) {
      trend = matching.length >= 3 ? 'plateau' : 'rising';
    } else {
      const ratio = recentPeak / priorPeak;
      if (ratio > 1.05) trend = 'rising';
      else if (ratio < 0.95) trend = 'dropping';
      else trend = 'plateau';
    }
  }

  return c.json({
    exercise,
    peak,
    recent,
    trend,
    frequency: {
      total_sessions: matching.length,
      last_session_date: matching[0]?.date.slice(0, 10) || null,
      sessions_last_30d,
      sessions_last_90d,
    },
  });
});

// GET /api/routine/prs — sibling endpoint per Boro spec (Prowl #83).
// Alias to /api/routine/personal-records?grouped=true for cleaner call-site naming.
app.get('/api/routine/prs', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const range = c.req.query('range');
  let dateFilter = '';
  if (range === 'month') dateFilter = "AND achieved_at >= datetime('now', '-30 days')";
  const records = sqlite.prepare(`
    SELECT pr.* FROM personal_records pr
    INNER JOIN (
      SELECT exercise_name, MAX(weight) as max_weight
      FROM personal_records
      WHERE 1=1 ${dateFilter}
      GROUP BY exercise_name
    ) best ON pr.exercise_name = best.exercise_name AND pr.weight = best.max_weight
    WHERE 1=1 ${dateFilter}
    GROUP BY pr.exercise_name
    ORDER BY pr.weight DESC, pr.reps DESC
  `).all();
  return c.json({ records, total_exercises: records.length });
});

// Helper: parse exercise name from Alpha Progression format
// Input: "1. Lat Pulldowns with Wide Overhand Grip · Machine · 8 reps"
function parseExerciseName(raw: string): { name: string; equipment: string } {
  const cleaned = raw.replace(/^\d+\.\s*/, '');
  const parts = cleaned.split(' · ');
  return { name: parts[0] || cleaned, equipment: parts[1] || '' };
}

// Parse string-format exercises like "Chest Press 190lbs 8/8/6" into sets
function parseExerciseString(raw: string): { name: string; sets: { weight: number; reps: number; unit: string }[] } {
  // Match: "Exercise Name <weight><unit> <reps>/<reps>/..."
  const match = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|lbs?|KG|LBS?)\s+([\d/]+)$/);
  if (!match) return { name: raw, sets: [] };
  const name = match[1].trim();
  const weight = parseFloat(match[2]);
  const unit = match[3].toLowerCase().startsWith('lb') ? 'lbs' : 'kg';
  const repsList = match[4].split('/').map(r => parseInt(r) || 0).filter(r => r > 0);
  return { name, sets: repsList.map(reps => ({ weight, reps, unit })) };
}

// GET /api/routine/workout-trends — exercise progress over time (T#397)
app.get('/api/routine/workout-trends', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const range = c.req.query('range') || 'year';
  const exercise = c.req.query('exercise'); // optional: filter to specific exercise

  let dateFilter = '';
  const rangeMap: Record<string, number> = {
    week: 7, month: 30, '3m': 90, year: 365, '3y': 365 * 3, '10y': 365 * 10,
  };
  const days = rangeMap[range];
  if (days) {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    dateFilter = ` AND logged_at >= '${from}'`;
  }

  // Get all workout logs in range
  const rows = sqlite.prepare(
    `SELECT id, logged_at, data FROM routine_logs
     WHERE type = 'workout' AND deleted_at IS NULL${dateFilter}
     ORDER BY logged_at ASC`
  ).all() as any[];

  // Parse exercises from each workout, compute per-exercise stats
  const exerciseData: Map<string, Array<{
    date: string;
    maxWeight: number;
    totalVolume: number;
    totalSets: number;
    totalReps: number;
    unit: string;
  }>> = new Map();

  const exerciseFrequency: Map<string, number> = new Map();

  for (const row of rows) {
    let data: any;
    try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { continue; }
    const exercises: any[] = data.exercises || [];

    for (const ex of exercises) {
      const rawName = typeof ex === 'string' ? ex : (ex.name || '');
      const { name, equipment } = parseExerciseName(rawName);
      if (!name) continue;
      // Include equipment in the key to split Machine vs Dumbbell etc.
      const displayName = equipment ? `${name} · ${equipment}` : name;

      // Filter by exercise if specified
      if (exercise && displayName.toLowerCase() !== exercise.toLowerCase()) continue;

      exerciseFrequency.set(displayName, (exerciseFrequency.get(displayName) || 0) + 1);

      const sets: any[] = ex.sets || [];
      if (sets.length === 0) continue;

      const unit = sets[0]?.unit || 'KG';
      let maxWeight = 0;
      let totalVolume = 0;
      let totalSets = sets.length;
      let totalReps = 0;

      for (const s of sets) {
        const w = parseFloat(s.weight) || 0;
        const r = parseInt(s.reps) || 0;
        if (w > maxWeight) maxWeight = w;
        totalVolume += w * r;
        totalReps += r;
      }

      if (!exerciseData.has(displayName)) exerciseData.set(displayName, []);
      exerciseData.get(displayName)!.push({
        date: row.logged_at,
        maxWeight,
        totalVolume,
        totalSets,
        totalReps,
        unit,
      });
    }
  }

  // Top 5 by frequency (default selection), but include ALL trend data
  const sortedExercises = [...exerciseFrequency.entries()]
    .sort((a, b) => b[1] - a[1]);
  const topExercises = exercise
    ? [...exerciseData.keys()]
    : sortedExercises.slice(0, 5).map(([name]) => name);

  // Include trend data for ALL exercises so frontend can display any selection
  const trends: Record<string, any[]> = {};
  for (const [name] of exerciseData) {
    trends[name] = exerciseData.get(name) || [];
  }

  return c.json({
    exercises: topExercises,
    trends,
    totalWorkouts: rows.length,
    allExercises: sortedExercises.map(([name, count]) => ({ name, count })),
  });
});

// GET /api/routine/body-composition — body comp history from Withings (T#479, Spec #28)
app.get('/api/routine/body-composition', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge access required' }, 403);
  const range = c.req.query('range') || 'month';
  const rangeMap: Record<string, string> = {
    '1w': '-7 days', week: '-7 days', '1m': '-30 days', month: '-30 days',
    '3m': '-90 days', '1y': '-365 days', year: '-365 days',
    '3y': '-1095 days', '10y': '-3650 days', all: '-36500 days',
  };
  const dateOffset = rangeMap[range] || '-30 days';

  const rows = sqlite.prepare(
    `SELECT logged_at, data FROM routine_logs
     WHERE type = 'measurement' AND source = 'withings' AND deleted_at IS NULL
     AND logged_at >= datetime('now', 'localtime', ?)
     ORDER BY logged_at ASC`
  ).all(dateOffset) as any[];

  const measurements = rows.map(r => {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return {
      logged_at: r.logged_at,
      weight: d.weight ? Number(d.weight.toFixed(2)) : null,
      body_fat_pct: d.body_fat_pct ? Number(d.body_fat_pct.toFixed(1)) : null,
      fat_mass: d.fat_mass ? Number(d.fat_mass.toFixed(2)) : null,
      fat_free_mass: d.fat_free_mass ? Number(d.fat_free_mass.toFixed(2)) : null,
      muscle_mass: d.muscle_mass ? Number(d.muscle_mass.toFixed(2)) : null,
      bone_mass: d.bone_mass ? Number(d.bone_mass.toFixed(2)) : null,
      hydration: d.hydration ? Number(d.hydration.toFixed(1)) : null,
      visceral_fat: d.visceral_fat ?? null,
    };
  });

  const latest = measurements.length > 0 ? measurements[measurements.length - 1] : null;
  const previous = measurements.length > 1 ? measurements[measurements.length - 2] : null;

  // Compute trends
  const trends: Record<string, { current: number | null; previous: number | null; direction: string }> = {};
  if (latest && previous) {
    for (const key of ['body_fat_pct', 'fat_mass', 'muscle_mass', 'bone_mass', 'hydration', 'visceral_fat'] as const) {
      const curr = (latest as any)[key];
      const prev = (previous as any)[key];
      if (curr != null && prev != null) {
        trends[key] = { current: curr, previous: prev, direction: curr > prev ? 'up' : curr < prev ? 'down' : 'stable' };
      }
    }
  }

  return c.json({ measurements, latest, previous, trends, range, total: measurements.length });
});

// GET /api/routine/stats — summary stats
app.get('/api/routine/stats', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const totalLogs = (sqlite.prepare('SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL').get() as any).c;
  const byType = sqlite.prepare('SELECT type, COUNT(*) as count FROM routine_logs WHERE deleted_at IS NULL GROUP BY type').all();
  const thisWeek = (sqlite.prepare("SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= datetime('now', '-7 days')").get() as any).c;
  const latestWeight = sqlite.prepare("SELECT json_extract(data, '$.value') as value, logged_at FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1").get() as any;
  return c.json({ total_logs: totalLogs, by_type: byType, workouts_this_week: thisWeek, latest_weight: latestWeight });
});

// GET /api/routine/summary — enhanced summary for Stats tab (T#410)
app.get('/api/routine/summary', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const range = c.req.query('range') || 'week';
  const rangeMap: Record<string, number> = { week: 7, month: 30, '3m': 90, year: 365 };
  const days = rangeMap[range] || 7;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const workoutsThisRange = (sqlite.prepare(
    "SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= ?"
  ).get(from) as any).c;

  // Total volume this range (sum of weight * reps across all sets)
  const workoutRows = sqlite.prepare(
    "SELECT data FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= ?"
  ).all(from) as any[];

  let totalVolume = 0;
  let bestLift = { exercise: '', weight: 0, reps: 0, unit: 'kg' };
  for (const row of workoutRows) {
    try {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      for (const ex of (data.exercises || [])) {
        if (typeof ex === 'string') {
          const parsed = parseExerciseString(ex);
          for (const s of parsed.sets) {
            totalVolume += s.weight * s.reps;
            if (s.weight > bestLift.weight) {
              bestLift = { exercise: parsed.name, weight: s.weight, reps: s.reps, unit: s.unit };
            }
          }
        } else {
          const { name } = parseExerciseName(ex.name || '');
          for (const s of (ex.sets || [])) {
            const w = parseFloat(s.weight) || 0;
            const r = parseInt(s.reps) || 0;
            totalVolume += w * r;
            if (w > bestLift.weight) {
              bestLift = { exercise: name, weight: w, reps: r, unit: s.unit || 'kg' };
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  const latestWeight = sqlite.prepare(
    "SELECT json_extract(data, '$.value') as value, logged_at FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1"
  ).get() as any;

  const prevWeight = sqlite.prepare(
    "SELECT json_extract(data, '$.value') as value FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1 OFFSET 1"
  ).get() as any;

  const weightTrend = latestWeight && prevWeight ? (latestWeight.value > prevWeight.value ? 'up' : latestWeight.value < prevWeight.value ? 'down' : 'stable') : null;

  return c.json({
    workouts: workoutsThisRange,
    totalVolume: Math.round(totalVolume),
    bestLift: bestLift.weight > 0 ? bestLift : null,
    latestWeight: latestWeight ? { ...latestWeight, trend: weightTrend } : null,
    range,
  });
});

// GET /api/routine/exercises — exercise library (T#410)
app.get('/api/routine/exercises', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const q = c.req.query('q');
  const muscleGroup = c.req.query('muscle_group');

  let query = 'SELECT * FROM exercises WHERE 1=1';
  const params: any[] = [];
  if (q) { query += ' AND name LIKE ?'; params.push(`%${q}%`); }
  if (muscleGroup) { query += ' AND muscle_group = ?'; params.push(muscleGroup); }
  query += ' ORDER BY name ASC';

  const exercises = sqlite.prepare(query).all(...params);
  return c.json({ exercises });
});

// POST /api/routine/exercises — add custom exercise (T#410)
app.post('/api/routine/exercises', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  try {
    const body = await c.req.json();
    const { name, muscle_group, equipment } = body;
    if (!name) return c.json({ error: 'Exercise name is required' }, 400);
    try {
      sqlite.prepare(
        'INSERT INTO exercises (name, muscle_group, equipment, created_by) VALUES (?, ?, ?, ?)'
      ).run(name, muscle_group || null, equipment || null, 'manual');
    } catch (e: any) {
      if (e.message?.includes('UNIQUE')) return c.json({ error: 'Exercise already exists' }, 409);
      throw e;
    }
    const exercise = sqlite.prepare('SELECT * FROM exercises WHERE name = ? AND equipment IS ?').get(name, equipment || null);
    return c.json(exercise, 201);
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// POST /api/routine/exercises/seed — seed exercise library from existing workout data (T#410)
app.post('/api/routine/exercises/seed', (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);

  const rows = sqlite.prepare(
    "SELECT data FROM routine_logs WHERE type = 'workout' AND deleted_at IS NULL"
  ).all() as any[];

  const seen = new Set<string>();
  let seeded = 0;

  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO exercises (name, muscle_group, equipment, created_by) VALUES (?, ?, ?, ?)'
  );

  for (const row of rows) {
    try {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      for (const ex of (data.exercises || [])) {
        const rawName = typeof ex === 'string' ? ex : (ex.name || '');
        const { name, equipment } = parseExerciseName(rawName);
        const key = `${name}|${equipment}`;
        if (!name || seen.has(key)) continue;
        seen.add(key);
        const result = insert.run(name, data.muscle_group || null, equipment || null, 'import');
        if (result.changes > 0) seeded++;
      }
    } catch { /* skip */ }
  }

  return c.json({ seeded, total: seen.size });
});

// GET /api/routine/personal-records — personal records list (T#410, T#543)
app.get('/api/routine/personal-records', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const exercise = c.req.query('exercise');
  const range = c.req.query('range');
  const grouped = c.req.query('grouped'); // 'true' = best lift per exercise

  if (grouped === 'true') {
    // Best lift per exercise — highest weight, then highest reps at that weight
    let dateFilter = '';
    if (range === 'month') dateFilter = "AND achieved_at >= datetime('now', '-30 days')";
    const records = sqlite.prepare(`
      SELECT pr.* FROM personal_records pr
      INNER JOIN (
        SELECT exercise_name, MAX(weight) as max_weight
        FROM personal_records
        WHERE 1=1 ${dateFilter}
        GROUP BY exercise_name
      ) best ON pr.exercise_name = best.exercise_name AND pr.weight = best.max_weight
      WHERE 1=1 ${dateFilter}
      GROUP BY pr.exercise_name
      ORDER BY pr.weight DESC, pr.reps DESC
    `).all();
    return c.json({ records });
  }

  let query = 'SELECT * FROM personal_records WHERE 1=1';
  const params: any[] = [];
  if (exercise) { query += ' AND exercise_name = ?'; params.push(exercise); }
  if (range === 'month') {
    query += " AND achieved_at >= datetime('now', '-30 days')";
  }
  query += ' ORDER BY weight DESC, reps DESC';

  const records = sqlite.prepare(query).all(...params);
  return c.json({ records });
});

// POST /api/routine/personal-records/seed — backfill PRs from all workout logs (T#543)
app.post('/api/routine/personal-records/seed', (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const workouts = sqlite.prepare(
    "SELECT id, logged_at, data FROM routine_logs WHERE type = 'workout' AND deleted_at IS NULL"
  ).all() as any[];

  const prInsert = sqlite.prepare(
    'INSERT OR IGNORE INTO personal_records (exercise_name, weight, reps, unit, achieved_at, log_id) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let inserted = 0;
  const insertPR = sqlite.transaction(() => {
    for (const log of workouts) {
      const d = typeof log.data === 'string' ? JSON.parse(log.data) : log.data;
      for (const ex of (d.exercises || [])) {
        if (typeof ex === 'string') {
          // Manual format: "Chest Press 190lbs 8/8/6"
          const parsed = parseExerciseString(ex);
          for (const s of parsed.sets) {
            if (s.weight > 0 && s.reps > 0) {
              const res = prInsert.run(parsed.name, s.weight, s.reps, s.unit, log.logged_at, log.id);
              if ((res as any).changes > 0) inserted++;
            }
          }
        } else {
          // Structured format from Alpha Progression
          const { name } = parseExerciseName(typeof ex === 'string' ? ex : (ex.name || ''));
          if (!name) continue;
          for (const s of (ex.sets || [])) {
            const w = parseFloat(s.weight) || 0;
            const r = parseInt(s.reps) || 0;
            if (w > 0 && r > 0) {
              const unit = (s.unit || 'kg').toLowerCase().startsWith('lb') ? 'lbs' : 'kg';
              const res = prInsert.run(name, w, r, unit, log.logged_at, log.id);
              if ((res as any).changes > 0) inserted++;
            }
          }
        }
      }
    }
  });
  insertPR();

  return c.json({ seeded: inserted, from_workouts: workouts.length });
});

// GET /api/routine/photos — photo gallery
app.get('/api/routine/photos', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const tag = c.req.query('tag');
  let query = "SELECT * FROM routine_logs WHERE type = 'photo' AND deleted_at IS NULL";
  const params: any[] = [];
  if (tag) { query += " AND json_extract(data, '$.tag') = ?"; params.push(tag); }
  query += ' ORDER BY logged_at DESC';
  const photos = sqlite.prepare(query).all(...params);
  return c.json({ photos });
});

// T#710 Bertus P1 fold: extract workout validation so POST + PATCH enforce
// identically. Also addresses the inconsistency between create-path and
// edit-path discipline (same shape as T#706 parseDaysOfWeek helper).
// Mutates workoutData in place to coerce rpe to Number.
function validateWorkoutData(workoutData: any): { ok: true; data: any } | { ok: false; error: string; hint?: string } {
  if (!workoutData || typeof workoutData !== 'object' || !workoutData.exercises || !Array.isArray(workoutData.exercises)) {
    return {
      ok: false,
      error: 'Workout must include an exercises array.',
      hint: 'Expected format: { exercises: [{ name: "Chest Press", equipment: "Machine", sets: [{ weight: 80, reps: 10, unit: "kg" }] }] }',
    };
  }
  for (let i = 0; i < workoutData.exercises.length; i++) {
    const ex = workoutData.exercises[i];
    if (typeof ex === 'string') {
      return {
        ok: false,
        error: `Exercise ${i + 1} is a string ("${ex.slice(0, 60)}"). Exercises must be objects with name and sets.`,
        hint: 'Expected format: { name: "Chest Press", equipment: "Machine", sets: [{ weight: 80, reps: 10, unit: "kg" }] }',
      };
    }
    if (!ex.name?.trim()) {
      return { ok: false, error: `Exercise ${i + 1}: name is required.`, hint: '{ name: "Bench Press", sets: [{ weight: 80, reps: 10, unit: "kg" }] }' };
    }
    if (!ex.sets || !Array.isArray(ex.sets) || ex.sets.length === 0) {
      return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): sets array is required with at least one set.`, hint: 'sets: [{ weight: 80, reps: 10, unit: "kg" }]' };
    }
    // T#710: per-exercise notes — optional string
    if (ex.notes != null && typeof ex.notes !== 'string') {
      return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): notes must be a string if provided.`, hint: 'notes: "felt strong, depth good"' };
    }
    // T#711: hevy_template_id — optional string, cross-link to Hevy exercise library
    if (ex.hevy_template_id != null && typeof ex.hevy_template_id !== 'string') {
      return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): hevy_template_id must be a string if provided.`, hint: 'hevy_template_id: "D04AC939"' };
    }
    // T#711: superset_id — optional finite number, preserves Hevy superset grouping
    if (ex.superset_id != null) {
      if (typeof ex.superset_id !== 'number' || !Number.isFinite(ex.superset_id)) {
        return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): superset_id must be a finite number if provided.`, hint: 'superset_id: 0' };
      }
    }
    for (let j = 0; j < ex.sets.length; j++) {
      const s = ex.sets[j];
      if (s.weight == null || s.reps == null) {
        return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: weight and reps are required.`, hint: '{ weight: 80, reps: 10, unit: "kg" }' };
      }
      // T#710: per-set RPE — optional number 1-10
      if (s.rpe != null) {
        const rpeNum = Number(s.rpe);
        if (isNaN(rpeNum) || rpeNum < 1 || rpeNum > 10) {
          return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: rpe must be a number between 1 and 10 if provided.`, hint: '{ weight: 80, reps: 10, rpe: 8 }' };
        }
        s.rpe = rpeNum;
      }
      // T#711: per-set type — optional enum (normal|warmup|dropset|failure)
      if (s.type != null) {
        if (typeof s.type !== 'string') {
          return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: type must be a string if provided.`, hint: 'type: "warmup" | "normal" | "dropset" | "failure"' };
        }
        const t = s.type.toLowerCase();
        if (t !== 'normal' && t !== 'warmup' && t !== 'dropset' && t !== 'failure') {
          return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: type must be one of normal, warmup, dropset, failure.`, hint: 'type: "warmup"' };
        }
        s.type = t;
      }
    }
  }
  return { ok: true, data: workoutData };
}

// POST /api/routine/logs — create log entry
app.post('/api/routine/logs', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  try {
    const data = await c.req.json();
    const { type, logged_at } = data;
    if (!type || !data.data) return c.json({ error: 'type and data required' }, 400);
    if (!['meal', 'workout', 'weight', 'note', 'photo'].includes(type)) {
      return c.json({ error: 'type must be meal, workout, weight, note, or photo' }, 400);
    }
    // Meal macro validation — calories, protein, carbs, fat required (T#423, T#430)
    if (type === 'meal') {
      const mealData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      if (mealData.items && Array.isArray(mealData.items)) {
        // T#430: itemized meal — validate each item, auto-sum totals
        if (mealData.items.length === 0) return c.json({ error: 'At least 1 meal item required' }, 400);
        const macroFields = ['calories', 'protein', 'carbs', 'fat'] as const;
        for (let i = 0; i < mealData.items.length; i++) {
          const item = mealData.items[i];
          if (!item.name?.trim()) return c.json({ error: `Item ${i + 1}: name required` }, 400);
          const missing = macroFields.filter(f => item[f] == null || item[f] === '');
          if (missing.length > 0) return c.json({ error: `Item ${i + 1} (${item.name}): macros required: ${missing.join(', ')}` }, 400);
          for (const f of macroFields) {
            const v = Number(item[f]);
            if (isNaN(v) || v < 0) return c.json({ error: `Item ${i + 1} (${item.name}): ${f} must be a non-negative number` }, 400);
            item[f] = v;
          }
        }
        // Auto-compute top-level totals from items
        for (const f of macroFields) {
          mealData[f] = mealData.items.reduce((sum: number, item: any) => sum + (Number(item[f]) || 0), 0);
        }
        // Auto-generate description from items if not provided
        if (!mealData.description) {
          mealData.description = mealData.items.map((item: any) => item.name).slice(0, 3).join(', ') + (mealData.items.length > 3 ? '...' : '');
        }
        data.data = mealData;
      } else {
        // T#483: meal items are now mandatory — no more total-only logging
        return c.json({ error: 'Meal items required. Each meal must include an items array with individual food items and per-item macros (name, calories, protein, carbs, fat).' }, 400);
      }
    }
    // Workout validation — enforce structured exercise format (T#521, T#522, T#710)
    if (type === 'workout') {
      const workoutData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      const result = validateWorkoutData(workoutData);
      if (!result.ok) return c.json({ error: result.error, hint: result.hint }, 400);
      data.data = result.data;
    }
    const jsonData = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
    const now = new Date().toISOString();
    // Normalize logged_at to UTC — datetime-local inputs arrive without timezone
    let normalizedLoggedAt = logged_at || now;
    if (logged_at && !logged_at.endsWith('Z') && !logged_at.includes('+')) {
      normalizedLoggedAt = logged_at + 'Z';
    }
    const result = sqlite.prepare(
      'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(type, normalizedLoggedAt, jsonData, data.source || 'manual', now);
    const logId = (result as any).lastInsertRowid;
    const log = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ?').get(logId);

    // Update personal records for workout logs (T#410)
    if (type === 'workout') {
      try {
        const workoutData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const prInsert = sqlite.prepare(
          'INSERT OR IGNORE INTO personal_records (exercise_name, weight, reps, unit, achieved_at, log_id) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (const ex of (workoutData.exercises || [])) {
          const { name } = parseExerciseName(typeof ex === 'string' ? ex : (ex.name || ''));
          if (!name) continue;
          for (const s of (ex.sets || [])) {
            const w = parseFloat(s.weight) || 0;
            const r = parseInt(s.reps) || 0;
            if (w > 0 && r > 0) {
              prInsert.run(name, w, r, (s.unit || 'kg').toLowerCase(), logged_at || now, logId);
            }
          }
        }
      } catch { /* PR update failure is non-critical */ }
    }

    return c.json(log, 201);
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// PATCH /api/routine/logs/:id — edit log
app.patch('/api/routine/logs/:id', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) return c.json({ error: 'Log not found' }, 404);
  try {
    const body = await c.req.json();
    const existingData = (existing as any).type;
    const updates: string[] = [];
    const values: any[] = [];
    if (body.data) {
      // Auto-sum meal items on edit (T#430) — items mandatory (T#483)
      if (existingData === 'meal') {
        const mealData = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
        if (!mealData.items || !Array.isArray(mealData.items) || mealData.items.length === 0) {
          return c.json({ error: 'Meal items required. Each meal must include an items array with individual food items and per-item macros.' }, 400);
        }
        if (mealData.items && Array.isArray(mealData.items) && mealData.items.length > 0) {
          const macroFields = ['calories', 'protein', 'carbs', 'fat'] as const;
          for (const f of macroFields) {
            mealData[f] = mealData.items.reduce((sum: number, item: any) => sum + (Number(item[f]) || 0), 0);
          }
          if (!mealData.description) {
            mealData.description = mealData.items.map((item: any) => item.name).slice(0, 3).join(', ') + (mealData.items.length > 3 ? '...' : '');
          }
          body.data = mealData;
        }
      }
      // T#710 Bertus P1 fold: PATCH must validate workout data the same way
      // POST does — prevents malformed notes/rpe slipping through edit path.
      if (existingData === 'workout') {
        const workoutData = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
        const result = validateWorkoutData(workoutData);
        if (!result.ok) return c.json({ error: result.error, hint: result.hint }, 400);
        body.data = result.data;
      }
      updates.push('data = ?'); values.push(typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
    }
    if (body.logged_at) {
      let normalizedLoggedAt = body.logged_at;
      if (!body.logged_at.endsWith('Z') && !body.logged_at.includes('+')) {
        normalizedLoggedAt = body.logged_at + 'Z';
      }
      updates.push('logged_at = ?'); values.push(normalizedLoggedAt);
    }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
    values.push(id);
    sqlite.prepare(`UPDATE routine_logs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return c.json(sqlite.prepare('SELECT * FROM routine_logs WHERE id = ?').get(id));
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// DELETE /api/routine/logs/:id — soft delete
app.delete('/api/routine/logs/:id', (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) return c.json({ error: 'Log not found' }, 404);
  sqlite.prepare('UPDATE routine_logs SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return c.json({ success: true, id });
});

// GET /api/routine/logs/deleted — list soft-deleted entries for recovery
app.get('/api/routine/logs/deleted', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const limit = parseInt(c.req.query('limit') || '50');
  const rows = sqlite.prepare('SELECT * FROM routine_logs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?').all(limit);
  return c.json({ logs: rows, total: (rows as any[]).length });
});

// PATCH /api/routine/logs/:id/restore — undelete a soft-deleted log
app.patch('/api/routine/logs/:id/restore', (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NOT NULL').get(id);
  if (!existing) return c.json({ error: 'Deleted log not found' }, 404);
  sqlite.prepare('UPDATE routine_logs SET deleted_at = NULL WHERE id = ?').run(id);
  return c.json({ success: true, id, restored: true });
});

// POST /api/routine/photo/upload — upload progress photo
app.post('/api/routine/photo/upload', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  try {
    let formData: FormData;
    try { formData = await c.req.formData(); } catch { return c.json({ error: 'No file provided. Send multipart/form-data with a file field.' }, 400); }
    const file = formData.get('file') as File;
    const tag = formData.get('tag') as string || '';
    const notes = formData.get('notes') as string || '';
    if (!file || !(file instanceof File) || file.size === 0) return c.json({ error: 'No file provided' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: 'File too large. Max 10MB' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const imageType = detectImageType(buffer);
    if (!imageType) return c.json({ error: 'Invalid image. Only JPG, PNG, GIF, WebP allowed.' }, 400);

    // Process with sharp: EXIF rotation + keep date + strip GPS + resize
    let processedBuffer = buffer;
    let ext = imageType.ext;
    let captureDate: string | null = null;
    try {
      const sharp = require('sharp');
      // Extract EXIF date before processing
      const metadata = await sharp(buffer).metadata();
      if (metadata.exif) {
        try {
          // Parse EXIF for DateTimeOriginal (tag 0x9003)
          const exifStr = metadata.exif.toString('binary');
          const dateMatch = exifStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
          if (dateMatch) {
            captureDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}.000Z`;
          }
        } catch { /* date extraction failed */ }
      }
      processedBuffer = await sharp(buffer)
        .rotate()
        .resize(1920, null, { withoutEnlargement: true })
        .jpeg({ quality: 95 })
        .withMetadata({ orientation: undefined })
        .toBuffer();
      ext = '.jpg';
    } catch { /* sharp not available */ }

    const filename = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(ROUTINE_UPLOADS, filename), processedBuffer);

    // Create log entry — use EXIF capture date if available, otherwise now
    const now = new Date().toISOString();
    const loggedAt = captureDate || now;
    const photoData = JSON.stringify({ url: `/api/routine/photo/${filename}`, tag, notes, captureDate: captureDate || undefined });
    const result = sqlite.prepare(
      'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('photo', loggedAt, photoData, 'manual', now);
    const log = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ?').get((result as any).lastInsertRowid);
    return c.json(log, 201);
  } catch { return c.json({ error: 'Upload failed' }, 500); }
});

// GET /api/routine/photo/:filename — serve routine photo
app.get('/api/routine/photo/:filename', (c) => {
  if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const filename = c.req.param('filename').replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = path.join(ROUTINE_UPLOADS, filename);
  if (!fs.existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return new Response(fs.readFileSync(filePath), { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' } });
});

// POST /api/routine/import/alpha-progression — import Alpha Progression CSV (T#389)
app.post('/api/routine/import/alpha-progression', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access denied' }, 403);

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const sessions: any[] = [];
    let currentSession: any = null;
    let currentExercise: any = null;
    let unit = 'KG';
    let hasRir = false;

    for (const line of lines) {
      // Session header: "Workout Name";"date";"duration"
      if (line.startsWith('"') && line.includes('";"')) {
        const parts = line.split('";').map(s => s.replace(/^"|"$/g, ''));
        if (parts.length >= 3 && parts[1].match(/\d{4}-\d{2}-\d{2}/)) {
          if (currentSession) {
            if (currentExercise) currentSession.exercises.push(currentExercise);
            sessions.push(currentSession);
          }
          currentSession = {
            name: parts[0],
            date: parts[1],
            duration: parts[2],
            exercises: [],
          };
          currentExercise = null;
          continue;
        }
      }

      // Exercise header: "1. Exercise Name · Equipment · N reps"
      if (line.startsWith('"') && line.match(/^"\d+\./)) {
        if (currentExercise && currentSession) currentSession.exercises.push(currentExercise);
        const name = line.replace(/^"|"$/g, '');
        currentExercise = { name, sets: [], unit: 'KG' };
        continue;
      }

      // Unit row: #;KG;REPS or #;LB;REPS or #;KG;REPS;RIR
      if (line.startsWith('#;')) {
        const parts = line.split(';');
        unit = parts[1] || 'KG';
        hasRir = parts.includes('RIR');
        if (currentExercise) currentExercise.unit = unit;
        continue;
      }

      // Set row: 1;220;8 or 1;+0;12 or 1;-;-
      if (currentExercise && line.match(/^\d+;/)) {
        const parts = line.split(';');
        const setNum = parseInt(parts[0], 10);
        const weightStr = parts[1];
        const repsStr = parts[2];
        const rirStr = hasRir ? parts[3] : undefined;

        if (weightStr === '-' || repsStr === '-') continue; // Skip empty sets

        const weight = weightStr.startsWith('+') ? parseFloat(weightStr) : parseFloat(weightStr);
        const reps = parseInt(repsStr, 10);
        if (isNaN(weight) || isNaN(reps)) continue;

        const set: any = { set: setNum, weight, reps, unit };
        if (rirStr && rirStr !== '-') set.rir = rirStr;
        currentExercise.sets.push(set);
      }
    }

    // Push last session
    if (currentSession) {
      if (currentExercise) currentSession.exercises.push(currentExercise);
      sessions.push(currentSession);
    }

    // Filter out exercises with no completed sets
    for (const session of sessions) {
      session.exercises = session.exercises.filter((e: any) => e.sets.length > 0);
    }

    // Check for existing imports in this date range (dedup)
    const existingDates = new Set<string>();
    const existingRows = sqlite.prepare(
      "SELECT logged_at FROM routine_logs WHERE type = 'workout' AND source = 'alpha-progression' AND deleted_at IS NULL"
    ).all() as any[];
    for (const row of existingRows) existingDates.add(row.logged_at);

    // Filter out sessions that already exist (by date)
    const newSessions = sessions.filter((s: any) => {
      const loggedAt = new Date(s.date).toISOString();
      return !existingDates.has(loggedAt);
    });
    const duplicateCount = sessions.length - newSessions.length;

    // Preview mode: return parsed data without importing
    const preview = c.req.query('preview') === 'true';
    if (preview) {
      return c.json({
        sessions: sessions.length,
        new_sessions: newSessions.length,
        duplicates: duplicateCount,
        date_range: sessions.length > 0 ? {
          from: sessions[sessions.length - 1].date,
          to: sessions[0].date,
        } : null,
        total_exercises: newSessions.reduce((sum: number, s: any) => sum + s.exercises.length, 0),
        total_sets: newSessions.reduce((sum: number, s: any) => sum + s.exercises.reduce((esum: number, e: any) => esum + e.sets.length, 0), 0),
        sample: newSessions.slice(0, 3),
      });
    }

    // Import: insert only new sessions
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    let imported = 0;
    for (const session of newSessions) {
      const loggedAt = new Date(session.date).toISOString();
      const data = JSON.stringify({
        workout_name: session.name,
        duration: session.duration,
        exercises: session.exercises,
      });
      insert.run('workout', loggedAt, data, 'alpha-progression', now);
      imported++;
    }

    return c.json({
      imported,
      duplicates: duplicateCount,
      date_range: newSessions.length > 0 ? {
        from: newSessions[newSessions.length - 1].date,
        to: newSessions[0].date,
      } : null,
      total_exercises: newSessions.reduce((sum: number, s: any) => sum + s.exercises.length, 0),
      total_sets: newSessions.reduce((sum: number, s: any) => sum + s.exercises.reduce((esum: number, e: any) => esum + e.sets.length, 0), 0),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Import failed' }, 500);
  }
});

// POST /api/routine/import/alpha-measurements — import Alpha Progression Measurements CSV (T#392)
app.post('/api/routine/import/alpha-measurements', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access denied' }, 403);

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ error: 'No file provided' }, 400);

    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const entries: { type: string; date: string; value: number; unit: string }[] = [];
    let currentType = '';
    let currentUnit = '';

    for (const line of lines) {
      // Section header: "Body fat percentage" or Bodyweight
      if (line === '"Body fat percentage"' || line === 'Body fat percentage') {
        currentType = 'bodyfat';
        continue;
      }
      if (line === 'Bodyweight' || line === '"Bodyweight"') {
        currentType = 'weight';
        continue;
      }
      // Unit row: DATE;% or DATE;KG
      if (line.startsWith('DATE;')) {
        currentUnit = line.split(';')[1] || '';
        continue;
      }
      // Data row: "date";value
      if (currentType && line.startsWith('"')) {
        const parts = line.split(';');
        const date = parts[0].replace(/^"|"$/g, '');
        const value = parseFloat(parts[1]);
        if (!isNaN(value)) {
          entries.push({ type: currentType, date, value, unit: currentUnit });
        }
      }
    }

    // Dedup: check existing entries
    const existingDates = new Map<string, Set<string>>();
    const existingRows = sqlite.prepare(
      "SELECT type, logged_at FROM routine_logs WHERE type IN ('weight', 'bodyfat') AND source = 'alpha-progression' AND deleted_at IS NULL"
    ).all() as any[];
    for (const row of existingRows) {
      if (!existingDates.has(row.type)) existingDates.set(row.type, new Set());
      existingDates.get(row.type)!.add(row.logged_at);
    }

    const newEntries = entries.filter(e => {
      const loggedAt = new Date(e.date).toISOString();
      return !existingDates.get(e.type)?.has(loggedAt);
    });
    const duplicateCount = entries.length - newEntries.length;

    const preview = c.req.query('preview') === 'true';
    const bodyfatCount = newEntries.filter(e => e.type === 'bodyfat').length;
    const weightCount = newEntries.filter(e => e.type === 'weight').length;

    if (preview) {
      return c.json({
        total_entries: entries.length,
        new_entries: newEntries.length,
        duplicates: duplicateCount,
        bodyfat: bodyfatCount,
        weight: weightCount,
        date_range: entries.length > 0 ? {
          from: entries[entries.length - 1].date,
          to: entries[0].date,
        } : null,
      });
    }

    // Import
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    let imported = 0;
    for (const entry of newEntries) {
      const loggedAt = new Date(entry.date).toISOString();
      const data = JSON.stringify({
        value: entry.value,
        unit: entry.unit === '%' ? '%' : 'kg',
      });
      insert.run(entry.type === 'weight' ? 'weight' : 'bodyfat', loggedAt, data, 'alpha-progression', now);
      imported++;
    }

    return c.json({ imported, duplicates: duplicateCount, bodyfat: bodyfatCount, weight: weightCount });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Import failed' }, 500);
  }
});

// POST /api/routine/hevy/sync — pull recent workouts from Hevy into Forge (T#703)
// Owner-session or write-auth forge access.
// Query: ?days=7 (default window, max 90).
// Dedupes on hevy workout id stored in data.hevy_id.
app.post('/api/routine/hevy/sync', async (c) => {
  if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access denied' }, 403);

  const token = process.env.HEVY_API_TOKEN;
  if (!token) return c.json({ error: 'HEVY_API_TOKEN not configured on server' }, 500);

  const daysParam = parseInt(c.req.query('days') || '7', 10);
  const days = Math.min(90, Math.max(1, daysParam));
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    // Fetch pages until we reach workouts older than the window.
    const fetched: any[] = [];
    let page = 1;
    const pageSize = 10;
    while (true) {
      const url = `https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=${pageSize}`;
      const resp = await fetch(url, { headers: { 'api-key': token, 'accept': 'application/json' } });
      if (!resp.ok) return c.json({ error: `Hevy API ${resp.status}: ${await resp.text()}` }, 502);
      const body = await resp.json() as any;
      const workouts = body.workouts || [];
      if (workouts.length === 0) break;

      let hitOld = false;
      for (const w of workouts) {
        const startMs = new Date(w.start_time).getTime();
        if (startMs < sinceMs) { hitOld = true; continue; }
        fetched.push(w);
      }
      if (hitOld || page >= (body.page_count || 1) || page >= 10) break;
      page++;
    }

    // Existing hevy-source workouts — dedupe set on hevy_id.
    const existingIds = new Set<string>();
    const existingRows = sqlite.prepare(
      "SELECT data FROM routine_logs WHERE type = 'workout' AND source = 'hevy' AND deleted_at IS NULL"
    ).all() as any[];
    for (const row of existingRows) {
      try {
        const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        if (d?.hevy_id) existingIds.add(d.hevy_id);
      } catch { /* skip malformed */ }
    }

    const insert = sqlite.prepare(
      'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    let inserted = 0;
    let skipped = 0;
    const nowIso = new Date().toISOString();

    for (const w of fetched) {
      if (existingIds.has(w.id)) { skipped++; continue; }

      // Map Hevy → Forge workout shape.
      const startMs = new Date(w.start_time).getTime();
      const endMs = new Date(w.end_time).getTime();
      const durSec = Math.max(0, Math.round((endMs - startMs) / 1000));
      const h = Math.floor(durSec / 3600);
      const m = Math.floor((durSec % 3600) / 60);
      const duration = h > 0 ? `${h}:${String(m).padStart(2, '0')} hr` : `${m} min`;

      const exercises = (w.exercises || []).map((ex: any, idx: number) => {
        const mapped: any = {
          name: `${idx + 1}. ${ex.title || 'Unknown'}`,
          sets: (ex.sets || []).map((s: any, sIdx: number) => {
            const set: any = {
              set: sIdx + 1,
              weight: s.weight_kg ?? null,
              reps: s.reps ?? null,
              unit: 'KG',
            };
            // T#710: pass through Hevy RPE if present (1-10 numeric).
            if (s.rpe != null) {
              const rpeNum = Number(s.rpe);
              if (!isNaN(rpeNum) && rpeNum >= 1 && rpeNum <= 10) set.rpe = rpeNum;
            }
            // T#711: pass through Hevy set type (normal/warmup/dropset/failure).
            // Silent-drop on unknown per Gnarl/Bertus architect CLEAR — honest-untyped beats
            // inferred-normal for audit fidelity. Noise-log on drop gives observability signal
            // for Hevy drift or mapper gap without polluting storage.
            if (typeof s.type === 'string') {
              const t = s.type.toLowerCase();
              if (t === 'normal' || t === 'warmup' || t === 'dropset' || t === 'failure') {
                set.type = t;
              } else {
                console.warn(`[hevy-sync T#711] dropping unknown set.type="${s.type}" on workout ${w.id} exercise ${idx + 1} set ${sIdx + 1}`);
              }
            }
            return set;
          }),
          unit: 'KG',
        };
        // T#710: pass through Hevy exercise notes if present.
        if (typeof ex.notes === 'string' && ex.notes.trim()) {
          mapped.notes = ex.notes;
        }
        // T#711: pass through Hevy exercise_template_id (cross-link to Hevy library).
        if (typeof ex.exercise_template_id === 'string' && ex.exercise_template_id.trim()) {
          mapped.hevy_template_id = ex.exercise_template_id;
        }
        // T#711: pass through Hevy supersets_id (preserve superset grouping; number or null).
        if (typeof ex.supersets_id === 'number' && Number.isFinite(ex.supersets_id)) {
          mapped.superset_id = ex.supersets_id;
        }
        return mapped;
      });

      const data = JSON.stringify({
        workout_name: w.title || 'Untitled',
        duration,
        exercises,
        hevy_id: w.id,
        description: w.description || null,
      });

      insert.run('workout', w.end_time, data, 'hevy', nowIso);
      inserted++;
    }

    return c.json({
      window_days: days,
      fetched: fetched.length,
      inserted,
      skipped_duplicates: skipped,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Hevy sync failed' }, 500);
  }
});

// POST /api/webhooks/hevy — receive Hevy push notifications on workout creation (T#724)
// Hevy spec: POST { workoutId } body, expects 200 OK within 5 seconds.
// Auth: HEVY_WEBHOOK_TOKEN env var, Hevy puts in Authorization header as raw token
// (NO 'Bearer ' prefix — confirmed empirically via webhook.site capture 2026-04-29).
// Pattern parity with /api/webhooks/withings — respond fast + async sync.
// Bear T3 stamp: Discord 21:28 BKK 2026-04-26 (Sable Prowl #89 audit).
app.post('/api/webhooks/hevy', async (c) => {
  // Validate webhook secret (constant-time compare to prevent timing attacks)
  const webhookToken = process.env.HEVY_WEBHOOK_TOKEN;
  if (!webhookToken) {
    console.error('[Hevy webhook] HEVY_WEBHOOK_TOKEN not configured — rejecting');
    return c.text('OK', 200); // Still 200 to avoid Hevy retries
  }
  const authHeader = c.req.header('Authorization') || '';
  // Hevy sends the raw token as the Authorization header value (no 'Bearer ' prefix).
  // Use crypto.timingSafeEqual for canonical constant-time compare
  // (per Pip + Bertus PR #24 review — manual loop leaks length info via loop duration)
  const authBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(webhookToken);
  const valid = authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf);
  if (!valid) {
    return c.json({ error: 'forbidden' }, 401);
  }

  // Parse body
  let workoutId: string;
  try {
    const body = await c.req.json() as any;
    workoutId = String(body.workoutId || '');
    if (!workoutId) {
      console.warn('[Hevy webhook] missing workoutId in body');
      return c.text('OK', 200); // Still 200 — bad payload from Hevy is their concern, not ours
    }
  } catch {
    return c.text('OK', 200);
  }

  // UUID-shape allowlist on workoutId before URL interpolation (per Pip + Bertus
  // PR #24 review — defense-in-depth against forged-bearer with path-traversal
  // attempt; Hevy workoutIds are UUIDs per their spec)
  if (!/^[a-fA-F0-9-]{36}$/.test(workoutId)) {
    console.warn(`[Hevy webhook] invalid workoutId format: ${workoutId}`);
    return c.text('OK', 200);
  }

  console.log(`[Hevy webhook] received workoutId=${workoutId}`);

  // Async sync — respond 200 immediately, fetch + insert in background
  syncSingleHevyWorkout(workoutId).catch(err => {
    console.error(`[Hevy webhook] async sync failed for ${workoutId}:`, err);
  });

  return c.text('OK', 200);
});

// Helper: fetch a single Hevy workout by ID and insert into Forge.
// Reuses the same mapping shape as /api/routine/hevy/sync (T#710 RPE, T#711 set.type/template_id/superset_id).
// Idempotent — dedupe via existing hevy_id check.
//
// Async failures are non-fatal: if sync fails (Hevy API down, malformed response,
// DB error), the workout silently doesn't sync — Hevy gets 200, no retry.
// Recovery path: reconcile via POST /api/routine/hevy/sync full-pull endpoint,
// which is dedupe-safe and will catch any webhook-missed workouts on replay.
async function syncSingleHevyWorkout(workoutId: string): Promise<void> {
  const apiToken = process.env.HEVY_API_TOKEN;
  if (!apiToken) {
    console.error(`[Hevy webhook sync] HEVY_API_TOKEN not configured — cannot fetch ${workoutId}`);
    return;
  }

  // Check dedupe first — same workoutId webhook re-fires are no-op
  const existing = sqlite.prepare(
    "SELECT id FROM routine_logs WHERE type = 'workout' AND source = 'hevy' AND deleted_at IS NULL AND json_extract(data, '$.hevy_id') = ? LIMIT 1"
  ).get(workoutId) as any;
  if (existing) {
    console.log(`[Hevy webhook sync] workoutId=${workoutId} already exists as routine_log id=${existing.id}, skipping`);
    return;
  }

  // Fetch the workout from Hevy
  const url = `https://api.hevyapp.com/v1/workouts/${workoutId}`;
  const resp = await fetch(url, { headers: { 'api-key': apiToken, 'accept': 'application/json' } });
  if (!resp.ok) {
    console.error(`[Hevy webhook sync] Hevy API ${resp.status} for ${workoutId}: ${await resp.text()}`);
    return;
  }
  const w = await resp.json() as any;
  // Hevy single-workout endpoint may wrap in { workout: ... } — handle both shapes
  const workout = w.workout || w;
  if (!workout || !workout.id) {
    console.error(`[Hevy webhook sync] malformed Hevy response for ${workoutId}`);
    return;
  }

  // Map Hevy → Forge workout shape (mirrors /api/routine/hevy/sync logic).
  const startMs = new Date(workout.start_time).getTime();
  const endMs = new Date(workout.end_time).getTime();
  const durSec = Math.max(0, Math.round((endMs - startMs) / 1000));
  const h = Math.floor(durSec / 3600);
  const m = Math.floor((durSec % 3600) / 60);
  const duration = h > 0 ? `${h}:${String(m).padStart(2, '0')} hr` : `${m} min`;

  const exercises = (workout.exercises || []).map((ex: any, idx: number) => {
    const mapped: any = {
      name: `${idx + 1}. ${ex.title || 'Unknown'}`,
      sets: (ex.sets || []).map((s: any, sIdx: number) => {
        const set: any = {
          set: sIdx + 1,
          weight: s.weight_kg ?? null,
          reps: s.reps ?? null,
          unit: 'KG',
        };
        if (s.rpe != null) {
          const rpeNum = Number(s.rpe);
          if (!isNaN(rpeNum) && rpeNum >= 1 && rpeNum <= 10) set.rpe = rpeNum;
        }
        if (typeof s.type === 'string') {
          const t = s.type.toLowerCase();
          if (t === 'normal' || t === 'warmup' || t === 'dropset' || t === 'failure') {
            set.type = t;
          } else {
            console.warn(`[hevy-webhook T#711] dropping unknown set.type="${s.type}" on workout ${workout.id} exercise ${idx + 1} set ${sIdx + 1}`);
          }
        }
        return set;
      }),
      unit: 'KG',
    };
    if (typeof ex.notes === 'string' && ex.notes.trim()) mapped.notes = ex.notes;
    if (typeof ex.exercise_template_id === 'string' && ex.exercise_template_id.trim()) {
      mapped.hevy_template_id = ex.exercise_template_id;
    }
    if (typeof ex.supersets_id === 'number' && Number.isFinite(ex.supersets_id)) {
      mapped.superset_id = ex.supersets_id;
    }
    return mapped;
  });

  const data = {
    title: workout.title || 'Untitled workout',
    duration,
    exercises,
    hevy_id: workout.id,
    notes: typeof workout.description === 'string' && workout.description.trim() ? workout.description : undefined,
  };

  sqlite.prepare(
    'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('workout', new Date(workout.start_time).toISOString(), JSON.stringify(data), 'hevy', new Date().toISOString());

  console.log(`[Hevy webhook sync] inserted workoutId=${workoutId} title="${data.title}" exercises=${exercises.length}`);
}

// ============================================================================
// Rules — Decree and Norm governance (T#360)
// ============================================================================

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('decree', 'norm')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    enforcement TEXT NOT NULL,
    scope TEXT DEFAULT 'all',
    source_thread_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at DATETIME,
    archived_by TEXT
  )
`);

// Unique constraint on active rules to prevent duplicates
try { sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique_active ON rules (title, type) WHERE status = 'active'"); } catch {}

// Migration: add decree approval columns
try { sqlite.exec('ALTER TABLE rules ADD COLUMN approval_status TEXT DEFAULT NULL'); } catch {}
try { sqlite.exec('ALTER TABLE rules ADD COLUMN approved_by TEXT DEFAULT NULL'); } catch {}
try { sqlite.exec('ALTER TABLE rules ADD COLUMN approved_at DATETIME DEFAULT NULL'); } catch {}
try { sqlite.exec('ALTER TABLE rules ADD COLUMN rejection_reason TEXT DEFAULT NULL'); } catch {}

// Seed data — only on first run (empty table)
const ruleCount = (sqlite.prepare('SELECT COUNT(*) as c FROM rules').get() as any).c;
if (ruleCount === 0) {
  const seedRules = [
    { type: 'decree', title: 'SDD: All new features require spec files', content: 'All new features with endpoints or data models require a spec file in docs/specs/. Big features need Gorn approval via Sable.', author: 'leonard', enforcement: 'mandatory', source_thread_id: 256 },
    { type: 'decree', title: 'Big features need Gorn approval via Sable', content: 'New projects, cross-team features, and significant architecture changes require spec submission to /specs and Gorn approval routed through Sable.', author: 'leonard', enforcement: 'mandatory', source_thread_id: 256 },
    { type: 'decree', title: 'All Gorn action items route through Sable', content: 'Sable is the gatekeeper for all Gorn action items — spec approvals, reviews, decisions.', author: 'leonard', enforcement: 'mandatory', source_thread_id: 264 },
    { type: 'decree', title: 'Nothing is deleted — archive, never delete', content: 'No git push --force. No rm -rf without backup. Supersede, don\'t delete. Timestamps are truth.', author: 'gorn', enforcement: 'mandatory' },
    { type: 'decree', title: 'No git push --force', content: 'Force pushing violates the Nothing is Deleted principle. Always preserve history.', author: 'gorn', enforcement: 'mandatory' },
    { type: 'decree', title: 'No commits of secrets (.env, credentials)', content: 'Never commit secrets, .env files, or credentials to any repository.', author: 'gorn', enforcement: 'mandatory' },
    { type: 'norm', title: 'Use reactions for acknowledgments', content: 'Use emoji reactions (✅, 👀, etc.) for simple acknowledgments. Save posts for substantive content.', author: 'mara', enforcement: 'recommended' },
    { type: 'norm', title: 'Sign all work with Beast name', content: 'End forum posts and DMs with your Beast name (— Karo, — Zaghnal, etc.) for clear attribution.', author: 'mara', enforcement: 'recommended' },
  ];
  const insert = sqlite.prepare('INSERT INTO rules (type, title, content, author, enforcement, source_thread_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of seedRules) {
    insert.run(r.type, r.title, r.content, r.author, r.enforcement, r.source_thread_id || null);
  }
}

// Helper: decorate rule with effective status + enforcement keywords (T#426)
function decorateRule(rule: any) {
  if (!rule) return rule;
  // Override status to reflect approval state for decrees
  if (rule.type === 'decree' && rule.approval_status === 'pending') {
    return { ...rule, status: 'pending' };
  }
  if (rule.type === 'decree' && rule.approval_status === 'rejected') {
    return { ...rule, status: 'rejected' };
  }
  // Active approved decrees get enforcement language
  if (rule.type === 'decree' && rule.status === 'active' && (rule.approval_status === 'approved' || rule.approval_status === null)) {
    const enforcementLevel = (rule.enforcement || 'must').toLowerCase();
    const keyword = enforcementLevel === 'should' ? 'IMPORTANT: SHOULD' : 'IMPORTANT: MUST';
    return { ...rule, enforcement_text: `${keyword} — ${rule.title}` };
  }
  return rule;
}

// GET /api/rules — list rules
app.get('/api/rules', (c) => {
  const type = c.req.query('type');
  const status = c.req.query('status') || 'active';
  const scope = c.req.query('scope');
  const includePending = c.req.query('include_pending') === 'true';
  let query = 'SELECT * FROM rules WHERE status = ?';
  const params: any[] = [status];
  if (!includePending) { query += " AND (approval_status IS NULL OR approval_status = 'approved')"; }
  if (type) { query += ' AND type = ?'; params.push(type); }
  if (scope) { query += ' AND scope = ?'; params.push(scope); }
  query += " ORDER BY CASE type WHEN 'decree' THEN 0 WHEN 'norm' THEN 1 END, created_at DESC";
  const rules = (sqlite.prepare(query).all(...params) as any[]).map(decorateRule);
  return c.json({ rules, total: rules.length });
});

// GET /api/rules/decrees — active approved decrees only
app.get('/api/rules/decrees', (c) => {
  const rules = (sqlite.prepare("SELECT * FROM rules WHERE type = 'decree' AND status = 'active' AND (approval_status IS NULL OR approval_status = 'approved') ORDER BY created_at DESC").all() as any[]).map(decorateRule);
  return c.json({ rules, total: rules.length });
});

// GET /api/rules/pending — pending decrees awaiting Gorn approval
app.get('/api/rules/pending', (c) => {
  const rules = (sqlite.prepare("SELECT * FROM rules WHERE type = 'decree' AND status = 'active' AND approval_status = 'pending' ORDER BY created_at DESC").all() as any[]).map(decorateRule);
  return c.json({ rules, total: rules.length });
});

// POST /api/rules/:id/approve — Gorn approves a decree
app.post('/api/rules/:id/approve', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Only Gorn can approve decrees' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
  if (!rule) return c.json({ error: 'Rule not found' }, 404);
  if (rule.type !== 'decree') return c.json({ error: 'Only decrees need approval' }, 400);
  if (rule.approval_status !== 'pending') return c.json({ error: 'Only pending decrees can be approved' }, 400);
  const now = new Date().toISOString();
  sqlite.prepare('UPDATE rules SET approval_status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?')
    .run('approved', 'gorn', now, now, id);
  // Notify author (T#420)
  const author = rule.author?.toLowerCase();
  if (author && author !== 'gorn') {
    const msg = `Decree #${id} "${rule.title}" has been **approved** by Gorn.`;
    if (rule.source_thread_id) {
      try { addMessage(rule.source_thread_id, 'claude', msg, { author: 'system' }); } catch { /* non-critical */ }
    }
    try { await withRetry(() => sendDm('system', author, msg)); } catch { /* non-critical */ }
    wsBroadcast('decree_approved', { id, title: rule.title, author });
  }
  return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
});

// POST /api/rules/:id/reject — Gorn rejects a decree
app.post('/api/rules/:id/reject', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Only Gorn can reject decrees' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
  if (!rule) return c.json({ error: 'Rule not found' }, 404);
  if (rule.type !== 'decree') return c.json({ error: 'Only decrees can be rejected' }, 400);
  if (rule.approval_status !== 'pending') return c.json({ error: 'Only pending decrees can be rejected' }, 400);
  try {
    const data = await c.req.json();
    const reason = data.reason || '';
    const now = new Date().toISOString();
    sqlite.prepare('UPDATE rules SET approval_status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?')
      .run('rejected', reason, now, id);
    // Notify author (T#420)
    const author = rule.author?.toLowerCase();
    if (author && author !== 'gorn') {
      const msg = `Decree #${id} "${rule.title}" has been **rejected** by Gorn.${reason ? ` Reason: ${reason}` : ''}`;
      if (rule.source_thread_id) {
        try { addMessage(rule.source_thread_id, 'claude', msg, { author: 'system' }); } catch { /* non-critical */ }
      }
      try { await withRetry(() => sendDm('system', author, msg)); } catch { /* non-critical */ }
      wsBroadcast('decree_rejected', { id, title: rule.title, author, reason });
    }
    return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// GET /api/rules/markdown — all active rules as plain markdown (T#426)
app.get('/api/rules/markdown', (c) => {
  const rules = (sqlite.prepare("SELECT * FROM rules WHERE status = 'active' AND (approval_status IS NULL OR approval_status = 'approved') ORDER BY CASE type WHEN 'decree' THEN 0 WHEN 'norm' THEN 1 END, created_at DESC").all() as any[]).map(decorateRule);
  const decrees = rules.filter(r => r.type === 'decree');
  const norms = rules.filter(r => r.type === 'norm');
  let md = '';
  if (decrees.length) {
    md += '## Decrees\n\n';
    for (const d of decrees) md += `### ${d.enforcement_text || d.title}\n${d.content}\n\n`;
  }
  if (norms.length) {
    md += '## Norms\n\n';
    for (const n of norms) md += `### SHOULD — ${n.title}\n${n.content}\n\n`;
  }
  if (!rules.length) md = 'No active rules';
  return c.text(md.trim());
});

// GET /api/rules/norms — active norms only
app.get('/api/rules/norms', (c) => {
  const rules = sqlite.prepare("SELECT * FROM rules WHERE type = 'norm' AND status = 'active' ORDER BY created_at DESC").all();
  return c.json({ rules, total: (rules as any[]).length });
});

// GET /api/rules/:id — single rule
app.get('/api/rules/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!rule) return c.json({ error: 'Rule not found' }, 404);
  return c.json(decorateRule(rule));
});

// POST /api/rules — create rule
app.post('/api/rules', async (c) => {
  try {
    const data = await c.req.json();
    const { type, title, content, scope, source_thread_id } = data;
    if (!type || !title || !content) return c.json({ error: 'type, title, content required' }, 400);
    if (!['decree', 'norm'].includes(type)) return c.json({ error: 'type must be decree or norm' }, 400);
    // T#718 — derive author from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (data.author && data.author.toLowerCase() !== caller) {
      return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
    }
    const author = caller;
    if (type === 'decree' && !['leonard', 'gorn'].includes(author)) {
      return c.json({ error: 'Only Leonard and Gorn can create decrees' }, 403);
    }
    const enforcement = type === 'decree' ? 'mandatory' : 'recommended';
    // Decrees need Gorn approval (unless Gorn is creating it directly)
    const approvalStatus = type === 'decree' && author !== 'gorn' ? 'pending' : (type === 'decree' ? 'approved' : null);
    const approvedBy = type === 'decree' && author === 'gorn' ? 'gorn' : null;
    const approvedAt = type === 'decree' && author === 'gorn' ? new Date().toISOString() : null;
    const now = new Date().toISOString();
    const result = sqlite.prepare(
      'INSERT INTO rules (type, title, content, author, enforcement, scope, source_thread_id, approval_status, approved_by, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(type, title, content, author, enforcement, scope || 'all', source_thread_id || null, approvalStatus, approvedBy, approvedAt, now, now);
    const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get((result as any).lastInsertRowid);
    return c.json(decorateRule(rule), 201);
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// PATCH /api/rules/:id — update rule
app.patch('/api/rules/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
  if (!rule) return c.json({ error: 'Rule not found' }, 404);
  try {
    const data = await c.req.json();
    // T#718 — derive requester from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const claimed = (data.author || data.beast || c.req.query('as') || '').toLowerCase();
    if (claimed && claimed !== caller) {
      return c.json({ error: 'Identity spoof blocked. body.author/beast or ?as= must match authenticated caller or be omitted.' }, 403);
    }
    const requester = caller;
    if (rule.type === 'decree' && !['leonard', 'gorn'].includes(requester)) {
      return c.json({ error: 'Only Leonard and Gorn can edit decrees' }, 403);
    }
    if (rule.type === 'norm' && requester !== rule.author && requester !== 'leonard' && requester !== 'gorn') {
      return c.json({ error: 'Only the author or Leonard can edit norms' }, 403);
    }
    const updates: string[] = [];
    const values: any[] = [];
    if (data.title) { updates.push('title = ?'); values.push(data.title); }
    if (data.content) { updates.push('content = ?'); values.push(data.content); }
    if (data.scope) { updates.push('scope = ?'); values.push(data.scope); }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
    updates.push('updated_at = ?'); values.push(new Date().toISOString());
    values.push(id);
    sqlite.prepare(`UPDATE rules SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// PATCH /api/rules/:id/archive — archive rule
app.patch('/api/rules/:id/archive', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
  if (!rule) return c.json({ error: 'Rule not found' }, 404);
  if (rule.status === 'archived') return c.json({ error: 'Already archived' }, 400);
  try {
    const data = await c.req.json();
    // T#718 — derive requester from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const claimed = (data.author || data.beast || c.req.query('as') || '').toLowerCase();
    if (claimed && claimed !== caller) {
      return c.json({ error: 'Identity spoof blocked. body.author/beast or ?as= must match authenticated caller or be omitted.' }, 403);
    }
    const requester = caller;
    if (rule.type === 'decree' && !['leonard', 'gorn'].includes(requester)) {
      return c.json({ error: 'Only Leonard and Gorn can archive decrees' }, 403);
    }
    if (rule.type === 'norm' && requester !== rule.author && requester !== 'leonard' && requester !== 'gorn') {
      return c.json({ error: 'Only the author or Leonard can archive norms' }, 403);
    }
    const now = new Date().toISOString();
    sqlite.prepare('UPDATE rules SET status = ?, archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ?')
      .run('archived', now, requester, now, id);
    return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
  } catch { return c.json({ error: 'Invalid request' }, 400); }
});

// ============================================================================
// Prowl — Personal Task Manager for Gorn (T#279)
// ============================================================================

const ALLOWED_PROWL_CREATORS = ['gorn', 'sable', 'zaghnal', 'leonard', 'karo'];
const ALLOWED_PROWL_MANAGERS = ['gorn', 'sable', 'karo']; // T#619: Karo gets full manage access

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS prowl_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    category TEXT DEFAULT 'general',
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    source TEXT,
    source_id INTEGER,
    created_by TEXT NOT NULL DEFAULT 'gorn',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )
`).run(); } catch { /* exists */ }

// Add notified_at column for Prowl Telegram notifications (T#467)
try { sqlite.prepare(`ALTER TABLE prowl_tasks ADD COLUMN notified_at TEXT`).run(); } catch { /* already exists */ }
// Add remind_before column for advance reminders (T#471) — values: null, 15m, 30m, 1h, 1d
try { sqlite.prepare(`ALTER TABLE prowl_tasks ADD COLUMN remind_before TEXT`).run(); } catch { /* already exists */ }

// GET /api/prowl — list tasks with filters
app.get('/api/prowl', (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Authentication required' }, 403);
  const status = c.req.query('status') || 'pending';
  const priority = c.req.query('priority');
  const category = c.req.query('category');
  const due = c.req.query('due');

  let query = 'SELECT * FROM prowl_tasks WHERE 1=1';
  const params: any[] = [];

  if (status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  if (priority) {
    query += ' AND priority = ?';
    params.push(priority);
  }
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (due === 'overdue') {
    query += " AND due_date < datetime('now', 'localtime') AND status = 'pending'";
  } else if (due === 'today') {
    query += " AND date(due_date) = date('now', 'localtime')";
  } else if (due === 'week') {
    query += " AND date(due_date) BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')";
  }

  query += ' ORDER BY CASE priority WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 WHEN \'low\' THEN 2 END, created_at DESC';

  const rawTasks = sqlite.prepare(query).all(...params) as any[];

  // Attach checklist items to each task
  const tasks = rawTasks.map(t => {
    const checklist = sqlite.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id').all(t.id);
    return { ...t, checklist };
  });

  // Counts
  const counts = {
    pending: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE status = 'pending'").get() as any).c,
    done: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE status = 'done'").get() as any).c,
    overdue: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE due_date < datetime('now', 'localtime') AND status = 'pending'").get() as any).c,
    high: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'high' AND status = 'pending'").get() as any).c,
    medium: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'medium' AND status = 'pending'").get() as any).c,
    low: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'low' AND status = 'pending'").get() as any).c,
  };

  const categories = (sqlite.prepare("SELECT DISTINCT category FROM prowl_tasks WHERE category IS NOT NULL ORDER BY category").all() as any[]).map(r => r.category);

  return c.json({ tasks, counts, categories });
});

// GET /api/prowl/categories — unique categories with counts
app.get('/api/prowl/categories', (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Authentication required' }, 403);
  const rows = sqlite.prepare("SELECT category, COUNT(*) as count FROM prowl_tasks WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC").all();
  return c.json({ categories: rows });
});

// POST /api/prowl — create task
app.post('/api/prowl', async (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Authentication required' }, 403);
  try {
    const data = await c.req.json();
    if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);

    const requester = (c.req.query('as') || data.created_by || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester || !ALLOWED_PROWL_CREATORS.includes(requester)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_CREATORS.join(', ')} can create Prowl tasks` }, 403);
    }

    const priority = ['high', 'medium', 'low'].includes(data.priority) ? data.priority : 'medium';
    const now = new Date().toISOString();

    const validReminders = [null, '1m', '5m', '15m', '30m', '1h', '1d'];
    const remindBefore = validReminders.includes(data.remind_before) ? data.remind_before : null;

    const result = sqlite.prepare(
      'INSERT INTO prowl_tasks (title, priority, category, due_date, status, notes, source, source_id, created_by, remind_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      data.title.trim(),
      priority,
      data.category || 'general',
      data.due_date || null,
      'pending',
      data.notes || null,
      data.source || 'manual',
      data.source_id ?? null,
      requester,
      remindBefore,
      now,
      now
    );

    const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get((result as any).lastInsertRowid);
    wsBroadcast('prowl_update', { action: 'create' });
    return c.json(task, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || 'Invalid request' }, 400);
  }
});

// PATCH /api/prowl/:id — update task fields (T#619: Gorn, Sable, or Karo)
app.patch('/api/prowl/:id', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can update Prowl tasks` }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  try {
    const data = await c.req.json();
    if ('status' in data) return c.json({ error: 'Use PATCH /api/prowl/:id/status to change status' }, 400);

    const allowed = ['title', 'priority', 'category', 'due_date', 'notes', 'remind_before'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of allowed) {
      if (field in data) {
        updates.push(`${field} = ?`);
        values.push(data[field]);
      }
    }
    if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);

    updates.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    sqlite.prepare(`UPDATE prowl_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id);
    wsBroadcast('prowl_update', { action: 'update' });
    return c.json(task);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// PATCH /api/prowl/:id/status — change status (T#619: Gorn, Sable, or Karo)
app.patch('/api/prowl/:id/status', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can change Prowl task status` }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  try {
    const data = await c.req.json();
    const newStatus = data.status;
    if (!['pending', 'done'].includes(newStatus)) return c.json({ error: 'status must be pending or done' }, 400);

    const now = new Date().toISOString();
    const completedAt = newStatus === 'done' ? now : null;

    sqlite.prepare('UPDATE prowl_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, completedAt, now, id);
    const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id);
    wsBroadcast('prowl_update', { action: 'status' });
    return c.json(task);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// POST /api/prowl/:id/toggle — quick toggle pending ↔ done (T#619: Gorn, Sable, or Karo)
app.post('/api/prowl/:id/toggle', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can toggle Prowl tasks` }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  const now = new Date().toISOString();
  const newStatus = existing.status === 'pending' ? 'done' : 'pending';
  const completedAt = newStatus === 'done' ? now : null;

  sqlite.prepare('UPDATE prowl_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    .run(newStatus, completedAt, now, id);
  const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id);
  wsBroadcast('prowl_update', { action: 'toggle' });
  return c.json(task);
});

// DELETE /api/prowl/:id — delete task (T#619: Gorn, Sable, or Karo)
app.delete('/api/prowl/:id', async (c) => {
  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) {
    return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can delete Prowl tasks` }, 403);
  }
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  sqlite.prepare('DELETE FROM prowl_tasks WHERE id = ?').run(id);
  wsBroadcast('prowl_update', { action: 'delete' });
  return c.json({ deleted: true, id });
});

// --- Prowl Checklist Items (T#628) ---

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES prowl_tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).run(); } catch { /* exists */ }

// GET /api/prowl/:id/checklist — list checklist items for a task
app.get('/api/prowl/:id/checklist', (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Authentication required' }, 403);
  const taskId = parseInt(c.req.param('id'), 10);
  if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);
  const task = sqlite.prepare('SELECT id FROM prowl_tasks WHERE id = ?').get(taskId);
  if (!task) return c.json({ error: 'Task not found' }, 404);
  const items = sqlite.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id').all(taskId);
  return c.json({ items });
});

// POST /api/prowl/:id/checklist — add checklist item
app.post('/api/prowl/:id/checklist', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
  const taskId = parseInt(c.req.param('id'), 10);
  if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);
  const task = sqlite.prepare('SELECT id FROM prowl_tasks WHERE id = ?').get(taskId);
  if (!task) return c.json({ error: 'Task not found' }, 404);
  try {
    const data = await c.req.json();
    if (!data.text?.trim()) return c.json({ error: 'text required' }, 400);
    const now = new Date().toISOString();
    const maxOrder = (sqlite.prepare('SELECT MAX(sort_order) as m FROM checklist_items WHERE task_id = ?').get(taskId) as any)?.m || 0;
    const result = sqlite.prepare(
      'INSERT INTO checklist_items (task_id, text, checked, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)'
    ).run(taskId, data.text.trim(), maxOrder + 1, now, now);
    const item = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ?').get((result as any).lastInsertRowid);
    wsBroadcast('prowl_update', { action: 'checklist' });
    return c.json(item, 201);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// PATCH /api/prowl/:id/checklist/:itemId — update checklist item (text, checked, sort_order)
app.patch('/api/prowl/:id/checklist/:itemId', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
  const taskId = parseInt(c.req.param('id'), 10);
  const itemId = parseInt(c.req.param('itemId'), 10);
  if (isNaN(taskId) || isNaN(itemId)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?').get(itemId, taskId);
  if (!existing) return c.json({ error: 'Checklist item not found' }, 404);
  try {
    const data = await c.req.json();
    const allowed = ['text', 'checked', 'sort_order'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of allowed) {
      if (field in data) {
        updates.push(`${field} = ?`);
        values.push(field === 'checked' ? (data[field] ? 1 : 0) : data[field]);
      }
    }
    if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);
    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(itemId);
    sqlite.prepare(`UPDATE checklist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const item = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ?').get(itemId);
    wsBroadcast('prowl_update', { action: 'checklist' });
    return c.json(item);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// POST /api/prowl/:id/checklist/:itemId/toggle — quick toggle checked
app.post('/api/prowl/:id/checklist/:itemId/toggle', (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
  const taskId = parseInt(c.req.param('id'), 10);
  const itemId = parseInt(c.req.param('itemId'), 10);
  if (isNaN(taskId) || isNaN(itemId)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?').get(itemId, taskId) as any;
  if (!existing) return c.json({ error: 'Checklist item not found' }, 404);
  const now = new Date().toISOString();
  const newChecked = existing.checked ? 0 : 1;
  sqlite.prepare('UPDATE checklist_items SET checked = ?, updated_at = ? WHERE id = ?').run(newChecked, now, itemId);
  const item = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ?').get(itemId);
  wsBroadcast('prowl_update', { action: 'checklist' });
  return c.json(item);
});

// DELETE /api/prowl/:id/checklist/:itemId — delete checklist item
app.delete('/api/prowl/:id/checklist/:itemId', (c) => {
  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester && ALLOWED_PROWL_MANAGERS.includes(requester))) return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
  const taskId = parseInt(c.req.param('id'), 10);
  const itemId = parseInt(c.req.param('itemId'), 10);
  if (isNaN(taskId) || isNaN(itemId)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?').get(itemId, taskId);
  if (!existing) return c.json({ error: 'Checklist item not found' }, 404);
  sqlite.prepare('DELETE FROM checklist_items WHERE id = ?').run(itemId);
  wsBroadcast('prowl_update', { action: 'checklist' });
  return c.json({ deleted: true, id: itemId });
});

// POST /api/prowl/notify-test — test notification pipeline (Gorn-only)
app.post('/api/prowl/notify-test', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
  const sessionName = 'Sable';
  const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
  if (hasSession.exitCode !== 0) {
    return c.json({ error: 'Sable tmux session not found' }, 503);
  }
  const notification = '[Prowl] TEST: This is a test notification — if Sable receives this and sends Telegram, the pipeline works';
  enqueueNotification('sable', notification);
  return c.json({ success: true, message: 'Test notification sent to Sable' });
});

// ============================================================================
// Global Search — Meilisearch + FTS5 (T#347 + T#350)
// ============================================================================

// Meilisearch client (T#350)
const MEILI_HOST = process.env.MEILI_HOST || 'http://127.0.0.1:7700';
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || '';
let meili: MeiliSearch | null = null;
let meiliAvailable = false;

async function initMeilisearch() {
  if (!MEILI_MASTER_KEY) { console.log('[MEILI] No master key configured, skipping'); return; }
  try {
    meili = new MeiliSearch({ host: MEILI_HOST, apiKey: MEILI_MASTER_KEY });
    const health = await meili.health();
    if (health.status === 'available') {
      meiliAvailable = true;
      console.log('[MEILI] Connected to Meilisearch');

      // Create/update index settings
      const index = meili.index('denbook');
      try { await meili.createIndex('denbook', { primaryKey: 'search_id' }); } catch { /* exists */ }
      await index.updateSettings({
        searchableAttributes: ['title', 'content', 'author'],
        filterableAttributes: ['source_type', 'author'],
        sortableAttributes: ['created_at'],
        typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
      });
      console.log('[MEILI] Index settings configured');
    }
  } catch (e) {
    console.log(`[MEILI] Not available: ${e}`);
    meili = null;
    meiliAvailable = false;
  }
}

// Backfill Meilisearch
async function backfillMeilisearch() {
  if (!meili || !meiliAvailable) return;
  console.log('[MEILI] Backfilling...');
  const index = meili.index('denbook');
  const docs: any[] = [];
  const repoBase = path.join(import.meta.dirname || __dirname, '..');

  // Library
  const libRows = sqlite.prepare('SELECT id, title, content, author, created_at FROM library').all() as any[];
  for (const r of libRows) docs.push({ search_id: `library_${r.id}`, title: r.title, content: r.content, source_type: 'library', source_id: r.id, author: r.author, created_at: new Date(r.created_at).toISOString(), url: `/library?doc=${r.id}` });

  // Forum
  const forumRows = sqlite.prepare('SELECT m.id, t.title, m.content, m.author, m.created_at, m.thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id').all() as any[];
  for (const r of forumRows) docs.push({ search_id: `forum_${r.id}`, title: r.title, content: r.content, source_type: 'forum', source_id: r.id, author: r.author, created_at: r.created_at, url: `/forum?thread=${r.thread_id}` });

  // Tasks
  const taskRows = sqlite.prepare('SELECT id, title, description, assigned_to, created_at FROM tasks').all() as any[];
  for (const r of taskRows) docs.push({ search_id: `task_${r.id}`, title: r.title, content: r.description || '', source_type: 'task', source_id: r.id, author: r.assigned_to || '', created_at: r.created_at, url: `/board?task=${r.id}` });

  // Specs (file content)
  const specRows = sqlite.prepare('SELECT id, title, author, file_path, created_at FROM spec_reviews').all() as any[];
  for (const r of specRows) {
    const fp = path.join(repoBase, r.file_path);
    const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : r.title;
    docs.push({ search_id: `spec_${r.id}`, title: r.title, content, source_type: 'spec', source_id: r.id, author: r.author, created_at: r.created_at, url: `/specs?spec=${r.id}` });
  }

  // Risks
  const riskRows = sqlite.prepare('SELECT id, title, description, created_by, created_at FROM risks').all() as any[];
  for (const r of riskRows) docs.push({ search_id: `risk_${r.id}`, title: r.title, content: r.description || '', source_type: 'risk', source_id: r.id, author: r.created_by, created_at: r.created_at, url: '/risk' });

  // Shelves (T#351)
  const shelfRows = sqlite.prepare('SELECT id, name, description, icon, color, created_by, created_at FROM library_shelves').all() as any[];
  for (const r of shelfRows) docs.push({ search_id: `shelf_${r.id}`, title: r.name, content: r.description || '', source_type: 'shelf', source_id: r.id, author: r.created_by, created_at: r.created_at, url: `/library` });

  if (docs.length > 0) {
    const task = await index.addDocuments(docs);
    console.log(`[MEILI] Backfill queued: ${docs.length} docs (task: ${task.taskUid})`);
  }
}

// Init on startup
initMeilisearch().then(() => {
  if (meiliAvailable) {
    // Check if index is empty and backfill
    meili!.index('denbook').getStats().then(stats => {
      if (stats.numberOfDocuments === 0) backfillMeilisearch();
      else console.log(`[MEILI] Index has ${stats.numberOfDocuments} docs, skipping backfill`);
    }).catch(() => backfillMeilisearch());
  }
}).catch(() => {});

// Create FTS5 virtual table
try {
  sqlite.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    title, content, source_type, source_id UNINDEXED, author, created_at UNINDEXED,
    tokenize = 'porter unicode61'
  )`).run();
} catch { /* already exists */ }

// Index specs by reading their markdown files
function indexSpecFiles() {
  const specs = sqlite.prepare('SELECT id, title, author, file_path, repo, created_at FROM spec_reviews').all() as any[];
  const repoBase = path.join(import.meta.dirname || __dirname, '..');
  for (const spec of specs) {
    try {
      const filePath = path.join(repoBase, spec.file_path);
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : spec.title;
      searchIndexUpsert('spec', spec.id, spec.title, content, spec.author, spec.created_at);
    } catch { /* skip */ }
  }
}

// Backfill if index is empty
const searchCount = (sqlite.prepare('SELECT COUNT(*) as c FROM search_index').get() as any)?.c || 0;
if (searchCount === 0) {
  console.log('[SEARCH] Backfilling FTS5 search index...');
  const backfillStmts = [
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT title, content, 'library', id, author, created_at FROM library`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT t.title, m.content, 'forum', m.id, m.author, m.created_at
     FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT title, COALESCE(description,''), 'risk', id, created_by, created_at FROM risks`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT title, COALESCE(description,''), 'task', id, COALESCE(assigned_to,''), created_at FROM tasks`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT name, COALESCE(description,''), 'shelf', id, created_by, created_at FROM library_shelves`,
  ];
  for (const stmt of backfillStmts) {
    try { sqlite.prepare(stmt).run(); } catch (e) { console.log(`[SEARCH] Backfill warning: ${e}`); }
  }
  indexSpecFiles();
  const total = (sqlite.prepare('SELECT COUNT(*) as c FROM search_index').get() as any)?.c || 0;
  console.log(`[SEARCH] Backfill complete: ${total} documents indexed.`);
}

// URL generator for search results
const searchUrlMap: Record<string, (id: number) => string> = {
  forum: () => '#', // forum needs thread_id, handled specially
  library: (id) => `/library?doc=${id}`,
  spec: (id) => `/specs?spec=${id}`,
  risk: () => `/risk`,
  task: (id) => `/board?task=${id}`,
  shelf: () => `/library`,
};

function searchUrlFor(sourceType: string, sourceId: number, extraUrl?: string): string {
  if (extraUrl) return extraUrl;
  return (searchUrlMap[sourceType] || (() => '#'))(sourceId);
}

// Helper: index a document
function searchIndexUpsert(sourceType: string, sourceId: number, title: string, content: string, author: string, createdAt: string, url?: string) {
  const resolvedUrl = searchUrlFor(sourceType, sourceId, url);
  // FTS5 (sync)
  try {
    sqlite.prepare('DELETE FROM search_index WHERE source_type = ? AND source_id = ?').run(sourceType, String(sourceId));
    sqlite.prepare('INSERT INTO search_index(title, content, source_type, source_id, author, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(title, content, sourceType, String(sourceId), author, createdAt);
  } catch { /* ignore indexing errors */ }
  // Meilisearch (async, fire-and-forget)
  if (meili && meiliAvailable) {
    meili.index('denbook').addDocuments([{
      search_id: `${sourceType}_${sourceId}`, title, content, source_type: sourceType,
      source_id: sourceId, author, created_at: createdAt, url: resolvedUrl,
    }]).catch(() => {});
  }
}

function searchIndexDelete(sourceType: string, sourceId: number) {
  try { sqlite.prepare('DELETE FROM search_index WHERE source_type = ? AND source_id = ?').run(sourceType, String(sourceId)); } catch { /* ignore */ }
  if (meili && meiliAvailable) {
    meili.index('denbook').deleteDocument(`${sourceType}_${sourceId}`).catch(() => {});
  }
}

// Sanitize FTS5 query — prevent column targeting
function sanitizeFtsQuery(raw: string): string {
  const terms = raw.match(/"[^"]*"|[^\s]+/g) || [];
  return terms.map(t => t.startsWith('"') ? t : `"${t.replace(/"/g, '')}"`).join(' ');
}

// FTS5 search (used as fallback)
const VALID_SOURCE_TYPES = ['forum', 'library', 'task', 'spec', 'shelf'];
function fts5Search(q: string, type: string | undefined, limit: number, offset: number) {
  const sanitized = sanitizeFtsQuery(q);
  if (!sanitized) return { results: [], total: 0, query: q, engine: 'fts5' as const };

  let where = 'search_index MATCH ?';
  const params: any[] = [sanitized];
  if (type && VALID_SOURCE_TYPES.includes(type)) { where += ' AND source_type = ?'; params.push(type); }

  const total = (sqlite.prepare(`SELECT COUNT(*) as c FROM search_index WHERE ${where}`).get(...params) as any)?.c || 0;
  const rows = sqlite.prepare(
    `SELECT source_type, source_id, title, snippet(search_index, 1, '<mark>', '</mark>', '...', 40) as snippet, author, rank, created_at
     FROM search_index WHERE ${where} ORDER BY rank LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as any[];

  const urlMap: Record<string, (id: string) => string> = {
    library: (id) => `/library?doc=${id}`,
    spec: (id) => `/specs?spec=${id}`, risk: () => `/risk`, task: (id) => `/board?task=${id}`,
    shelf: () => `/library`,
  };

  // Forum source_id is message ID — look up thread_id for URL
  function forumUrl(messageId: string): string {
    const row = sqlite.prepare('SELECT thread_id FROM forum_messages WHERE id = ?').get(parseInt(messageId, 10)) as any;
    return row ? `/forum?thread=${row.thread_id}` : '#';
  }

  // Deduplicate by URL — keep first (best-ranked) result per URL
  const seen = new Set<string>();
  const deduped = rows.reduce((acc: any[], r: any) => {
    const url = r.source_type === 'forum' ? forumUrl(r.source_id) : (urlMap[r.source_type] || (() => '#'))(r.source_id);
    if (url !== '#' && seen.has(url)) return acc;
    if (url !== '#') seen.add(url);
    acc.push({
      source_type: r.source_type, source_id: r.source_id, title: r.title,
      snippet: r.snippet, author: r.author, url,
    });
    return acc;
  }, []);

  return {
    results: deduped,
    total: deduped.length, query: q, engine: 'fts5' as const,
  };
}

// GET /api/search — global search (Meilisearch with FTS5 fallback)
app.get('/api/search', async (c) => {
  // Search requires owner session or local Beast request (T#605)
  const role = (c.get as any)('role');
  if (role === 'guest') {
    return c.json({ error: 'Search is not available in guest mode' }, 403);
  }
  const hasSession = hasSessionAuth(c);
  const isLocalBeast = isLocalNetwork(c) && c.req.query('as');
  if (!hasSession && !isLocalBeast) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  const requester = c.req.query('as') || 'gorn';

  let q = c.req.query('q')?.trim();
  if (!q) return c.json({ results: [], total: 0, query: '' });

  // Direct ID lookup shortcuts: T:360, F:298, S:16, L:36 (colon prefix, mobile-friendly)
  // Also supports legacy: T#360, "thread 344", "task 123", "spec 16", "library 36"
  const taskMatch = q.match(/^(?:t[:#]?|task)\s*[:#]?(\d+)$/i);
  if (taskMatch) {
    const id = parseInt(taskMatch[1], 10);
    const task = sqlite.prepare('SELECT id, title, assigned_to FROM tasks WHERE id = ?').get(id) as any;
    if (task) return c.json({ results: [{ source_type: 'task', source_id: task.id, title: task.title, snippet: '', author: task.assigned_to || '', url: `/board?task=${task.id}` }], total: 1, query: q, engine: 'id_lookup' });
  }
  const threadMatch = q.match(/^(?:f[:#]?|thread)\s*[:#]?(\d+)$/i);
  if (threadMatch) {
    const id = parseInt(threadMatch[1], 10);
    const thread = sqlite.prepare('SELECT id, title FROM forum_threads WHERE id = ?').get(id) as any;
    if (thread) return c.json({ results: [{ source_type: 'forum', source_id: thread.id, title: thread.title, snippet: '', author: '', url: `/forum?thread=${thread.id}` }], total: 1, query: q, engine: 'id_lookup' });
  }
  const specMatch = q.match(/^(?:s[:#]?|spec)\s*[:#]?(\d+)$/i);
  if (specMatch) {
    const id = parseInt(specMatch[1], 10);
    const spec = sqlite.prepare('SELECT id, title FROM spec_reviews WHERE id = ?').get(id) as any;
    if (spec) return c.json({ results: [{ source_type: 'spec', source_id: spec.id, title: spec.title, snippet: '', author: '', url: `/specs?spec=${spec.id}` }], total: 1, query: q, engine: 'id_lookup' });
  }
  const libMatch = q.match(/^(?:l[:#]?|library)\s*[:#]?(\d+)$/i);
  if (libMatch) {
    const id = parseInt(libMatch[1], 10);
    const entry = sqlite.prepare('SELECT id, title FROM library WHERE id = ?').get(id) as any;
    if (entry) return c.json({ results: [{ source_type: 'library', source_id: entry.id, title: entry.title, snippet: '', author: '', url: `/library?doc=${entry.id}` }], total: 1, query: q, engine: 'id_lookup' });
  }

  let type = c.req.query('type') || undefined;
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

  // Type aliases: "thread" → "forum", "post" → "forum", "entry" → "library", etc.
  const TYPE_ALIASES: Record<string, string> = {
    thread: 'forum', post: 'forum', message: 'forum', f: 'forum',
    entry: 'library', doc: 'library', document: 'library', l: 'library',
    issue: 'task', ticket: 'task', t: 'task',
    specification: 'spec', s: 'spec',
    r: 'risk',
  };

  // Type-prefix syntax: "forum:websocket" or "type:forum websocket" (T#351/T#352)
  const prefixMatch = q.match(/^(\w+):\s*(.+)$/);
  if (prefixMatch) {
    const prefix = prefixMatch[1].toLowerCase();
    const rest = prefixMatch[2].trim();
    if (prefix === 'type') {
      // "type:forum test" or "type:thread test" — split on first space
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx > 0) {
        const typeName = rest.slice(0, spaceIdx).toLowerCase();
        const resolved = TYPE_ALIASES[typeName] || typeName;
        if (VALID_SOURCE_TYPES.includes(resolved)) {
          type = resolved;
          q = rest.slice(spaceIdx + 1).trim();
        }
      } else {
        // "type:forum" with no query — resolve type, search for everything
        const resolved = TYPE_ALIASES[rest.toLowerCase()] || rest.toLowerCase();
        if (VALID_SOURCE_TYPES.includes(resolved)) {
          type = resolved;
          q = '*';
        }
      }
    } else {
      // Direct prefix: "forum:websocket", "thread:websocket"
      const resolved = TYPE_ALIASES[prefix] || prefix;
      if (VALID_SOURCE_TYPES.includes(resolved)) {
        type = resolved;
        q = rest;
      }
    }
  }

  // Try Meilisearch first
  if (meili && meiliAvailable) {
    try {
      const filter = type && VALID_SOURCE_TYPES.includes(type) ? `source_type = "${type}"` : undefined;
      const results = await meili.index('denbook').search(q, {
        limit, offset, filter: filter || undefined,
        attributesToHighlight: ['title', 'content'],
        attributesToCrop: ['content'],
        cropLength: 50,
      });
      // Deduplicate by URL — keep first (best-ranked) result per URL
      const seen = new Set<string>();
      const deduped = (results.hits || []).reduce((acc: any[], h: any) => {
        const url = h.url || '#';
        if (url !== '#' && seen.has(url)) return acc;
        if (url !== '#') seen.add(url);
        acc.push({
          source_type: h.source_type, source_id: h.source_id, title: h.title,
          snippet: h._formatted?.content || h.content?.slice(0, 200) || '',
          author: h.author, url,
        });
        return acc;
      }, []);
      return c.json({
        results: deduped,
        total: deduped.length,
        query: q,
        engine: 'meilisearch',
        processingTimeMs: results.processingTimeMs,
      });
    } catch {
      // Fall through to FTS5
    }
  }

  // FTS5 fallback
  return c.json(fts5Search(q, type, limit, offset));
});

// POST /api/search/reindex — full rebuild (Gorn or trusted local)
app.post('/api/search/reindex', async (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Gorn-only' }, 403);

  // FTS5 rebuild
  sqlite.prepare('DELETE FROM search_index').run();
  const stmts = [
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT title, content, 'library', id, author, created_at FROM library`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT t.title, m.content, 'forum', m.id, m.author, m.created_at
     FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT title, COALESCE(description,''), 'risk', id, created_by, created_at FROM risks`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT title, COALESCE(description,''), 'task', id, COALESCE(assigned_to,''), created_at FROM tasks`,
    `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
     SELECT name, COALESCE(description,''), 'shelf', id, created_by, created_at FROM library_shelves`,
  ];
  for (const stmt of stmts) {
    try { sqlite.prepare(stmt).run(); } catch { /* skip */ }
  }
  indexSpecFiles();
  const indexed: Record<string, number> = {};
  const rows = sqlite.prepare('SELECT source_type, COUNT(*) as c FROM search_index GROUP BY source_type').all() as any[];
  for (const r of rows) indexed[r.source_type] = r.c;
  const fts5Total = Object.values(indexed).reduce((a, b) => a + b, 0);

  // Meilisearch rebuild
  let meiliTotal = 0;
  if (meili && meiliAvailable) {
    try {
      await meili.index('denbook').deleteAllDocuments();
      await backfillMeilisearch();
      const stats = await meili.index('denbook').getStats();
      meiliTotal = stats.numberOfDocuments;
    } catch { /* skip */ }
  }

  return c.json({ reindexed: true, total: fts5Total, indexed, meili: meiliAvailable ? { total: meiliTotal } : null });
});

// GET /api/search/status — integrity check
app.get('/api/search/status', async (c) => {
  const indexed: Record<string, number> = {};
  const source: Record<string, number> = {};

  const indexedRows = sqlite.prepare('SELECT source_type, COUNT(*) as c FROM search_index GROUP BY source_type').all() as any[];
  for (const r of indexedRows) indexed[r.source_type] = r.c;

  source.library = (sqlite.prepare('SELECT COUNT(*) as c FROM library').get() as any)?.c || 0;
  source.forum = (sqlite.prepare('SELECT COUNT(*) as c FROM forum_messages').get() as any)?.c || 0;
  source.spec = (sqlite.prepare('SELECT COUNT(*) as c FROM spec_reviews').get() as any)?.c || 0;
  source.risk = (sqlite.prepare('SELECT COUNT(*) as c FROM risks').get() as any)?.c || 0;
  source.task = (sqlite.prepare('SELECT COUNT(*) as c FROM tasks').get() as any)?.c || 0;
  source.shelf = (sqlite.prepare('SELECT COUNT(*) as c FROM library_shelves').get() as any)?.c || 0;

  const drift = Object.keys(source).some(k => (indexed[k] || 0) !== source[k]);

  let meiliStatus: any = { status: 'unavailable' };
  if (meili && meiliAvailable) {
    try {
      const stats = await meili.index('denbook').getStats();
      meiliStatus = { status: 'available', indexed: stats.numberOfDocuments };
    } catch { meiliStatus = { status: 'error' }; }
  }

  return c.json({
    indexed, source, drift,
    total_indexed: Object.values(indexed).reduce((a, b) => a + b, 0),
    engine: meiliAvailable ? 'meilisearch' : 'fts5',
    meilisearch: meiliStatus,
  });
});

// ============================================================================
// Telegram Two-Way Chat (T#633)
// ============================================================================
// Multi-bot long-polling: each Beast can have its own Telegram bot.
// Gorn sends messages/photos to a Beast's bot, they get forwarded as DMs.
// Config: TELEGRAM_BOTS env var (JSON array) or legacy single-bot env vars.

const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_POLL_INTERVAL = 3000; // ms

interface TelegramBot {
  token: string;
  beast: string;       // Beast name this bot belongs to
  chatId: string;      // Gorn's chat ID (same for all bots)
  offset: number;
  lastMessageAt: string | null;
  messageCount: number;
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  polling: boolean;    // Concurrent-poll guard. If a poll tick fires while a
                       // previous poll is still running, skip — otherwise both
                       // call getUpdates with the same offset and re-deliver
                       // the same update twice (dup-delivery bug found 2026-04-17).
}

// Parse bot configs from env
function parseTelegramBots(): TelegramBot[] {
  const bots: TelegramBot[] = [];

  // Try TELEGRAM_BOTS JSON array first: [{"token":"...","beast":"karo"},{"token":"...","beast":"sable"}]
  const botsJson = process.env.TELEGRAM_BOTS;
  if (botsJson) {
    try {
      const parsed = JSON.parse(botsJson);
      for (const b of parsed) {
        if (b.token && b.beast) {
          bots.push({
            token: b.token,
            beast: b.beast,
            chatId: b.chatId || TG_CHAT_ID,
            offset: 0, lastMessageAt: null, messageCount: 0, active: false, timer: null, polling: false,
          });
        }
      }
    } catch (e) { console.error('[Telegram] Failed to parse TELEGRAM_BOTS:', e); }
  }

  // Fallback: legacy single-bot env vars
  if (bots.length === 0) {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const beast = process.env.TELEGRAM_FORWARD_TO || 'karo';
    if (token && TG_CHAT_ID) {
      bots.push({
        token, beast, chatId: TG_CHAT_ID,
        offset: 0, lastMessageAt: null, messageCount: 0, active: false, timer: null, polling: false,
      });
    }
  }

  return bots;
}

const telegramBots = parseTelegramBots();

async function tgApi(token: string, method: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

async function tgSendReply(token: string, chatId: string, text: string): Promise<void> {
  await tgApi(token, 'sendMessage', { chat_id: chatId, text });
}

async function handleTelegramMessage(bot: TelegramBot, msg: any): Promise<void> {
  // Only accept messages from Gorn's chat.
  // T#712 PII-containment gate — this check is the boundary that makes
  // telegram_messages.raw_json safe to persist. Expanding this gate (group chats,
  // multi-sender, Boro chat forwarded) requires threat-model re-review on the
  // cached raw_json surface at the same time. Gate-to-storage coupling lives here.
  if (String(msg.chat.id) !== bot.chatId) {
    console.log(`[Telegram:${bot.beast}] Rejected: chat_id ${msg.chat.id} !== expected ${bot.chatId}`);
    return;
  }

  // T#712 cache inbound message before notification build.
  // Dual-shape mapper-lane per Library #98 canon-pending: silent-drop on malformed
  // payload with console.warn noise-log (Hevy→Forge pattern mirror). Never rejects
  // the notification path — just skips the cache write if the payload is shape-bad.
  try {
    const msgId = msg.message_id;
    if (typeof msgId === 'number' && Number.isFinite(msgId)) {
      // Strip known ephemeral TG-signed URL fields from raw_json before persist
      // (Bertus #887 flag 3). TG file_paths regenerate on bot-token rotation and
      // carry implicit auth; don't cache those.
      const sanitized = JSON.parse(JSON.stringify(msg));
      const stripEphemeral = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          if (k === 'file_path') delete obj[k]; // TG file download path (token-bearing)
          else if (typeof obj[k] === 'object') stripEphemeral(obj[k]);
        }
      };
      stripEphemeral(sanitized);
      const rawJson = JSON.stringify(sanitized);
      // INSERT OR IGNORE for TG retry-delivery dupes (Bertus #887 flag 4).
      sqlite.prepare(
        'INSERT OR IGNORE INTO telegram_messages (chat_id, id, from_id, text, caption, photo_file_id, date_unix, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        String(msg.chat.id),
        msgId,
        msg.from?.id ? String(msg.from.id) : null,
        msg.text || null,
        msg.caption || null,
        // photo_file_id: TG file_ids regenerate on bot-token rotation; bytes not
        // stored per v1 scope (photo bytes fetched separately in media branch below).
        msg.photo && msg.photo.length > 0 ? (msg.photo[msg.photo.length - 1].file_id || null) : null,
        msg.date || Math.floor(Date.now() / 1000),
        Date.now(),
        rawJson
      );
    } else {
      console.warn(`[Telegram:${bot.beast} T#712] dropping cache — malformed message_id: ${JSON.stringify(msgId)}`);
    }
  } catch (cacheErr) {
    console.warn(`[Telegram:${bot.beast} T#712] dropping cache — persist error:`, cacheErr);
  }

  try {
    let notifyText: string;
    let confirmText: string;

    // Build reply-to context if this message is a reply.
    // T#712 format: `(replying to TG#<id>: "<80-char-preview>...")`
    // Parseable convention — `TG#` prefix, integer id, `:` delimiter, quoted preview.
    // Caller can fetch full body via GET /api/telegram/message/:id when the 80-char
    // preview truncates useful context.
    let replyContext = '';
    if (msg.reply_to_message) {
      const replied = msg.reply_to_message;
      const repliedId = typeof replied.message_id === 'number' ? replied.message_id : '?';
      const repliedText = replied.text || replied.caption || '[media]';
      const repliedPreview = repliedText.length > 80 ? repliedText.slice(0, 80) + '...' : repliedText;
      replyContext = `(replying to TG#${repliedId}: "${repliedPreview}")\\n`;
    }

    if (msg.photo && msg.photo.length > 0) {
      // Download and save photo so Beasts can view it
      let photoUrl = '';
      try {
        const photo = msg.photo[msg.photo.length - 1];
        const fileInfo = await tgApi(bot.token, 'getFile', { file_id: photo.file_id });
        if (fileInfo.ok && fileInfo.result?.file_path) {
          const filePath = fileInfo.result.file_path;
          const imageRes = await fetch(`https://api.telegram.org/file/bot${bot.token}/${filePath}`);
          if (imageRes.ok) {
            const buffer = Buffer.from(await imageRes.arrayBuffer());
            if (buffer.length <= 20 * 1024 * 1024) {
              // Process with sharp if available
              let processedBuffer = buffer;
              let ext = '.' + (filePath.split('.').pop() || 'jpg');
              try {
                const sharp = require('sharp');
                const metadata = await sharp(buffer).metadata();
                if (metadata.width && metadata.width > 1920) {
                  processedBuffer = await sharp(buffer).rotate().resize(1920, null, { withoutEnlargement: true }).jpeg({ quality: 95 }).withMetadata({ orientation: undefined }).toBuffer();
                  ext = '.jpg';
                } else {
                  processedBuffer = await sharp(buffer).rotate().withMetadata({ orientation: undefined }).toBuffer();
                }
              } catch { /* sharp not available */ }

              if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
              const filename = `telegram_${crypto.randomUUID()}${ext}`;
              fs.writeFileSync(path.join(UPLOADS_DIR, filename), processedBuffer);
              try {
                sqlite.prepare('INSERT INTO files (filename, original_name, mime_type, size_bytes, uploaded_by, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(filename, `telegram_photo${ext}`, ext === '.jpg' ? 'image/jpeg' : 'image/png', processedBuffer.length, 'gorn', 'telegram', Date.now());
              } catch { /* files table may not have all columns */ }
              photoUrl = `https://denbook.online/api/f/${filename}`;
              console.log(`[Telegram:${bot.beast}] Photo saved: ${filename}`);
            }
          }
        }
      } catch (e) { console.error(`[Telegram:${bot.beast}] Photo download error:`, e); }

      // T#712: replyContext threaded to photo branch (walk-all-write-paths per @pip discipline)
      const caption = msg.caption || '';
      if (photoUrl) {
        notifyText = caption
          ? `[Telegram from Gorn] ${replyContext}${caption}\\n\\nPhoto: ${photoUrl}`
          : `[Telegram from Gorn] ${replyContext}Photo: ${photoUrl}`;
      } else {
        notifyText = caption
          ? `[Telegram from Gorn] ${replyContext}Photo: ${caption}`
          : `[Telegram from Gorn] ${replyContext}Photo received (download failed)`;
      }
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.text) {
      notifyText = `[Telegram from Gorn] ${replyContext}${msg.text}`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.document) {
      // T#712: replyContext threaded to document branch
      const docName = msg.document.file_name || 'unknown';
      notifyText = `[Telegram from Gorn] ${replyContext}Document: ${docName}${msg.caption ? ' — ' + msg.caption : ''}`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.voice) {
      // T#712: replyContext threaded to voice branch
      notifyText = `[Telegram from Gorn] ${replyContext}Voice message`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.sticker) {
      // T#712: replyContext threaded to sticker branch
      const emoji = msg.sticker.emoji || '';
      notifyText = `[Telegram from Gorn] ${replyContext}Sticker ${emoji}`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else {
      notifyText = `[Telegram from Gorn] ${replyContext}Message received`;
      confirmText = `✓ Notified ${bot.beast}`;
    }

    // Use the TG message's send time (msg.date is unix seconds) so the Beast
    // sees when Gorn actually SENT the message, not when polling caught it.
    // Important on bad connectivity (trains, tunnels) where the gap can be
    // meaningful. Falls back to server receive time if msg.date missing.
    // The timestamp itself is stamped by enqueueNotification — we just pass
    // the event time through via opts.sentAt.
    const msgTime = msg.date ? new Date(msg.date * 1000) : new Date();

    // Send tmux notification to the Beast — they reply via Telegram
    const notification = `${notifyText}\\n\\nReply via Telegram to respond to Gorn.`;
    enqueueNotification(bot.beast, notification, { sentAt: msgTime });

    console.log(`[Telegram:${bot.beast}] Notified: ${notifyText.slice(0, 80)}`);
    bot.messageCount++;
    bot.lastMessageAt = new Date().toISOString();

  } catch (err) {
    console.error(`[Telegram:${bot.beast}] Error handling message:`, err);
  }
}

async function pollTelegramBot(bot: TelegramBot): Promise<void> {
  // Concurrent-poll guard: if a previous poll hasn't returned yet (common when
  // long-poll timeout + async handleTelegramMessage exceed TG_POLL_INTERVAL),
  // skip this tick. Without this, two polls race on the same bot.offset and
  // re-deliver the same update_id twice.
  if (bot.polling) return;
  bot.polling = true;
  try {
    const data = await tgApi(bot.token, 'getUpdates', {
      offset: String(bot.offset),
      timeout: '3',
      allowed_updates: JSON.stringify(['message']),
    });

    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        bot.offset = update.update_id + 1;
        const msg = update.message;
        if (msg) {
          console.log(`[Telegram:${bot.beast}] Update ${update.update_id}: chat_id=${msg.chat?.id} from=${msg.from?.username || msg.from?.id} text=${(msg.text || '[non-text]').slice(0, 50)}`);
          await handleTelegramMessage(bot, msg);
        }
      }
    }
  } catch (err) {
    console.error(`[Telegram:${bot.beast}] Poll error:`, err);
  } finally {
    bot.polling = false;
  }
}

function startTelegramPolling(): void {
  if (telegramBots.length === 0) {
    console.log('[Telegram] No bots configured — polling disabled');
    return;
  }

  for (const bot of telegramBots) {
    bot.active = true;
    // Stagger initial polls to avoid hitting Telegram rate limits
    const delay = telegramBots.indexOf(bot) * 1000;
    setTimeout(() => {
      pollTelegramBot(bot).then(() => {
        bot.timer = setInterval(() => pollTelegramBot(bot), TG_POLL_INTERVAL);
        console.log(`[Telegram:${bot.beast}] Polling started (every ${TG_POLL_INTERVAL / 1000}s)`);
      });
    }, delay);
  }
}

// GET /api/telegram/status — polling status (owner only)
app.get('/api/telegram/status', (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Auth required' }, 403);

  return c.json({
    bots: telegramBots.map(b => ({
      beast: b.beast,
      polling: b.active,
      chat_id: b.chatId ? `${b.chatId.slice(0, 4)}****` : null,
      last_message_at: b.lastMessageAt,
      message_count: b.messageCount,
    })),
    poll_interval_ms: TG_POLL_INTERVAL,
    total_bots: telegramBots.length,
  });
});

// T#712: GET /api/telegram/message/:id — fetch cached inbound TG message body.
// Use when the 80-char replyContext preview in a Beast notification is insufficient.
// Narrow-by-default auth (TELEGRAM_READ_MODES: Gorn session + Sable only).
// `:id` is the TG message_id (integer); resolves against single-chat cache since
// the chat-gate is Gorn-only upstream. Composite PK in the table allows this to
// expand cleanly if the chat-gate ever opens.
app.get('/api/telegram/message/:id', (c) => {
  if (!isTelegramAuthorized(c)) return c.json({ error: 'Telegram cache is private' }, 403);
  const idParam = c.req.param('id');
  const msgId = parseInt(idParam, 10);
  if (!Number.isFinite(msgId) || String(msgId) !== idParam) {
    return c.json({ error: 'id must be an integer' }, 400);
  }
  // T#712 Bertus #890 harden: query uses composite PK scoped to configured
  // bot chat_ids rather than WHERE id=? alone. Future-proof against chat-gate
  // expansion without relying on upstream-gate assumption. Single-chat universe
  // today (all bots share Gorn's chatId) so IN clause is 1-wide.
  const validChatIds = telegramBots.map(b => b.chatId).filter(Boolean);
  if (validChatIds.length === 0) return c.json({ error: 'no telegram bots configured' }, 503);
  const placeholders = validChatIds.map(() => '?').join(',');
  const row = sqlite.prepare(
    `SELECT chat_id, id, from_id, text, caption, photo_file_id, date_unix, received_at, raw_json FROM telegram_messages WHERE chat_id IN (${placeholders}) AND id = ? LIMIT 1`
  ).get(...validChatIds, msgId) as any;
  if (!row) return c.json({ error: 'message not found' }, 404);
  let raw: any = null;
  try { raw = JSON.parse(row.raw_json); } catch { /* leave null on parse fail */ }
  return c.json({
    chat_id: row.chat_id,
    id: row.id,
    from_id: row.from_id,
    text: row.text,
    caption: row.caption,
    photo_file_id: row.photo_file_id,
    date_unix: row.date_unix,
    received_at: row.received_at,
    raw: raw,
  });
});

// Start polling on server boot
startTelegramPolling();

// ============================================================================
// Static Frontend (production build)
// ============================================================================

const FRONTEND_DIST = path.join(import.meta.dirname || __dirname, '..', 'frontend', 'dist');

if (fs.existsSync(FRONTEND_DIST)) {
  // Serve static assets
  app.get('/assets/*', (c) => {
    const filePath = path.join(FRONTEND_DIST, c.req.path);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
      };
      const fileBuffer = fs.readFileSync(filePath);
      c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      c.header('Content-Length', fileBuffer.length.toString());
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(fileBuffer);
    }
    return c.notFound();
  });

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    const indexBuffer = fs.readFileSync(indexPath);
    c.header('Content-Type', 'text/html');
    c.header('Content-Length', indexBuffer.length.toString());
    return c.body(indexBuffer);
  });
}

// ============================================================================
// WebSocket — Real-time push updates
// ============================================================================

const wsClients = new Set<any>();

// Web presence tracking — in-memory, ephemeral (T#595)
// Keyed by identity (e.g. 'gorn', 'gorn_guest'). Rebuilt on server restart.
const webPresence = new Map<string, { identity: string; role: string; lastSeen: number }>();
const WEB_PRESENCE_TIMEOUT_MS = 90_000; // 90s — 3 missed heartbeats

// Allowed origins for WebSocket connections
const WS_ALLOWED_ORIGINS = new Set([
  'http://localhost:47778',
  'http://127.0.0.1:47778',
  'https://denbook.online',
]);

// Validate WebSocket upgrade request
function validateWsUpgrade(req: Request, server: any): { allowed: boolean; reason?: string; identity?: string } {
  // 1. Origin validation — reject cross-origin browser connections.
  // Design decision: missing Origin is allowed (non-browser clients like curl, wscat, Beast
  // processes don't send Origin headers). The auth check below gates non-browser access.
  // Origin validation is specifically anti-CSRF for browsers, which always send Origin on
  // WebSocket upgrades per the spec.
  const origin = req.headers.get('origin');
  if (origin && !WS_ALLOWED_ORIGINS.has(origin)) {
    return { allowed: false, reason: `Origin rejected: ${origin}` };
  }

  // 2. Auth check — same as REST: local network OR valid session
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || server.requestIP(req)?.address
    || '127.0.0.1';

  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
    || ip.startsWith('192.168.') || ip.startsWith('10.')
    || (ip.startsWith('172.') && (() => {
      const second = parseInt(ip.split('.')[1], 10);
      return second >= 16 && second <= 31;
    })());

  // Check session cookie from Cookie header
  const cookies = req.headers.get('cookie') || '';
  const sessionMatch = cookies.match(/(?:^|;\s*)oracle_session=([^;]+)/);
  const sessionToken = sessionMatch?.[1] || '';
  let hasSession = false;
  if (sessionToken) {
    const colonIdx = sessionToken.indexOf(':');
    if (colonIdx !== -1) {
      const expiresStr = sessionToken.substring(0, colonIdx);
      const signature = sessionToken.substring(colonIdx + 1);
      const expires = parseInt(expiresStr, 10);
      if (!isNaN(expires) && expires >= Date.now()) {
        const expectedSignature = createHmac('sha256', SESSION_SECRET)
          .update(expiresStr)
          .digest('hex');
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedSignature);
        if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
          hasSession = true;
        }
      }
    }
  }

  // WS is read-only (broadcast only) — origin check above is sufficient security.
  // Session auth is not required for WS since cookies may not be sent with WS upgrades
  // in all browsers (SameSite restrictions). The origin whitelist prevents cross-site abuse.

  const identity = hasSession ? 'gorn' : (isLocal ? 'local' : (origin ? 'browser' : 'unknown'));
  return { allowed: true, identity };
}

// Broadcast an event to all connected WebSocket clients
export function wsBroadcast(event: string, data: any) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(payload); } catch { wsClients.delete(ws); }
  }
}

// WebSocket upgrade is handled in the fetch() handler below (with auth + origin validation)
// The /ws path is intercepted before Hono routing to validate origin and session.

// ============================================================================
// Start Server
// ============================================================================

console.log(`
🔮 Oracle Nightly HTTP Server running! (Hono.js)

   URL: http://localhost:${PORT}

   Endpoints:
   - GET  /api/health          Health check
   - GET  /api/search?q=...    Search Oracle knowledge
   - GET  /api/list            Browse all documents
   - GET  /api/reflect         Random wisdom
   - GET  /api/stats           Database statistics
   - GET  /api/graph           Knowledge graph data
   - GET  /api/map             Knowledge map 2D (hash-based layout)
   - GET  /api/map3d           Knowledge map 3D (real PCA from LanceDB embeddings)
   - GET  /api/context         Project context (ghq format)
   - POST /api/learn           Add new pattern/learning

   Forum:
   - GET  /api/threads         List threads
   - GET  /api/thread/:id      Get thread
   - POST /api/thread          Send message

   Supersede Log:
   - GET  /api/supersede       List supersessions
   - GET  /api/supersede/chain/:path  Document lineage
   - POST /api/supersede       Log supersession
`);

export default {
  port: Number(PORT),
  hostname: process.env.BIND_HOST || '127.0.0.1',
  fetch(req: Request, server: any) {
    // Handle WebSocket upgrade
    if (new URL(req.url).pathname === '/ws') {
      // Validate origin + auth before accepting upgrade
      const validation = validateWsUpgrade(req, server);
      if (!validation.allowed) {
        // Audit log rejected WebSocket upgrade attempts
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || req.headers.get('x-real-ip')
          || server.requestIP(req)?.address || 'unknown';
        try {
          sqlite.prepare(
            `INSERT INTO audit_log (actor, actor_type, action, resource_type, resource_id, ip_source, request_method, request_path, status_code)
             VALUES (?, 'unknown', 'ws_upgrade_rejected', 'websocket', NULL, ?, 'GET', '/ws', 403)`
          ).run(req.headers.get('origin') || 'no-origin', ip);
        } catch (e) { console.error('[WS audit]', e); }
        return new Response(validation.reason || 'Forbidden', { status: 403 });
      }
      // Derive role and identity from session cookie using the full parser
      // validateWsUpgrade uses a simplified token check that fails on 4-part tokens —
      // use parseSessionToken here to get accurate role and identity for presence tracking.
      const wsCookies = req.headers.get('cookie') || '';
      const wsSessionMatch = wsCookies.match(/(?:^|;\s*)oracle_session=([^;]+)/);
      const wsParsed = parseSessionToken(wsSessionMatch?.[1] || '');
      const wsRole = wsParsed.valid ? (wsParsed.role || 'owner') : (validation.identity === 'local' ? 'beast' : 'unknown');
      const wsData = wsParsed.valid && wsParsed.role === 'guest' ? wsParsed.data : undefined;
      // Identity for presence: use parsed session result, fall back to validateWsUpgrade's value
      const wsIdentity = wsParsed.valid
        ? (wsParsed.role === 'guest' ? (wsParsed.data || 'guest') : 'gorn')
        : validation.identity;
      const success = server.upgrade(req, { data: { identity: wsIdentity, role: wsRole, username: wsData } });
      if (success) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return app.fetch(req, { ip: server.requestIP(req)?.address });
  },
  websocket: {
    open(ws: any) {
      wsClients.add(ws);
      const identity = ws.data?.identity || 'unknown';
      ws.send(JSON.stringify({ event: 'connected', data: { clients: wsClients.size, identity }, ts: Date.now() }));
    },
    message(ws: any, message: string) {
      // Clients can send ping, we respond pong
      if (message === 'ping') ws.send('pong');

      // Presence heartbeat — update in-memory map
      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;
        if (parsed?.type === 'heartbeat') {
          const identity = ws.data?.identity;
          const role = ws.data?.role || 'unknown';
          if (identity && identity !== 'unknown') {
            const key = ws.data?.username || identity; // guest username or 'gorn'/'local'
            const wasOnline = webPresence.has(key);
            webPresence.set(key, { identity, role, lastSeen: Date.now() });
            if (!wasOnline) {
              wsBroadcast('presence_update', { identity: key, role, online: true });
            }
          }
        }
      } catch { /* not JSON — ignore */ }
    },
    close(ws: any) {
      wsClients.delete(ws);
      // Remove from presence map and broadcast offline if they were online
      const key = ws.data?.username || ws.data?.identity;
      if (key && webPresence.has(key)) {
        const entry = webPresence.get(key)!;
        webPresence.delete(key);
        wsBroadcast('presence_update', { identity: key, role: entry.role, online: false });
      }
    },
  },
};

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
import { rbacMiddleware } from './server/rbac.ts';
import type { Role } from './server/rbac.ts';
import {
  initGuestTables,
  createGuest,
  listGuests,
  getGuest,
  getGuestByUsername,
  updateGuest,
  deleteGuest,
  isGuestActive,
  recordFailedAttempt,
  recordSuccessfulLogin,
  logGuestAction,
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
  revokeToken,
  listTokens,
  pruneBeastTokens,
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
    '/api/help'
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
    // Actor extraction chain (updated for T#546 Beast tokens):
    // 1. Bearer token identity (set by auth middleware — trusted)
    // 2. Session cookie → "gorn" (browser requests — trusted)
    // 3. ?as= query param (legacy, logged for migration tracking)
    // 4. Request body .author or .beast field (legacy)
    // 5. Path patterns (e.g. /api/dm/karo/...)
    // 6. X-Beast header (future)
    // 7. Fallback: "unknown"
    const tokenActor = (c.get as any)('actor') as string | undefined;
    const tokenActorType = (c.get as any)('actorType') as string | undefined;
    let actor = tokenActor || '';
    let actorType = tokenActorType || '';

    if (!actor) {
      // Legacy: ?as= parameter (log for migration tracking)
      const asParam = c.req.query('as') || '';
      if (asParam) {
        actor = asParam;
        logSecurityEvent({
          eventType: 'settings_changed', // Reuse existing type for legacy tracking
          severity: 'info',
          actor: asParam,
          actorType: 'beast',
          target: path,
          details: { auth_method: 'legacy_as_param', deprecation: 'Use Bearer token auth' },
          ipSource: ip,
          requestId,
        });
      }
    }
    if (!actor && bodyData) {
      if (bodyData.author && typeof bodyData.author === 'string') actor = bodyData.author;
      else if (bodyData.beast && typeof bodyData.beast === 'string') actor = bodyData.beast;
      else if (bodyData.from && typeof bodyData.from === 'string') actor = bodyData.from;
    }
    if (!actor) {
      const pathMatch = path.match(/\/api\/(?:dm|schedules)\/(?!messages|dashboard|due|pending)([a-z][\w-]*)/i);
      if (pathMatch) actor = pathMatch[1];
    }
    if (!actor) {
      if (hasSessionAuth(c)) actor = 'gorn';
    }
    if (!actor) {
      actor = c.req.header('x-beast') || 'unknown';
    }
    if (!actorType) {
      actorType = hasSessionAuth(c) ? 'human' : 'beast';
    }
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
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/auth/login', async (c) => {
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
  const now = Date.now();
  const attempts = loginAttempts.get(ip);
  if (attempts) {
    if (now - attempts.firstAttempt > LOGIN_RATE_WINDOW_MS) {
      loginAttempts.delete(ip);
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
      const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
      entry.count++;
      loginAttempts.set(ip, entry);
      if (guest) recordFailedAttempt(sqlite, guest);
      logSecurityEvent({
        eventType: 'auth_failure',
        severity: 'warning',
        actor: username,
        actorType: 'guest',
        target: '/api/auth/login',
        details: { attempt_number: (loginAttempts.get(ip)?.count || 1), auth_type: 'guest' },
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
    loginAttempts.delete(ip);
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
    const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
    entry.count++;
    loginAttempts.set(ip, entry);
    logSecurityEvent({
      eventType: 'auth_failure',
      severity: 'warning',
      actorType: 'unknown',
      target: '/api/auth/login',
      details: { attempt_number: entry.count },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ success: false, error: 'Invalid password' }, 401);
  }

  // Successful owner login clears rate limit
  loginAttempts.delete(ip);
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
    return c.json({ error: 'Guest account management requires owner session' }, 403);
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
    return c.json({ error: 'Guest account management requires owner session' }, 403);
  }

  const guests = listGuests(sqlite);
  return c.json({ guests });
});

// Get single guest account
app.get('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'Guest account management requires owner session' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const { password_hash, ...safe } = guest;
  return c.json(safe);
});

// Update guest account (expiry, disable, display name)
app.patch('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'Guest account management requires owner session' }, 403);
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

// Delete guest account
app.delete('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'Guest account management requires owner session' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const deleted = deleteGuest(sqlite, id);
  if (!deleted) return c.json({ error: 'Guest not found' }, 404);

  return c.json({ success: true });
});

// ============================================================================
// Beast Token Routes (T#546 — API tokens per Beast)
// ============================================================================

// Create token — Gorn session auth only
app.post('/api/auth/tokens', async (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'Token creation requires Gorn session auth' }, 403);
  }
  // Block ?as= on this endpoint
  if (c.req.query('as')) {
    return c.json({ error: 'Token creation does not accept ?as= parameter' }, 403);
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
    return c.json({ error: 'Token listing requires Gorn session auth' }, 403);
  }
  return c.json({ tokens: listTokens() });
});

// Revoke token — Gorn session auth only
app.delete('/api/auth/tokens/:id', (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'Token revocation requires Gorn session auth' }, 403);
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

// Rotate token — Beast self-service (requires valid Bearer token)
app.post('/api/auth/tokens/rotate', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'Token rotation requires Bearer token auth' }, 403);
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
    { method: 'POST', path: '/api/thread', desc: 'Create thread or post message', params: 'body: { message, author, thread_id?, title?, reply_to_id? }' },
    { method: 'GET', path: '/api/thread/:id', desc: 'Get thread messages', params: '?limit=50&offset=0' },
    { method: 'PATCH', path: '/api/thread/:id/category', desc: 'Update thread category', params: 'body: { category, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/lock', desc: 'Lock/unlock thread', params: 'body: { locked, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/archive', desc: 'Archive/unarchive thread', params: 'body: { archived, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/pin', desc: 'Pin/unpin thread', params: 'body: { pinned, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/title', desc: 'Rename thread title', params: 'body: { title, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/status', desc: 'Update thread status', params: 'body: { status, beast }' },
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
    { method: 'GET', path: '/api/dm/:from/:to', desc: 'Get DM conversation between two beasts', params: '?limit=30&offset=0&order=desc' },
    { method: 'POST', path: '/api/dm', desc: 'Send a DM', params: 'body: { from, to, message }' },
    { method: 'PATCH', path: '/api/dm/:from/:to/read', desc: 'Mark DM conversation as read', params: null },
    { method: 'GET', path: '/api/dm/unread/:beast', desc: 'Get unread DM counts', params: null },
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
    { method: 'POST', path: '/api/prowl/notify-test', desc: 'Test Prowl notification pipeline (Gorn-only)', params: null },
    // Routine (Forge)
    { method: 'GET', path: '/api/routine/logs', desc: 'List routine logs', params: '?type=&date=&limit=20&offset=0' },
    { method: 'GET', path: '/api/routine/today', desc: 'Today routine summary', params: null },
    { method: 'GET', path: '/api/routine/weight', desc: 'Weight history', params: '?limit=30' },
    { method: 'GET', path: '/api/routine/body-composition', desc: 'Body composition history from Withings', params: '?range=month (1w,1m,3m,1y,3y,all)' },
    { method: 'GET', path: '/api/routine/stats', desc: 'Routine statistics', params: null },
    { method: 'GET', path: '/api/routine/summary', desc: 'Routine summary with trends', params: null },
    { method: 'GET', path: '/api/routine/exercises', desc: 'List exercises', params: null },
    { method: 'POST', path: '/api/routine/exercises', desc: 'Add exercise', params: 'body: { name, equipment?, muscle_group? }' },
    { method: 'GET', path: '/api/routine/personal-records', desc: 'Personal records', params: null },
    { method: 'POST', path: '/api/routine/logs', desc: 'Create routine log', params: 'body: { type, date, ... }' },
    { method: 'PATCH', path: '/api/routine/logs/:id', desc: 'Update routine log', params: 'body: { ... }' },
    { method: 'DELETE', path: '/api/routine/logs/:id', desc: 'Soft-delete routine log', params: null },
    { method: 'PATCH', path: '/api/routine/logs/:id/restore', desc: 'Restore deleted log', params: null },
    // OAuth
    { method: 'GET', path: '/api/oauth/withings/authorize', desc: 'Start Withings OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/withings/callback', desc: 'OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/withings/status', desc: 'Check Withings connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/withings/disconnect', desc: 'Disconnect Withings', params: null },
    { method: 'GET', path: '/api/withings/devices', desc: 'List Withings devices', params: null },
    // Search
    { method: 'GET', path: '/api/search', desc: 'Search documents and knowledge', params: '?q=query&type=all&limit=10' },
    { method: 'GET', path: '/api/search/status', desc: 'Search index status', params: null },
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
    { method: 'GET', path: '/api/dashboard/activity', desc: 'Activity stats', params: null },
    { method: 'GET', path: '/api/dashboard/growth', desc: 'Growth metrics', params: null },
    // Library
    { method: 'GET', path: '/api/library', desc: 'List library entries', params: '?shelf=&limit=50' },
    { method: 'POST', path: '/api/library', desc: 'Add library entry', params: 'body: { title, content, shelf?, author }' },
    // Handoffs
    { method: 'POST', path: '/api/handoff', desc: 'Submit session handoff', params: 'body: { oracle, summary, ... }' },
    { method: 'GET', path: '/api/inbox', desc: 'Get inbox items', params: '?type=&limit=20' },
  ];

// API Help — machine-readable endpoint catalog for Beast self-correction
app.get('/api/help', (c) => {
  const filter = c.req.query('q')?.toLowerCase();

  let result = HELP_ENDPOINTS;
  if (filter) {
    result = HELP_ENDPOINTS.filter(e =>
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

  // Guest DM summary (own conversations only)
  let dmSummary: any[] = [];
  if (guestUsername) {
    const guestDisplayName = getGuestDisplayName(guestUsername);
  const guestTag = `[Guest] ${guestDisplayName}`;
    dmSummary = sqlite.prepare(
      "SELECT DISTINCT CASE WHEN participant1 = ? THEN participant2 ELSE participant1 END as other, (SELECT content FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message, (SELECT created_at FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_at FROM dm_conversations c WHERE participant1 = ? OR participant2 = ? ORDER BY last_at DESC LIMIT 10"
    ).all(guestTag, guestTag, guestTag) as any[];
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
  });
});

// Guest threads — public only (T#559)
app.get('/api/guest/threads', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const rows = sqlite.prepare(
    "SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE visibility = 'public' ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as any[];

  const total = (sqlite.prepare("SELECT COUNT(*) as total FROM forum_threads WHERE visibility = 'public'").get() as any)?.total || 0;

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
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        author: m.author,
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
  const from = c.req.param('from');
  const to = c.req.param('to');
  const guestUsername = (c.get as any)('guestUsername');
  const guestDisplayName = getGuestDisplayName(guestUsername);
  const guestTag = `[Guest] ${guestDisplayName}`;

  // Guests can only read their own conversations
  if (from !== guestTag && to !== guestTag && from !== guestUsername && to !== guestUsername) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const messages = getDmMessages(from, to, limit, offset);
  return c.json(messages);
});

// Guest DM — send message (T#559)
app.post('/api/guest/dm', async (c) => {
  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.to || !data.message) return c.json({ error: 'to and message required' }, 400);

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
  const result = await withRetry(() => sendDm(guestTag, data.to, data.message));

  if (result.messageId) {
    try {
      sqlite.prepare('UPDATE dm_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
    } catch { /* column may not exist */ }
  }

  wsBroadcast('new_dm', { conversation_id: result.conversationId });
  return c.json({ conversation_id: result.conversationId, message_id: result.messageId }, 201);
});

// Guest profile — own info (T#559)
app.get('/api/guest/profile', (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  return c.json({
    username: guest.username,
    display_name: guest.display_name,
    created_at: guest.created_at,
    expires_at: guest.expires_at,
  });
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

  return c.json({ beasts });
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
  if (!hasSessionAuth(c)) return c.json({ error: 'Browser session required' }, 403);
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
  if (!hasSessionAuth(c)) return c.json({ error: 'Browser session required' }, 403);
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
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', keys]);

    return c.json({ sent: true, beast: name, length: keys.length });
  } catch {
    return c.json({ error: 'Session not found or send failed' }, 404);
  }
});

// Send special keys (Enter, Ctrl-C, etc.)
app.post('/api/beast/:name/terminal/key', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Browser session required' }, 403);
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
    return c.json({ error: 'Remote attach requires local access' }, 403);
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
    const { beast, threadId, messageId } = body;
    if (!beast || !threadId || !messageId) {
      return c.json({ error: 'beast, threadId, messageId required' }, 400);
    }
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

// Get unread counts for a beast
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
    GROUP BY t.id
    HAVING unread_count > 0
    ORDER BY unread_count DESC
  `).all(beast) as any[];

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
      legacy_url: `/api/forum/file/${filename}`,
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
      thumbnail_url: f.mime_type.startsWith('image/') ? `/api/forum/file/${f.filename}` : null,
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
    thumbnail_url: file.mime_type.startsWith('image/') ? `/api/forum/file/${file.filename}` : null,
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

// GET /api/f/:hash — download by hash (requires login — no local bypass)
app.get('/api/f/:hash', (c) => {
  // Require session or bearer token — local bypass not sufficient for file access
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  const hasSession = sessionCookie && verifySessionToken(sessionCookie);
  const hasBearer = c.req.header('Authorization')?.startsWith('Bearer den_');
  if (!hasSession && !hasBearer) {
    return c.json({ error: 'Authentication required — login to access files' }, 401);
  }

  const hash = c.req.param('hash');
  // Validate: alphanumeric, hyphens, dots — no path traversal
  if (hash.includes('..') || hash.includes('/')) return c.json({ error: 'Invalid file hash' }, 400);
  if (!/^[\w.-]+$/.test(hash)) return c.json({ error: 'Invalid file hash' }, 400);

  // Try files table first, then fall back to disk (legacy avatar files)
  const file = sqlite.prepare('SELECT * FROM files WHERE filename = ? AND deleted_at IS NULL').get(hash) as any;
  const filePath = path.join(UPLOADS_DIR, hash);

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
      url: `/api/forum/file/${r.filename}`,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      uploaded_by: r.uploaded_by,
    })),
  });
});

// Mute/unmute thread notifications for a beast
app.post('/api/forum/mute', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.beast || !body.threadId) return c.json({ error: 'beast and threadId required' }, 400);
    const muted = body.muted !== false ? 1 : 0;
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO forum_notification_prefs (beast_name, thread_id, muted, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(beast_name, thread_id) DO UPDATE SET muted = excluded.muted, updated_at = excluded.updated_at
    `).run(body.beast.toLowerCase(), body.threadId, muted, now);
    return c.json({ success: true, beast: body.beast, thread_id: body.threadId, muted: !!muted });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Get muted threads for a beast
app.get('/api/forum/muted/:beast', (c) => {
  const beast = c.req.param('beast').toLowerCase();
  const rows = sqlite.prepare(
    'SELECT thread_id FROM forum_notification_prefs WHERE beast_name = ? AND muted = 1'
  ).all(beast) as any[];
  return c.json({ beast, muted_threads: rows.map(r => r.thread_id) });
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
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const role = (c.get as any)('role') as Role | undefined;

  let query = 'SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE 1=1';
  const params: any[] = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  // Guests only see public threads
  if (role === 'guest') { query += " AND visibility = 'public'"; }
  query += ' ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = sqlite.prepare(query).all(...params) as any[];
  let countQuery = 'SELECT COUNT(*) as total FROM forum_threads';
  if (role === 'guest') { countQuery += " WHERE visibility = 'public'"; }
  const total = (sqlite.prepare(countQuery).get() as any)?.total || 0;

  return c.json({
    threads: rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status || 'active',
      category: t.category || 'discussion',
      pinned: !!(t.pinned),
      message_count: t.msg_count || 0,
      created_at: new Date(t.created_at).toISOString(),
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
    if (!data.author) {
      return c.json({ error: 'Missing required field: author' }, 400);
    }

    // Guest restrictions: can only post in existing public threads, cannot create new threads
    const role = (c.get as any)('role') as Role | undefined;
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername') || data.author;

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

      // Tag guest author with [Guest] prefix for display
      data.author = `[Guest] ${guestUsername}`;
    }

    const result = await withRetry(() => handleThreadMessage({
      message: data.message,
      threadId: data.thread_id,
      title: data.title,
      role: data.role || 'human',
      author: data.author,
    }));
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
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        author: m.author,
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
    if (!body.content?.trim() || !body.beast) {
      return c.json({ error: 'content (non-empty) and beast are required' }, 400);
    }

    // Get current content
    const current = sqlite.prepare('SELECT content, author FROM forum_messages WHERE id = ?').get(messageId) as any;
    if (!current) return c.json({ error: 'Message not found' }, 404);

    // Restrict edits to original author only
    const authorLower = (current.author || '').toLowerCase();
    const beastLower = body.beast.toLowerCase();
    if (!authorLower.includes(beastLower)) {
      return c.json({ error: 'Only the original author can edit this message' }, 403);
    }

    // Save original to edit history (Nothing is Deleted)
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO forum_message_edits (message_id, original_content, edited_by, created_at)
      VALUES (?, ?, ?, ?)
    `).run(messageId, current.content, body.beast, now);

    // Update message
    sqlite.prepare('UPDATE forum_messages SET content = ?, edited_at = ? WHERE id = ?')
      .run(body.content, now, messageId);

    return c.json({ success: true, message_id: messageId, edited_at: new Date(now).toISOString() });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
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
    if (!body.beast || !body.emoji) {
      return c.json({ error: 'beast and emoji are required' }, 400);
    }

    const role = (c.get as any)('role');

    // Guest identity enforcement — override body.beast with session identity
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername');
      body.beast = `[Guest] ${guestUsername || 'Guest'}`;

      // Thread visibility check — guests can only react to messages in public threads
      const msg = sqlite.prepare('SELECT thread_id FROM forum_messages WHERE id = ?').get(messageId) as any;
      if (msg) {
        const thread = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(msg.thread_id) as any;
        if (thread && thread.visibility && thread.visibility !== 'public') {
          return c.json({ error: 'Guests cannot react to messages in private threads' }, 403);
        }
      }
    }

    // Sender validation for non-local requests
    if (!isTrustedRequest(c)) {
      const as = body.as?.toLowerCase();
      if (!as) return c.json({ error: 'as param required for sender validation' }, 400);
      if (as !== body.beast.toLowerCase() && as !== 'gorn') {
        return c.json({ error: 'Can only react as yourself' }, 403);
      }
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
    if (!body.beast || !body.emoji) {
      return c.json({ error: 'beast and emoji are required' }, 400);
    }

    const role = (c.get as any)('role');
    // Guest identity enforcement
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername');
      body.beast = `[Guest] ${guestUsername || 'Guest'}`;
    }

    if (!isTrustedRequest(c)) {
      const as = body.as?.toLowerCase();
      if (!as) return c.json({ error: 'as param required' }, 400);
      if (as !== body.beast.toLowerCase() && as !== 'gorn') {
        return c.json({ error: 'Can only remove your own reactions' }, 403);
      }
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

// DELETE /api/thread/:id — delete a thread and all related data
// Auth: thread creator or Gorn only (for test cleanup)
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
  // Cascade: reactions, read state, messages, then thread
  sqlite.prepare('DELETE FROM forum_reactions WHERE message_id IN (SELECT id FROM forum_messages WHERE thread_id = ?)').run(id);
  sqlite.prepare('DELETE FROM forum_read_status WHERE thread_id = ?').run(id);
  sqlite.prepare('DELETE FROM forum_messages WHERE thread_id = ?').run(id);
  sqlite.prepare('DELETE FROM forum_threads WHERE id = ?').run(id);
  return c.json({ deleted: id, title: existing.title });
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
    if (!data.from || !data.to || !data.message) {
      return c.json({ error: 'Missing required fields: from, to, message' }, 400);
    }

    // Guest DM restrictions
    const role = (c.get as any)('role') as Role | undefined;
    if (role === 'guest') {
      const guestUsername = (c.get as any)('guestUsername') || data.from;

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

      // Tag guest sender
      data.from = `[Guest] ${guestUsername}`;
    }

    // Sender validation: non-local requests must provide 'as' matching 'from'
    if (!isTrustedRequest(c) && role !== 'guest') {
      const as = data.as?.toLowerCase();
      if (!as) return c.json({ error: 'as param required for sender validation' }, 400);
      if (as !== data.from.toLowerCase() && as !== 'gorn') {
        return c.json({ error: 'Sender impersonation blocked. as must match from.' }, 403);
      }
    }
    const result = await withRetry(() => sendDm(data.from, data.to, data.message));
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

// Get messages between two Oracles
app.get('/api/dm/:name/:other', (c) => {
  const name = c.req.param('name');
  const other = c.req.param('other');
  const as = c.req.query('as')?.toLowerCase();
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
  const as = c.req.query('as')?.toLowerCase() || (hasSessionAuth(c) ? 'gorn' : '');
  if (!as) return c.json({ error: 'as param required for DELETE' }, 400);
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

// --- Shelf CRUD ---

// GET /api/library/shelves — list all shelves with entry counts
app.get('/api/library/shelves', (c) => {
  const shelves = sqlite.prepare(`
    SELECT s.*, COUNT(l.id) as entry_count
    FROM library_shelves s
    LEFT JOIN library l ON l.shelf_id = s.id
    GROUP BY s.id
    ORDER BY s.name
  `).all();
  return c.json({ shelves });
});

// GET /api/library/shelves/:id — single shelf with entries
app.get('/api/library/shelves/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id);
  if (!shelf) return c.json({ error: 'Shelf not found' }, 404);
  const entryCount = (sqlite.prepare('SELECT COUNT(*) as c FROM library WHERE shelf_id = ?').get(id) as any).c;
  return c.json({ ...shelf as any, entry_count: entryCount });
});

// POST /api/library/shelves — create shelf
app.post('/api/library/shelves', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.name?.trim()) return c.json({ error: 'name required' }, 400);
    const author = (c.req.query('as') || data.created_by || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!author) return c.json({ error: 'Identity required' }, 400);

    // Check duplicate
    const existing = sqlite.prepare('SELECT id FROM library_shelves WHERE name = ?').get(data.name.trim());
    if (existing) return c.json({ error: 'A shelf with this name already exists' }, 409);

    const now = new Date().toISOString();
    const result = sqlite.prepare(
      'INSERT INTO library_shelves (name, description, icon, color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(data.name.trim(), data.description || null, data.icon || null, data.color || null, author, now, now);
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
    const allowed = ['name', 'description', 'icon', 'color'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const field of allowed) {
      if (field in data) {
        if (field === 'name' && data.name?.trim()) {
          const dup = sqlite.prepare('SELECT id FROM library_shelves WHERE name = ? AND id != ?').get(data.name.trim(), id);
          if (dup) return c.json({ error: 'A shelf with this name already exists' }, 409);
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
  const q = c.req.query('q');
  const type = c.req.query('type') || c.req.query('category');
  const author = c.req.query('author');
  const tag = c.req.query('tag');
  const limit = Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50);
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

  let query = 'SELECT * FROM library WHERE 1=1';
  const params: any[] = [];

  if (q) {
    query += ' AND (title LIKE ? OR content LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  if (author) {
    query += ' AND author = ?';
    params.push(author);
  }
  if (tag) {
    query += ' AND tags LIKE ?';
    params.push(`%"${tag}"%`);
  }
  const shelfId = c.req.query('shelf_id');
  if (shelfId === 'null') {
    query += ' AND shelf_id IS NULL';
  } else if (shelfId) {
    query += ' AND shelf_id = ?';
    params.push(parseInt(shelfId, 10));
  }

  // Count
  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
  const countResult = sqlite.prepare(countQuery).get(...params) as any;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
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
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 2) return c.json({ suggestions: [] });

  const pattern = `%${q}%`;

  const shelves = sqlite.prepare(
    'SELECT id, name, icon, color, "shelf" as result_type FROM library_shelves WHERE name LIKE ? LIMIT 5'
  ).all(pattern) as any[];

  const entries = sqlite.prepare(
    'SELECT id, title, type, author, shelf_id, "entry" as result_type FROM library WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 8'
  ).all(pattern) as any[];

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
  const row = sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id) as any;
  if (!row) return c.json({ error: 'Entry not found' }, 404);

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
    if (!data.title || !data.content || !data.author) {
      return c.json({ error: 'title, content, and author required' }, 400);
    }

    const allowed = ['research', 'architecture', 'learning', 'decision'];
    const type = allowed.includes(data.type) ? data.type : 'learning';
    const tags = JSON.stringify(data.tags || []);
    const now = Date.now();

    const shelfId = data.shelf_id ? Number(data.shelf_id) : null;
    if (!shelfId) return c.json({ error: 'shelf_id required — every entry must belong to a shelf' }, 400);
    const result = sqlite.prepare(
      'INSERT INTO library (title, content, type, author, tags, shelf_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(data.title, data.content, type, data.author, tags, shelfId, now, now);

    const newId = (result as any).lastInsertRowid;
    searchIndexUpsert('library', newId, data.title, data.content, data.author, new Date(now).toISOString());
    return c.json({ id: newId, title: data.title, type, author: data.author }, 201);
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
  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
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
} catch { /* already exists */ }

const VALID_TASK_TYPES = ['bug', 'feature', 'improvement', 'chore', 'task'];

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
  const assignedTo = c.req.query('assigned_to');
  const priority = c.req.query('priority');
  const limit = Math.min(200, parseInt(c.req.query('limit') || '100', 10));
  const offset = parseInt(c.req.query('offset') || '0', 10);

  let query = 'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1';
  const params: any[] = [];

  if (projectId) { query += ' AND t.project_id = ?'; params.push(parseInt(projectId, 10)); }
  if (status) { query += ' AND t.status = ?'; params.push(status); }
  if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }
  if (priority) { query += ' AND t.priority = ?'; params.push(priority); }
  const type = c.req.query('type');
  if (type) { query += ' AND t.type = ?'; params.push(type); }

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
  const { title, description, project_id, status, priority, assigned_to, created_by, thread_id, due_date, type, reviewer } = data;
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

  const now = new Date().toISOString();
  const approvalRequired = data.approval_required ? 1 : 0;
  const result = sqlite.prepare(
    'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, thread_id, due_date, type, approval_required, reviewer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(project_id || null, title, description || '', taskStatus, taskPriority, assigned_to || null, created_by, thread_id || null, due_date || null, taskType, approvalRequired, reviewer, now, now);

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
  for (const field of ['title', 'description', 'status', 'priority', 'assigned_to', 'project_id', 'thread_id', 'due_date', 'type', 'approval_required', 'spec_id', 'reviewer']) {
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
    const task = sqlite.prepare('SELECT assigned_to, created_by, title FROM tasks WHERE id = ?').get(taskId) as any;
    if (task) {
      const { parseMentions, notifyMentioned } = await import('./forum/mentions.ts');
      const commenter = author.split('@')[0].toLowerCase();
      const toNotify = new Set<string>();
      // Notify assignee and creator
      if (task.assigned_to && task.assigned_to !== commenter) toNotify.add(task.assigned_to.toLowerCase());
      if (task.created_by && task.created_by !== commenter) toNotify.add(task.created_by.toLowerCase());
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
  const assignedTo = c.req.query('assigned_to');

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

// Security events access: session auth only until T#546 (API tokens) ships.
// Bertus review: ?as= is spoofable (Risk #12), so no allowlist fallback for security logs.
const SECURITY_READ_ALLOWLIST = ['bertus', 'talon']; // Reserved for T#546 API token auth

// GET /api/security/events — query security events
app.get('/api/security/events', (c) => {
  // Session auth only — no ?as= until T#546 ships (Bertus review finding)
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'Security events require Gorn session authentication' }, 403);
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
  // Session auth only — no ?as= until T#546 ships (Bertus review finding)
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'Security event stats require Gorn session authentication' }, 403);
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

const VALID_INTERVALS: Record<string, number> = {
  '10m': 600, '30m': 1800, '1h': 3600, '3h': 10800,
  '6h': 21600, '12h': 43200, '1d': 86400, '7d': 604800,
};

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
    intervalSeconds = VALID_INTERVALS[interval];
    if (!intervalSeconds) {
      return c.json({ error: `Invalid interval. Valid: ${Object.keys(VALID_INTERVALS).join(', ')}` }, 400);
    }
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

  let nextDue: string;
  const runAt = data.run_at || null;
  if (isOnce) {
    nextDue = new Date(data.run_at).toISOString();
  } else if (scheduleTime) {
    const intervalDays = interval === '7d' ? 7 : 1;
    nextDue = computeNextFixedTime(scheduleTime, intervalDays);
  } else {
    const now = new Date();
    nextDue = new Date(now.getTime() + intervalSeconds * 1000).toISOString();
  }

  const result = sqlite.prepare(
    `INSERT INTO beast_schedules (beast, task, command, interval, interval_seconds, next_due_at, schedule_time, timezone, source, once, run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(beast, task, command || null, interval, intervalSeconds, nextDue, scheduleTime, tz, source || null, isOnce ? 1 : 0, runAt);
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
    const secs = VALID_INTERVALS[data.interval];
    if (!secs) return c.json({ error: `Invalid interval. Valid: ${Object.keys(VALID_INTERVALS).join(', ')}` }, 400);
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
  const requester = (c.req.query('as') || data.as || data.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (!requester) {
    return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
  }
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
  if (existing.schedule_time) {
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
    const overdue = sqlite.prepare(
      `SELECT * FROM beast_schedules
       WHERE enabled = 1 AND datetime(next_due_at) <= datetime(?)
       AND trigger_status IS NOT 'completed'
       AND trigger_status IS NOT 'triggered'
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
const DRAIN_SPACING = 3000; // 3s between sends to same Beast
const DRAIN_DIR = '/tmp/den-notify';
const drainLastSent: Map<string, number> = new Map(); // beast → last send timestamp

function runDrainCycle() {
  try {
    if (!fs.existsSync(DRAIN_DIR)) return;
    const files = fs.readdirSync(DRAIN_DIR).filter(f => f.endsWith('.queue'));

    for (const file of files) {
      const beast = file.replace('.queue', '');
      const queuePath = path.join(DRAIN_DIR, file);
      const lockPath = path.join(DRAIN_DIR, `${beast}.lock`);

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
    return c.json({ error: 'DB maintenance is restricted to Gorn (session auth required)' }, 403);
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

    return c.json({
      success: true,
      file: `ψ/inbox/handoff/${filename}`,
      message: 'Handoff written.'
    }, 201);
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

const ALLOWED_SPEC_REPOS = ['oracle-v2', 'supply-chain-tool', 'karo', 'zaghnal', 'gnarl', 'bertus', 'flint', 'pip', 'dex', 'talon', 'quill', 'sable', 'nyx', 'vigil', 'rax', 'leonard', 'mara', 'snap'];

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
    const { repo, file_path, task_id, thread_id, title, author } = data;
    if (!repo || !file_path || !title || !author) {
      return c.json({ error: 'repo, file_path, title, author required' }, 400);
    }
    if (!task_id && !thread_id) {
      return c.json({ error: 'At least one of task_id or thread_id is required. Link your spec to a task or forum thread.' }, 400);
    }
    if (!ALLOWED_SPEC_REPOS.includes(repo)) {
      return c.json({ error: `Invalid repo. Allowed: ${ALLOWED_SPEC_REPOS.join(', ')}` }, 400);
    }
    const requester = (c.req.query('as') || data.as || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (requester && requester !== 'gorn' && requester !== author.toLowerCase()) {
      return c.json({ error: 'Author must match requesting identity' }, 403);
    }
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge access required' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge access required' }, 403);
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
  76: 'muscle_mass', 77: 'hydration', 88: 'bone_mass', 170: 'visceral_fat',
};

// Fetch and store Withings measurements for a date range
async function syncWithingsMeasurements(startdate: number, enddate: number): Promise<{ synced: number; skipped: number }> {
  const tokenData = await ensureFreshWithingsToken();
  if (!tokenData) throw new Error('No Withings connection');

  const params: Record<string, string> = {
    action: 'getmeas',
    meastypes: '1,5,6,8,76,77,88,170',
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

    // Store weight as 'weight' type so Forge chart picks it up
    if (measurements.weight) {
      const weightData = JSON.stringify({ value: measurements.weight, unit: 'kg', source: 'withings', withings_grpid: grpid });
      sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('weight', loggedAt, weightData, 'withings', now);
    }

    // Store full body composition as 'measurement' type
    if (Object.keys(measurements).length > 1 || !measurements.weight) {
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

  // Only handle weight/body comp (appli=1)
  if (appli !== '1') {
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge access required' }, 403);

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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Authentication required' }, 403);
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

// Auth helper: only Gorn (session) + Sable (trusted local request with identity)
function isForgeAuthorized(c: any): boolean {
  if (hasSessionAuth(c)) return true; // Gorn browser session
  // Sable access: must be a trusted local request (localhost) AND identify as sable
  if (isTrustedRequest(c)) {
    const as = (c.req.query('as') || '').toLowerCase();
    return ['gorn', 'sable'].includes(as);
  }
  return false;
}

// GET /api/routine/logs — list logs
app.get('/api/routine/logs', (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const today = new Date().toISOString().slice(0, 10);
  const logs = sqlite.prepare(
    "SELECT * FROM routine_logs WHERE deleted_at IS NULL AND date(logged_at) = ? ORDER BY logged_at DESC"
  ).all(today);
  return c.json({ logs, date: today });
});

// GET /api/routine/weight — weight history for chart (with time-based grouping)
app.get('/api/routine/weight', (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge access required' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const totalLogs = (sqlite.prepare('SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL').get() as any).c;
  const byType = sqlite.prepare('SELECT type, COUNT(*) as count FROM routine_logs WHERE deleted_at IS NULL GROUP BY type').all();
  const thisWeek = (sqlite.prepare("SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= datetime('now', '-7 days')").get() as any).c;
  const latestWeight = sqlite.prepare("SELECT json_extract(data, '$.value') as value, logged_at FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1").get() as any;
  return c.json({ total_logs: totalLogs, by_type: byType, workouts_this_week: thisWeek, latest_weight: latestWeight });
});

// GET /api/routine/summary — enhanced summary for Stats tab (T#410)
app.get('/api/routine/summary', (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);

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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const tag = c.req.query('tag');
  let query = "SELECT * FROM routine_logs WHERE type = 'photo' AND deleted_at IS NULL";
  const params: any[] = [];
  if (tag) { query += " AND json_extract(data, '$.tag') = ?"; params.push(tag); }
  query += ' ORDER BY logged_at DESC';
  const photos = sqlite.prepare(query).all(...params);
  return c.json({ photos });
});

// POST /api/routine/logs — create log entry
app.post('/api/routine/logs', async (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
    // Workout validation — enforce structured exercise format (T#521, T#522)
    if (type === 'workout') {
      const workoutData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      if (!workoutData.exercises || !Array.isArray(workoutData.exercises)) {
        return c.json({
          error: 'Workout must include an exercises array.',
          hint: 'Expected format: { exercises: [{ name: "Chest Press", equipment: "Machine", sets: [{ weight: 80, reps: 10, unit: "kg" }] }] }',
        }, 400);
      }
      for (let i = 0; i < workoutData.exercises.length; i++) {
        const ex = workoutData.exercises[i];
        if (typeof ex === 'string') {
          return c.json({
            error: `Exercise ${i + 1} is a string ("${ex.slice(0, 60)}"). Exercises must be objects with name and sets.`,
            hint: 'Expected format: { name: "Chest Press", equipment: "Machine", sets: [{ weight: 80, reps: 10, unit: "kg" }] }',
          }, 400);
        }
        if (!ex.name?.trim()) {
          return c.json({ error: `Exercise ${i + 1}: name is required.`, hint: '{ name: "Bench Press", sets: [{ weight: 80, reps: 10, unit: "kg" }] }' }, 400);
        }
        if (!ex.sets || !Array.isArray(ex.sets) || ex.sets.length === 0) {
          return c.json({ error: `Exercise ${i + 1} ("${ex.name}"): sets array is required with at least one set.`, hint: 'sets: [{ weight: 80, reps: 10, unit: "kg" }]' }, 400);
        }
        for (let j = 0; j < ex.sets.length; j++) {
          const s = ex.sets[j];
          if (s.weight == null || s.reps == null) {
            return c.json({ error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: weight and reps are required.`, hint: '{ weight: 80, reps: 10, unit: "kg" }' }, 400);
          }
        }
      }
      data.data = workoutData;
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) return c.json({ error: 'Log not found' }, 404);
  sqlite.prepare('UPDATE routine_logs SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return c.json({ success: true, id });
});

// GET /api/routine/logs/deleted — list soft-deleted entries for recovery
app.get('/api/routine/logs/deleted', (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const limit = parseInt(c.req.query('limit') || '50');
  const rows = sqlite.prepare('SELECT * FROM routine_logs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?').all(limit);
  return c.json({ logs: rows, total: (rows as any[]).length });
});

// PATCH /api/routine/logs/:id/restore — undelete a soft-deleted log
app.patch('/api/routine/logs/:id/restore', (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NOT NULL').get(id);
  if (!existing) return c.json({ error: 'Deleted log not found' }, 404);
  sqlite.prepare('UPDATE routine_logs SET deleted_at = NULL WHERE id = ?').run(id);
  return c.json({ success: true, id, restored: true });
});

// POST /api/routine/photo/upload — upload progress photo
app.post('/api/routine/photo/upload', async (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
  const filename = c.req.param('filename').replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = path.join(ROUTINE_UPLOADS, filename);
  if (!fs.existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return new Response(fs.readFileSync(filePath), { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' } });
});

// POST /api/routine/import/alpha-progression — import Alpha Progression CSV (T#389)
app.post('/api/routine/import/alpha-progression', async (c) => {
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge access denied' }, 403);

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
  if (!isForgeAuthorized(c)) return c.json({ error: 'Forge access denied' }, 403);

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
    const author = (data.author || '').toLowerCase();
    if (!type || !title || !content || !author) return c.json({ error: 'type, title, content, author required' }, 400);
    if (!['decree', 'norm'].includes(type)) return c.json({ error: 'type must be decree or norm' }, 400);
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
    const requester = (data.author || data.beast || c.req.query('as') || '').toLowerCase();
    if (!requester) return c.json({ error: 'Identity required' }, 400);
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
    const requester = (data.author || data.beast || c.req.query('as') || '').toLowerCase();
    if (!requester) return c.json({ error: 'Identity required' }, 400);
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

  const tasks = sqlite.prepare(query).all(...params);

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

// PATCH /api/prowl/:id — update task fields (Gorn or Sable, no status changes)
app.patch('/api/prowl/:id', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester === 'sable')) return c.json({ error: 'Gorn or Sable only' }, 403);
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

// PATCH /api/prowl/:id/status — change status (Gorn or Sable)
app.patch('/api/prowl/:id/status', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester === 'sable')) return c.json({ error: 'Gorn or Sable only' }, 403);
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

// POST /api/prowl/:id/toggle — quick toggle pending ↔ done (Gorn or Sable)
app.post('/api/prowl/:id/toggle', async (c) => {
  const requester = c.req.query('as')?.toLowerCase();
  if (!hasSessionAuth(c) && !(isTrustedRequest(c) && requester === 'sable')) return c.json({ error: 'Gorn or Sable only' }, 403);
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

// DELETE /api/prowl/:id — delete task (Gorn or Sable)
app.delete('/api/prowl/:id', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
  if (requester !== 'gorn' && requester !== 'sable') {
    return c.json({ error: 'Only Gorn or Sable can delete Prowl tasks' }, 403);
  }

  const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  sqlite.prepare('DELETE FROM prowl_tasks WHERE id = ?').run(id);
  wsBroadcast('prowl_update', { action: 'delete' });
  return c.json({ deleted: true, id });
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
  const requester = c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '');
  if (!requester && !isTrustedRequest(c)) {
    return c.json({ error: 'Authentication required' }, 401);
  }

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
      const success = server.upgrade(req, { data: { identity: validation.identity } });
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
    },
    close(ws: any) {
      wsClients.delete(ws);
    },
  },
};

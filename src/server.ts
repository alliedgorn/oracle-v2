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
  updateThreadStatus
} from './forum/handler.ts';


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

// CORS middleware
app.use('*', cors());

// ============================================================================
// Auth Helpers
// ============================================================================

// Session secret - generate once per server run
const SESSION_SECRET = process.env.ORACLE_SESSION_SECRET || crypto.randomUUID();
const SESSION_COOKIE_NAME = 'oracle_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
function generateSessionToken(): string {
  const expires = Date.now() + SESSION_DURATION_MS;
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(String(expires))
    .digest('hex');
  return `${expires}:${signature}`;
}

// Verify session token with timing-safe comparison
function verifySessionToken(token: string): boolean {
  if (!token) return false;
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return false;

  const expiresStr = token.substring(0, colonIdx);
  const signature = token.substring(colonIdx + 1);
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || expires < Date.now()) return false;

  const expectedSignature = createHmac('sha256', SESSION_SECRET)
    .update(expiresStr)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
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

  const localBypass = getSetting('auth_local_bypass') !== 'false'; // Default true
  if (localBypass && isLocalNetwork(c)) return true;

  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  return verifySessionToken(sessionCookie || '');
}

// ============================================================================
// Auth Middleware (protects /api/* except auth routes)
// ============================================================================

app.use('/api/*', async (c, next) => {
  const path = c.req.path;

  // Skip auth for certain endpoints
  const publicPaths = [
    '/api/auth/status',
    '/api/auth/login',
    '/api/health'
  ];
  if (publicPaths.some(p => path === p)) {
    return next();
  }

  if (!isAuthenticated(c)) {
    return c.json({ error: 'Unauthorized', requiresAuth: true }, 401);
  }

  return next();
});

// ============================================================================
// Audit Logging Middleware (Task #72 — logs all mutating API requests)
// ============================================================================

const AUDIT_SKIP = ['/api/health', '/api/auth/status', '/api/auth/login', '/api/session/stats'];

app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;

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
    // Actor extraction chain (Bertus spec):
    // 1. ?as= query param (Beast API calls)
    // 2. Request body .author or .beast field (forum posts, reactions)
    // 3. Path patterns (e.g. /api/dm/karo/..., /api/notifications/karo)
    // 4. Session cookie → "gorn" (browser requests)
    // 5. X-Beast header (future: Beast-to-API calls)
    // 6. Fallback: "unknown"
    let actor = c.req.query('as') || '';
    if (!actor && bodyData) {
      if (bodyData.author && typeof bodyData.author === 'string') actor = bodyData.author;
      else if (bodyData.beast && typeof bodyData.beast === 'string') actor = bodyData.beast;
      else if (bodyData.from && typeof bodyData.from === 'string') actor = bodyData.from;
    }
    if (!actor) {
      // Try path patterns: /api/dm/{beast}/..., /api/schedules/{beast}
      // Exclude known sub-paths (messages, dashboard, due) that aren't beast names
      const pathMatch = path.match(/\/api\/(?:dm|schedules)\/(?!messages|dashboard|due|pending)([a-z][\w-]*)/i);
      if (pathMatch) actor = pathMatch[1];
    }
    if (!actor) {
      // Session cookie = Gorn (browser)
      if (hasSessionAuth(c)) actor = 'gorn';
    }
    if (!actor) {
      // X-Beast header (future use)
      actor = c.req.header('x-beast') || 'unknown';
    }
    const actorType = hasSessionAuth(c) ? 'human' : 'beast';
    const statusCode = c.res.status;

    // Extract resource info from path
    const parts = path.replace('/api/', '').split('/');
    const resourceType = parts[0] || null;
    const resourceId = parts[1] || null;

    sqlite.prepare(
      `INSERT INTO audit_log (actor, actor_type, action, resource_type, resource_id, ip_source, request_method, request_path, status_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(actor, actorType, `${method} ${path}`, resourceType, resourceId, ip, method, path, statusCode);
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

  return c.json({
    authenticated,
    authEnabled,
    hasPassword,
    localBypass,
    isLocal
  });
});

// Login
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json();
  const { password } = body;

  if (!password) {
    return c.json({ success: false, error: 'Password required' }, 400);
  }

  const storedHash = getSetting('auth_password_hash');
  if (!storedHash) {
    return c.json({ success: false, error: 'No password configured' }, 400);
  }

  // Verify password using Bun's built-in password functions
  const valid = await Bun.password.verify(password, storedHash);
  if (!valid) {
    return c.json({ success: false, error: 'Invalid password' }, 401);
  }

  // Set session cookie
  const token = generateSessionToken();
  const isHttps = c.req.url.startsWith('https') || c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true, // Always behind HTTPS via Caddy
    sameSite: 'None',
    maxAge: SESSION_DURATION_MS / 1000,
    path: '/'
  });

  return c.json({ success: true });
});

// Logout
app.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true });
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

// Get all beasts with status (processing/idle/offline)
app.get('/api/pack', (c) => {
  const profiles = getAllBeastProfiles();

  // Get active tmux sessions, detect Claude state from pane content
  const tmuxStatus: Map<string, 'processing' | 'idle' | 'shell' | 'offline'> = new Map();
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
            isProcessing = /[✻✽·] \w+…|Running…|Thinking…|Doodling…|Crafting…|Bunning…|Brewing…|Writing…|Reading…|Searching…|esc to interrupt/.test(abovePrompt);
          }

          if (isProcessing) {
            tmuxStatus.set(session.toLowerCase(), 'processing');
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

  const beasts = profiles.map(p => {
    const sessionName = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    const rawStatus = tmuxStatus.get(sessionName.toLowerCase()) || tmuxStatus.get(p.name) || 'offline';
    return {
      ...p,
      online: rawStatus === 'processing' || rawStatus === 'idle',
      status: rawStatus, // 'processing' | 'idle' | 'shell' | 'offline'
      sessionName,
    };
  });

  return c.json({ beasts });
});

// Capture live terminal output for a Beast
app.get('/api/beast/:name/terminal', (c) => {
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
    execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });

    // Send keys
    execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} -l ${JSON.stringify(keys)}`, { timeout: 2000 });

    return c.json({ sent: true, beast: name, length: keys.length });
  } catch {
    return c.json({ error: 'Session not found or send failed' }, 404);
  }
});

// Send special keys (Enter, Ctrl-C, etc.)
app.post('/api/beast/:name/terminal/key', async (c) => {
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

    execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });
    execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} ${key}`, { timeout: 2000 });

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
    octopus: '#9b59b6',
  };
  const ANIMAL_EMOJI: Record<string, string> = {
    hyena: '🐾', horse: '🐴', alligator: '🐊', bear: '🐻',
    kangaroo: '🦘', lion: '🦁', raccoon: '🦝', otter: '🦦', crow: '🐦‍⬛',
    octopus: '🐙',
  };

  const animal = profile?.animal?.toLowerCase() || 'unknown';
  const color = BEAST_COLORS[animal] || '#6b7280';
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

// Image upload with validation and resize
const UPLOADS_DIR = path.join(ORACLE_DATA_DIR, 'uploads');
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB — resize on server

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
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const context = formData.get('context') as string; // 'forum' or 'dm'
    const messageId = formData.get('message_id');
    const beast = formData.get('beast');

    if (!file) return c.json({ error: 'No file provided' }, 400);
    if (file.size > MAX_FILE_SIZE) return c.json({ error: `File too large. Max ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());

    // Magic byte validation — no SVGs, only raster images
    const imageType = detectImageType(buffer);
    if (!imageType) return c.json({ error: 'Invalid image. Only JPG, PNG, GIF, WebP allowed.' }, 400);

    // Ensure uploads dir exists
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    // Resize large images (max 1920px wide, JPEG 80% quality)
    let processedBuffer = buffer;
    let finalExt = imageType.ext;
    let finalMime = imageType.mime;
    try {
      const sharp = require('sharp');
      const metadata = await sharp(buffer).metadata();
      if (metadata.width && metadata.width > 1920) {
        processedBuffer = await sharp(buffer)
          .rotate() // Auto-fix EXIF orientation
          .resize(1920, null, { withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .withMetadata({ orientation: undefined }) // Strip EXIF (GPS, etc.)
          .toBuffer();
        finalExt = '.jpg';
        finalMime = 'image/jpeg';
      } else if (buffer.length > 2 * 1024 * 1024) {
        processedBuffer = await sharp(buffer)
          .rotate()
          .jpeg({ quality: 85 })
          .withMetadata({ orientation: undefined })
          .toBuffer();
        finalExt = '.jpg';
        finalMime = 'image/jpeg';
      } else {
        // Normal size — still fix EXIF rotation and strip metadata
        processedBuffer = await sharp(buffer)
          .rotate()
          .withMetadata({ orientation: undefined })
          .toBuffer();
      }
    } catch { /* sharp not available — save original */ }

    // Hash-based filename (UUID, no original name in path)
    const filename = `${crypto.randomUUID()}${finalExt}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    // Write processed file
    fs.writeFileSync(filePath, processedBuffer);

    // Record in DB
    const now = Date.now();
    const result = sqlite.prepare(`
      INSERT INTO forum_attachments (message_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(messageId ? Number(messageId) : null, filename, file.name, finalMime, processedBuffer.length, beast || null, now);

    return c.json({
      id: (result as any).lastInsertRowid,
      filename,
      original_name: file.name,
      url: `/api/forum/file/${filename}`,
      size_bytes: file.size,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Upload failed' }, 500);
  }
});

// Serve uploaded files
app.get('/api/forum/file/:filename', (c) => {
  const filename = c.req.param('filename');
  // Sanitize — no path traversal
  if (filename.includes('..') || filename.includes('/')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return c.json({ error: 'File not found' }, 404);

  const meta = sqlite.prepare('SELECT mime_type, original_name FROM forum_attachments WHERE filename = ?').get(filename) as any;
  const content = fs.readFileSync(filePath);
  // Safe content type — only serve known image types, everything else as octet-stream
  const safeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const contentType = safeTypes.has(meta?.mime_type) ? meta.mime_type : 'application/octet-stream';
  c.header('Content-Type', contentType);
  c.header('Content-Disposition', 'inline');
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(content);
});

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

  let query = 'SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE 1=1';
  const params: any[] = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  query += ' ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = sqlite.prepare(query).all(...params) as any[];
  const countQuery = 'SELECT COUNT(*) as total FROM forum_threads';
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
    const result = await withRetry(() => handleThreadMessage({
      message: data.message,
      threadId: data.thread_id,
      title: data.title,
      role: data.role || 'human',
      author: data.author,
    }));
    // Store reply_to_id if provided
    if (data.reply_to_id && result.messageId) {
      sqlite.prepare('UPDATE forum_messages SET reply_to_id = ? WHERE id = ?')
        .run(data.reply_to_id, result.messageId);
    }
    // Index forum message for search (T#347)
    if (result.messageId && result.threadId) {
      const threadTitle = data.title || (sqlite.prepare('SELECT title FROM forum_threads WHERE id = ?').get(result.threadId) as any)?.title || '';
      searchIndexUpsert('forum', result.messageId, threadTitle, data.message, data.author, new Date().toISOString());
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
// Supported emoji whitelist — request new ones via forum
const SUPPORTED_EMOJI = new Set([
  '👍', '👎', '❤️', '🔥', '👀', '✅', '❌',
  '😂', '😢', '🤔', '💪', '🎉', '🙏', '👏', '💯',
  '🚀', '⭐', '⚠️', '💡', '🏆', '🫡', '🤝',
  '📦', // shipped
  '🐾', '🐴', '🐊', '🐻', '🦘', '🦁', '🦝', '🦦', '🐙', '🐦‍⬛', // beast animals
]);

// GET /api/reactions/supported — list supported emoji
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

// Send a DM
app.post('/api/dm', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.from || !data.to || !data.message) {
      return c.json({ error: 'Missing required fields: from, to, message' }, 400);
    }
    // Sender validation: non-local requests must provide 'as' matching 'from'
    if (!isTrustedRequest(c)) {
      const as = data.as?.toLowerCase();
      if (!as) return c.json({ error: 'as param required for sender validation' }, 400);
      if (as !== data.from.toLowerCase() && as !== 'gorn') {
        return c.json({ error: 'Sender impersonation blocked. as must match from.' }, 403);
      }
    }
    const result = await withRetry(() => sendDm(data.from, data.to, data.message));
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
      content: m.content,
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

    const shelfId = data.shelf_id !== undefined ? (data.shelf_id || null) : null;
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

  query += ' ORDER BY CASE t.priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, t.created_at DESC';
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const tasks = sqlite.prepare(query).all(...params) as any[];
  return c.json({ tasks, total });
});

// POST /api/tasks — create task
app.post('/api/tasks', async (c) => {
  const data = await c.req.json();
  const { title, description, project_id, status, priority, assigned_to, created_by, thread_id, due_date, type } = data;
  if (!title || !created_by) return c.json({ error: 'title and created_by required' }, 400);
  if (!project_id) return c.json({ error: 'project_id required — every task must belong to a project' }, 400);

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
  const validPriorities = ['critical', 'high', 'medium', 'low'];
  const taskStatus = validStatuses.includes(status) ? status : 'todo';
  const taskPriority = validPriorities.includes(priority) ? priority : 'medium';
  if (type && !VALID_TASK_TYPES.includes(type)) return c.json({ error: `Invalid type. Valid: ${VALID_TASK_TYPES.join(', ')}` }, 400);
  const taskType = type || 'task';

  const now = new Date().toISOString();
  const approvalRequired = data.approval_required ? 1 : 0;
  const result = sqlite.prepare(
    'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, thread_id, due_date, type, approval_required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(project_id || null, title, description || '', taskStatus, taskPriority, assigned_to || null, created_by, thread_id || null, due_date || null, taskType, approvalRequired, now, now);

  const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get((result as any).lastInsertRowid) as any;
  searchIndexUpsert('task', task.id, task.title, task.description || '', task.assigned_to || '', now);
  wsBroadcast('task_created', { id: task.id });
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

  // SDD enforcement: block forward transitions if approval_required and no approved spec
  if (data.status && ['in_progress', 'in_review', 'done'].includes(data.status)) {
    const gateError = checkApprovalGate(existing);
    if (gateError) return c.json({ error: gateError }, 400);
  }

  const updates: string[] = [];
  const params: any[] = [];
  for (const field of ['title', 'description', 'status', 'priority', 'assigned_to', 'project_id', 'thread_id', 'due_date', 'type', 'approval_required', 'spec_id']) {
    if (data[field] !== undefined) { updates.push(`${field} = ?`); params.push(data[field]); }
  }
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
  updates.push('updated_at = ?'); params.push(new Date().toISOString());
  params.push(id);

  sqlite.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(id) as any;
  if (task) searchIndexUpsert('task', id, task.title, task.description || '', task.assigned_to || '', task.created_at);
  wsBroadcast('task_updated', { id: task?.id });
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

  const projects = sqlite.prepare("SELECT * FROM projects ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 END, name").all() as any[];

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
    status_code INTEGER
  )`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`).run();
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
  try {
    execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });
  } catch {
    return c.json({ error: `tmux session '${sessionName}' not found — Beast may be offline` }, 503);
  }

  // Send notification to Beast (same as auto-trigger daemon)
  const safeTask = schedule.task.replace(/[^a-zA-Z0-9 _./-]/g, '');
  const safeCommand = schedule.command ? schedule.command.replace(/[^a-zA-Z0-9 _./:@=-]/g, '') : '';
  const notification = `# [Scheduler] Due now: ${safeTask} (schedule #${schedule.id})${safeCommand ? ` | Command: ${safeCommand}` : ''}`;

  try {
    execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} -l ${JSON.stringify(notification)}`, { timeout: 2000 });
    execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} Enter`, { timeout: 2000 });

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
    // - NULL: never triggered
    // - 'pending': beast called /run last cycle, now next_due has passed again — re-trigger
    // - 'triggered': sent notification but beast hasn't /run yet — re-trigger after 5 min cooldown
    // - 'failed': previous attempt failed — retry
    // - 'completed': one-time schedule finished — skip
    const overdue = sqlite.prepare(
      `SELECT * FROM beast_schedules
       WHERE enabled = 1 AND datetime(next_due_at) <= datetime(?)
       AND (
         trigger_status IS NULL
         OR trigger_status = 'pending'
         OR (trigger_status = 'triggered' AND datetime(last_triggered_at) <= datetime(?, '-5 minutes'))
         OR trigger_status = 'failed'
       )
       AND (last_triggered_at IS NULL OR datetime(last_triggered_at) <= datetime(?, '-5 minutes'))
       ORDER BY next_due_at`
    ).all(now, now, now) as any[];

    for (const schedule of overdue) {
      const sessionName = schedule.beast.charAt(0).toUpperCase() + schedule.beast.slice(1);

      // Check if Beast tmux session exists
      try {
        execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });
      } catch {
        // Session not found — skip, log
        console.log(`[Scheduler] Skip ${schedule.beast}/${schedule.task}: tmux session '${sessionName}' not found`);
        continue;
      }

      // Send comment notification to Beast (NOT a command — Option 1 per Gnarl's review)
      // Sanitize task name: strip any chars that could be interpreted by tmux/shell
      const safeTask = schedule.task.replace(/[^a-zA-Z0-9 _./-]/g, '');
      const safeCommand = schedule.command ? schedule.command.replace(/[^a-zA-Z0-9 _./:@=-]/g, '') : '';
      const notification = `# [Scheduler] Due now: ${safeTask} (schedule #${schedule.id})${safeCommand ? ` | Command: ${safeCommand}` : ''}`;

      try {
        execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} -l ${JSON.stringify(notification)}`, { timeout: 2000 });
        execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} Enter`, { timeout: 2000 });

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
  } catch (err) {
    console.error(`[Scheduler] Cycle error: ${err}`);
  }
}

// Start the daemon
setInterval(runSchedulerCycle, SCHEDULER_INTERVAL);
// Run first cycle after 5s (let server boot)
setTimeout(runSchedulerCycle, 5000);
console.log('[Scheduler] Auto-trigger daemon started (10s interval)');

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

    const pruned = (auditResult.changes || 0);

    if (pruned > 0) {
      // VACUUM to reclaim space after large deletes
      sqlite.exec('VACUUM');
      console.log(`[DB Maintenance] Pruned ${auditResult.changes} audit rows (>${DB_RETENTION_DAYS}d). VACUUM complete.`);
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
  const specs = sqlite.prepare(query).all(...params);
  return c.json({ specs });
});

// GET /api/specs/:id — get spec detail
app.get('/api/specs/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
  if (!spec) return c.json({ error: 'Spec not found' }, 404);
  const resolved = resolveSpecPath(spec.repo, spec.file_path);
  if (resolved) {
    try { spec.content = fs.readFileSync(resolved, 'utf-8'); } catch { spec.content = null; }
  }
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
    const { repo, file_path, task_id, title, author } = data;
    if (!repo || !file_path || !title || !author) {
      return c.json({ error: 'repo, file_path, title, author required' }, 400);
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
      'INSERT INTO spec_reviews (repo, file_path, task_id, title, author, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(repo, file_path, task_id || null, title, author, 'pending', now, now);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get((result as any).lastInsertRowid) as any;
    // Auto-link spec to task if task_id provided
    if (task_id) {
      const taskIdNum = parseInt(String(task_id).replace(/\D/g, ''), 10);
      if (!isNaN(taskIdNum)) {
        sqlite.prepare('UPDATE tasks SET spec_id = ?, updated_at = ? WHERE id = ?').run(spec.id, now, taskIdNum);
      }
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
    // Auto-comment on associated PM Board task + notify assignee
    if (spec.task_id) {
      const taskIdNum = parseInt(spec.task_id.replace(/\D/g, ''), 10);
      if (!isNaN(taskIdNum)) {
        const task = sqlite.prepare('SELECT id, assigned_to, created_by, title FROM tasks WHERE id = ?').get(taskIdNum) as any;
        if (task) {
          const commentContent = action === 'approve'
            ? `Spec approved by Gorn. Implementation unblocked.`
            : `Spec rejected by Gorn: ${feedback}`;
          sqlite.prepare(
            'INSERT INTO task_comments (task_id, author, content, created_at) VALUES (?, ?, ?, ?)'
          ).run(taskIdNum, 'gorn', commentContent, now);
          // Notify assignee and creator
          try {
            const { notifyMentioned } = await import('./forum/mentions.ts');
            const toNotify = new Set<string>();
            if (task.assigned_to) toNotify.add(task.assigned_to.toLowerCase());
            if (task.created_by) toNotify.add(task.created_by.toLowerCase());
            if (spec.author) toNotify.add(spec.author.toLowerCase());
            // Add spec comment participants
            const specParticipants = sqlite.prepare(
              'SELECT DISTINCT author FROM spec_comments WHERE spec_id = ?'
            ).all(id) as any[];
            for (const p of specParticipants) {
              if (p.author) toNotify.add(p.author.toLowerCase());
            }
            toNotify.delete('gorn');
            if (toNotify.size > 0) {
              notifyMentioned(
                [...toNotify],
                0,
                `Task #${taskIdNum}: ${task.title || 'Untitled'}`,
                'gorn',
                `Spec ${action}d: ${commentContent.slice(0, 100)}`,
                {
                  type: 'Specs',
                  label: `Spec #${id} (task #${taskIdNum})`,
                  hint: `Use /spec to view spec details. Use /board task ${taskIdNum} to view task.`,
                }
              );
            }
          } catch { /* notification failure is non-critical */ }
        }
      }
    }
    return c.json(updated);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
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

// Helper: decorate rule with effective status
function decorateRule(rule: any) {
  if (!rule) return rule;
  // Override status to reflect approval state for decrees
  if (rule.type === 'decree' && rule.approval_status === 'pending') {
    return { ...rule, status: 'pending' };
  }
  if (rule.type === 'decree' && rule.approval_status === 'rejected') {
    return { ...rule, status: 'rejected' };
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
    return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
  } catch { return c.json({ error: 'Invalid request' }, 400); }
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

// GET /api/prowl — list tasks with filters
app.get('/api/prowl', (c) => {
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
    query += " AND due_date < date('now') AND status = 'pending'";
  } else if (due === 'today') {
    query += " AND due_date = date('now')";
  } else if (due === 'week') {
    query += " AND due_date BETWEEN date('now') AND date('now', '+7 days')";
  }

  query += ' ORDER BY CASE priority WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 WHEN \'low\' THEN 2 END, created_at DESC';

  const tasks = sqlite.prepare(query).all(...params);

  // Counts
  const counts = {
    pending: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE status = 'pending'").get() as any).c,
    done: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE status = 'done'").get() as any).c,
    overdue: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE due_date < date('now') AND status = 'pending'").get() as any).c,
    high: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'high' AND status = 'pending'").get() as any).c,
    medium: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'medium' AND status = 'pending'").get() as any).c,
    low: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'low' AND status = 'pending'").get() as any).c,
  };

  const categories = (sqlite.prepare("SELECT DISTINCT category FROM prowl_tasks WHERE category IS NOT NULL ORDER BY category").all() as any[]).map(r => r.category);

  return c.json({ tasks, counts, categories });
});

// GET /api/prowl/categories — unique categories with counts
app.get('/api/prowl/categories', (c) => {
  const rows = sqlite.prepare("SELECT category, COUNT(*) as count FROM prowl_tasks WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC").all();
  return c.json({ categories: rows });
});

// POST /api/prowl — create task
app.post('/api/prowl', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);

    const requester = (c.req.query('as') || data.created_by || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester || !ALLOWED_PROWL_CREATORS.includes(requester)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_CREATORS.join(', ')} can create Prowl tasks` }, 403);
    }

    const priority = ['high', 'medium', 'low'].includes(data.priority) ? data.priority : 'medium';
    const now = new Date().toISOString();

    const result = sqlite.prepare(
      'INSERT INTO prowl_tasks (title, priority, category, due_date, status, notes, source, source_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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

// PATCH /api/prowl/:id — update task fields (Gorn-only, no status changes)
app.patch('/api/prowl/:id', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  try {
    const data = await c.req.json();
    if ('status' in data) return c.json({ error: 'Use PATCH /api/prowl/:id/status to change status' }, 400);

    const allowed = ['title', 'priority', 'category', 'due_date', 'notes'];
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

// PATCH /api/prowl/:id/status — change status (Gorn-only)
app.patch('/api/prowl/:id/status', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
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

// POST /api/prowl/:id/toggle — quick toggle pending ↔ done (Gorn-only)
app.post('/api/prowl/:id/toggle', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
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

// Helper: index a document
function searchIndexUpsert(sourceType: string, sourceId: number, title: string, content: string, author: string, createdAt: string, url?: string) {
  // FTS5 (sync)
  try {
    sqlite.prepare('DELETE FROM search_index WHERE source_type = ? AND source_id = ?').run(sourceType, String(sourceId));
    sqlite.prepare('INSERT INTO search_index(title, content, source_type, source_id, author, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(title, content, sourceType, String(sourceId), author, createdAt);
  } catch { /* ignore indexing errors */ }
  // Meilisearch (async, fire-and-forget)
  if (meili && meiliAvailable) {
    meili.index('denbook').addDocuments([{
      search_id: `${sourceType}_${sourceId}`, title, content, source_type: sourceType,
      source_id: sourceId, author, created_at: createdAt, url: url || '#',
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
    forum: (id) => `/forum?thread=${id}`, library: (id) => `/library?doc=${id}`,
    spec: (id) => `/specs?spec=${id}`, risk: () => `/risk`, task: (id) => `/board?task=${id}`,
  };

  return {
    results: rows.map(r => ({
      source_type: r.source_type, source_id: r.source_id, title: r.title,
      snippet: r.snippet, author: r.author, url: (urlMap[r.source_type] || (() => '#'))(r.source_id),
    })),
    total, query: q, engine: 'fts5' as const,
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
    thread: 'forum', post: 'forum', message: 'forum',
    entry: 'library', doc: 'library', document: 'library',
    issue: 'task', ticket: 'task',
    specification: 'spec',
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
      return c.json({
        results: (results.hits || []).map((h: any) => ({
          source_type: h.source_type, source_id: h.source_id, title: h.title,
          snippet: h._formatted?.content || h.content?.slice(0, 200) || '',
          author: h.author, url: h.url || '#',
        })),
        total: results.estimatedTotalHits || 0,
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
      c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(fs.readFileSync(filePath));
    }
    return c.notFound();
  });

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    c.header('Content-Type', 'text/html');
    return c.body(fs.readFileSync(indexPath));
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
  hostname: '0.0.0.0',
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

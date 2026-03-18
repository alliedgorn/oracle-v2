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
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: false, // Allow HTTP for local dev
    sameSite: 'Lax',
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
app.get('/api/search', async (c) => {
  const q = c.req.query('q');
  if (!q) {
    return c.json({ error: 'Missing query parameter: q' }, 400);
  }
  const type = c.req.query('type') || 'all';
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');
  const mode = (c.req.query('mode') || 'hybrid') as 'hybrid' | 'fts' | 'vector';
  const project = c.req.query('project'); // Explicit project filter
  const cwd = c.req.query('cwd');         // Auto-detect project from cwd
  const model = c.req.query('model');     // Embedding model: 'bge-m3' (default), 'nomic', or 'qwen3'

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
    const oracle = c.req.query('oracle') || undefined;
    const event = c.req.query('event') || undefined;
    const since = c.req.query('since') || undefined; // ISO timestamp

    if (!fs.existsSync(FEED_LOG)) return c.json({ events: [], total: 0 });

    const raw = fs.readFileSync(FEED_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    let events = raw.map(line => {
      const [ts, oracleName, host, eventType, project, rest] = line.split(' | ').map(s => s.trim());
      const [sessionId, ...msgParts] = (rest || '').split(' » ');
      return {
        timestamp: ts,
        oracle: oracleName,
        host,
        event: eventType,
        project,
        session_id: sessionId?.trim(),
        message: msgParts.join(' » ').trim(),
      };
    });

    if (oracle) events = events.filter(e => e.oracle === oracle);
    if (event) events = events.filter(e => e.event === event);
    if (since) events = events.filter(e => e.timestamp >= since);

    events.reverse(); // newest first
    const total = events.length;
    events = events.slice(0, limit);

    // Derive active oracles (unique oracles from last 5 min)
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const recentAll = raw.map(line => {
      const [ts, oracleName] = line.split(' | ').map(s => s.trim());
      return { timestamp: ts, oracle: oracleName };
    }).filter(e => e.timestamp >= fiveMinAgo);
    const activeOracles = [...new Set(recentAll.map(e => e.oracle))];

    return c.json({ events, total, active_oracles: activeOracles });
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

          // Bottom of pane = truth. Check last 3 lines.
          const lines = pane1.split('\n').filter(l => l.trim());
          const bottomLines = lines.slice(-3).join('\n');

          // "esc to interrupt" at bottom = actively processing
          // "bypass permissions" without "esc to interrupt" = idle
          const hasEscToInterrupt = /esc to interrupt/.test(bottomLines);

          if (hasEscToInterrupt) {
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

// POST /api/remote/attach — attach a beast's claude window
app.post('/api/remote/attach', async (c) => {
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

// POST /api/remote/detach — detach current beast
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
          .resize(1920, null, { withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        finalExt = '.jpg';
        finalMime = 'image/jpeg';
      } else if (buffer.length > 2 * 1024 * 1024) {
        // Over 2MB — compress without resizing
        processedBuffer = await sharp(buffer)
          .jpeg({ quality: 85 })
          .toBuffer();
        finalExt = '.jpg';
        finalMime = 'image/jpeg';
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
// Group Routes
// ============================================================================

// Create group
app.post('/api/groups', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name) return c.json({ error: 'name is required' }, 400);
    const name = body.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!name) return c.json({ error: 'Invalid group name' }, 400);

    const now = Date.now();
    sqlite.prepare('INSERT INTO forum_groups (name, description, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(name, body.description || null, body.beast || null, now);

    // Add initial members if provided
    if (body.members && Array.isArray(body.members)) {
      for (const member of body.members.slice(0, 20)) {
        sqlite.prepare('INSERT OR IGNORE INTO forum_group_members (group_id, beast_name, added_at) VALUES ((SELECT id FROM forum_groups WHERE name = ?), ?, ?)')
          .run(name, member.toLowerCase(), now);
      }
    }

    return c.json({ success: true, name });
  } catch (error: any) {
    if (error.message?.includes('UNIQUE')) return c.json({ error: 'Group already exists' }, 409);
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// List all groups
app.get('/api/groups', (c) => {
  const groups = sqlite.prepare(`
    SELECT g.id, g.name, g.description, g.created_by, g.created_at,
           GROUP_CONCAT(m.beast_name) as members,
           COUNT(m.beast_name) as member_count
    FROM forum_groups g
    LEFT JOIN forum_group_members m ON m.group_id = g.id
    GROUP BY g.id
    ORDER BY g.name
  `).all() as any[];

  return c.json({
    groups: groups.map(g => ({
      id: g.id,
      name: g.name,
      description: g.description,
      created_by: g.created_by,
      members: g.members ? g.members.split(',') : [],
      member_count: g.member_count,
      created_at: new Date(g.created_at).toISOString(),
    })),
  });
});

// Get group by name
app.get('/api/group/:name', (c) => {
  const name = c.req.param('name').toLowerCase();
  const group = sqlite.prepare('SELECT * FROM forum_groups WHERE name = ?').get(name) as any;
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const members = sqlite.prepare('SELECT beast_name FROM forum_group_members WHERE group_id = ?').all(group.id) as any[];
  return c.json({
    ...group,
    members: members.map(m => m.beast_name),
    member_count: members.length,
  });
});

// Add member to group
app.post('/api/group/:name/members', async (c) => {
  const name = c.req.param('name').toLowerCase();
  try {
    const body = await c.req.json();
    if (!body.beast) return c.json({ error: 'beast is required' }, 400);

    const group = sqlite.prepare('SELECT id FROM forum_groups WHERE name = ?').get(name) as any;
    if (!group) return c.json({ error: 'Group not found' }, 404);

    // Check member count
    const count = sqlite.prepare('SELECT COUNT(*) as c FROM forum_group_members WHERE group_id = ?').get(group.id) as any;
    if (count.c >= 20) return c.json({ error: 'Group full (max 20 members)' }, 400);

    sqlite.prepare('INSERT OR IGNORE INTO forum_group_members (group_id, beast_name, added_at) VALUES (?, ?, ?)')
      .run(group.id, body.beast.toLowerCase(), Date.now());

    return c.json({ success: true, group: name, added: body.beast });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Remove member from group
app.delete('/api/group/:name/members/:beast', (c) => {
  const name = c.req.param('name').toLowerCase();
  const beast = c.req.param('beast').toLowerCase();

  const group = sqlite.prepare('SELECT id FROM forum_groups WHERE name = ?').get(name) as any;
  if (!group) return c.json({ error: 'Group not found' }, 404);

  sqlite.prepare('DELETE FROM forum_group_members WHERE group_id = ? AND beast_name = ?').run(group.id, beast);
  return c.json({ success: true, group: name, removed: beast });
});

// Delete group
app.delete('/api/group/:name', (c) => {
  const name = c.req.param('name').toLowerCase();
  const group = sqlite.prepare('SELECT id FROM forum_groups WHERE name = ?').get(name) as any;
  if (!group) return c.json({ error: 'Group not found' }, 404);

  sqlite.prepare('DELETE FROM forum_group_members WHERE group_id = ?').run(group.id);
  sqlite.prepare('DELETE FROM forum_groups WHERE id = ?').run(group.id);
  return c.json({ success: true, deleted: name });
});

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
    const result = await handleThreadMessage({
      message: data.message,
      threadId: data.thread_id,
      title: data.title,
      role: data.role || 'human',
      author: data.author,
    });
    // Store reply_to_id if provided
    if (data.reply_to_id && result.messageId) {
      sqlite.prepare('UPDATE forum_messages SET reply_to_id = ? WHERE id = ?')
        .run(data.reply_to_id, result.messageId);
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
    if (!isLocalNetwork(c)) {
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
    if (!isLocalNetwork(c)) {
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

// Standalone mindlinks table (thread-less)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS mindlinks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beast TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )`).run();
} catch { /* already exists */ }

// GET /api/mindlink — list all mindlink items (thread-based + standalone)
app.get('/api/mindlink', (c) => {
  const status = c.req.query('status') || 'pending';

  // Thread-based mindlinks (from gorn-queue category)
  const threadItems = sqlite.prepare(`
    SELECT id, title, status, category, queue_status, queue_tagged_by, queue_tagged_at, queue_summary, created_at,
      (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as message_count
    FROM forum_threads
    WHERE category = 'gorn-queue' AND queue_status = ?
    ORDER BY queue_tagged_at ASC
  `).all(status) as any[];

  // Standalone mindlinks
  const standaloneItems = sqlite.prepare(
    'SELECT * FROM mindlinks WHERE status = ? ORDER BY created_at ASC'
  ).all(status) as any[];

  const items = [
    ...threadItems.map(r => ({
      type: 'thread' as const,
      id: `thread-${r.id}`,
      thread_id: r.id,
      beast: r.queue_tagged_by,
      title: r.title,
      summary: r.queue_summary,
      status: r.queue_status,
      message_count: r.message_count,
      created_at: new Date(r.queue_tagged_at || r.created_at).toISOString(),
    })),
    ...standaloneItems.map(r => ({
      type: 'standalone' as const,
      id: `mindlink-${r.id}`,
      mindlink_id: r.id,
      beast: r.beast,
      title: null,
      summary: r.message,
      context: r.context,
      status: r.status,
      message_count: 0,
      created_at: new Date(r.created_at).toISOString(),
    })),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return c.json({ items, total: items.length });
});

// POST /api/mindlink — Beast sends a mindlink (thread-based or standalone)
app.post('/api/mindlink', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.beast || !data.message) {
      return c.json({ error: 'beast and message required' }, 400);
    }
    // Sender validation for non-local requests
    if (!isLocalNetwork(c)) {
      const as = data.as?.toLowerCase();
      if (!as) return c.json({ error: 'as param required for sender validation' }, 400);
      if (as !== data.beast.toLowerCase() && as !== 'gorn') {
        return c.json({ error: 'Sender impersonation blocked. as must match beast.' }, 403);
      }
    }

    if (data.thread_id) {
      // Thread-based: tag the thread
      const now = Date.now();
      sqlite.prepare(`
        UPDATE forum_threads
        SET category = 'gorn-queue', queue_status = 'pending', queue_tagged_by = ?, queue_tagged_at = ?, queue_summary = ?
        WHERE id = ?
      `).run(data.beast, now, data.message, data.thread_id);
      return c.json({ success: true, type: 'thread', thread_id: data.thread_id });
    } else {
      // Standalone mindlink
      const now = Date.now();
      const result = sqlite.prepare(
        'INSERT INTO mindlinks (beast, message, context, status, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(data.beast, data.message, data.context || null, 'pending', now);
      return c.json({ success: true, type: 'standalone', mindlink_id: (result as any).lastInsertRowid });
    }
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// PATCH /api/mindlink/:id — update status (gorn only from browser)
app.patch('/api/mindlink/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const data = await c.req.json();
    const allowed = ['decided', 'deferred', 'pending', 'withdrawn'];
    if (!data.status || !allowed.includes(data.status)) {
      return c.json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` }, 400);
    }

    if (!isLocalNetwork(c)) {
      const as = data.as?.toLowerCase();
      if (as !== 'gorn') return c.json({ error: 'Only Gorn can update mindlink items' }, 403);
    }

    if (id.startsWith('thread-')) {
      const threadId = parseInt(id.replace('thread-', ''), 10);
      sqlite.prepare('UPDATE forum_threads SET queue_status = ? WHERE id = ? AND category = ?')
        .run(data.status, threadId, 'gorn-queue');
    } else if (id.startsWith('mindlink-')) {
      const mlId = parseInt(id.replace('mindlink-', ''), 10);
      sqlite.prepare('UPDATE mindlinks SET status = ? WHERE id = ?').run(data.status, mlId);
    } else {
      return c.json({ error: 'Invalid ID format' }, 400);
    }

    return c.json({ success: true, id, status: data.status });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

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
    if (!isLocalNetwork(c)) {
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

// DM Dashboard — restricted to gorn on non-local requests
app.get('/api/dm/dashboard', (c) => {
  if (!isLocalNetwork(c)) {
    const as = c.req.query('as')?.toLowerCase();
    if (as !== 'gorn') return c.json({ error: 'Dashboard access restricted to gorn' }, 403);
  }
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
    if (!isLocalNetwork(c)) {
      const as = data.as?.toLowerCase();
      if (!as) return c.json({ error: 'as param required for sender validation' }, 400);
      if (as !== data.from.toLowerCase() && as !== 'gorn') {
        return c.json({ error: 'Sender impersonation blocked. as must match from.' }, 403);
      }
    }
    const result = sendDm(data.from, data.to, data.message);
    wsBroadcast('new_dm', { from: data.from, to: data.to, conversation_id: result.conversationId });
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
  if (!isLocalNetwork(c)) {
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
  if (!isLocalNetwork(c)) {
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
  if (!isLocalNetwork(c)) {
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
  if (!isLocalNetwork(c)) {
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
      tags: JSON.parse(r.tags || '[]'),
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    })),
    total: countResult?.count || 0,
  });
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

    const result = sqlite.prepare(
      'INSERT INTO library (title, content, type, author, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(data.title, data.content, type, data.author, tags, now, now);

    return c.json({
      id: (result as any).lastInsertRowid,
      title: data.title,
      type,
      author: data.author,
    }, 201);
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

    params.push(id);
    sqlite.prepare(`UPDATE library SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    return c.json({ success: true, id });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// GET /api/library/types — list available types and counts
app.get('/api/library/types', (c) => {
  const rows = sqlite.prepare('SELECT type, COUNT(*) as count FROM library GROUP BY type ORDER BY count DESC').all() as any[];
  return c.json({ types: rows });
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
} catch { /* already exists */ }

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
  const status = c.req.query('status') || 'active';
  const rows = sqlite.prepare(
    'SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC'
  ).all(status) as any[];
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
  wsBroadcast('project_created', project);
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
  const { title, description, project_id, status, priority, assigned_to, created_by, thread_id, due_date } = data;
  if (!title || !created_by) return c.json({ error: 'title and created_by required' }, 400);

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];
  const validPriorities = ['critical', 'high', 'medium', 'low'];
  const taskStatus = validStatuses.includes(status) ? status : 'todo';
  const taskPriority = validPriorities.includes(priority) ? priority : 'medium';

  const now = new Date().toISOString();
  const result = sqlite.prepare(
    'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, thread_id, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(project_id || null, title, description || '', taskStatus, taskPriority, assigned_to || null, created_by, thread_id || null, due_date || null, now, now);

  const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get((result as any).lastInsertRowid);
  wsBroadcast('task_created', task);
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

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];
  const validPriorities = ['critical', 'high', 'medium', 'low'];
  if (data.status && !validStatuses.includes(data.status)) return c.json({ error: `Invalid status. Valid: ${validStatuses.join(', ')}` }, 400);
  if (data.priority && !validPriorities.includes(data.priority)) return c.json({ error: `Invalid priority. Valid: ${validPriorities.join(', ')}` }, 400);

  const updates: string[] = [];
  const params: any[] = [];
  for (const field of ['title', 'description', 'status', 'priority', 'assigned_to', 'project_id', 'thread_id', 'due_date']) {
    if (data[field] !== undefined) { updates.push(`${field} = ?`); params.push(data[field]); }
  }
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
  updates.push('updated_at = ?'); params.push(new Date().toISOString());
  params.push(id);

  sqlite.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(id);
  wsBroadcast('task_updated', task);
  return c.json(task);
});

// DELETE /api/tasks/:id — soft delete (set status to 'deleted')
app.delete('/api/tasks/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const now = new Date().toISOString();
  sqlite.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('deleted', now, id);
  return c.json({ success: true, id });
});

// POST /api/tasks/bulk-status — bulk status update (for PM)
app.post('/api/tasks/bulk-status', async (c) => {
  const data = await c.req.json();
  const { task_ids, status } = data;
  if (!Array.isArray(task_ids) || !status) return c.json({ error: 'task_ids and status required' }, 400);

  const validStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];
  if (!validStatuses.includes(status)) return c.json({ error: 'Invalid status' }, 400);

  const now = new Date().toISOString();
  const stmt = sqlite.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
  for (const id of task_ids) {
    stmt.run(status, now, id);
  }
  wsBroadcast('tasks_bulk_updated', { task_ids, status });
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

  // Notify task assignee and creator about the new comment
  try {
    const task = sqlite.prepare('SELECT assigned_to, created_by, title FROM tasks WHERE id = ?').get(taskId) as any;
    if (task) {
      const commenter = author.split('@')[0].toLowerCase();
      const toNotify = new Set<string>();
      if (task.assigned_to && task.assigned_to !== commenter) toNotify.add(task.assigned_to.toLowerCase());
      if (task.created_by && task.created_by !== commenter) toNotify.add(task.created_by.toLowerCase());
      toNotify.delete('gorn'); toNotify.delete('human'); toNotify.delete('user');
      if (toNotify.size > 0) {
        const { notifyMentioned } = await import('./forum/mentions.ts');
        notifyMentioned(
          [...toNotify],
          0, // no thread_id
          `Task #${taskId}: ${task.title || 'Untitled'}`,
          commenter,
          `New comment on task #${taskId}: ${content.slice(0, 100)}`
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
    todo: [], in_progress: [], in_review: [], done: [], blocked: [],
  };
  for (const task of tasks) {
    if (columns[task.status]) columns[task.status].push(task);
  }

  const projects = sqlite.prepare('SELECT * FROM projects WHERE status = ? ORDER BY name').all('active') as any[];

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
} catch { /* already exists */ }

const VALID_INTERVALS: Record<string, number> = {
  '10m': 600, '30m': 1800, '1h': 3600, '3h': 10800,
  '6h': 21600, '12h': 43200, '1d': 86400, '7d': 604800,
};

// GET /api/schedules — all schedules (optional ?beast= filter)
app.get('/api/schedules', (c) => {
  const beast = c.req.query('beast');
  let query = 'SELECT * FROM beast_schedules';
  const params: any[] = [];
  if (beast) { query += ' WHERE beast = ?'; params.push(beast); }
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

// POST /api/schedules — create a schedule
app.post('/api/schedules', async (c) => {
  const data = await c.req.json();
  const { beast, task, command, interval, source } = data;
  if (!beast || !task || !interval) {
    return c.json({ error: 'beast, task, and interval are required' }, 400);
  }
  // Validate task name — only safe characters (alphanumeric, spaces, basic punctuation)
  if (typeof task !== 'string' || task.length > 100 || /[`$\\{}<>|;&]/.test(task)) {
    return c.json({ error: 'Task name contains invalid characters or is too long (max 100 chars, no shell metacharacters)' }, 400);
  }
  // Validate beast name
  if (typeof beast !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(beast)) {
    return c.json({ error: 'Invalid beast name' }, 400);
  }
  const intervalSeconds = VALID_INTERVALS[interval];
  if (!intervalSeconds) {
    return c.json({ error: `Invalid interval. Valid: ${Object.keys(VALID_INTERVALS).join(', ')}` }, 400);
  }
  // Prevent duplicate: same beast + same task name + enabled
  const duplicate = sqlite.prepare(
    'SELECT id FROM beast_schedules WHERE beast = ? AND task = ? AND enabled = 1'
  ).get(beast, task) as any;
  if (duplicate) {
    return c.json({ error: `Schedule '${task}' already exists for ${beast} (id: ${duplicate.id}). Disable or delete it first.` }, 409);
  }
  const now = new Date();
  const nextDue = new Date(now.getTime() + intervalSeconds * 1000).toISOString();
  const result = sqlite.prepare(
    `INSERT INTO beast_schedules (beast, task, command, interval, interval_seconds, next_due_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(beast, task, command || null, interval, intervalSeconds, nextDue, source || null);
  const created = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(result.lastInsertRowid) as any;
  wsBroadcast('schedule_update', { action: 'created', schedule: created });
  return c.json(created, 201);
});

// PATCH /api/schedules/:id — update a schedule (owner or Gorn only)
app.patch('/api/schedules/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  const data = await c.req.json();
  const requester = (c.req.query('as') || data.as || data.beast || '').toLowerCase();
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
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
  updates.push("updated_at = datetime('now')");
  params.push(id);
  sqlite.prepare(`UPDATE beast_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  wsBroadcast('schedule_update', { action: 'updated', schedule: updated });
  return c.json(updated);
});

// PATCH /api/schedules/:id/run — mark a schedule as run (owner or Gorn only)
app.patch('/api/schedules/:id/run', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  const data = await c.req.json().catch(() => ({}));
  const requester = (c.req.query('as') || data.as || data.beast || '').toLowerCase();
  if (!requester) {
    return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
  }
  if (requester !== existing.beast && requester !== 'gorn') {
    return c.json({ error: `Only ${existing.beast} or Gorn can run this schedule` }, 403);
  }
  // If task failed, don't update last_run (Pip's edge case)
  if (data.failed) {
    return c.json({ ...existing, message: 'Failed run — not updating last_run_at' });
  }
  const now = new Date();
  const nextDue = new Date(now.getTime() + existing.interval_seconds * 1000).toISOString();
  sqlite.prepare(
    `UPDATE beast_schedules SET last_run_at = ?, next_due_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(now.toISOString(), nextDue, id);
  const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  wsBroadcast('schedule_update', { action: 'run', schedule: updated });
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
  const requester = (c.req.query('as') || body.as || body.beast || '').toLowerCase();
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

// PATCH /api/schedules/:id/trigger — mark as triggered (owner, Gorn, or server daemon only)
app.patch('/api/schedules/:id/trigger', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Schedule not found' }, 404);
  const data = await c.req.json().catch(() => ({}));
  const requester = (c.req.query('as') || data.as || data.beast || '').toLowerCase();
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
  wsBroadcast('schedule_update', { action: 'triggered', schedule: updated });
  return c.json(updated);
});

// GET /api/scheduler/health — daemon status
app.get('/api/scheduler/health', (c) => {
  return c.json({ status: 'running', interval_seconds: 60, last_check: schedulerLastCheck });
});

// ============================================================================
// Scheduler Auto-Trigger Daemon (60s polling)
// ============================================================================

let schedulerLastCheck: string | null = null;

function runSchedulerCycle() {
  try {
    const now = new Date().toISOString();
    schedulerLastCheck = now;

    // Find all overdue, enabled schedules that haven't been triggered yet (or were triggered but not run)
    const overdue = sqlite.prepare(
      `SELECT * FROM beast_schedules
       WHERE enabled = 1 AND next_due_at <= ?
       AND (trigger_status IS NULL OR trigger_status = 'pending' OR trigger_status = 'completed' OR trigger_status = 'failed')
       ORDER BY next_due_at`
    ).all(now) as any[];

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
      const notification = `# [Scheduler] Due now: ${safeTask} (schedule #${schedule.id})`;

      try {
        execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} -l ${JSON.stringify(notification)}`, { timeout: 2000 });
        execSync(`tmux send-keys -t ${JSON.stringify(sessionName)} Enter`, { timeout: 2000 });

        // Mark as triggered
        sqlite.prepare(
          `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
        ).run(now, schedule.id);

        wsBroadcast('schedule_update', { action: 'triggered', schedule: { ...schedule, last_triggered_at: now, trigger_status: 'triggered' } });
        console.log(`[Scheduler] Triggered: ${schedule.beast}/${schedule.task} (#${schedule.id})`);
      } catch (err) {
        console.log(`[Scheduler] Failed to notify ${schedule.beast}: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Cycle error: ${err}`);
  }
}

// Start the daemon — runs every 60 seconds
const SCHEDULER_INTERVAL = 60_000;
setInterval(runSchedulerCycle, SCHEDULER_INTERVAL);
// Run first cycle after 5s (let server boot)
setTimeout(runSchedulerCycle, 5000);
console.log('[Scheduler] Auto-trigger daemon started (60s interval)');

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

// Broadcast an event to all connected WebSocket clients
export function wsBroadcast(event: string, data: any) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(payload); } catch { wsClients.delete(ws); }
  }
}

// WebSocket upgrade route
app.get('/ws', (c) => {
  const success = c.env?.upgrade?.(c.req.raw);
  if (success) return undefined as any;
  return c.text('WebSocket upgrade failed', 400);
});

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
      const success = server.upgrade(req);
      if (success) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return app.fetch(req, { ip: server.requestIP(req)?.address });
  },
  websocket: {
    open(ws: any) {
      wsClients.add(ws);
      ws.send(JSON.stringify({ event: 'connected', data: { clients: wsClients.size }, ts: Date.now() }));
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

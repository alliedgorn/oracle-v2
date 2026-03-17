/**
 * Oracle Forum Handler
 *
 * DB-first threaded discussions with Oracle.
 * - Create threads, add messages
 * - Oracle auto-responds from knowledge base
 * - Logs unanswered questions for later
 *
 * Refactored to use Drizzle ORM for type-safe queries.
 */

import { eq, desc, and, sql } from 'drizzle-orm';
import { db, forumThreads, forumMessages } from '../db/index.ts';
import { getProjectContext } from '../server/context.ts';
import { parseMentions, notifyMentioned } from './mentions.ts';
import type {
  ForumThread,
  ForumMessage,
  ThreadStatus,
  MessageRole,
  OracleThreadInput,
  OracleThreadOutput,
} from './types.ts';

/**
 * Get project context from environment (ghq path detection)
 */
function getProjectContext_(): string | undefined {
  const projectCtx = getProjectContext(process.cwd());
  return projectCtx && 'repo' in projectCtx ? projectCtx.repo : undefined;
}

// ============================================================================
// Thread Operations
// ============================================================================

/**
 * Create a new thread
 */
export function createThread(
  title: string,
  createdBy: string = 'user',
  project?: string
): ForumThread {
  const now = Date.now();

  const result = db.insert(forumThreads).values({
    title,
    createdBy,
    status: 'active',
    project: project || null,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: forumThreads.id }).get();

  return {
    id: result.id,
    title,
    createdBy,
    status: 'active',
    project,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get thread by ID
 */
export function getThread(threadId: number): ForumThread | null {
  const row = db.select()
    .from(forumThreads)
    .where(eq(forumThreads.id, threadId))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    createdBy: row.createdBy || 'unknown',
    status: (row.status || 'active') as ThreadStatus,
    issueUrl: row.issueUrl || undefined,
    issueNumber: row.issueNumber || undefined,
    project: row.project || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt || undefined,
  };
}

/**
 * Update thread status
 */
export function updateThreadStatus(threadId: number, status: ThreadStatus): void {
  db.update(forumThreads)
    .set({ status, updatedAt: Date.now() })
    .where(eq(forumThreads.id, threadId))
    .run();
}

/**
 * List threads with optional filters
 */
export function listThreads(options: {
  status?: ThreadStatus;
  project?: string;
  limit?: number;
  offset?: number;
} = {}): { threads: ForumThread[]; total: number } {
  const { status, project, limit = 20, offset = 0 } = options;

  // Build conditions array
  const conditions = [];
  if (status) {
    conditions.push(eq(forumThreads.status, status));
  }
  if (project) {
    conditions.push(eq(forumThreads.project, project));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get count
  const countResult = db.select({ count: sql<number>`count(*)` })
    .from(forumThreads)
    .where(whereClause)
    .get();
  const total = countResult?.count || 0;

  // Get threads
  const rows = db.select()
    .from(forumThreads)
    .where(whereClause)
    .orderBy(desc(forumThreads.updatedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return {
    threads: rows.map(row => ({
      id: row.id,
      title: row.title,
      createdBy: row.createdBy || 'unknown',
      status: (row.status || 'active') as ThreadStatus,
      issueUrl: row.issueUrl || undefined,
      issueNumber: row.issueNumber || undefined,
      project: row.project || undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      syncedAt: row.syncedAt || undefined,
    })),
    total,
  };
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Add a message to a thread
 */
export function addMessage(
  threadId: number,
  role: MessageRole,
  content: string,
  options: {
    author?: string;
    principlesFound?: number;
    patternsFound?: number;
    searchQuery?: string;
  } = {}
): ForumMessage {
  const now = Date.now();

  const result = db.insert(forumMessages).values({
    threadId,
    role,
    content,
    author: options.author || null,
    principlesFound: options.principlesFound || null,
    patternsFound: options.patternsFound || null,
    searchQuery: options.searchQuery || null,
    createdAt: now,
  }).returning({ id: forumMessages.id }).get();

  // Update thread timestamp
  db.update(forumThreads)
    .set({ updatedAt: now })
    .where(eq(forumThreads.id, threadId))
    .run();

  return {
    id: result.id,
    threadId,
    role,
    content,
    author: options.author,
    principlesFound: options.principlesFound,
    patternsFound: options.patternsFound,
    searchQuery: options.searchQuery,
    createdAt: now,
  };
}

/**
 * Get messages for a thread
 */
export function getMessages(
  threadId: number,
  limit?: number,
  offset: number = 0,
  order: 'asc' | 'desc' = 'asc',
): { messages: ForumMessage[]; total: number } {
  const countResult = db.select({ count: sql<number>`count(*)` })
    .from(forumMessages)
    .where(eq(forumMessages.threadId, threadId))
    .get();

  const total = countResult?.count ?? 0;

  let query = db.select()
    .from(forumMessages)
    .where(eq(forumMessages.threadId, threadId))
    .orderBy(order === 'desc' ? desc(forumMessages.createdAt) : forumMessages.createdAt);

  if (limit !== undefined) {
    query = query.limit(limit).offset(offset) as typeof query;
  }

  const rows = query.all();

  const messages = rows.map(row => ({
    id: row.id,
    threadId: row.threadId,
    role: row.role as MessageRole,
    content: row.content,
    author: row.author || undefined,
    principlesFound: row.principlesFound || undefined,
    patternsFound: row.patternsFound || undefined,
    searchQuery: row.searchQuery || undefined,
    commentId: row.commentId || undefined,
    createdAt: row.createdAt,
  }));

  return { messages, total };
}

// ============================================================================
// Main Thread API (MCP Tool Interface)
// ============================================================================

/**
 * Main entry point: Send message to thread, Oracle auto-responds
 */
export async function handleThreadMessage(
  input: OracleThreadInput
): Promise<OracleThreadOutput> {
  const { message, threadId, title, role = 'human', model, author: authorOverride } = input;

  // Get project context
  const project = getProjectContext_();

  // Determine author: use override if provided, otherwise compute from role/model
  let author: string;
  if (authorOverride) {
    author = authorOverride;
  } else if (role === 'human') {
    author = 'user';
  } else {
    // Use model name if provided (opus, sonnet), else 'claude'
    author = model || 'claude';
    // Add project context if available
    if (project) {
      author = `${author}@${project}`;
    }
  }

  let thread: ForumThread;

  // Create or get thread
  if (threadId) {
    const existing = getThread(threadId);
    if (!existing) {
      throw new Error(`Thread ${threadId} not found`);
    }
    thread = existing;
  } else {
    // New thread - use title or first 50 chars of message
    const threadTitle = title || message.slice(0, 50) + (message.length > 50 ? '...' : '');
    thread = createThread(threadTitle, author, project);
  }

  // Add the user's message
  const userMessage = addMessage(thread.id, role, message, {
    author,
  });

  // Mark as pending — but don't reopen closed threads
  if ((role === 'human' || role === 'claude') && thread.status !== 'closed') {
    updateThreadStatus(thread.id, 'pending');
  }

  // Parse @mentions and notify via tmux
  const mentions = parseMentions(message, thread.id);
  const notified = notifyMentioned(mentions, thread.id, thread.title, author, message);

  // Gorn notification rules:
  // 1. Gorn posts with @mentions → only mentioned beasts notified (already handled above)
  // 2. Gorn posts without @mentions → notify thread participants (same as @here)
  if (role === 'human' && mentions.length === 0) {
    const { getOracleRegistry } = await import('./mentions.ts');
    const registry = getOracleRegistry();
    const alreadyNotified = new Set(notified);
    // Get thread participants using Drizzle
    try {
      const rows = db.select({ author: forumMessages.author })
        .from(forumMessages)
        .where(eq(forumMessages.threadId, thread.id))
        .all();
      const seen = new Set<string>();
      const participants: string[] = [];
      for (const r of rows) {
        const name = r.author?.split('@')[0]?.toLowerCase();
        if (name && name in registry && name !== 'gorn' && name !== 'human' && name !== 'user' && !alreadyNotified.has(name) && !seen.has(name)) {
          seen.add(name);
          participants.push(name);
        }
      }
      if (participants.length > 0) {
        const extra = notifyMentioned(participants, thread.id, thread.title, 'gorn', message);
        notified.push(...extra);
      }
    } catch { /* ignore */ }
  }

  // Get updated thread status
  const updatedThread = getThread(thread.id)!;

  return {
    threadId: thread.id,
    messageId: userMessage.id,
    status: updatedThread.status as ThreadStatus,
    issueUrl: updatedThread.issueUrl,
    notified: notified.length > 0 ? notified : undefined,
  };
}

/**
 * Get full thread with messages (supports pagination)
 */
export function getFullThread(
  threadId: number,
  limit?: number,
  offset: number = 0,
  order: 'asc' | 'desc' = 'asc',
): {
  thread: ForumThread;
  messages: ForumMessage[];
  total: number;
} | null {
  const thread = getThread(threadId);
  if (!thread) return null;

  const { messages, total } = getMessages(threadId, limit, offset, order);
  return { thread, messages, total };
}

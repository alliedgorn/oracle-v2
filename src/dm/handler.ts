/**
 * Oracle DM Handler
 *
 * Private one-on-one messaging between Oracles.
 * Participants are stored alphabetically for deterministic lookups.
 */

import { eq, and, desc, sql, isNull } from 'drizzle-orm';
import { db, dmConversations, dmMessages } from '../db/index.ts';
import { getOracleRegistry } from '../forum/mentions.ts';
import { enqueueNotification } from '../notify.ts';
import type { DmConversation, DmMessage } from './types.ts';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sort two names alphabetically for consistent conversation lookup.
 */
function sortPair(a: string, b: string): [string, string] {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? [la, lb] : [lb, la];
}

/**
 * Sanitize text for tmux injection.
 */
function sanitizeForTmux(text: string, maxLen: number = 200): string {
  return text
    .replace(/\n/g, ' ')
    .replace(/"/g, "'")
    .replace(/\\/g, '\\\\')
    .slice(0, maxLen);
}

// ============================================================================
// Conversation Operations
// ============================================================================

/**
 * Find or create a conversation between two Oracles.
 */
export function getOrCreateConversation(name1: string, name2: string): DmConversation {
  const [p1, p2] = sortPair(name1, name2);
  const now = Date.now();

  // Try to find existing
  const existing = db.select()
    .from(dmConversations)
    .where(and(
      eq(dmConversations.participant1, p1),
      eq(dmConversations.participant2, p2),
    ))
    .get();

  if (existing) {
    return {
      id: existing.id,
      participant1: existing.participant1,
      participant2: existing.participant2,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  }

  // Create new
  const result = db.insert(dmConversations).values({
    participant1: p1,
    participant2: p2,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: dmConversations.id }).get();

  return {
    id: result.id,
    participant1: p1,
    participant2: p2,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Send a DM. Returns conversation ID, message ID, and whether recipient was notified.
 */
export function sendDm(
  from: string,
  to: string,
  content: string,
  notifyAs?: string,
): { conversationId: number; messageId: number; notified: boolean } {
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const conversation = getOrCreateConversation(fromLower, toLower);
  const now = Date.now();

  // Insert message
  const result = db.insert(dmMessages).values({
    conversationId: conversation.id,
    sender: fromLower,
    content,
    createdAt: now,
  }).returning({ id: dmMessages.id }).get();

  // Update conversation timestamp
  db.update(dmConversations)
    .set({ updatedAt: now })
    .where(eq(dmConversations.id, conversation.id))
    .run();

  // Notify recipient via tmux (use notifyAs for display if provided)
  const notified = notifyDmRecipient(notifyAs || fromLower, toLower, content);

  return {
    conversationId: conversation.id,
    messageId: result.id,
    notified,
  };
}

/**
 * Notify DM recipient via tmux.
 * Sends a short notification with preview + read/reply instructions.
 * The beast reads the full message via the API, not from the tmux injection.
 */
function notifyDmRecipient(from: string, to: string, content: string): boolean {
  const registry = getOracleRegistry();
  const entry = registry[to];
  if (!entry) return false;

  const preview = sanitizeForTmux(content, 120);
  const message = `[DM from ${from}]: ${preview}...\n\nUse /dm to read and /dm ${from} <message> to reply.`;

  try {
    return enqueueNotification(to, message);
  } catch {
    return false;
  }
}

/**
 * List conversations for an Oracle, with last message preview and unread count.
 */
export function listConversations(
  oracleName: string,
  limit: number = 20,
  offset: number = 0,
): { conversations: Array<{
  id: number;
  with: string;
  lastMessage: string;
  lastSender: string;
  lastAt: number;
  unreadCount: number;
  createdAt: number;
}>; total: number } {
  const name = oracleName.toLowerCase();

  // Find all conversations where this oracle is a participant
  const allConvs = db.select()
    .from(dmConversations)
    .where(
      sql`${dmConversations.participant1} = ${name} OR ${dmConversations.participant2} = ${name}`
    )
    .orderBy(desc(dmConversations.updatedAt))
    .all();

  const total = allConvs.length;
  const paged = allConvs.slice(offset, offset + limit);

  const conversations = paged.map(conv => {
    const other = conv.participant1 === name ? conv.participant2 : conv.participant1;

    // Get last message
    const lastMsg = db.select()
      .from(dmMessages)
      .where(eq(dmMessages.conversationId, conv.id))
      .orderBy(desc(dmMessages.createdAt))
      .limit(1)
      .get();

    // Count unread (messages from the other person that I haven't read)
    const unreadResult = db.select({ count: sql<number>`count(*)` })
      .from(dmMessages)
      .where(and(
        eq(dmMessages.conversationId, conv.id),
        eq(dmMessages.sender, other),
        isNull(dmMessages.readAt),
      ))
      .get();

    return {
      id: conv.id,
      with: other,
      lastMessage: lastMsg?.content || '',
      lastSender: lastMsg?.sender || '',
      lastAt: lastMsg?.createdAt || conv.createdAt,
      unreadCount: unreadResult?.count || 0,
      createdAt: conv.createdAt,
    };
  });

  return { conversations, total };
}

/**
 * Get messages in a conversation between two Oracles.
 */
export function getMessages(
  name1: string,
  name2: string,
  limit: number = 50,
  offset: number = 0,
  order: 'asc' | 'desc' = 'asc',
): { conversationId: number | null; participants: [string, string]; messages: DmMessage[]; total: number } {
  const [p1, p2] = sortPair(name1, name2);

  const conv = db.select()
    .from(dmConversations)
    .where(and(
      eq(dmConversations.participant1, p1),
      eq(dmConversations.participant2, p2),
    ))
    .get();

  if (!conv) {
    return { conversationId: null, participants: [p1, p2], messages: [], total: 0 };
  }

  const countResult = db.select({ count: sql<number>`count(*)` })
    .from(dmMessages)
    .where(eq(dmMessages.conversationId, conv.id))
    .get();

  const rows = db.select()
    .from(dmMessages)
    .where(eq(dmMessages.conversationId, conv.id))
    .orderBy(order === 'desc' ? desc(dmMessages.createdAt) : dmMessages.createdAt)
    .limit(limit)
    .offset(offset)
    .all();

  return {
    conversationId: conv.id,
    participants: [p1, p2],
    messages: rows.map(r => ({
      id: r.id,
      conversationId: r.conversationId,
      sender: r.sender,
      content: r.content,
      readAt: r.readAt || undefined,
      createdAt: r.createdAt,
    })),
    total: countResult?.count || 0,
  };
}

/**
 * Mark all messages from `other` to `reader` as read.
 */
export function markRead(reader: string, other: string): { markedRead: number; conversationId: number | null } {
  const [p1, p2] = sortPair(reader, other);
  const readerLower = reader.toLowerCase();
  const otherLower = other.toLowerCase();

  const conv = db.select()
    .from(dmConversations)
    .where(and(
      eq(dmConversations.participant1, p1),
      eq(dmConversations.participant2, p2),
    ))
    .get();

  if (!conv) {
    return { markedRead: 0, conversationId: null };
  }

  const now = Date.now();
  const result = db.update(dmMessages)
    .set({ readAt: now })
    .where(and(
      eq(dmMessages.conversationId, conv.id),
      eq(dmMessages.sender, otherLower),
      isNull(dmMessages.readAt),
    ))
    .run();

  return {
    markedRead: result.changes,
    conversationId: conv.id,
  };
}

/**
 * Mark ALL unread messages in a conversation as read (for observer/god-view).
 */
export function markAllRead(name1: string, name2: string): { markedRead: number; conversationId: number | null } {
  const [p1, p2] = sortPair(name1, name2);

  const conv = db.select()
    .from(dmConversations)
    .where(and(
      eq(dmConversations.participant1, p1),
      eq(dmConversations.participant2, p2),
    ))
    .get();

  if (!conv) {
    return { markedRead: 0, conversationId: null };
  }

  const now = Date.now();
  const result = db.update(dmMessages)
    .set({ readAt: now })
    .where(and(
      eq(dmMessages.conversationId, conv.id),
      isNull(dmMessages.readAt),
    ))
    .run();

  return {
    markedRead: result.changes,
    conversationId: conv.id,
  };
}

/**
 * Dashboard: Gorn's god-view of all DM conversations.
 */
export function getDashboard(limit: number = 50): {
  conversations: Array<{
    id: number;
    participants: [string, string];
    messageCount: number;
    unreadCount: number;
    lastMessage: string;
    lastSender: string;
    lastAt: number;
    createdAt: number;
  }>;
  totalConversations: number;
  totalMessages: number;
} {
  const allConvs = db.select()
    .from(dmConversations)
    .orderBy(desc(dmConversations.updatedAt))
    .limit(limit)
    .all();

  const totalConvsResult = db.select({ count: sql<number>`count(*)` })
    .from(dmConversations)
    .get();

  const totalMsgsResult = db.select({ count: sql<number>`count(*)` })
    .from(dmMessages)
    .get();

  const conversations = allConvs.map(conv => {
    // Message count
    const msgCount = db.select({ count: sql<number>`count(*)` })
      .from(dmMessages)
      .where(eq(dmMessages.conversationId, conv.id))
      .get();

    // Unread count — only messages NOT sent by gorn (messages from beasts to gorn)
    const unreadCount = db.select({ count: sql<number>`count(*)` })
      .from(dmMessages)
      .where(and(
        eq(dmMessages.conversationId, conv.id),
        isNull(dmMessages.readAt),
        sql`${dmMessages.sender} != 'gorn'`,
      ))
      .get();

    // Last message
    const lastMsg = db.select()
      .from(dmMessages)
      .where(eq(dmMessages.conversationId, conv.id))
      .orderBy(desc(dmMessages.createdAt))
      .limit(1)
      .get();

    return {
      id: conv.id,
      participants: [conv.participant1, conv.participant2] as [string, string],
      messageCount: msgCount?.count || 0,
      unreadCount: unreadCount?.count || 0,
      lastMessage: lastMsg?.content || '',
      lastSender: lastMsg?.sender || '',
      lastAt: lastMsg?.createdAt || conv.createdAt,
      createdAt: conv.createdAt,
    };
  });

  return {
    conversations,
    totalConversations: totalConvsResult?.count || 0,
    totalMessages: totalMsgsResult?.count || 0,
  };
}

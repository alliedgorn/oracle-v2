#!/usr/bin/env bun
/**
 * TG Desktop JSON export → telegram_messages backfill.
 *
 * Ingests historical messages that predate T#712 cache-ship (yesterday
 * 2026-04-23 ~23:47 BKK). The Bot API provides no historical-message
 * fetch, so the only recovery path for pre-cache messages is the
 * TG Desktop export feature (Settings → Advanced → Export Telegram Data
 * → JSON).
 *
 * Usage:
 *   bun scripts/tg-backfill.ts <path-to-result.json>
 *
 * Input shape (TG Desktop export):
 *   - Can be single-chat export: { name, type, id, messages: [...] }
 *   - Or multi-chat export: { chats: { list: [...] } }
 *
 * PII-containment gate: only messages from chat_ids configured in
 * TELEGRAM_BOTS are ingested. Anything outside the gate is skipped +
 * reported. Preserves the same boundary as live intake
 * (src/server.ts handleTelegramMessage) so backfill can't smuggle
 * third-party chat bytes into telegram_messages.raw_json.
 *
 * Idempotent: composite PK (chat_id, id) + INSERT OR IGNORE means
 * re-running with the same JSON is a no-op.
 *
 * Reporting:
 *   - imported: new rows actually inserted
 *   - duplicate: rows already present (INSERT OR IGNORE skipped)
 *   - outside_gate: messages from chat_ids NOT in TELEGRAM_BOTS
 *   - malformed: messages missing required fields
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Configure paths from env (follows oracle-v2 config.ts pattern)
const ORACLE_DATA_DIR = process.env.ORACLE_DATA_DIR || `${process.env.HOME}/.oracle`;
const DB_PATH = process.env.ORACLE_DB_PATH || `${ORACLE_DATA_DIR}/oracle.db`;

interface TgExportMessage {
  id: number;
  type?: string; // 'message' | 'service' | ...
  date?: string;
  date_unixtime?: string;
  from?: string;
  from_id?: string;
  text?: string | Array<string | { type: string; text: string }>;
  text_entities?: Array<{ type: string; text: string }>;
  photo?: string;
  file?: string;
  [key: string]: unknown;
}

interface TgExportChat {
  name?: string;
  type?: string;
  id: number | string;
  messages?: TgExportMessage[];
}

interface TgExportRoot {
  chats?: { list?: TgExportChat[] };
  // Single-chat export has the chat fields at root:
  name?: string;
  type?: string;
  id?: number | string;
  messages?: TgExportMessage[];
}

interface BotConfig {
  beast: string;
  chatId: string;
  token: string;
}

// Parse TELEGRAM_BOTS env the same way server.ts does
function parseTelegramBots(): BotConfig[] {
  const raw = process.env.TELEGRAM_BOTS || '';
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<Partial<BotConfig>>;
    return arr.filter(b => b.beast && b.chatId && b.token).map(b => ({
      beast: String(b.beast),
      chatId: String(b.chatId),
      token: String(b.token),
    }));
  } catch (e) {
    console.error('[tg-backfill] Failed to parse TELEGRAM_BOTS env:', e);
    return [];
  }
}

// Normalize text_entities array OR string into a flat text string
function normalizeText(text: string | Array<string | { type: string; text: string }> | undefined): string | null {
  if (text === undefined || text === null) return null;
  if (typeof text === 'string') return text || null;
  if (Array.isArray(text)) {
    const parts: string[] = [];
    for (const t of text) {
      if (typeof t === 'string') parts.push(t);
      else if (t && typeof t === 'object' && 'text' in t) parts.push(t.text);
    }
    const joined = parts.join('');
    return joined || null;
  }
  return null;
}

// Extract the chat list from either single-chat or multi-chat export shape
function extractChats(root: TgExportRoot): TgExportChat[] {
  if (root.chats?.list && Array.isArray(root.chats.list)) return root.chats.list;
  if (root.id !== undefined && Array.isArray(root.messages)) {
    return [{
      name: root.name,
      type: root.type,
      id: root.id,
      messages: root.messages,
    }];
  }
  return [];
}

function main() {
  const [, , jsonPath] = process.argv;
  if (!jsonPath) {
    console.error('Usage: bun scripts/tg-backfill.ts <path-to-result.json>');
    process.exit(1);
  }

  const absPath = resolve(jsonPath);
  console.log(`[tg-backfill] Reading ${absPath}`);
  const raw = readFileSync(absPath, 'utf-8');
  const root = JSON.parse(raw) as TgExportRoot;

  const bots = parseTelegramBots();
  if (bots.length === 0) {
    console.error('[tg-backfill] TELEGRAM_BOTS env empty — cannot enforce PII gate. Aborting.');
    process.exit(2);
  }
  const allowedChatIds = new Set(bots.map(b => b.chatId));
  console.log(`[tg-backfill] PII gate: ${allowedChatIds.size} allowed chat_id(s) — ${[...allowedChatIds].join(', ')}`);

  const chats = extractChats(root);
  if (chats.length === 0) {
    console.error('[tg-backfill] No chats found in export. Expected { chats: { list: [...] } } or single-chat { id, messages }.');
    process.exit(3);
  }
  console.log(`[tg-backfill] Found ${chats.length} chat(s) in export`);

  const db = new Database(DB_PATH);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO telegram_messages
      (chat_id, id, from_id, text, caption, photo_file_id, date_unix, received_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let duplicate = 0;
  let outsideGate = 0;
  let malformed = 0;
  let serviceSkipped = 0;

  const nowSec = Math.floor(Date.now() / 1000);

  // Wrap in a transaction for speed + atomicity
  db.transaction(() => {
    for (const chat of chats) {
      const chatId = String(chat.id);
      if (!allowedChatIds.has(chatId)) {
        const msgCount = Array.isArray(chat.messages) ? chat.messages.length : 0;
        outsideGate += msgCount;
        console.log(`[tg-backfill] SKIP chat ${chatId} (${chat.name || 'unnamed'}) — outside PII gate, ${msgCount} messages skipped`);
        continue;
      }

      const msgs = chat.messages || [];
      console.log(`[tg-backfill] Processing chat ${chatId} (${chat.name || 'unnamed'}) — ${msgs.length} messages`);

      for (const m of msgs) {
        // Service messages (join/leave/etc) are not user content — skip
        if (m.type && m.type !== 'message') {
          serviceSkipped++;
          continue;
        }

        if (typeof m.id !== 'number') {
          malformed++;
          continue;
        }

        // Date: prefer date_unixtime, fall back to parsing date string
        let dateUnix: number | null = null;
        if (m.date_unixtime) {
          const parsed = parseInt(m.date_unixtime, 10);
          if (Number.isFinite(parsed)) dateUnix = parsed;
        }
        if (dateUnix === null && m.date) {
          const d = new Date(m.date);
          if (!isNaN(d.getTime())) dateUnix = Math.floor(d.getTime() / 1000);
        }
        if (dateUnix === null) {
          malformed++;
          continue;
        }

        const normalizedText = normalizeText(m.text);
        const fromId = m.from_id ? String(m.from_id) : null;
        // TG exports have a `photo` field (filesystem path); normalize to a
        // stable-enough marker. We don't have the original file_id from the
        // export, but we can synthesize one from the path for dedup + audit.
        const photoFileId = m.photo ? `export:${m.photo}` : null;

        // Caption: if message has photo + text, the text IS the caption
        // (TG export doesn't split caption separately from message text
        // the way Bot API does).
        const hasPhoto = !!m.photo;
        const caption = hasPhoto ? normalizedText : null;
        const text = hasPhoto ? null : normalizedText;

        // Preserve the full original message as raw_json for future re-extraction
        const rawJson = JSON.stringify(m);

        const result = stmt.run(
          chatId,
          m.id,
          fromId,
          text,
          caption,
          photoFileId,
          dateUnix,
          nowSec, // received_at = backfill time, not original (we didn't see it live)
          rawJson,
        );

        // bun:sqlite .run() returns { changes: N }; 0 changes = INSERT OR IGNORE hit existing
        if ((result as any).changes === 1) imported++;
        else duplicate++;
      }
    }
  })();

  db.close();

  console.log('');
  console.log('[tg-backfill] Done.');
  console.log(`  imported:        ${imported}`);
  console.log(`  duplicate:       ${duplicate}`);
  console.log(`  outside_gate:    ${outsideGate}`);
  console.log(`  malformed:       ${malformed}`);
  console.log(`  service_skipped: ${serviceSkipped}`);
  console.log(`  total processed: ${imported + duplicate + outsideGate + malformed + serviceSkipped}`);
}

main();

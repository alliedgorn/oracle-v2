/**
 * Oracle v2 Drizzle Database Client
 *
 * Single source of truth for DB initialization:
 * 1. Drizzle migrations (schema tables)
 * 2. FTS5 virtual table (raw SQL, can't be managed by Drizzle)
 * 3. Seed indexing_status row
 */

import { eq } from 'drizzle-orm';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import * as schema from './schema.ts';
import { DB_PATH, ORACLE_DATA_DIR } from '../config.ts';

// Migrations folder (relative to this file)
const MIGRATIONS_FOLDER = path.join(import.meta.dirname || __dirname, 'migrations');

/**
 * Initialize FTS5 virtual table (must use raw SQL)
 * Drizzle doesn't manage FTS5 — this is idempotent.
 */
export function initFts5(sqliteDb: Database): void {
  sqliteDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS oracle_fts USING fts5(
      id UNINDEXED,
      content,
      concepts,
      tokenize='porter unicode61'
    )
  `);
}

/**
 * Initialize a database: run migrations, create FTS5, seed indexing_status.
 */
function initializeDatabase(sqliteDb: Database, drizzleDb: BunSQLiteDatabase<typeof schema>): void {
  // WAL mode for concurrent reads
  sqliteDb.exec('PRAGMA journal_mode = WAL');
  sqliteDb.exec('PRAGMA busy_timeout = 5000');

  // Run Drizzle migrations (creates/updates all schema tables)
  migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

  // FTS5 (raw SQL, idempotent)
  initFts5(sqliteDb);

  // Ensure indexing_status has its single row
  sqliteDb.exec('INSERT OR IGNORE INTO indexing_status (id, is_indexing) VALUES (1, 0)');

  // One-time migration: normalize project casing to lowercase
  const migrated = sqliteDb.prepare("SELECT value FROM settings WHERE key = 'migration_lowercase_projects'").get() as { value: string } | undefined;
  if (!migrated) {
    sqliteDb.exec("UPDATE oracle_documents SET project = LOWER(project) WHERE project <> LOWER(project)");
    sqliteDb.exec("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('migration_lowercase_projects', '1', unixepoch() * 1000)");
  }
}

/**
 * Create a fully-initialized database connection.
 * Used by MCP entry (src/index.ts) and indexer (src/indexer.ts).
 */
export function createDatabase(dbPath?: string): {
  sqlite: Database;
  db: BunSQLiteDatabase<typeof schema>;
} {
  const resolvedPath = dbPath || DB_PATH;

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqliteDb = new Database(resolvedPath);
  const drizzleDb = drizzle(sqliteDb, { schema });

  initializeDatabase(sqliteDb, drizzleDb);

  return { sqlite: sqliteDb, db: drizzleDb };
}

// ============================================================================
// Default module-level connection (used by server.ts, handlers, etc.)
// ============================================================================

// Ensure data dir exists before opening DB
if (!fs.existsSync(ORACLE_DATA_DIR)) {
  fs.mkdirSync(ORACLE_DATA_DIR, { recursive: true });
}

const defaultSqlite = new Database(DB_PATH);
const defaultDb = drizzle(defaultSqlite, { schema });

// Run initialization on the default connection
initializeDatabase(defaultSqlite, defaultDb);

export const sqlite = defaultSqlite;
export const db = defaultDb;

// Export schema for use in queries
export * from './schema.ts';

// ============================================================================
// Beast Profile helpers
// ============================================================================

export function getBeastProfile(name: string) {
  return db.select().from(schema.beastProfiles).where(eq(schema.beastProfiles.name, name.toLowerCase())).get() ?? null;
}

export function getAllBeastProfiles() {
  return db.select().from(schema.beastProfiles).all();
}

export function upsertBeastProfile(profile: {
  name: string;
  displayName: string;
  animal: string;
  avatarUrl?: string | null;
  bio?: string | null;
  interests?: string | null;
  themeColor?: string | null;
  role?: string | null;
}) {
  const now = Date.now();
  const name = profile.name.toLowerCase();

  return db.insert(schema.beastProfiles)
    .values({
      name,
      displayName: profile.displayName,
      animal: profile.animal,
      avatarUrl: profile.avatarUrl ?? null,
      bio: profile.bio ?? null,
      interests: profile.interests ?? null,
      themeColor: profile.themeColor ?? null,
      role: profile.role ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.beastProfiles.name,
      set: {
        displayName: profile.displayName,
        animal: profile.animal,
        avatarUrl: profile.avatarUrl ?? undefined,
        bio: profile.bio ?? undefined,
        interests: profile.interests ?? undefined,
        themeColor: profile.themeColor ?? undefined,
        role: profile.role ?? undefined,
        updatedAt: now,
      },
    })
    .run();
}

export function updateBeastAvatar(name: string, avatarUrl: string) {
  return db.update(schema.beastProfiles)
    .set({ avatarUrl, updatedAt: Date.now() })
    .where(eq(schema.beastProfiles.name, name.toLowerCase()))
    .run();
}

/**
 * Close database connection
 */
export function closeDb() {
  defaultSqlite.close();
}

// ============================================================================
// Settings helpers
// ============================================================================

export function getSetting(key: string): string | null {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  db.insert(schema.settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: Date.now() },
    })
    .run();
}

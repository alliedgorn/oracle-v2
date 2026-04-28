/**
 * Bun test preload — runs before any test module imports.
 *
 * Forces ORACLE_DB_PATH and ORACLE_DATA_DIR to safe in-memory / /tmp values
 * so `bun test <anything>` (script-wrapped OR direct path invocation) cannot
 * touch the production SQLite at ~/.oracle/oracle.db.
 *
 * Wired via bunfig.toml `[test] preload`. Runs once per `bun test` invocation,
 * before src/db/index.ts is imported anywhere. Per-Bun-process scope: every
 * test file in the run sees the same in-memory DB.
 *
 * Background: 2026-04-28 incidents (Karo wiped beast_tokens twice via
 * `bun test src/server/__tests__/beast-tokens.test.ts`). Bear directive:
 * make the test DB a code-level baseline, not a script-level convention.
 *
 * Override path: if a developer explicitly wants to test against a real DB
 * file (e.g. for migration testing), set ORACLE_DB_PATH BEFORE invoking
 * `bun test` — the preload only sets defaults if unset, never overrides.
 */

if (!process.env.ORACLE_DB_PATH) {
  process.env.ORACLE_DB_PATH = ':memory:';
}
if (!process.env.ORACLE_DATA_DIR) {
  process.env.ORACLE_DATA_DIR = '/tmp/oracle-test-data';
}

// Defensive guard: refuse to proceed if ORACLE_DB_PATH points at a real
// production-shaped path. Catches the case where a developer exports
// ORACLE_DB_PATH=~/.oracle/oracle.db in their shell and forgets to unset.
const dbPath = process.env.ORACLE_DB_PATH;
if (
  dbPath !== ':memory:' &&
  !dbPath.startsWith('/tmp/') &&
  !dbPath.startsWith('/var/folders/') && // macOS temp
  !dbPath.includes('/test')
) {
  // eslint-disable-next-line no-console
  console.error(
    `[test-preload] REFUSING to run tests against non-test DB path: ${dbPath}\n` +
    `  Set ORACLE_DB_PATH=:memory: (default) OR a /tmp/* path to proceed.\n` +
    `  See WORKFLOW.md §"Test discipline".`
  );
  process.exit(1);
}

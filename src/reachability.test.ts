/**
 * T#664 Part 2 — Reachability regression test (CI gate)
 *
 * DRAFT — target location in oracle-v2: `src/reachability.test.ts`
 *
 * Asserts that the vulnerable API surface identified in the T#663 reachability
 * sweep (thread #20, msg #8113 / #8115 / #8116) stays unused in oracle-v2.
 * If any of these patterns appears in `src/` (via a future PR adding dynamic
 * queries, HTTP transport, or auth handlers), this test fails and the
 * reachability claim from the T#663 downgrade must be re-evaluated before
 * the PR can merge.
 *
 * ## What this guards
 *
 * ### Drizzle SQL injection surface (GHSA-gpj5-g38j-94v9)
 * - `sql.identifier(` — the vulnerable drizzle API for passing user-controlled
 *   identifiers. Zero call sites today; if any appear, the drizzle advisory
 *   becomes potentially reachable.
 * - `sql.raw(` — raw SQL string injection surface. Not the advisory itself but
 *   adjacent enough that any new use warrants review.
 * - String-literal `orderBy("...")` / `orderBy('...')` — dynamic column name
 *   as a plain string rather than a schema reference. If the string comes from
 *   request input, it is an identifier-injection vector.
 * - `getTableColumns(` / `getTableConfig(` — drizzle programmatic column
 *   introspection. Safe on static schema, risky if the table object or column
 *   name comes from user input.
 *
 * ### MCP SDK transport surface (hono / @hono/node-server / express / path-to-regexp)
 * Oracle-v2 uses stdio transport only. The vulnerable hono, @hono/node-server,
 * express-rate-limit, and path-to-regexp are dead code because their
 * importers (`server/streamableHttp.js`, `server/webStandardStreamableHttp.js`,
 * `server/sse.js`, `server/express.js`, `server/auth/router.js`) are never
 * loaded by oracle-v2's static import chain (verified in thread #20 msg #8116
 * and Bertus's msg #8122 review extension). This gate locks that in.
 *
 * Doctrine: **stdio-only MCP transport**. All HTTP-ish transports in the SDK
 * are blocked, not just a subset.
 *
 * - `@modelcontextprotocol/sdk/server/streamableHttp` — HTTP streamable
 *   transport. Importing it loads `@hono/node-server` runtime.
 * - `@modelcontextprotocol/sdk/server/webStandardStreamableHttp` — web-standard
 *   variant of the streamable HTTP transport. Loads the same hono chain.
 * - `@modelcontextprotocol/sdk/server/sse` — SSE transport. Loads the express
 *   chain.
 * - `@modelcontextprotocol/sdk/server/express` — express transport. Importing
 *   it loads express, express-rate-limit, path-to-regexp, and the vulnerable
 *   auth handlers.
 * - `@modelcontextprotocol/sdk/server/auth/router` — MCP auth router. Loads
 *   the same express chain.
 * - `@modelcontextprotocol/sdk/server/auth/handlers` — individual auth
 *   handlers. Any of them loads express.
 *
 * ## Method
 *
 * Walk `src/` recursively, read every `.ts` file (excluding test files),
 * check for each forbidden pattern, fail if any match.
 *
 * ## Exemptions
 *
 * Test files (`*.test.ts`, `__tests__/`) are excluded — tests may legitimately
 * import vulnerable APIs to test them. This file is itself a test and would
 * otherwise match its own forbidden-pattern list.
 *
 * If a legitimate non-test use of one of these patterns ever needs to be
 * added, the right move is:
 *   1. Update the T#663 reachability analysis for the new use
 *   2. Adjust this test to allow the specific call site with a comment linking
 *      the updated reachability analysis
 *   3. Do NOT blanket-disable the gate
 */

import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Target root is `src/` relative to the oracle-v2 repo root when this lives at
// `src/reachability.test.ts`. Adjust if the file moves.
//
// Use fileURLToPath rather than new URL('.', import.meta.url).pathname — the
// raw .pathname URL-encodes non-ASCII characters in the path (e.g. `ψ` becomes
// `%CF%88`), which fs can't resolve. fileURLToPath decodes them correctly.
// Caught when smoke-testing the test from pip's lab directory (which has `ψ`
// in its path) before handoff to oracle-v2. Oracle-v2's path is plain ASCII
// so the raw .pathname would work there, but the correct form handles both.
const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

interface ForbiddenPattern {
  /** Human-readable name for error messages */
  name: string;
  /** Literal substring to search for */
  needle: string;
  /** Why this pattern is forbidden / what advisory it links to */
  reason: string;
}

const FORBIDDEN: ForbiddenPattern[] = [
  // Drizzle SQL injection surface
  {
    name: 'sql.identifier() call',
    needle: 'sql.identifier(',
    reason: 'GHSA-gpj5-g38j-94v9 — drizzle <0.45.2 SQL injection via unescaped identifiers. Any new use requires reachability re-analysis.',
  },
  {
    name: 'sql.raw() call',
    needle: 'sql.raw(',
    reason: 'Raw SQL construction — if the string comes from user input, identifier or value injection is trivial. Any new use requires a security comment.',
  },
  {
    name: 'getTableColumns() call',
    needle: 'getTableColumns(',
    reason: 'Drizzle programmatic column introspection. Safe on static schema, risky if table object comes from user input. Any new use requires review.',
  },
  {
    name: 'getTableConfig() call',
    needle: 'getTableConfig(',
    reason: 'Same as getTableColumns — drizzle programmatic table metadata access. Any new use requires review.',
  },
  // MCP SDK transport surface — locks stdio-only (per Bertus extension msg #8118
  // and review extension msg #8122). Block every HTTP-ish transport the SDK
  // ships with, not just a subset — the doctrine is "stdio-only", not
  // "only-these-specific-HTTP-transports-blocked".
  {
    name: 'MCP streamableHttp import',
    needle: '@modelcontextprotocol/sdk/server/streamableHttp',
    reason: 'HTTP streamable transport. Importing loads @hono/node-server and makes hono CVEs reachable. Oracle-v2 is stdio-only per the T#663 reachability sweep.',
  },
  {
    name: 'MCP web-standard streamable HTTP import',
    needle: '@modelcontextprotocol/sdk/server/webStandardStreamableHttp',
    reason: 'Web-standard streamable HTTP transport. Loads hono chain. Oracle-v2 is stdio-only.',
  },
  {
    name: 'MCP SSE transport import',
    needle: '@modelcontextprotocol/sdk/server/sse',
    reason: 'SSE transport. Loads express chain. Oracle-v2 is stdio-only.',
  },
  {
    name: 'MCP express transport import',
    needle: '@modelcontextprotocol/sdk/server/express',
    reason: 'Express transport. Importing loads express, express-rate-limit, path-to-regexp. Oracle-v2 is stdio-only.',
  },
  {
    name: 'MCP auth router import',
    needle: '@modelcontextprotocol/sdk/server/auth/router',
    reason: 'MCP auth router. Loads the same express chain as above. Oracle-v2 does not use MCP auth.',
  },
  {
    name: 'MCP auth handlers import',
    needle: '@modelcontextprotocol/sdk/server/auth/handlers',
    reason: 'MCP auth handlers (register / authorize / revoke / token / metadata). Each imports express. Oracle-v2 does not use MCP auth.',
  },
];

/** Walk a directory recursively, yielding absolute paths to .ts files that are NOT test files. */
function* walkNonTestTsFiles(root: string): Generator<string> {
  const entries = readdirSync(root);
  for (const entry of entries) {
    const fullPath = join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      yield* walkNonTestTsFiles(fullPath);
    } else if (stat.isFile()) {
      if (!entry.endsWith('.ts')) continue;
      // Exclude all common test-file conventions. Oracle-v2 currently uses
      // .test.ts and __tests__/ (the directory is skipped above). .spec.ts is
      // excluded too as future-proofing per Bertus msg #8122 — if someone
      // introduces that convention later, the exclusion must not silently miss it.
      if (entry.endsWith('.test.ts')) continue;
      if (entry.endsWith('.spec.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      yield fullPath;
    }
  }
}

interface Match {
  pattern: ForbiddenPattern;
  file: string;
  line: number;
  lineText: string;
}

function findMatches(): Match[] {
  const matches: Match[] = [];
  for (const absPath of walkNonTestTsFiles(SRC_ROOT)) {
    const relPath = relative(SRC_ROOT, absPath);
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip obvious comment lines to cut false positives in docstrings that mention the patterns
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      for (const pattern of FORBIDDEN) {
        if (line.includes(pattern.needle)) {
          matches.push({ pattern, file: relPath, line: i + 1, lineText: line.trim() });
        }
      }
    }
  }
  return matches;
}

test('T#664: no vulnerable-surface API calls in src/ (reachability lock)', () => {
  const matches = findMatches();

  const report = matches
    .map((m) => `  ${m.file}:${m.line} — ${m.pattern.name}\n    ${m.lineText}\n    reason: ${m.pattern.reason}`)
    .join('\n\n');

  const failMessage =
    matches.length === 0
      ? ''
      : `Found ${matches.length} forbidden pattern match(es) in src/. The T#663 reachability analysis said these APIs were unused; a new use invalidates the downgrade.\n\n${report}\n\nIf this is an intentional legitimate use:\n  1. Update T#663 reachability analysis for the new call site\n  2. Add a specific exemption in this test with a comment linking the updated analysis\n  3. Do not disable the test wholesale\n`;

  // Use expect with a custom message via toBe — gives bun a clean assertion
  // failure instead of a bare throw. If matches.length > 0, the error message
  // above is what the failure shows.
  if (matches.length > 0) {
    throw new Error(failMessage);
  }
  expect(matches.length).toBe(0);
});

test('T#664: stdio-only MCP transport (bundle check hook)', () => {
  // Placeholder for Zaghnal's refinement from T#664 comment: after bundle step,
  // verify the bundled artifact does not contain `streamableHttp` or
  // `auth/router` symbols. Oracle-v2 does not currently bundle for production
  // (bun runs source directly), so this test is a no-op today. If a bundle
  // step is added later, wire this test to scan the bundled output.
  //
  // Implementation sketch:
  //   const bundle = readFileSync('./dist/server.js', 'utf8');
  //   expect(bundle).not.toContain('streamableHttp');
  //   expect(bundle).not.toContain('auth/router');
  //
  // For now, just assert the source-level check ran above (which is the
  // meaningful guard in the absence of a bundle).
  expect(true).toBe(true);
});

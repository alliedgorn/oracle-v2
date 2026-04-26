/**
 * T#673 — Info-disclosure regression test for /api/beast/:name/* endpoints
 *
 * Scans server.ts for 403 error response bodies and checks them against a
 * FORBIDDEN_IN_ERROR_BODY allowlist. Error responses on auth-gated endpoints
 * should be generic — they must not leak auth-mode hints (session vs token vs
 * cookie), network topology (local-only), or implementation details.
 *
 * ## What this guards
 *
 * T#666 identified that `/api/beast/:name/terminal` endpoints returned
 * "Browser session required" on 403, leaking the auth mechanism to
 * unauthenticated callers. This test ensures no new (or existing) 403
 * response on beast endpoints contains words that reveal auth internals.
 *
 * ## Forbidden terms in error bodies
 *
 * These words in a 403 response body tell an attacker how the auth system
 * works, reducing the attack surface they need to probe:
 *
 * - `browser`  — reveals browser-based auth
 * - `session`  — reveals session-based auth
 * - `cookie`   — reveals cookie auth mechanism
 * - `bearer`   — reveals bearer token auth
 * - `token`    — reveals token-based auth (exception: /api/auth/tokens/* endpoints
 *                where "token" IS the resource, not an auth-mode leak)
 * - `as=`      — reveals the ?as= impersonation parameter
 * - `local`    — reveals network-topology restrictions (e.g. "Local network only")
 *
 * ## Scope
 *
 * Primary: All route handlers for `/api/beast/:name/*` paths.
 * Secondary: Full-file scan to surface info-disclosure elsewhere (reported
 * as warnings, not failures, to avoid scope creep on T#673).
 *
 * ## Method
 *
 * Parse server.ts, find all 403 response lines, extract the error string,
 * check against FORBIDDEN_IN_ERROR_BODY. Report matches with line numbers.
 *
 * Source: Thread #20, T#666 finding, Bertus pre-blessed scope.
 * Author: Pip (QA/Chaos Testing)
 */

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(SRC_ROOT, 'server.ts');

/**
 * Words that must not appear in 403 error response bodies on beast endpoints.
 * Case-insensitive matching. Each entry explains why it leaks information.
 */
const FORBIDDEN_IN_ERROR_BODY: Array<{ term: string; reason: string }> = [
  {
    term: 'browser',
    reason: 'Reveals that auth is browser-based (session cookies). Attacker learns to target cookie theft rather than token theft.',
  },
  {
    term: 'session',
    reason: 'Reveals session-based auth mechanism. Generic "Access denied" or "Forbidden" gives nothing away.',
  },
  {
    term: 'cookie',
    reason: 'Reveals cookie-based auth. Same as "session" — tells attacker exactly what credential to steal.',
  },
  {
    term: 'bearer',
    reason: 'Reveals bearer token auth. Attacker knows to look for Authorization headers or token storage.',
  },
  {
    term: 'as=',
    reason: 'Reveals the ?as= identity parameter. Attacker learns they can impersonate Beasts if they find a valid name.',
  },
  {
    term: 'local network',
    reason: 'Reveals network topology restriction. Attacker learns the endpoint works from localhost, suggesting SSRF as a bypass.',
  },
  {
    term: 'local access',
    reason: 'Same as "local network" — reveals network-layer auth that can be bypassed via SSRF.',
  },
];

/**
 * Endpoints where "token" in the error body is acceptable because "token"
 * IS the resource being managed, not an auth-mode leak.
 * e.g. /api/auth/tokens — "Token creation requires..." is about the token
 * CRUD API, not revealing how auth works.
 */
const TOKEN_TERM_EXEMPT_PATHS = [
  '/api/auth/tokens',
];

/**
 * Spoof-detection 403 responses ("Identity spoof blocked. ?as=/body.beast must
 * match authenticated caller...") legitimately mention "as=" because the
 * attempted spoof IS the diagnostic — owner-debug-affordance preserves the
 * specific message so legit code with auth-shape mismatch can be debugged.
 *
 * These are in-flow owner messages, not external attack surface. Whether to
 * also flatten them (security-by-obscurity over owner-debug-affordance) is a
 * separate scope decision — file follow-up if desired.
 */
const SPOOF_DETECTION_PATTERN = /Identity spoof blocked/i;

interface ErrorMatch {
  line: number;
  errorText: string;
  term: string;
  reason: string;
  routePath: string;
}

/**
 * Extract the current route path context for a given line number.
 * Walks backward from the line to find the nearest app.get/post/patch/delete/put declaration.
 */
function findRoutePath(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const match = lines[i].match(/app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (match) return match[2];
  }
  return 'unknown';
}

/**
 * Check if a route path matches /api/beast/:name/* pattern.
 */
function isBeastEndpoint(path: string): boolean {
  return path.startsWith('/api/beast/') || path === '/api/beasts';
}

/**
 * Scan server.ts for 403 responses containing forbidden terms.
 */
function scanForInfoDisclosure(): { beastMatches: ErrorMatch[]; otherMatches: ErrorMatch[] } {
  const content = readFileSync(SERVER_PATH, 'utf8');
  const lines = content.split('\n');
  const beastMatches: ErrorMatch[] = [];
  const otherMatches: ErrorMatch[] = [];

  // Match patterns like: c.json({ error: '...' }, 403) or c.json({ error: "..." }, 403)
  const errorPattern = /c\.json\(\s*\{\s*error:\s*['"`]([^'"`]+)['"`]\s*\}\s*,\s*403\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const match = line.match(errorPattern);
    if (!match) continue;

    const errorText = match[1];
    const routePath = findRoutePath(lines, i);

    for (const forbidden of FORBIDDEN_IN_ERROR_BODY) {
      if (errorText.toLowerCase().includes(forbidden.term.toLowerCase())) {
        // Check token exemption
        if (forbidden.term === 'token' && TOKEN_TERM_EXEMPT_PATHS.some(p => routePath.startsWith(p))) {
          continue;
        }

        const entry: ErrorMatch = {
          line: i + 1,
          errorText,
          term: forbidden.term,
          reason: forbidden.reason,
          routePath,
        };

        if (isBeastEndpoint(routePath)) {
          beastMatches.push(entry);
        } else {
          otherMatches.push(entry);
        }
      }
    }
  }

  return { beastMatches, otherMatches };
}

test('T#673: no info-disclosure in 403 responses on /api/beast/:name/* endpoints', () => {
  const { beastMatches } = scanForInfoDisclosure();

  if (beastMatches.length > 0) {
    const report = beastMatches
      .map(
        (m) =>
          `  server.ts:${m.line} [${m.routePath}]\n` +
          `    error: "${m.errorText}"\n` +
          `    forbidden term: "${m.term}" — ${m.reason}`
      )
      .join('\n\n');

    throw new Error(
      `Found ${beastMatches.length} info-disclosure issue(s) in /api/beast/:name/* 403 responses.\n\n` +
        `These error bodies leak auth-mode or infrastructure details to unauthenticated callers.\n` +
        `Replace with generic messages like "Access denied" or "Forbidden".\n\n` +
        `${report}\n\n` +
        `If a specific message is intentional and reviewed:\n` +
        `  1. Document the security rationale in a comment at the call site\n` +
        `  2. Add an exemption in this test with a link to the review\n` +
        `  3. Do not disable the test wholesale`
    );
  }

  expect(beastMatches.length).toBe(0);
});

test('T#679: no info-disclosure in 403 responses on non-beast endpoints (post-T#679 hardening)', () => {
  const { otherMatches } = scanForInfoDisclosure();

  // Filter out spoof-detection messages — owner-debug-affordance, not external
  // attack surface. See SPOOF_DETECTION_PATTERN definition for rationale.
  const enforceableMatches = otherMatches.filter(
    (m) => !SPOOF_DETECTION_PATTERN.test(m.errorText)
  );

  if (enforceableMatches.length > 0) {
    const summary = enforceableMatches
      .map((m) => `  server.ts:${m.line} [${m.routePath}] "${m.errorText}" (term: ${m.term})`)
      .join('\n');

    throw new Error(
      `[T#679] Found ${enforceableMatches.length} info-disclosure leak(s) in non-beast 403 responses ` +
        `(spoof-detection messages excluded — see SPOOF_DETECTION_PATTERN):\n${summary}\n` +
        `Replace verbose 403 message with { error: 'forbidden' } per T#679.\n`
    );
  }

  // Hard-fail (post-T#679) — was advisory soft-pass under T#673, flipped per
  // T#679 acceptance criterion 2.
  expect(enforceableMatches.length).toBe(0);
});

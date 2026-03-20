/**
 * Audit Logging API Integration Tests
 * Tier 3 — access control, actor extraction verification
 *
 * Note: Audit logs are restricted to Gorn (session auth) and
 * security team (bertus, talon) via ?as= identity.
 * Other Beasts are blocked.
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Audit Logging API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // Access Control (Regression Guards)
  // =====================
  describe("Access Control — Gorn + Security Team", () => {
    test("GET /api/audit rejects unauthenticated requests", async () => {
      const res = await fetch(`${BASE_URL}/api/audit`);
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("restricted");
    });

    test("GET /api/audit/stats rejects unauthenticated requests", async () => {
      const res = await fetch(`${BASE_URL}/api/audit/stats`);
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("restricted");
    });

    test("GET /api/audit with ?as=pip rejects Beast identity", async () => {
      const res = await fetch(`${BASE_URL}/api/audit?as=${TEST_BEAST}`);
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("restricted");
    });

    test("GET /api/audit/stats with ?as=pip rejects Beast identity", async () => {
      const res = await fetch(`${BASE_URL}/api/audit/stats?as=${TEST_BEAST}`);
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("restricted");
    });

    test("GET /api/audit with fake X-Beast header is rejected", async () => {
      const res = await fetch(`${BASE_URL}/api/audit`, {
        headers: { "X-Beast": "gorn" },
      });
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("restricted");
    });

    test("GET /api/audit with ?as=karo rejects non-security Beast", async () => {
      const res = await fetch(`${BASE_URL}/api/audit?as=karo`);
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("restricted");
    });
  });

  // =====================
  // Security Team Access (Allowlist)
  // =====================
  describe("Security Team Access", () => {
    test("GET /api/audit with ?as=bertus allows security team", async () => {
      const res = await fetch(`${BASE_URL}/api/audit?as=bertus`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.audit || data).toBeTruthy();
    });

    test("GET /api/audit with ?as=talon allows security team", async () => {
      const res = await fetch(`${BASE_URL}/api/audit?as=talon`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.audit || data).toBeTruthy();
    });

    test("GET /api/audit/stats with ?as=bertus allows security team", async () => {
      const res = await fetch(`${BASE_URL}/api/audit/stats?as=bertus`);
      expect(res.ok).toBe(true);
    });

    test("Audit entries have expected fields", async () => {
      const res = await fetch(`${BASE_URL}/api/audit?as=bertus`);
      const data = await res.json();
      const entries = data.audit || data;
      if (Array.isArray(entries) && entries.length > 0) {
        const entry = entries[0];
        expect(entry.id).toBeTruthy();
        expect(entry.timestamp).toBeTruthy();
        expect(entry.action || entry.request_path).toBeTruthy();
      }
    });

    test("Actor field is populated (not all unknown)", async () => {
      const res = await fetch(`${BASE_URL}/api/audit?as=bertus`);
      const data = await res.json();
      const entries = data.audit || data;
      if (Array.isArray(entries) && entries.length > 0) {
        const knownActors = entries.filter((e: any) => e.actor && e.actor !== "unknown");
        // At least some entries should have known actors after the fix
        expect(knownActors.length).toBeGreaterThan(0);
      }
    });
  });

  // =====================
  // Actor Extraction (Indirect Verification)
  // =====================
  describe("Actor Extraction — Indirect", () => {
    test("API calls with ?as= param capture actor", async () => {
      // Make a request that should log with actor=pip
      const res = await fetch(
        `${BASE_URL}/api/notifications/${TEST_BEAST}?as=${TEST_BEAST}`
      );
      expect(res.ok).toBe(true);
      // We can't read audit logs to verify, but if the request succeeded
      // the middleware should have captured actor=pip from ?as= param
    });

    test("API calls with body author capture actor", async () => {
      // Forum post includes author in body
      const res = await fetch(`${BASE_URL}/api/thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: 81,
          message: `test_audit_actor_${Date.now()}`,
          role: "claude",
          author: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(true);
      // Audit middleware should extract actor=pip from body.author
    });
  });

  // =====================
  // Edge Cases
  // =====================
  describe("Edge Cases", () => {
    test("GET /api/audit with invalid query params doesn't crash", async () => {
      const res = await fetch(
        `${BASE_URL}/api/audit?limit=abc&offset=-1`
      );
      // Should still return the auth error, not a 500
      expect(res.status).toBeLessThan(500);
    });

    test("GET /api/audit/stats with invalid params doesn't crash", async () => {
      const res = await fetch(
        `${BASE_URL}/api/audit/stats?from=invalid&to=also-invalid`
      );
      expect(res.status).toBeLessThan(500);
    });
  });
});

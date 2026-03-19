/**
 * DM API Integration Tests
 * Tier 1 — direct messages, conversations, read tracking
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";
const TEST_PREFIX = "test_dm_";

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function sendDM(from: string, to: string, message: string) {
  const res = await fetch(`${BASE_URL}/api/dm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, message }),
  });
  return { res, data: await res.json() };
}

describe("DM API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // Send & Read
  // =====================
  describe("Send & Read", () => {
    test("POST /api/dm sends a message", async () => {
      const { res, data } = await sendDM(
        TEST_BEAST,
        OTHER_BEAST,
        `${TEST_PREFIX}hello ${Date.now()}`
      );
      expect(res.ok).toBe(true);
      expect(data.message_id).toBeTruthy();
      expect(data.conversation_id).toBeTruthy();
    });

    test("GET /api/dm/:name lists conversations", async () => {
      const res = await fetch(`${BASE_URL}/api/dm/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.conversations).toBeInstanceOf(Array);
    });

    test("GET /api/dm/:name/:other returns conversation thread", async () => {
      const res = await fetch(
        `${BASE_URL}/api/dm/${TEST_BEAST}/${OTHER_BEAST}`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.messages).toBeInstanceOf(Array);
    });

    test("GET /api/dm/dashboard returns summary", async () => {
      const res = await fetch(`${BASE_URL}/api/dm/dashboard`);
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Read Tracking
  // =====================
  describe("Read Tracking", () => {
    test("PATCH /api/dm/:name/:other/read-all marks conversation read", async () => {
      const res = await fetch(
        `${BASE_URL}/api/dm/${TEST_BEAST}/${OTHER_BEAST}/read-all`,
        { method: "PATCH" }
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Validation
  // =====================
  describe("Validation", () => {
    test("POST DM without from fails", async () => {
      const res = await fetch(`${BASE_URL}/api/dm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: OTHER_BEAST, message: "no from" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST DM without to fails", async () => {
      const res = await fetch(`${BASE_URL}/api/dm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: TEST_BEAST, message: "no to" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST DM without message fails", async () => {
      const res = await fetch(`${BASE_URL}/api/dm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: TEST_BEAST, to: OTHER_BEAST }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST DM to self is handled", async () => {
      const res = await fetch(`${BASE_URL}/api/dm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: TEST_BEAST,
          to: TEST_BEAST,
          message: "talking to myself",
        }),
      });
      // Should either work or reject gracefully (no 500)
      expect(res.status).toBeLessThan(500);
    });

    test("GET conversation with nonexistent beast returns empty or 404", async () => {
      const res = await fetch(
        `${BASE_URL}/api/dm/${TEST_BEAST}/nonexistent_beast_xyz`
      );
      expect(res.status).toBeLessThan(500);
    });
  });
});

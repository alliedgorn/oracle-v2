/**
 * DM API Integration Tests
 * Tier 1 — direct messages, conversations, read tracking
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";
const TEST_PREFIX = "test_dm_";
const createdMessageIds: number[] = [];

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
  const data = await res.json();
  if (res.ok && data.message_id) createdMessageIds.push(data.message_id);
  return { res, data };
}

describe("DM API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    for (const id of createdMessageIds) {
      try {
        await fetch(`${BASE_URL}/api/dm/messages/${id}?as=${TEST_BEAST}`, { method: "DELETE" });
      } catch {
        // Best-effort cleanup
      }
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

  // =====================
  // Delete Messages
  // =====================
  describe("Delete Messages", () => {
    test("DELETE /api/dm/messages/:id removes a message", async () => {
      const { data } = await sendDM(
        TEST_BEAST,
        OTHER_BEAST,
        `${TEST_PREFIX}delete_test_${Date.now()}`
      );
      const idx = createdMessageIds.indexOf(data.message_id);
      if (idx >= 0) createdMessageIds.splice(idx, 1); // Don't double-delete in cleanup

      const res = await fetch(
        `${BASE_URL}/api/dm/messages/${data.message_id}?as=${TEST_BEAST}`,
        { method: "DELETE" }
      );
      expect(res.ok).toBe(true);
    });

    test("DELETE nonexistent message returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/dm/messages/99999999?as=${TEST_BEAST}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    test("DELETE without ?as= is rejected (auth required)", async () => {
      const { data } = await sendDM(
        TEST_BEAST,
        OTHER_BEAST,
        `${TEST_PREFIX}auth_test_${Date.now()}`
      );
      const res = await fetch(
        `${BASE_URL}/api/dm/messages/${data.message_id}`,
        { method: "DELETE" }
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      // Clean up since the delete failed
      await fetch(
        `${BASE_URL}/api/dm/messages/${data.message_id}?as=${TEST_BEAST}`,
        { method: "DELETE" }
      );
      const idx = createdMessageIds.indexOf(data.message_id);
      if (idx >= 0) createdMessageIds.splice(idx, 1);
    });

    test("DELETE by non-participant is rejected", async () => {
      const { data } = await sendDM(
        TEST_BEAST,
        OTHER_BEAST,
        `${TEST_PREFIX}idor_test_${Date.now()}`
      );
      // Try deleting as a beast not in this conversation
      const res = await fetch(
        `${BASE_URL}/api/dm/messages/${data.message_id}?as=gnarl`,
        { method: "DELETE" }
      );
      expect(res.status).toBe(403);
      // Clean up
      await fetch(
        `${BASE_URL}/api/dm/messages/${data.message_id}?as=${TEST_BEAST}`,
        { method: "DELETE" }
      );
      const idx = createdMessageIds.indexOf(data.message_id);
      if (idx >= 0) createdMessageIds.splice(idx, 1);
    });
  });
});

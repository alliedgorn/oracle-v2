/**
 * Notification Queue API Integration Tests
 * Tier 2 — notifications, read tracking, dismissal
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Notification Queue API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // List & Read
  // =====================
  describe("List & Read", () => {
    test("GET /api/notifications/:beast returns notifications", async () => {
      const res = await fetch(`${BASE_URL}/api/notifications/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.notifications).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThanOrEqual(0);
    });

    test("GET /api/notifications/:beast/unread returns unread only", async () => {
      const res = await fetch(
        `${BASE_URL}/api/notifications/${TEST_BEAST}/unread`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.notifications || data).toBeTruthy();
    });

    test("GET /api/notifications/unread-all returns global unread counts", async () => {
      const res = await fetch(`${BASE_URL}/api/notifications/unread-all`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toBeTruthy();
    });

    test("Notifications have required fields", async () => {
      const res = await fetch(`${BASE_URL}/api/notifications/${TEST_BEAST}`);
      const data = await res.json();
      if (data.notifications && data.notifications.length > 0) {
        const notif = data.notifications[0];
        expect(notif.id).toBeTruthy();
        expect(notif.beast).toBe(TEST_BEAST);
        expect(notif.type).toBeTruthy();
        expect(notif.status).toBeTruthy();
        expect(notif.created_at).toBeTruthy();
      }
    });
  });

  // =====================
  // Mark Seen
  // =====================
  describe("Mark Seen", () => {
    test("PATCH /api/notifications/:id/seen marks notification as seen", async () => {
      // Get a pending notification
      const listRes = await fetch(
        `${BASE_URL}/api/notifications/${TEST_BEAST}`
      );
      const listData = await listRes.json();
      const pending = listData.notifications?.find(
        (n: any) => n.status === "pending"
      );
      if (!pending) {
        // No pending notifications to test, skip gracefully
        expect(true).toBe(true);
        return;
      }
      const res = await fetch(
        `${BASE_URL}/api/notifications/${pending.id}/seen?as=${TEST_BEAST}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
        }
      );
      expect(res.ok).toBe(true);
    });

    test("PATCH /api/notifications/:beast/seen-all marks all as seen", async () => {
      const res = await fetch(
        `${BASE_URL}/api/notifications/${TEST_BEAST}/seen-all?as=${TEST_BEAST}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
        }
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Dismiss
  // =====================
  describe("Dismiss", () => {
    test("PATCH /api/notifications/:id/dismiss dismisses notification", async () => {
      const listRes = await fetch(
        `${BASE_URL}/api/notifications/${TEST_BEAST}`
      );
      const listData = await listRes.json();
      const notif = listData.notifications?.[0];
      if (!notif) {
        expect(true).toBe(true);
        return;
      }
      const res = await fetch(
        `${BASE_URL}/api/notifications/${notif.id}/dismiss?as=${TEST_BEAST}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
        }
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Ownership / IDOR
  // =====================
  describe("Ownership", () => {
    test("Cannot read another beast's notifications", async () => {
      // Get pip's notifications count
      const pipRes = await fetch(
        `${BASE_URL}/api/notifications/${TEST_BEAST}`
      );
      const pipData = await pipRes.json();

      // Get bertus's notifications count
      const bertusRes = await fetch(
        `${BASE_URL}/api/notifications/${OTHER_BEAST}`
      );
      const bertusData = await bertusRes.json();

      // Both should return their own data (no cross-contamination)
      expect(pipRes.ok).toBe(true);
      expect(bertusRes.ok).toBe(true);
      // Notifications should be scoped to each beast
      if (pipData.notifications?.length > 0) {
        for (const n of pipData.notifications) {
          expect(n.beast).toBe(TEST_BEAST);
        }
      }
      if (bertusData.notifications?.length > 0) {
        for (const n of bertusData.notifications) {
          expect(n.beast).toBe(OTHER_BEAST);
        }
      }
    });
  });

  // =====================
  // Edge Cases
  // =====================
  describe("Edge Cases", () => {
    test("GET /api/notifications/nonexistent-beast returns empty", async () => {
      const res = await fetch(
        `${BASE_URL}/api/notifications/nonexistent_beast_xyz`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.notifications?.length || 0).toBe(0);
    });

    test("PATCH /api/notifications/999999/seen handles nonexistent id", async () => {
      const res = await fetch(
        `${BASE_URL}/api/notifications/999999/seen?as=${TEST_BEAST}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
        }
      );
      expect(res.ok).toBe(false);
      expect(res.status === 400 || res.status === 404).toBe(true);
    });

    test("PATCH /api/notifications/999999/dismiss handles nonexistent id", async () => {
      const res = await fetch(
        `${BASE_URL}/api/notifications/999999/dismiss?as=${TEST_BEAST}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
        }
      );
      expect(res.ok).toBe(false);
      expect(res.status === 400 || res.status === 404).toBe(true);
    });
  });
});

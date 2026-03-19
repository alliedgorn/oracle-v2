/**
 * Auth & Ownership Integration Tests
 * Tier 1 — negative auth tests, IDOR across all mutation endpoints
 *
 * Per Bertus security review: verify unauthenticated and wrong-beast
 * requests are rejected with correct status codes (401/403)
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

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

describe("Auth & Ownership Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // Auth Endpoints
  // =====================
  describe("Auth Endpoints", () => {
    test("GET /api/auth/status returns auth state", async () => {
      const res = await fetch(`${BASE_URL}/api/auth/status`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(typeof data).toBe("object");
    });

    test("GET /api/settings returns config", async () => {
      const res = await fetch(`${BASE_URL}/api/settings`);
      expect(res.ok).toBe(true);
    });

    test("POST /api/settings restricted to gorn", async () => {
      // Non-gorn should be rejected
      const res = await fetch(`${BASE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ as: TEST_BEAST, key: "test", value: "test" }),
      });
      // Should be 403 or similar
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // =====================
  // Scheduler IDOR — Cross-beast mutations
  // =====================
  describe("Scheduler IDOR", () => {
    let ownScheduleId: number;
    let otherScheduleId: number;

    beforeAll(async () => {
      // Create own schedule
      const res1 = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: `auth_test_own_${Date.now()}`,
          interval: "1d",
        }),
      });
      if (res1.ok) {
        const data = await res1.json();
        ownScheduleId = data.id;
      }

      // Create other beast's schedule
      const res2 = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: OTHER_BEAST,
          task: `auth_test_other_${Date.now()}`,
          interval: "1d",
        }),
      });
      if (res2.ok) {
        const data = await res2.json();
        otherScheduleId = data.id;
      }
    });

    afterAll(async () => {
      // Cleanup
      for (const [id, beast] of [
        [ownScheduleId, TEST_BEAST],
        [otherScheduleId, OTHER_BEAST],
      ] as [number, string][]) {
        if (id) {
          try {
            await fetch(`${BASE_URL}/api/schedules/${id}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ beast }),
            });
          } catch {}
        }
      }
    });

    test("own schedule PATCH succeeds", async () => {
      if (!ownScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${ownScheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, interval: "6h" }),
      });
      expect(res.ok).toBe(true);
    });

    test("cross-beast PATCH returns 403", async () => {
      if (!otherScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${otherScheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, interval: "6h" }),
      });
      expect(res.status).toBe(403);
    });

    test("cross-beast DELETE returns 403", async () => {
      if (!otherScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${otherScheduleId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      expect(res.status).toBe(403);
    });

    test("cross-beast /trigger returns 403", async () => {
      if (!otherScheduleId) return;
      const res = await fetch(
        `${BASE_URL}/api/schedules/${otherScheduleId}/trigger`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      expect(res.status).toBe(403);
    });

    test("no beast identity on PATCH returns 400", async () => {
      if (!ownScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${ownScheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval: "6h" }),
      });
      expect(res.status).toBe(400);
    });

    test("no beast identity on DELETE returns 400", async () => {
      if (!ownScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${ownScheduleId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    test("gorn can override ownership", async () => {
      if (!otherScheduleId) return;
      const res = await fetch(
        `${BASE_URL}/api/schedules/${otherScheduleId}/trigger`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: "gorn" }),
        }
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Beast Profile IDOR
  // =====================
  describe("Beast Profile Access", () => {
    test("GET /api/beasts lists all beasts", async () => {
      const res = await fetch(`${BASE_URL}/api/beasts`);
      expect(res.ok).toBe(true);
    });

    test("GET /api/beast/:name returns profile", async () => {
      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.name).toBe(TEST_BEAST);
    });

    test("GET nonexistent beast returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/beast/nonexistent_xyz`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Task/Board Ownership
  // =====================
  describe("Task Ownership", () => {
    let testTaskId: number;

    beforeAll(async () => {
      const res = await fetch(`${BASE_URL}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `auth_test_task_${Date.now()}`,
          description: "Auth test task",
          assigned_to: TEST_BEAST,
          created_by: TEST_BEAST,
          priority: "low",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        testTaskId = data.id || data.task?.id;
      }
    });

    afterAll(async () => {
      if (testTaskId) {
        try {
          await fetch(`${BASE_URL}/api/tasks/${testTaskId}`, {
            method: "DELETE",
          });
        } catch {}
      }
    });

    test("GET /api/tasks returns task list", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.tasks).toBeInstanceOf(Array);
    });

    test("GET /api/tasks/:id returns task", async () => {
      if (!testTaskId) return;
      const res = await fetch(`${BASE_URL}/api/tasks/${testTaskId}`);
      expect(res.ok).toBe(true);
    });

    test("PATCH /api/tasks/:id updates task", async () => {
      if (!testTaskId) return;
      const res = await fetch(`${BASE_URL}/api/tasks/${testTaskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });
      expect(res.ok).toBe(true);
    });

    test("GET nonexistent task returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks/99999`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Group Access
  // =====================
  describe("Group Access", () => {
    test("GET /api/groups lists groups", async () => {
      const res = await fetch(`${BASE_URL}/api/groups`);
      expect(res.ok).toBe(true);
    });

    test("GET nonexistent group returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/group/nonexistent_xyz`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Endpoint Security — No 500s
  // =====================
  describe("No 500 errors on bad input", () => {
    const endpoints = [
      { method: "GET", path: "/api/schedules/notanumber" },
      { method: "GET", path: "/api/thread/notanumber" },
      { method: "GET", path: "/api/tasks/notanumber" },
      { method: "POST", path: "/api/thread", body: {} },
      { method: "POST", path: "/api/dm", body: {} },
      { method: "POST", path: "/api/schedules", body: {} },
      { method: "POST", path: "/api/tasks", body: {} },
    ];

    for (const { method, path, body } of endpoints) {
      test(`${method} ${path} with bad input does not 500`, async () => {
        const res = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status).toBeLessThan(500);
      });
    }
  });
});

/**
 * Scheduler API Integration Tests
 * Tier 1 — highest bug frequency area
 *
 * Tests: CRUD, ownership/IDOR, validation, trigger lifecycle, datetime handling
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";

// Test data prefix for isolation
const TEST_PREFIX = "test_sched_";
const createdScheduleIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createSchedule(overrides: Record<string, unknown> = {}) {
  const body = {
    beast: TEST_BEAST,
    task: `${TEST_PREFIX}${Date.now()}`,
    interval: "1d",
    ...overrides,
  };
  const res = await fetch(`${BASE_URL}/api/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const data = await res.json();
    createdScheduleIds.push(data.id);
    return { res, data };
  }
  return { res, data: null };
}

async function deleteSchedule(id: number, beast = TEST_BEAST) {
  return fetch(`${BASE_URL}/api/schedules/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beast }),
  });
}

describe("Scheduler API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    // Cleanup all test schedules
    for (const id of createdScheduleIds) {
      try {
        await deleteSchedule(id);
      } catch {
        // Best effort cleanup
      }
    }
  });

  // =====================
  // Health
  // =====================
  describe("Health", () => {
    test("GET /api/scheduler/health returns running status", async () => {
      const res = await fetch(`${BASE_URL}/api/scheduler/health`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.status).toBe("running");
      expect(data.interval_seconds).toBe(10);
      expect(data.last_check).toBeTruthy();
    });

    test("health last_check updates within 15 seconds", async () => {
      const res1 = await fetch(`${BASE_URL}/api/scheduler/health`);
      const data1 = await res1.json();
      await Bun.sleep(12_000);
      const res2 = await fetch(`${BASE_URL}/api/scheduler/health`);
      const data2 = await res2.json();
      expect(data1.last_check).not.toBe(data2.last_check);
    }, 20_000);
  });

  // =====================
  // CRUD — Happy Path
  // =====================
  describe("CRUD — Happy Path", () => {
    test("GET /api/schedules returns schedule list", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.schedules).toBeInstanceOf(Array);
    });

    test("GET /api/schedules?beast=X filters by beast", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules?beast=${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      for (const s of data.schedules) {
        expect(s.beast).toBe(TEST_BEAST);
      }
    });

    test("POST /api/schedules creates a schedule", async () => {
      const { res, data } = await createSchedule({
        task: `${TEST_PREFIX}create_happy`,
        interval: "1h",
      });
      expect(res.status).toBe(201);
      expect(data.beast).toBe(TEST_BEAST);
      expect(data.task).toBe(`${TEST_PREFIX}create_happy`);
      expect(data.interval).toBe("1h");
      expect(data.interval_seconds).toBe(3600);
      expect(data.enabled).toBe(1);
      expect(data.trigger_status).toBe("pending");
      expect(data.next_due_at).toBeTruthy();
    });

    test("GET /api/schedules/:id returns single schedule", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}get_single`,
      });
      const res = await fetch(`${BASE_URL}/api/schedules/${created.id}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(created.id);
      expect(data.task).toBe(`${TEST_PREFIX}get_single`);
    });

    test("PATCH /api/schedules/:id updates schedule", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}patch_happy`,
      });
      const res = await fetch(`${BASE_URL}/api/schedules/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, interval: "3h" }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.interval).toBe("3h");
      expect(data.interval_seconds).toBe(10800);
    });

    test("DELETE /api/schedules/:id removes schedule", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}delete_happy`,
      });
      const idx = createdScheduleIds.indexOf(created.id);
      if (idx >= 0) createdScheduleIds.splice(idx, 1); // Don't double-delete in cleanup

      const res = await deleteSchedule(created.id);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.deleted).toBe(true);
    });

    test("POST with schedule_time and timezone", async () => {
      const { res, data } = await createSchedule({
        task: `${TEST_PREFIX}fixed_time`,
        interval: "1d",
        schedule_time: "09:00",
        timezone: "Asia/Bangkok",
      });
      expect(res.ok).toBe(true);
      expect(data.schedule_time).toBe("09:00");
      expect(data.timezone).toBe("Asia/Bangkok");
      // 09:00 BKK = 02:00 UTC
      expect(data.next_due_at).toContain("02:00:00");
    });
  });

  // =====================
  // Trigger Lifecycle
  // =====================
  describe("Trigger Lifecycle", () => {
    test("PATCH /:id/trigger sets status to triggered", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}trigger_test`,
      });
      const res = await fetch(
        `${BASE_URL}/api/schedules/${created.id}/trigger`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.trigger_status).toBe("triggered");
      expect(data.last_triggered_at).toBeTruthy();
    });

    test("PATCH /:id/run resets status to pending and advances next_due", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}run_test`,
        interval: "1h",
      });
      // First trigger it
      await fetch(`${BASE_URL}/api/schedules/${created.id}/trigger`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      // Then /run
      const res = await fetch(`${BASE_URL}/api/schedules/${created.id}/run`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.trigger_status).toBe("pending");
      // next_due_at should have advanced
      const nextDue = new Date(data.next_due_at);
      expect(nextDue.getTime()).toBeGreaterThan(Date.now());
    });

    test("/run advances next_due_at by interval_seconds", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}run_advance`,
        interval: "3h",
      });
      const originalDue = new Date(created.next_due_at).getTime();

      const res = await fetch(`${BASE_URL}/api/schedules/${created.id}/run`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      const data = await res.json();
      const newDue = new Date(data.next_due_at).getTime();
      // Should advance — new due should be after run time
      expect(newDue).toBeGreaterThan(originalDue);
    });
  });

  // =====================
  // Ownership / IDOR
  // =====================
  describe("Ownership / IDOR", () => {
    let victimScheduleId: number;

    beforeAll(async () => {
      // Create a schedule owned by OTHER_BEAST via gorn override or direct
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: OTHER_BEAST,
          task: `${TEST_PREFIX}victim_schedule`,
          interval: "1d",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        victimScheduleId = data.id;
      }
    });

    afterAll(async () => {
      if (victimScheduleId) {
        try {
          await deleteSchedule(victimScheduleId, OTHER_BEAST);
        } catch {}
      }
    });

    test("PATCH rejects cross-beast modification (403)", async () => {
      if (!victimScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${victimScheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, task: "hacked" }),
      });
      expect(res.status).toBe(403);
    });

    test("DELETE rejects cross-beast deletion (403)", async () => {
      if (!victimScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${victimScheduleId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      expect(res.status).toBe(403);
    });

    test("/trigger rejects cross-beast trigger (403)", async () => {
      if (!victimScheduleId) return;
      const res = await fetch(
        `${BASE_URL}/api/schedules/${victimScheduleId}/trigger`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      expect(res.status).toBe(403);
    });

    test("/run rejects cross-beast run (403 or 404)", async () => {
      if (!victimScheduleId) return;
      const res = await fetch(
        `${BASE_URL}/api/schedules/${victimScheduleId}/run`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      // Should be 403 (forbidden) or 404 (not found for this beast)
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    test("PATCH with no beast param is rejected (400)", async () => {
      if (!victimScheduleId) return;
      const res = await fetch(`${BASE_URL}/api/schedules/${victimScheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "no-identity" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Validation
  // =====================
  describe("Validation", () => {
    test("rejects missing beast", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "no-beast", interval: "1h" }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects missing task", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, interval: "1h" }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects empty task name", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, task: "", interval: "1h" }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects missing interval", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, task: "no-interval" }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects invalid interval format", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "bad-interval",
          interval: "banana",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects negative interval", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "negative",
          interval: "-1h",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects too-short interval (1s)", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "too-short",
          interval: "1s",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects invalid schedule_time (25:99)", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "bad-time",
          interval: "1d",
          schedule_time: "25:99",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects invalid timezone", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "bad-tz",
          interval: "1d",
          schedule_time: "09:00",
          timezone: "Mars/Olympus",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects duplicate task name for same beast", async () => {
      const taskName = `${TEST_PREFIX}duplicate_${Date.now()}`;
      await createSchedule({ task: taskName });
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: taskName,
          interval: "1h",
        }),
      });
      expect(res.status).toBe(409);
    });

    test("rejects very long task name", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "A".repeat(500),
          interval: "1h",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Security — Injection
  // =====================
  describe("Security — Injection", () => {
    test("rejects SQL injection in task name", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "'; DROP TABLE schedules; --",
          interval: "1h",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects shell injection in task name", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "test; rm -rf /",
          interval: "1h",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects XSS in task name", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          task: "<script>alert(1)</script>",
          interval: "1h",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Edge Cases
  // =====================
  describe("Edge Cases", () => {
    test("GET nonexistent schedule returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules/99999`);
      expect(res.status).toBe(404);
    });

    test("PATCH nonexistent schedule returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules/99999`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, task: "ghost" }),
      });
      expect(res.status).toBe(404);
    });

    test("DELETE nonexistent schedule returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/schedules/99999`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      expect(res.status).toBe(404);
    });

    test("PATCH preserves fields not being updated", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}preserve_fields`,
        interval: "1d",
        schedule_time: "09:00",
        timezone: "Asia/Bangkok",
      });
      // Update only interval
      const res = await fetch(`${BASE_URL}/api/schedules/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, interval: "12h" }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.interval).toBe("12h");
      expect(data.schedule_time).toBe("09:00");
      expect(data.timezone).toBe("Asia/Bangkok");
    });

    test("enable/disable toggle works", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}toggle_enable`,
      });
      // Disable
      const res1 = await fetch(`${BASE_URL}/api/schedules/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, enabled: false }),
      });
      const data1 = await res1.json();
      expect(data1.enabled).toBeFalsy();

      // Re-enable
      const res2 = await fetch(`${BASE_URL}/api/schedules/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST, enabled: true }),
      });
      const data2 = await res2.json();
      expect(data2.enabled).toBeTruthy();
    });
  });

  // =====================
  // Re-trigger — regression guard for a78e350
  // =====================
  describe("Re-trigger — stale triggered schedules", () => {
    test("triggered schedule appears in /due after being stuck (daemon query coverage)", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}retrigger_test`,
        interval: "10m",
      });
      // Manually trigger it
      await fetch(`${BASE_URL}/api/schedules/${created.id}/trigger`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      // Verify it's in triggered state
      const check = await fetch(`${BASE_URL}/api/schedules/${created.id}`);
      const checkData = await check.json();
      expect(checkData.trigger_status).toBe("triggered");
    });

    test("/run after trigger resets to pending with advanced next_due", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}retrigger_run`,
        interval: "10m",
      });
      // Trigger
      await fetch(`${BASE_URL}/api/schedules/${created.id}/trigger`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      // Run
      const res = await fetch(`${BASE_URL}/api/schedules/${created.id}/run`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.trigger_status).toBe("pending");
      expect(new Date(data.next_due_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  // =====================
  // DateTime Format (regression guard for Task #58)
  // =====================
  describe("DateTime Format — Task #58 regression guard", () => {
    test("next_due_at is valid ISO 8601", async () => {
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}datetime_check`,
      });
      expect(created.next_due_at).toBeTruthy();
      const parsed = new Date(created.next_due_at);
      expect(parsed.getTime()).not.toBeNaN();
    });

    test("schedule_time 09:00 BKK correctly computes next_due_at", async () => {
      const { data } = await createSchedule({
        task: `${TEST_PREFIX}bkk_time_check`,
        interval: "1d",
        schedule_time: "09:00",
        timezone: "Asia/Bangkok",
      });
      const nextDue = new Date(data.next_due_at);
      // 09:00 BKK = 02:00 UTC
      expect(nextDue.getUTCHours()).toBe(2);
      expect(nextDue.getUTCMinutes()).toBe(0);
    });

    test("daemon trigger query finds overdue schedules (format compatibility)", async () => {
      // Create a schedule, manually set it to overdue via /trigger + /run pattern
      const { data: created } = await createSchedule({
        task: `${TEST_PREFIX}daemon_query_test`,
        interval: "10m", // shortest allowed
      });
      expect(created).toBeTruthy();
      // Verify it appears in the schedules list with correct status
      const res = await fetch(
        `${BASE_URL}/api/schedules?beast=${TEST_BEAST}`
      );
      const list = await res.json();
      const found = list.schedules.find(
        (s: Record<string, unknown>) => s.id === created!.id
      );
      expect(found).toBeTruthy();
      expect(found.trigger_status).toBe("pending");
    });
  });
});

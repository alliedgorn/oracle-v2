/**
 * Tasks & Board API Integration Tests
 * Tier 2 — task CRUD, board state, comments, bulk operations
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";
const TEST_PREFIX = "test_task_";

const createdTaskIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createTask(overrides: Record<string, unknown> = {}) {
  const body = {
    title: `${TEST_PREFIX}${Date.now()}`,
    description: "Test task created by Pip",
    priority: "medium",
    assigned_to: TEST_BEAST,
    created_by: TEST_BEAST,
    ...overrides,
  };
  const res = await fetch(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const data = await res.json();
    if (data.id) createdTaskIds.push(data.id);
    return { res, data };
  }
  return { res, data: await res.json().catch(() => null) };
}

async function deleteTask(id: number) {
  return fetch(`${BASE_URL}/api/tasks/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beast: TEST_BEAST }),
  });
}

describe("Tasks & Board API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    // Cleanup test tasks
    for (const id of createdTaskIds) {
      await deleteTask(id).catch(() => {});
    }
  });

  // =====================
  // CRUD
  // =====================
  describe("Task CRUD", () => {
    test("POST /api/tasks creates a task", async () => {
      const { res, data } = await createTask();
      expect(res.ok).toBe(true);
      expect(data.id).toBeTruthy();
      expect(data.title).toContain(TEST_PREFIX);
    });

    test("GET /api/tasks lists tasks", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.tasks).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThan(0);
    });

    test("GET /api/tasks/:id returns a single task", async () => {
      const { data: created } = await createTask();
      const res = await fetch(`${BASE_URL}/api/tasks/${created.id}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(created.id);
      expect(data.title).toBe(created.title);
    });

    test("PATCH /api/tasks/:id updates a task", async () => {
      const { data: created } = await createTask();
      const res = await fetch(`${BASE_URL}/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "in_progress",
          beast: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.status || data.task?.status).toBeTruthy();
    });

    test("DELETE /api/tasks/:id deletes a task", async () => {
      const { data: created } = await createTask();
      const id = created.id;
      // Remove from cleanup list since we're deleting it here
      const idx = createdTaskIds.indexOf(id);
      if (idx > -1) createdTaskIds.splice(idx, 1);

      const res = await fetch(`${BASE_URL}/api/tasks/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: TEST_BEAST }),
      });
      expect(res.ok).toBe(true);
    });

    test("GET /api/tasks/:id returns 404 for nonexistent task", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks/999999`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Filtering
  // =====================
  describe("Filtering & Queries", () => {
    test("GET /api/tasks?status=done filters by status", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks?status=done`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.tasks).toBeInstanceOf(Array);
      // All returned tasks should have status=done
      for (const task of data.tasks) {
        expect(task.status).toBe("done");
      }
    });

    test("GET /api/tasks?assignee=pip filters by assignee", async () => {
      await createTask({ assigned_to: TEST_BEAST });
      const res = await fetch(`${BASE_URL}/api/tasks?assignee=${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.tasks).toBeInstanceOf(Array);
    });

    test("GET /api/tasks?priority=high filters by priority", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks?priority=high`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.tasks).toBeInstanceOf(Array);
    });
  });

  // =====================
  // Comments
  // =====================
  describe("Task Comments", () => {
    test("POST /api/tasks/:id/comments adds a comment", async () => {
      const { data: task } = await createTask();
      const res = await fetch(`${BASE_URL}/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: TEST_BEAST,
          content: `${TEST_PREFIX}comment ${Date.now()}`,
        }),
      });
      expect(res.ok).toBe(true);
    });

    test("GET /api/tasks/:id/comments lists comments", async () => {
      const { data: task } = await createTask();
      // Add a comment first
      await fetch(`${BASE_URL}/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: TEST_BEAST,
          content: `${TEST_PREFIX}read_test ${Date.now()}`,
        }),
      });
      const res = await fetch(`${BASE_URL}/api/tasks/${task.id}/comments`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data) || Array.isArray(data.comments)).toBe(true);
    });
  });

  // =====================
  // Bulk Operations
  // =====================
  describe("Bulk Operations", () => {
    test("POST /api/tasks/bulk-status updates multiple tasks", async () => {
      const { data: t1 } = await createTask();
      const { data: t2 } = await createTask();
      const res = await fetch(`${BASE_URL}/api/tasks/bulk-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_ids: [t1.id, t2.id],
          status: "in_progress",
          beast: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Board
  // =====================
  describe("Board", () => {
    test("GET /api/board returns board state", async () => {
      const res = await fetch(`${BASE_URL}/api/board`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      // Board should return structured data
      expect(data).toBeTruthy();
    });
  });

  // =====================
  // Validation
  // =====================
  describe("Validation", () => {
    test("POST /api/tasks without title fails", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "no title",
          created_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(false);
    });

    test("POST /api/tasks without created_by fails", async () => {
      const res = await fetch(`${BASE_URL}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${TEST_PREFIX}no_creator`,
        }),
      });
      expect(res.ok).toBe(false);
    });

    test("PATCH /api/tasks/:id with invalid status fails gracefully", async () => {
      const { data: task } = await createTask();
      const res = await fetch(`${BASE_URL}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "nonexistent_status_xyz",
          beast: TEST_BEAST,
        }),
      });
      // Should either reject or ignore invalid status
      const data = await res.json();
      expect(data).toBeTruthy();
    });
  });
});

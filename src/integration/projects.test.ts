/**
 * Projects API Integration Tests
 * Tier 1 — CRUD, task counts, status filtering
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_PREFIX = "test_projects_";
const createdProjectIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Projects API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // List
  // =====================
  describe("List", () => {
    test("GET /api/projects returns active projects", async () => {
      const res = await fetch(`${BASE_URL}/api/projects`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.projects).toBeInstanceOf(Array);
    });

    test("GET /api/projects with status filter", async () => {
      const res = await fetch(`${BASE_URL}/api/projects?status=archived`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.projects).toBeInstanceOf(Array);
    });
  });

  // =====================
  // Create
  // =====================
  describe("Create", () => {
    test("POST /api/projects creates project", async () => {
      const res = await fetch(`${BASE_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${TEST_PREFIX}QA Test Project`,
          description: "Test project for integration testing",
          created_by: "pip",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeTruthy();
      expect(data.name).toContain(TEST_PREFIX);
      createdProjectIds.push(data.id);
    });

    test("POST /api/projects rejects missing name", async () => {
      const res = await fetch(`${BASE_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "No name",
          created_by: "pip",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/projects rejects missing created_by", async () => {
      const res = await fetch(`${BASE_URL}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${TEST_PREFIX}No Creator`,
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Detail
  // =====================
  describe("Detail", () => {
    test("GET /api/projects/:id returns project with task counts", async () => {
      if (createdProjectIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/projects/${createdProjectIds[0]}`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(createdProjectIds[0]);
      expect(data.name).toContain(TEST_PREFIX);
      expect(data.task_counts).toBeTruthy();
      expect(typeof data.task_counts).toBe("object");
    });

    test("GET /api/projects/99999 returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/projects/99999`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Update
  // =====================
  describe("Update", () => {
    test("PATCH /api/projects/:id updates name", async () => {
      if (createdProjectIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/projects/${createdProjectIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `${TEST_PREFIX}Updated Name`,
          }),
        }
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.name).toBe(`${TEST_PREFIX}Updated Name`);
    });

    test("PATCH /api/projects/:id updates status", async () => {
      if (createdProjectIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/projects/${createdProjectIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "archived" }),
        }
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.status).toBe("archived");
    });

    test("PATCH /api/projects/:id rejects empty update", async () => {
      if (createdProjectIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/projects/${createdProjectIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      expect(res.status).toBe(400);
    });
  });
});

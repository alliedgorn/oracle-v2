/**
 * Library API Integration Tests
 * Tier 1 — CRUD, search, filtering, types
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_PREFIX = "test_library_";
const createdEntryIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Library API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    // Clean up test entries by updating title to mark as test
    // No DELETE endpoint, so entries persist
  });

  // =====================
  // List & Filter
  // =====================
  describe("List & Filter", () => {
    test("GET /api/library returns entry list", async () => {
      const res = await fetch(`${BASE_URL}/api/library`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.entries).toBeInstanceOf(Array);
      expect(typeof data.total).toBe("number");
    });

    test("GET /api/library with search query", async () => {
      const res = await fetch(`${BASE_URL}/api/library?q=test`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.entries).toBeInstanceOf(Array);
    });

    test("GET /api/library with type filter", async () => {
      const res = await fetch(`${BASE_URL}/api/library?type=research`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.entries).toBeInstanceOf(Array);
      for (const entry of data.entries) {
        expect(entry.type).toBe("research");
      }
    });

    test("GET /api/library with author filter", async () => {
      const res = await fetch(`${BASE_URL}/api/library?author=gnarl`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.entries).toBeInstanceOf(Array);
      for (const entry of data.entries) {
        expect(entry.author).toBe("gnarl");
      }
    });

    test("GET /api/library with pagination", async () => {
      const res = await fetch(
        `${BASE_URL}/api/library?limit=2&offset=0`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.entries.length).toBeLessThanOrEqual(2);
    });

    test("GET /api/library with tag filter", async () => {
      const res = await fetch(`${BASE_URL}/api/library?tag=security`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.entries).toBeInstanceOf(Array);
    });
  });

  // =====================
  // Create
  // =====================
  describe("Create", () => {
    test("POST /api/library creates entry", async () => {
      const res = await fetch(`${BASE_URL}/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${TEST_PREFIX}QA Test Entry`,
          content: "Test content for integration testing",
          author: "pip",
          type: "learning",
          tags: ["test", "qa"],
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeTruthy();
      expect(data.title).toContain(TEST_PREFIX);
      expect(data.type).toBe("learning");
      createdEntryIds.push(data.id);
    });

    test("POST /api/library with valid type", async () => {
      const res = await fetch(`${BASE_URL}/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${TEST_PREFIX}Research Entry`,
          content: "Research content",
          author: "pip",
          type: "research",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.type).toBe("research");
      createdEntryIds.push(data.id);
    });

    test("POST /api/library defaults invalid type to learning", async () => {
      const res = await fetch(`${BASE_URL}/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${TEST_PREFIX}Bad Type Entry`,
          content: "Content with bad type",
          author: "pip",
          type: "nonexistent_type",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.type).toBe("learning");
      createdEntryIds.push(data.id);
    });

    test("POST /api/library rejects missing required fields", async () => {
      const res = await fetch(`${BASE_URL}/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "No content or author",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/library rejects missing title", async () => {
      const res = await fetch(`${BASE_URL}/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Content without title",
          author: "pip",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/library rejects invalid JSON", async () => {
      const res = await fetch(`${BASE_URL}/api/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Read Single
  // =====================
  describe("Read Single", () => {
    test("GET /api/library/:id returns entry", async () => {
      if (createdEntryIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/library/${createdEntryIds[0]}`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(createdEntryIds[0]);
      expect(data.title).toContain(TEST_PREFIX);
      expect(data.content).toBeTruthy();
      expect(data.tags).toBeInstanceOf(Array);
      expect(data.created_at).toBeTruthy();
      expect(data.updated_at).toBeTruthy();
    });

    test("GET /api/library/99999 returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/library/99999`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Update
  // =====================
  describe("Update", () => {
    test("PATCH /api/library/:id updates title", async () => {
      if (createdEntryIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/library/${createdEntryIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `${TEST_PREFIX}Updated Title`,
          }),
        }
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.title).toBe(`${TEST_PREFIX}Updated Title`);
    });

    test("PATCH /api/library/:id updates content", async () => {
      if (createdEntryIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/library/${createdEntryIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "Updated content by Pip QA",
          }),
        }
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.content).toBe("Updated content by Pip QA");
    });

    test("PATCH /api/library/:id updates tags", async () => {
      if (createdEntryIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/library/${createdEntryIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tags: ["updated", "qa", "pip"],
          }),
        }
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.tags).toEqual(["updated", "qa", "pip"]);
    });

    test("PATCH /api/library/:id rejects invalid JSON", async () => {
      if (createdEntryIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/library/${createdEntryIds[0]}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        }
      );
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Types
  // =====================
  describe("Types", () => {
    test("GET /api/library/types returns type counts", async () => {
      const res = await fetch(`${BASE_URL}/api/library/types`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.types).toBeInstanceOf(Array);
      for (const t of data.types) {
        expect(t.type).toBeTruthy();
        expect(typeof t.count).toBe("number");
      }
    });
  });
});

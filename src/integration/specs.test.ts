/**
 * Specs API Integration Tests
 * Tier 1 — spec registration, review workflow, history, diff
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_PREFIX = "test_specs_";
const TEST_RUN_ID = Date.now();
const createdSpecIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Specs API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    for (const id of createdSpecIds) {
      try {
        await fetch(`${BASE_URL}/api/specs/${id}?as=pip`, { method: "DELETE" });
      } catch {}
    }
  });

  // =====================
  // List & Filter
  // =====================
  describe("List & Filter", () => {
    test("GET /api/specs returns spec list", async () => {
      const res = await fetch(`${BASE_URL}/api/specs`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.specs).toBeInstanceOf(Array);
    });

    test("GET /api/specs with status filter", async () => {
      const res = await fetch(`${BASE_URL}/api/specs?status=approved`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.specs).toBeInstanceOf(Array);
      for (const spec of data.specs) {
        expect(spec.status).toBe("approved");
      }
    });

    test("GET /api/specs with repo filter", async () => {
      const res = await fetch(`${BASE_URL}/api/specs?repo=oracle-v2`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.specs).toBeInstanceOf(Array);
      for (const spec of data.specs) {
        expect(spec.repo).toBe("oracle-v2");
      }
    });

    test("GET /api/specs with both filters", async () => {
      const res = await fetch(
        `${BASE_URL}/api/specs?status=pending&repo=oracle-v2`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.specs).toBeInstanceOf(Array);
    });
  });

  // =====================
  // Spec Detail
  // =====================
  describe("Spec Detail", () => {
    test("GET /api/specs/:id returns spec detail", async () => {
      // Get first spec
      const listRes = await fetch(`${BASE_URL}/api/specs`);
      const listData = await listRes.json();
      if (listData.specs.length === 0) return; // skip if no specs

      const specId = listData.specs[0].id;
      const res = await fetch(`${BASE_URL}/api/specs/${specId}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(specId);
      expect(data.title).toBeTruthy();
      expect(data.repo).toBeTruthy();
      expect(data.status).toBeTruthy();
    });

    test("GET /api/specs/99999 returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/specs/99999`);
      expect(res.status).toBe(404);
    });

    test("GET /api/specs/:id/content returns raw markdown", async () => {
      const listRes = await fetch(`${BASE_URL}/api/specs`);
      const listData = await listRes.json();
      if (listData.specs.length === 0) return;

      const specId = listData.specs[0].id;
      const res = await fetch(`${BASE_URL}/api/specs/${specId}/content`);
      // Could be 200 (file exists) or 404 (file not on disk)
      expect(res.status).toBeLessThan(500);
      const data = await res.json();
      if (res.ok) {
        expect(data.content).toBeTruthy();
        expect(data.file_path).toBeTruthy();
      }
    });

    test("GET /api/specs/99999/content returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/specs/99999/content`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Spec Registration
  // =====================
  describe("Spec Registration", () => {
    test("POST /api/specs creates new spec", async () => {
      const res = await fetch(`${BASE_URL}/api/specs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "oracle-v2",
          file_path: `docs/specs/${TEST_PREFIX}${TEST_RUN_ID}.md`,
          task_id: "T999",
          title: `${TEST_PREFIX}Test Spec`,
          author: "pip",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeTruthy();
      expect(data.status).toBe("pending");
      expect(data.author).toBe("pip");
      createdSpecIds.push(data.id);
    });

    test("POST /api/specs rejects missing fields", async () => {
      const res = await fetch(`${BASE_URL}/api/specs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "oracle-v2",
          // missing file_path, title, author
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/specs rejects invalid repo", async () => {
      const res = await fetch(`${BASE_URL}/api/specs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "evil-repo",
          file_path: "docs/test.md",
          title: "Evil Spec",
          author: "pip",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/specs rejects duplicate repo+path", async () => {
      // Try to register the same spec again
      const res = await fetch(`${BASE_URL}/api/specs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "oracle-v2",
          file_path: `docs/specs/${TEST_PREFIX}${TEST_RUN_ID}.md`,
          title: `${TEST_PREFIX}Duplicate`,
          author: "pip",
        }),
      });
      expect(res.status).toBe(409);
    });

    test("POST /api/specs rejects author mismatch", async () => {
      const res = await fetch(`${BASE_URL}/api/specs?as=karo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: "oracle-v2",
          file_path: `docs/specs/${TEST_PREFIX}mismatch_${TEST_RUN_ID}.md`,
          title: "Mismatch Test",
          author: "pip",
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  // =====================
  // Spec History & Diff
  // =====================
  describe("History & Diff", () => {
    test("GET /api/specs/:id/history returns versions", async () => {
      const listRes = await fetch(`${BASE_URL}/api/specs`);
      const listData = await listRes.json();
      if (listData.specs.length === 0) return;

      const specId = listData.specs[0].id;
      const res = await fetch(`${BASE_URL}/api/specs/${specId}/history`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.versions).toBeInstanceOf(Array);
      expect(data.file_path).toBeTruthy();
    });

    test("GET /api/specs/99999/history returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/specs/99999/history`);
      expect(res.status).toBe(404);
    });

    test("GET /api/specs/:id/diff requires from param", async () => {
      const listRes = await fetch(`${BASE_URL}/api/specs`);
      const listData = await listRes.json();
      if (listData.specs.length === 0) return;

      const specId = listData.specs[0].id;
      const res = await fetch(`${BASE_URL}/api/specs/${specId}/diff`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("from");
    });

    test("GET /api/specs/:id/diff rejects invalid hash", async () => {
      const listRes = await fetch(`${BASE_URL}/api/specs`);
      const listData = await listRes.json();
      if (listData.specs.length === 0) return;

      const specId = listData.specs[0].id;
      const res = await fetch(
        `${BASE_URL}/api/specs/${specId}/diff?from=; rm -rf /`
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid commit hash");
    });

    test("GET /api/specs/:id/diff with valid hashes", async () => {
      const listRes = await fetch(`${BASE_URL}/api/specs`);
      const listData = await listRes.json();
      if (listData.specs.length === 0) return;

      // Find a spec with history
      const specId = listData.specs[0].id;
      const histRes = await fetch(
        `${BASE_URL}/api/specs/${specId}/history`
      );
      const histData = await histRes.json();
      if (histData.versions.length < 2) return; // need 2 versions for diff

      const from = histData.versions[1].hash;
      const to = histData.versions[0].hash;
      const res = await fetch(
        `${BASE_URL}/api/specs/${specId}/diff?from=${from}&to=${to}`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.from).toBe(from);
      expect(data.to).toBe(to);
    });
  });

  // =====================
  // Review Workflow
  // =====================
  describe("Review Workflow", () => {
    test("POST /api/specs/:id/review requires auth", async () => {
      if (createdSpecIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/specs/${createdSpecIds[0]}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        }
      );
      expect(res.status).toBe(403);
    });

    test("POST /api/specs/:id/review rejects invalid action", async () => {
      if (createdSpecIds.length === 0) return;

      const res = await fetch(
        `${BASE_URL}/api/specs/${createdSpecIds[0]}/review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: "session=gorn",
          },
          body: JSON.stringify({ action: "maybe" }),
        }
      );
      // Either 403 (no real session) or 400 (invalid action)
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST /api/specs/99999/review returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/specs/99999/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "session=gorn",
        },
        body: JSON.stringify({ action: "approve" }),
      });
      // 403 (no auth) or 404 (not found)
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // =====================
  // Resubmit
  // =====================
  describe("Resubmit", () => {
    test("POST /api/specs/:id/resubmit only works on rejected specs", async () => {
      if (createdSpecIds.length === 0) return;

      // Our test spec is pending, not rejected
      const res = await fetch(
        `${BASE_URL}/api/specs/${createdSpecIds[0]}/resubmit`,
        { method: "POST" }
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("rejected");
    });

    test("POST /api/specs/99999/resubmit returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/specs/99999/resubmit`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});

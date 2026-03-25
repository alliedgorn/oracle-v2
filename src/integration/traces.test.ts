/**
 * Traces API Integration Tests
 * Tier 1 — list, detail, chain, linking
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = "http://localhost:47778";

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Traces API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // List
  // =====================
  describe("List", () => {
    test("GET /api/traces returns trace list", async () => {
      const res = await fetch(`${BASE_URL}/api/traces`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.traces).toBeInstanceOf(Array);
    });

    test("GET /api/traces with query filter", async () => {
      const res = await fetch(`${BASE_URL}/api/traces?query=test`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.traces).toBeInstanceOf(Array);
    });

    test("GET /api/traces with status filter", async () => {
      const res = await fetch(`${BASE_URL}/api/traces?status=raw`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.traces).toBeInstanceOf(Array);
    });

    test("GET /api/traces with pagination", async () => {
      const res = await fetch(
        `${BASE_URL}/api/traces?limit=5&offset=0`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.traces).toBeInstanceOf(Array);
      expect(data.traces.length).toBeLessThanOrEqual(5);
    });
  });

  // =====================
  // Detail
  // =====================
  describe("Detail", () => {
    test("GET /api/traces/:id with nonexistent id returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/traces/nonexistent_id_99999`);
      expect(res.status).toBe(404);
    });

    test("GET /api/traces/:id returns trace if exists", async () => {
      const listRes = await fetch(`${BASE_URL}/api/traces?limit=1`);
      const listData = await listRes.json();
      if (listData.traces.length === 0) return;

      const traceId = listData.traces[0].id;
      const res = await fetch(`${BASE_URL}/api/traces/${traceId}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(traceId);
    });
  });

  // =====================
  // Chain
  // =====================
  describe("Chain", () => {
    test("GET /api/traces/:id/chain returns chain", async () => {
      const listRes = await fetch(`${BASE_URL}/api/traces?limit=1`);
      const listData = await listRes.json();
      if (listData.traces.length === 0) return;

      const traceId = listData.traces[0].id;
      const res = await fetch(`${BASE_URL}/api/traces/${traceId}/chain`);
      expect(res.ok).toBe(true);
    });

    test("GET /api/traces/:id/chain with direction", async () => {
      const listRes = await fetch(`${BASE_URL}/api/traces?limit=1`);
      const listData = await listRes.json();
      if (listData.traces.length === 0) return;

      const traceId = listData.traces[0].id;
      const res = await fetch(
        `${BASE_URL}/api/traces/${traceId}/chain?direction=up`
      );
      expect(res.ok).toBe(true);
    });

    test("GET /api/traces/:id/linked-chain returns linked chain", async () => {
      const listRes = await fetch(`${BASE_URL}/api/traces?limit=1`);
      const listData = await listRes.json();
      if (listData.traces.length === 0) return;

      const traceId = listData.traces[0].id;
      const res = await fetch(
        `${BASE_URL}/api/traces/${traceId}/linked-chain`
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Linking
  // =====================
  describe("Linking", () => {
    test("POST /api/traces/:prevId/link rejects missing nextId", async () => {
      const res = await fetch(`${BASE_URL}/api/traces/fake_id/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("nextId");
    });

    test("DELETE /api/traces/:id/link rejects missing direction", async () => {
      const res = await fetch(`${BASE_URL}/api/traces/fake_id/link`, {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("direction");
    });

    test("DELETE /api/traces/:id/link rejects invalid direction", async () => {
      const res = await fetch(
        `${BASE_URL}/api/traces/fake_id/link?direction=sideways`,
        { method: "DELETE" }
      );
      expect(res.status).toBe(400);
    });
  });
});

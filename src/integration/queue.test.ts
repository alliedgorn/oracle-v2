/**
 * Queue API Integration Tests
 * Tier 1 — Gorn's decision queue: list, tag, update
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

describe("Queue API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // List
  // =====================
  describe("List", () => {
    test("GET /api/queue/gorn returns pending items", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.items).toBeInstanceOf(Array);
      expect(typeof data.total).toBe("number");
    });

    test("GET /api/queue/gorn with status filter", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn?status=decided`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.items).toBeInstanceOf(Array);
    });

    test("GET /api/queue/gorn with deferred filter", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn?status=deferred`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.items).toBeInstanceOf(Array);
    });

    test("GET /api/queue/gorn with withdrawn filter", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn?status=withdrawn`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.items).toBeInstanceOf(Array);
    });
  });

  // =====================
  // Tag (POST)
  // =====================
  describe("Tag", () => {
    test("POST /api/queue/gorn rejects missing thread_id", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagged_by: "pip" }),
      });
      expect(res.status).toBe(400);
    });

    test("POST /api/queue/gorn rejects invalid JSON", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Update Status (PATCH)
  // =====================
  describe("Update Status", () => {
    test("PATCH /api/queue/gorn/:id rejects invalid status", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn/1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "invalid", as: "gorn" }),
      });
      expect(res.status).toBe(400);
    });

    // Note: localhost requests are trusted (isTrustedRequest=true),
    // so the `as` field check is bypassed for local requests.
    // Auth enforcement only applies to non-local (browser) requests.
    test("PATCH /api/queue/gorn/:id accepts local requests (trusted)", async () => {
      const res = await fetch(`${BASE_URL}/api/queue/gorn/1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "decided", as: "pip" }),
      });
      // Local requests bypass auth — this is by design
      expect(res.ok).toBe(true);
    });
  });
});

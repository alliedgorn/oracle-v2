/**
 * Beast Profiles API Integration Tests
 * Tier 3 — profiles, avatars, updates, validation
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

describe("Beast Profiles API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  // =====================
  // List & Read
  // =====================
  describe("List & Read", () => {
    test("GET /api/beasts returns all beasts", async () => {
      const res = await fetch(`${BASE_URL}/api/beasts`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      const beasts = Array.isArray(data) ? data : data.beasts;
      expect(beasts).toBeInstanceOf(Array);
      expect(beasts.length).toBeGreaterThan(0);
    });

    test("GET /api/beast/:name returns a single profile", async () => {
      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.name).toBe(TEST_BEAST);
      expect(data.animal).toBeTruthy();
      expect(data.role).toBeTruthy();
    });

    test("Beast profile has expected fields", async () => {
      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      const data = await res.json();
      expect(data.name).toBeTruthy();
      expect(data.displayName).toBeTruthy();
      expect(data.animal).toBeTruthy();
      expect(data.bio).toBeTruthy();
      expect(data.role).toBeTruthy();
      expect(data.createdAt).toBeTruthy();
    });

    test("GET /api/beast/nonexistent returns 404", async () => {
      const res = await fetch(
        `${BASE_URL}/api/beast/nonexistent_beast_xyz_999`
      );
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Update
  // =====================
  describe("Update Profile", () => {
    let originalBio: string;

    test("PATCH /api/beast/:name updates profile fields", async () => {
      // Save original
      const origRes = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      const origData = await origRes.json();
      originalBio = origData.bio;

      const testBio = `test_bio_${Date.now()}`;
      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio: testBio }),
      });
      expect(res.ok).toBe(true);

      // Verify update
      const verifyRes = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      const verifyData = await verifyRes.json();
      expect(verifyData.bio).toBe(testBio);

      // Restore original
      await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio: originalBio }),
      });
    });

    test("PATCH /api/beast/:name updates interests", async () => {
      const origRes = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      const origData = await origRes.json();
      const originalInterests = origData.interests;

      const testInterests = `test_interest_${Date.now()}`;
      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interests: testInterests }),
      });
      expect(res.ok).toBe(true);

      // Restore
      await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interests: originalInterests }),
      });
    });

    test("PATCH /api/beast/:name updates themeColor", async () => {
      const origRes = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      const origData = await origRes.json();
      const originalColor = origData.themeColor;

      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeColor: "#FF0000" }),
      });
      expect(res.ok).toBe(true);

      // Restore
      await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeColor: originalColor }),
      });
    });

    test("PATCH nonexistent beast returns 404", async () => {
      const res = await fetch(
        `${BASE_URL}/api/beast/nonexistent_beast_xyz_999`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bio: "test" }),
        }
      );
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Avatar
  // =====================
  describe("Avatar", () => {
    test("GET /api/beast/:name/avatar.svg returns SVG", async () => {
      const res = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}/avatar.svg`);
      expect(res.ok).toBe(true);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("svg");
    });

    test("GET /api/beast/nonexistent/avatar.svg handles missing beast", async () => {
      const res = await fetch(
        `${BASE_URL}/api/beast/nonexistent_beast_xyz_999/avatar.svg`
      );
      // Should return 404 or a fallback SVG
      expect(res.status).toBeLessThan(500);
    });
  });

  // =====================
  // Cross-beast Isolation
  // =====================
  describe("Cross-beast", () => {
    test("Different beasts have different profiles", async () => {
      const pipRes = await fetch(`${BASE_URL}/api/beast/${TEST_BEAST}`);
      const bertusRes = await fetch(`${BASE_URL}/api/beast/${OTHER_BEAST}`);
      const pip = await pipRes.json();
      const bertus = await bertusRes.json();

      expect(pip.name).toBe(TEST_BEAST);
      expect(bertus.name).toBe(OTHER_BEAST);
      expect(pip.animal).not.toBe(bertus.animal);
    });
  });
});

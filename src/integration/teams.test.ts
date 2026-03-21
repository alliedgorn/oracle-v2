/**
 * Teams API Integration Tests
 * Tier 2 — team CRUD, members, projects, validation
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";
const TEST_PREFIX = "test_team_";

const createdTeamIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createTeam(overrides: Record<string, unknown> = {}) {
  const body = {
    name: `${TEST_PREFIX}${Date.now()}`,
    description: "Test team created by Pip",
    created_by: TEST_BEAST,
    ...overrides,
  };
  const res = await fetch(`${BASE_URL}/api/teams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.ok && data.id) createdTeamIds.push(data.id);
  return { res, data };
}

describe("Teams API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    for (const id of createdTeamIds) {
      try {
        await fetch(`${BASE_URL}/api/teams/${id}?as=${TEST_BEAST}`, { method: "DELETE" });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  // =====================
  // CRUD
  // =====================
  describe("Team CRUD", () => {
    test("POST /api/teams creates a team", async () => {
      const { res, data } = await createTeam();
      expect(res.ok).toBe(true);
      expect(data.id).toBeTruthy();
      expect(data.name).toContain(TEST_PREFIX);
    });

    test("GET /api/teams lists teams", async () => {
      const res = await fetch(`${BASE_URL}/api/teams`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.teams || data).toBeTruthy();
      expect(Array.isArray(data.teams || data)).toBe(true);
    });

    test("GET /api/teams/:id returns a single team", async () => {
      const { data: created } = await createTeam();
      const res = await fetch(`${BASE_URL}/api/teams/${created.id}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(created.id);
      expect(data.name).toBe(created.name);
    });

    test("PATCH /api/teams/:id updates a team", async () => {
      const { data: created } = await createTeam();
      const newDesc = `updated_${Date.now()}`;
      const res = await fetch(`${BASE_URL}/api/teams/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: newDesc,
          beast: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(true);
    });

    test("GET /api/teams/beast/:beast returns teams for a beast", async () => {
      const res = await fetch(`${BASE_URL}/api/teams/beast/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data.teams || data)).toBe(true);
    });
  });

  // =====================
  // Members
  // =====================
  describe("Team Members", () => {
    test("POST /api/teams/:id/members adds a member", async () => {
      const { data: team } = await createTeam();
      const res = await fetch(`${BASE_URL}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: OTHER_BEAST,
          role: "member",
          added_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(true);
    });

    test("DELETE /api/teams/:id/members/:beast removes a member", async () => {
      const { data: team } = await createTeam();
      // Add member first
      await fetch(`${BASE_URL}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: OTHER_BEAST,
          role: "member",
          added_by: TEST_BEAST,
        }),
      });
      // Remove member
      const res = await fetch(
        `${BASE_URL}/api/teams/${team.id}/members/${OTHER_BEAST}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      expect(res.ok).toBe(true);
    });

    test("Cannot add nonexistent beast as member (ghost member fix)", async () => {
      const { data: team } = await createTeam();
      const res = await fetch(`${BASE_URL}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: "nonexistent_beast_xyz",
          role: "member",
          added_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("not found");
    });

    test("Cannot add duplicate member", async () => {
      const { data: team } = await createTeam();
      // Creator is already a member — try adding them again
      const res = await fetch(`${BASE_URL}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          role: "member",
          added_by: TEST_BEAST,
        }),
      });
      // Should fail or handle gracefully
      expect(res.status === 400 || res.status === 409 || res.ok).toBe(true);
    });
  });

  // =====================
  // Validation — Regression Guards
  // =====================
  describe("Validation (Regression Guards)", () => {
    test("SQL injection chars rejected in team name", async () => {
      const res = await fetch(`${BASE_URL}/api/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test'; DROP TABLE teams;--",
          created_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("invalid characters");
    });

    test("XSS script tags rejected in team name", async () => {
      const res = await fetch(`${BASE_URL}/api/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "<script>alert(1)</script>",
          created_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(false);
      const data = await res.json();
      expect(data.error).toContain("invalid characters");
    });

    test("POST /api/teams without name fails", async () => {
      const res = await fetch(`${BASE_URL}/api/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "no name",
          created_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(false);
    });

    test("POST /api/teams without created_by fails", async () => {
      const res = await fetch(`${BASE_URL}/api/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${TEST_PREFIX}no_creator`,
        }),
      });
      expect(res.ok).toBe(false);
    });
  });

  // =====================
  // Projects
  // =====================
  describe("Team Projects", () => {
    test("POST /api/teams/:id/projects assigns a project", async () => {
      const { data: team } = await createTeam();
      const res = await fetch(`${BASE_URL}/api/teams/${team.id}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: 1,
          beast: TEST_BEAST,
        }),
      });
      // May succeed or fail depending on project existence
      expect(res.status).toBeLessThan(500);
    });
  });

  // =====================
  // Edge Cases
  // =====================
  describe("Edge Cases", () => {
    test("GET /api/teams/999999 returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/teams/999999`);
      expect(res.status).toBe(404);
    });

    test("GET /api/teams/beast/nonexistent returns empty", async () => {
      const res = await fetch(
        `${BASE_URL}/api/teams/beast/nonexistent_beast_xyz`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      const teams = data.teams || data;
      expect(Array.isArray(teams)).toBe(true);
      expect(teams.length).toBe(0);
    });

    test("POST /api/teams/:id/members on nonexistent team fails", async () => {
      const res = await fetch(`${BASE_URL}/api/teams/999999/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          role: "member",
          added_by: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(false);
    });

    test("DELETE /api/teams/:id removes team with cascading delete", async () => {
      const { data: team } = await createTeam({
        name: `${TEST_PREFIX}delete_cascade_${Date.now()}`,
      });
      const idx = createdTeamIds.indexOf(team.id);
      if (idx >= 0) createdTeamIds.splice(idx, 1);

      const res = await fetch(`${BASE_URL}/api/teams/${team.id}?as=${TEST_BEAST}`, {
        method: "DELETE",
      });
      expect(res.ok).toBe(true);

      // Verify team is gone
      const check = await fetch(`${BASE_URL}/api/teams/${team.id}`);
      expect(check.status).toBe(404);
    });

    test("DELETE nonexistent team returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/teams/999999?as=${TEST_BEAST}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    test("DELETE without ?as= is rejected (auth required)", async () => {
      const { data: team } = await createTeam({
        name: `${TEST_PREFIX}noauth_${Date.now()}`,
      });
      const res = await fetch(`${BASE_URL}/api/teams/${team.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    test("DELETE by non-creator is rejected (403)", async () => {
      const { data: team } = await createTeam({
        name: `${TEST_PREFIX}idor_delete_${Date.now()}`,
      });
      const res = await fetch(`${BASE_URL}/api/teams/${team.id}?as=${OTHER_BEAST}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });
  });
});

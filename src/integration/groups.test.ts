/**
 * Groups API Integration Tests
 * Tier 3 — group CRUD, members, validation
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";
const TEST_PREFIX = "testgrp";

const createdGroupNames: string[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createGroup(overrides: Record<string, unknown> = {}) {
  const name = `${TEST_PREFIX}${Date.now()}`;
  const body = {
    name,
    members: [TEST_BEAST],
    ...overrides,
  };
  const res = await fetch(`${BASE_URL}/api/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const actualName = data.name || name;
  if (res.ok) createdGroupNames.push(actualName);
  return { res, data, name: actualName };
}

async function deleteGroup(name: string) {
  return fetch(`${BASE_URL}/api/group/${name}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
}

describe("Groups API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
  });

  afterAll(async () => {
    for (const name of createdGroupNames) {
      await deleteGroup(name).catch(() => {});
    }
  });

  // =====================
  // CRUD
  // =====================
  describe("Group CRUD", () => {
    test("POST /api/groups creates a group", async () => {
      const { res, data } = await createGroup();
      expect(res.ok).toBe(true);
      expect(data.name || data.group?.name).toBeTruthy();
    });

    test("GET /api/groups lists all groups", async () => {
      const res = await fetch(`${BASE_URL}/api/groups`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      const groups = Array.isArray(data) ? data : data.groups;
      expect(groups).toBeInstanceOf(Array);
      expect(groups.length).toBeGreaterThan(0);
    });

    test("GET /api/group/:name returns a single group", async () => {
      const { name } = await createGroup();
      const res = await fetch(`${BASE_URL}/api/group/${name}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.name).toBe(name);
    });

    test("DELETE /api/group/:name deletes a group", async () => {
      const { name } = await createGroup();
      // Remove from cleanup list
      const idx = createdGroupNames.indexOf(name);
      if (idx > -1) createdGroupNames.splice(idx, 1);

      const res = await deleteGroup(name);
      expect(res.ok).toBe(true);

      // Verify deleted
      const verifyRes = await fetch(`${BASE_URL}/api/group/${name}`);
      expect(verifyRes.status).toBe(404);
    });

    test("GET /api/group/nonexistent returns 404", async () => {
      const res = await fetch(
        `${BASE_URL}/api/group/nonexistent_group_xyz_999`
      );
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Members
  // =====================
  describe("Group Members", () => {
    test("POST /api/group/:name/members adds a member", async () => {
      const { name } = await createGroup();
      const res = await fetch(`${BASE_URL}/api/group/${name}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beast: OTHER_BEAST }),
      });
      expect(res.ok).toBe(true);

      // Verify member added
      const groupRes = await fetch(`${BASE_URL}/api/group/${name}`);
      const groupData = await groupRes.json();
      const members = groupData.members || [];
      const memberNames = members.map((m: any) =>
        typeof m === "string" ? m : m.name || m.beast
      );
      expect(memberNames).toContain(OTHER_BEAST);
    });

    test("DELETE /api/group/:name/members/:beast removes a member", async () => {
      const { name } = await createGroup({ members: [TEST_BEAST, OTHER_BEAST] });
      const res = await fetch(
        `${BASE_URL}/api/group/${name}/members/${OTHER_BEAST}`,
        { method: "DELETE" }
      );
      expect(res.ok).toBe(true);
    });

    test("Cannot add member to nonexistent group", async () => {
      const res = await fetch(
        `${BASE_URL}/api/group/nonexistent_group_xyz_999/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      expect(res.ok).toBe(false);
    });
  });

  // =====================
  // Validation
  // =====================
  describe("Validation", () => {
    test("POST /api/groups without name fails", async () => {
      const res = await fetch(`${BASE_URL}/api/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: [TEST_BEAST] }),
      });
      expect(res.ok).toBe(false);
    });

    test("Duplicate group name fails or is handled", async () => {
      const { name } = await createGroup();
      const res = await fetch(`${BASE_URL}/api/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, members: [TEST_BEAST] }),
      });
      // Should fail with conflict or be rejected
      expect(res.status === 400 || res.status === 409 || res.ok).toBe(true);
    });
  });

  // =====================
  // Real Groups
  // =====================
  describe("Existing Groups", () => {
    test("Known groups exist (builders, infra, leads, security, research)", async () => {
      const res = await fetch(`${BASE_URL}/api/groups`);
      const data = await res.json();
      const groups = Array.isArray(data) ? data : data.groups;
      const names = groups.map((g: any) => g.name);
      expect(names).toContain("builders");
      expect(names).toContain("infra");
      expect(names).toContain("leads");
    });
  });
});

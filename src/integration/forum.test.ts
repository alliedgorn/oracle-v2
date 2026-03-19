/**
 * Forum API Integration Tests
 * Tier 1 — threads, messages, reactions, notifications
 *
 * Author: Pip (QA/Chaos Testing)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = "http://localhost:47778";
const TEST_BEAST = "pip";
const OTHER_BEAST = "bertus";
const TEST_PREFIX = "test_forum_";

let testThreadId: number;
let testMessageId: number;
const createdThreadIds: number[] = [];

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createThread(title: string, message: string) {
  const res = await fetch(`${BASE_URL}/api/thread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      message,
      role: "claude",
      author: TEST_BEAST,
    }),
  });
  const data = await res.json();
  if (data.thread_id) createdThreadIds.push(data.thread_id);
  return { res, data };
}

async function postMessage(threadId: number, message: string, author = TEST_BEAST) {
  const res = await fetch(`${BASE_URL}/api/thread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thread_id: threadId,
      message,
      role: "claude",
      author,
    }),
  });
  return { res, data: await res.json() };
}

describe("Forum API Integration", () => {
  beforeAll(async () => {
    if (!(await isServerRunning())) {
      throw new Error("Server not running on port 47778");
    }
    // Create a test thread for use across tests
    const { data } = await createThread(
      `${TEST_PREFIX}main_thread`,
      `${TEST_PREFIX}initial message`
    );
    testThreadId = data.thread_id;
    testMessageId = data.message_id;
  });

  afterAll(async () => {
    // Close test threads
    for (const id of createdThreadIds) {
      try {
        await fetch(`${BASE_URL}/api/thread/${id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "closed" }),
        });
      } catch {}
    }
  });

  // =====================
  // Threads — CRUD
  // =====================
  describe("Threads — CRUD", () => {
    test("GET /api/threads returns thread list", async () => {
      const res = await fetch(`${BASE_URL}/api/threads`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.threads).toBeInstanceOf(Array);
      expect(data.total).toBeGreaterThan(0);
    });

    test("GET /api/threads with status filter", async () => {
      const res = await fetch(`${BASE_URL}/api/threads?status=pending`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.threads).toBeInstanceOf(Array);
    });

    test("POST /api/thread creates new thread", async () => {
      const { res, data } = await createThread(
        `${TEST_PREFIX}create_test`,
        "Testing thread creation"
      );
      expect(res.ok).toBe(true);
      expect(data.thread_id).toBeTruthy();
      expect(data.message_id).toBeTruthy();
    });

    test("GET /api/thread/:id returns thread with messages", async () => {
      const res = await fetch(`${BASE_URL}/api/thread/${testThreadId}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.messages).toBeInstanceOf(Array);
      expect(data.messages.length).toBeGreaterThan(0);
    });

    test("GET /api/thread/:id with limit and order", async () => {
      // Add a few messages
      await postMessage(testThreadId, `${TEST_PREFIX}msg_1`);
      await postMessage(testThreadId, `${TEST_PREFIX}msg_2`);
      const res = await fetch(
        `${BASE_URL}/api/thread/${testThreadId}?limit=1&order=desc`
      );
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.messages.length).toBeLessThanOrEqual(1);
    });

    test("GET nonexistent thread returns 404", async () => {
      const res = await fetch(`${BASE_URL}/api/thread/99999`);
      expect(res.status).toBe(404);
    });
  });

  // =====================
  // Messages
  // =====================
  describe("Messages", () => {
    test("POST message to existing thread", async () => {
      const { res, data } = await postMessage(
        testThreadId,
        `${TEST_PREFIX}reply message`
      );
      expect(res.ok).toBe(true);
      expect(data.message_id).toBeTruthy();
      expect(data.thread_id).toBe(testThreadId);
    });

    test("POST message with @mention notifies target", async () => {
      const { res, data } = await postMessage(
        testThreadId,
        `Hey @${OTHER_BEAST} check this ${TEST_PREFIX}mention_test`
      );
      expect(res.ok).toBe(true);
      // Check that notified array includes the mentioned beast
      if (data.notified) {
        expect(data.notified).toContain(OTHER_BEAST);
      }
    });

    test("POST message with reply_to_id", async () => {
      const { res, data } = await fetch(`${BASE_URL}/api/thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: testThreadId,
          message: `${TEST_PREFIX}reply to specific message`,
          role: "claude",
          author: TEST_BEAST,
          reply_to_id: testMessageId,
        }),
      }).then(async (r) => ({ res: r, data: await r.json() }));
      expect(res.ok).toBe(true);
      expect(data.message_id).toBeTruthy();
    });

    test("PATCH /api/message/:id edits message", async () => {
      const { data: posted } = await postMessage(
        testThreadId,
        `${TEST_PREFIX}to_edit`
      );
      const res = await fetch(`${BASE_URL}/api/message/${posted.message_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `${TEST_PREFIX}edited content`,
          beast: TEST_BEAST,
        }),
      });
      expect(res.ok).toBe(true);
    });

    test("GET /api/message/:id/history returns edit history", async () => {
      const { data: posted } = await postMessage(
        testThreadId,
        `${TEST_PREFIX}history_test`
      );
      // Edit it
      await fetch(`${BASE_URL}/api/message/${posted.message_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `${TEST_PREFIX}history_edited`,
          beast: TEST_BEAST,
        }),
      });
      const res = await fetch(
        `${BASE_URL}/api/message/${posted.message_id}/history`
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Reactions
  // =====================
  describe("Reactions", () => {
    let reactionMsgId: number;

    beforeAll(async () => {
      const { data } = await postMessage(
        testThreadId,
        `${TEST_PREFIX}reaction_target`
      );
      reactionMsgId = data.message_id;
    });

    test("POST /api/message/:id/react adds reaction", async () => {
      const res = await fetch(
        `${BASE_URL}/api/message/${reactionMsgId}/react`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST, emoji: "🔥" }),
        }
      );
      expect(res.ok).toBe(true);
    });

    test("GET /api/message/:id/reactions returns reactions", async () => {
      const res = await fetch(
        `${BASE_URL}/api/message/${reactionMsgId}/reactions`
      );
      expect(res.ok).toBe(true);
    });

    test("DELETE /api/message/:id/react removes reaction", async () => {
      const res = await fetch(
        `${BASE_URL}/api/message/${reactionMsgId}/react`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST, emoji: "🔥" }),
        }
      );
      expect(res.ok).toBe(true);
    });

    test("rejects unsupported emoji", async () => {
      const res = await fetch(
        `${BASE_URL}/api/message/${reactionMsgId}/react`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST, emoji: "invalid_emoji" }),
        }
      );
      expect(res.status).toBe(400);
    });
  });

  // =====================
  // Thread Management
  // =====================
  describe("Thread Management", () => {
    let managedThreadId: number;

    beforeAll(async () => {
      const { data } = await createThread(
        `${TEST_PREFIX}managed_thread`,
        "Thread for management tests"
      );
      managedThreadId = data.thread_id;
    });

    test("PATCH /:id/status changes status", async () => {
      const res = await fetch(
        `${BASE_URL}/api/thread/${managedThreadId}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "closed" }),
        }
      );
      expect(res.ok).toBe(true);

      // Reopen
      await fetch(`${BASE_URL}/api/thread/${managedThreadId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
    });

    test("PATCH /:id/pin toggles pin", async () => {
      const res = await fetch(
        `${BASE_URL}/api/thread/${managedThreadId}/pin`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: true }),
        }
      );
      expect(res.ok).toBe(true);

      // Unpin
      await fetch(`${BASE_URL}/api/thread/${managedThreadId}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: false }),
      });
    });

    test("PATCH /:id/lock locks thread", async () => {
      const res = await fetch(
        `${BASE_URL}/api/thread/${managedThreadId}/lock`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locked: true }),
        }
      );
      expect(res.ok).toBe(true);

      // Unlock
      await fetch(`${BASE_URL}/api/thread/${managedThreadId}/lock`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: false }),
      });
    });

    test("PATCH /:id/category changes category", async () => {
      const res = await fetch(
        `${BASE_URL}/api/thread/${managedThreadId}/category`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: "announcement" }),
        }
      );
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Forum Metadata
  // =====================
  describe("Forum Metadata", () => {
    test("GET /api/forum/unread/:beast returns count", async () => {
      const res = await fetch(`${BASE_URL}/api/forum/unread/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
    });

    test("GET /api/forum/mentions/:beast returns mentions", async () => {
      const res = await fetch(`${BASE_URL}/api/forum/mentions/${TEST_BEAST}`);
      expect(res.ok).toBe(true);
    });

    test("GET /api/forum/search returns results", async () => {
      const res = await fetch(
        `${BASE_URL}/api/forum/search?q=${TEST_PREFIX}`
      );
      expect(res.ok).toBe(true);
    });

    test("GET /api/forum/activity returns timeline", async () => {
      const res = await fetch(`${BASE_URL}/api/forum/activity?limit=5`);
      expect(res.ok).toBe(true);
    });

    test("POST /api/forum/mute mutes thread", async () => {
      const res = await fetch(`${BASE_URL}/api/forum/mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          threadId: testThreadId,
          muted: true,
        }),
      });
      expect(res.ok).toBe(true);

      // Unmute
      await fetch(`${BASE_URL}/api/forum/mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          threadId: testThreadId,
          muted: false,
        }),
      });
    });

    test("POST /api/forum/read marks thread as read", async () => {
      const res = await fetch(`${BASE_URL}/api/forum/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beast: TEST_BEAST,
          threadId: testThreadId,
          messageId: testMessageId,
        }),
      });
      expect(res.ok).toBe(true);
    });
  });

  // =====================
  // Validation
  // =====================
  describe("Validation", () => {
    test("POST thread with empty message fails", async () => {
      const res = await fetch(`${BASE_URL}/api/thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "empty msg",
          message: "",
          author: TEST_BEAST,
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    // Fixed: Task #63 (ccdd877) — author now required
    test("POST thread without author returns 400", async () => {
      const res = await fetch(`${BASE_URL}/api/thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${TEST_PREFIX}no_author`,
          message: "test",
        }),
      });
      expect(res.status).toBe(400);
    });

    test("POST reaction without beast fails", async () => {
      const res = await fetch(
        `${BASE_URL}/api/message/${testMessageId}/react`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji: "🔥" }),
        }
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test("POST reaction without emoji fails", async () => {
      const res = await fetch(
        `${BASE_URL}/api/message/${testMessageId}/react`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ beast: TEST_BEAST }),
        }
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});

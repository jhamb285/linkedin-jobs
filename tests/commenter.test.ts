import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/test-commenter.db";

describe("Store — Comment Queue", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(TEST_DB);
    store.insertPost({
      id: "comment-test-1",
      url: "https://linkedin.com/posts/test-comment",
      authorName: "Alice",
      authorHeadline: "CTO",
      authorUrl: "https://linkedin.com/in/alice",
      content: "Need help building AI agents for our workflow",
      engagementCount: 20,
      scrapedAt: new Date().toISOString(),
      queryUsed: "test",
    });
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(TEST_DB);
      unlinkSync(TEST_DB + "-wal");
      unlinkSync(TEST_DB + "-shm");
    } catch {}
  });

  it("should insert a comment into the queue", () => {
    const id = store.insertComment(
      "comment-test-1",
      "The key challenge with agentic workflows is reliable tool-calling. What framework are you evaluating?"
    );
    expect(id).toBeGreaterThan(0);
  });

  it("should retrieve pending comments", () => {
    store.insertComment("comment-test-1", "Test comment");
    const pending = store.getPendingComments();
    expect(pending.length).toBe(1);
    expect(pending[0].postContent).toBe(
      "Need help building AI agents for our workflow"
    );
  });

  it("should update comment status through approval flow", () => {
    store.insertComment("comment-test-1", "Original comment");

    // Approve
    store.updateCommentStatus(1, "approved");
    const approved = store.getApprovedComments();
    expect(approved.length).toBe(1);

    // Post
    store.updateCommentStatus(1, "posted", {
      bereachResponse: '{"success": true}',
    });
    const pending = store.getPendingComments();
    expect(pending.length).toBe(0);
  });

  it("should allow editing comment text during approval", () => {
    store.insertComment("comment-test-1", "Original comment");
    store.updateCommentStatus(1, "approved", { text: "Edited comment" });

    const approved = store.getApprovedComments();
    expect(approved[0].comment_text).toBe("Edited comment");
  });

  it("should reject comments", () => {
    store.insertComment("comment-test-1", "Bad comment");
    store.updateCommentStatus(1, "rejected");

    const pending = store.getPendingComments();
    expect(pending.length).toBe(0);

    const stats = store.getStats();
    expect(stats.rejectedComments).toBe(1);
  });
});

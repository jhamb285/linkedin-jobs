import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { unlinkSync } from "fs";
import type { ScrapedPost } from "../src/types";

const TEST_DB = "/tmp/test-leads.db";

describe("Store — Posts", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(TEST_DB);
      unlinkSync(TEST_DB + "-wal");
      unlinkSync(TEST_DB + "-shm");
    } catch {}
  });

  const samplePost: ScrapedPost = {
    id: "test123",
    url: "https://linkedin.com/posts/test",
    authorName: "John Doe",
    authorHeadline: "CEO at TechCo",
    authorUrl: "https://linkedin.com/in/johndoe",
    content: "Looking for an AI engineer to build our agentic system",
    engagementCount: 42,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"looking for AI engineer"',
  };

  it("should insert a new post", () => {
    const inserted = store.insertPost(samplePost);
    expect(inserted).toBe(true);
  });

  it("should ignore duplicate posts", () => {
    store.insertPost(samplePost);
    const second = store.insertPost(samplePost);
    expect(second).toBe(false);
  });

  it("should retrieve unscored posts", () => {
    store.insertPost(samplePost);
    const unscored = store.getUnscoredPosts();
    expect(unscored.length).toBe(1);
  });

  it("should retrieve post by id", () => {
    store.insertPost(samplePost);
    const post = store.getPostById("test123");
    expect(post).not.toBeNull();
    expect(post!.authorName).toBe("John Doe");
  });
});

describe("Store — Stats", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(TEST_DB);
      unlinkSync(TEST_DB + "-wal");
      unlinkSync(TEST_DB + "-shm");
    } catch {}
  });

  it("should return zero stats for empty database", () => {
    const stats = store.getStats();
    expect(stats.totalPosts).toBe(0);
    expect(stats.scoredPosts).toBe(0);
    expect(stats.pendingComments).toBe(0);
    expect(stats.todayComments).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Store } from "../src/store";
import { unlinkSync } from "fs";
import type { ScrapedPost, PostScore } from "../src/types";

const TEST_DB = "/tmp/test-matcher.db";

describe("Store — Scoring", () => {
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
    id: "score-test-1",
    url: "https://linkedin.com/posts/test-score",
    authorName: "Jane Smith",
    authorHeadline: "Hiring Manager at AI Corp",
    authorUrl: "https://linkedin.com/in/janesmith",
    content: "We need a freelance AI engineer for a 3-month contract to build our RAG pipeline",
    engagementCount: 15,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"freelance AI engineer"',
  };

  const highScore: PostScore = {
    postId: "score-test-1",
    relevance: 9,
    fit: 8,
    urgency: 7,
    engagementPotential: 8,
    total: 32,
    positioning: "consulting",
    reasoning: "Direct ask for freelance AI engineer with specific project scope",
    scoredAt: new Date().toISOString(),
  };

  it("should insert and retrieve scores", () => {
    store.insertPost(samplePost);
    store.insertScore(highScore);

    const unscored = store.getUnscoredPosts();
    expect(unscored.length).toBe(0);
  });

  it("should find high-scoring uncommented posts", () => {
    store.insertPost(samplePost);
    store.insertScore(highScore);

    const leads = store.getHighScoringUncommented(25);
    expect(leads.length).toBe(1);
  });

  it("should not return posts with existing comments", () => {
    store.insertPost(samplePost);
    store.insertScore(highScore);
    store.insertComment("score-test-1", "Great post about RAG!");

    const leads = store.getHighScoringUncommented(25);
    expect(leads.length).toBe(0);
  });

  it("should detect recently commented authors", () => {
    store.insertPost(samplePost);
    store.insertScore(highScore);
    store.insertComment("score-test-1", "Test comment");
    store.updateCommentStatus(1, "approved");

    const recent = store.wasAuthorCommentedRecently(
      "https://linkedin.com/in/janesmith"
    );
    expect(recent).toBe(true);
  });
});

describe("Store — Activity Log", () => {
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

  it("should track daily activity counts", () => {
    store.logActivity("comment", "https://linkedin.com/posts/1");
    store.logActivity("comment", "https://linkedin.com/posts/2");
    store.logActivity("connection", "https://linkedin.com/in/someone");

    expect(store.getTodayCount("comment")).toBe(2);
    expect(store.getTodayCount("connection")).toBe(1);
    expect(store.getTodayCount("dm")).toBe(0);
  });
});

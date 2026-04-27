import { Database } from "bun:sqlite";
import type {
  ScrapedPost,
  PostScore,
  QueuedComment,
  QueuedDm,
  ActionType,
  PipelineStats,
  CommentStatus,
  SearchQuery,
} from "./types";

export interface QueryRunCounts {
  fetched: number;
  inserted: number;
  rejected_date: number;
  rejected_dedup_content: number;
  rejected_dedup_db: number;
  rejected_geo: number;
  rejected_intent: number;
  rejected_normalize: number;
  geo_reasons: Record<string, number>;
  intent_reasons: Record<string, number>;
  error: string | null;
}

export class Store {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        author_name TEXT,
        author_headline TEXT,
        author_url TEXT,
        content TEXT,
        engagement_count INTEGER DEFAULT 0,
        scraped_at TEXT NOT NULL,
        query_used TEXT
      );

      CREATE TABLE IF NOT EXISTS scores (
        post_id TEXT PRIMARY KEY REFERENCES posts(id),
        relevance INTEGER NOT NULL,
        fit INTEGER NOT NULL,
        urgency INTEGER NOT NULL,
        engagement_potential INTEGER NOT NULL,
        total INTEGER NOT NULL,
        positioning TEXT NOT NULL,
        reasoning TEXT,
        scored_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT NOT NULL REFERENCES posts(id),
        comment_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        generated_at TEXT NOT NULL,
        reviewed_at TEXT,
        posted_at TEXT,
        bereach_response TEXT
      );

      CREATE TABLE IF NOT EXISTS dms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT NOT NULL REFERENCES posts(id),
        author_url TEXT NOT NULL,
        connection_status TEXT DEFAULT 'pending',
        dm_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        sent_at TEXT
      );

      CREATE TABLE IF NOT EXISTS lead_content (
        post_id TEXT PRIMARY KEY REFERENCES posts(id),
        summary TEXT NOT NULL,
        comment TEXT NOT NULL,
        connection_note TEXT NOT NULL,
        dm TEXT NOT NULL,
        comment_aj TEXT,
        comment_pk TEXT,
        connection_note_aj TEXT,
        connection_note_pk TEXT,
        dm_aj TEXT,
        dm_pk TEXT,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target_url TEXT NOT NULL,
        performed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scores_total ON scores(total);
      CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
      CREATE INDEX IF NOT EXISTS idx_dms_status ON dms(status);
      CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(performed_at);

      CREATE TABLE IF NOT EXISTS scrape_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        leads_fetched INTEGER DEFAULT 0,
        leads_inserted INTEGER DEFAULT 0,
        actor_runs INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        capped INTEGER DEFAULT 0,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scrape_runs_started ON scrape_runs(started_at);

      CREATE TABLE IF NOT EXISTS scrape_run_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        query_group TEXT,
        tier INTEGER,
        max_results INTEGER,
        fetched INTEGER DEFAULT 0,
        inserted INTEGER DEFAULT 0,
        rejected_date INTEGER DEFAULT 0,
        rejected_dedup_content INTEGER DEFAULT 0,
        rejected_dedup_db INTEGER DEFAULT 0,
        rejected_geo INTEGER DEFAULT 0,
        rejected_geo_reason TEXT,
        rejected_intent INTEGER DEFAULT 0,
        rejected_intent_reason TEXT,
        rejected_normalize INTEGER DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_srq_run ON scrape_run_queries(run_id);
      CREATE INDEX IF NOT EXISTS idx_srq_query ON scrape_run_queries(query);
      CREATE INDEX IF NOT EXISTS idx_srq_started ON scrape_run_queries(started_at);
    `);

    // Additive: rejected_normalize counter added after initial table deploy.
    // Idempotent ALTER pattern used elsewhere in this file.
    try {
      this.db.exec(
        `ALTER TABLE scrape_run_queries ADD COLUMN rejected_normalize INTEGER DEFAULT 0`
      );
    } catch {
      // Column already exists
    }

    // Add persona columns to existing lead_content tables (idempotent)
    const personaCols = [
      "comment_aj", "comment_pk",
      "connection_note_aj", "connection_note_pk",
      "dm_aj", "dm_pk",
    ];
    for (const col of personaCols) {
      try {
        this.db.exec(`ALTER TABLE lead_content ADD COLUMN ${col} TEXT`);
      } catch {
        // Column already exists, ignore
      }
    }

    // Track export status at the post level (covers both approved and rejected)
    try {
      this.db.exec(`ALTER TABLE posts ADD COLUMN exported_at TEXT`);
    } catch {}
  }

  // ── Author Dedup ──

  wasAuthorScrapedThisWeek(authorUrl: string): boolean {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM posts WHERE author_url = ? AND scraped_at > ?`
      )
      .get(authorUrl, cutoff) as { cnt: number };
    return row.cnt > 0;
  }

  // ── Posts ──

  insertPost(post: ScrapedPost): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO posts (id, url, author_name, author_headline, author_url, content, engagement_count, scraped_at, query_used)
      VALUES ($id, $url, $authorName, $authorHeadline, $authorUrl, $content, $engagementCount, $scrapedAt, $queryUsed)
    `);
    const result = stmt.run({
      $id: post.id,
      $url: post.url,
      $authorName: post.authorName,
      $authorHeadline: post.authorHeadline,
      $authorUrl: post.authorUrl,
      $content: post.content,
      $engagementCount: post.engagementCount,
      $scrapedAt: post.scrapedAt,
      $queryUsed: post.queryUsed,
    });
    return result.changes > 0;
  }

  private mapPost(row: Record<string, unknown>): ScrapedPost {
    return {
      id: row.id as string,
      url: row.url as string,
      authorName: (row.author_name ?? row.authorName ?? "") as string,
      authorHeadline: (row.author_headline ?? row.authorHeadline ?? "") as string,
      authorUrl: (row.author_url ?? row.authorUrl ?? "") as string,
      content: (row.content ?? "") as string,
      engagementCount: (row.engagement_count ?? row.engagementCount ?? 0) as number,
      scrapedAt: (row.scraped_at ?? row.scrapedAt ?? "") as string,
      queryUsed: (row.query_used ?? row.queryUsed ?? "") as string,
    };
  }

  getUnscoredPosts(): ScrapedPost[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM posts p LEFT JOIN scores s ON p.id = s.post_id WHERE s.post_id IS NULL`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapPost(r));
  }

  getPostById(id: string): ScrapedPost | null {
    const row = this.db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPost(row) : null;
  }

  // ── Scores ──

  insertScore(score: PostScore): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scores (post_id, relevance, fit, urgency, engagement_potential, total, positioning, reasoning, scored_at)
       VALUES ($postId, $relevance, $fit, $urgency, $engagementPotential, $total, $positioning, $reasoning, $scoredAt)`
      )
      .run({
        $postId: score.postId,
        $relevance: score.relevance,
        $fit: score.fit,
        $urgency: score.urgency,
        $engagementPotential: score.engagementPotential,
        $total: score.total,
        $positioning: score.positioning,
        $reasoning: score.reasoning,
        $scoredAt: score.scoredAt,
      });
  }

  getHighScoringUncommented(threshold: number): Array<ScrapedPost & PostScore> {
    return this.db
      .prepare(
        `SELECT p.*, s.relevance, s.fit, s.urgency, s.engagement_potential, s.total, s.positioning, s.reasoning, s.scored_at
       FROM posts p
       JOIN scores s ON p.id = s.post_id
       LEFT JOIN comments c ON p.id = c.post_id
       WHERE s.total >= ? AND s.fit > 0 AND c.id IS NULL
       ORDER BY s.total DESC`
      )
      .all(threshold) as Array<ScrapedPost & PostScore>;
  }

  wasAuthorCommentedRecently(authorUrl: string, days: number = 7): boolean {
    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    ).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM comments c
       JOIN posts p ON c.post_id = p.id
       WHERE p.author_url = ? AND c.status IN ('approved', 'posted') AND c.generated_at > ?`
      )
      .get(authorUrl, cutoff) as { cnt: number };
    return row.cnt > 0;
  }

  // ── Comments ──

  insertComment(postId: string, text: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO comments (post_id, comment_text, status, generated_at)
       VALUES (?, ?, 'pending', ?)`
      )
      .run(postId, text, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  getPendingComments(): Array<QueuedComment & { postContent: string; authorName: string; postUrl: string }> {
    return this.db
      .prepare(
        `SELECT c.*, p.content as postContent, p.author_name as authorName, p.url as postUrl
       FROM comments c JOIN posts p ON c.post_id = p.id
       WHERE c.status = 'pending'
       ORDER BY c.generated_at ASC`
      )
      .all() as Array<QueuedComment & { postContent: string; authorName: string; postUrl: string }>;
  }

  getApprovedComments(): Array<QueuedComment & { postUrl: string }> {
    return this.db
      .prepare(
        `SELECT c.*, p.url as postUrl FROM comments c JOIN posts p ON c.post_id = p.id
       WHERE c.status = 'approved' ORDER BY c.reviewed_at ASC`
      )
      .all() as Array<QueuedComment & { postUrl: string }>;
  }

  updateCommentStatus(
    id: number,
    status: CommentStatus,
    extra?: { text?: string; bereachResponse?: string }
  ): void {
    const now = new Date().toISOString();
    if (extra?.text) {
      this.db
        .prepare(
          `UPDATE comments SET status = ?, comment_text = ?, reviewed_at = ? WHERE id = ?`
        )
        .run(status, extra.text, now, id);
    } else if (extra?.bereachResponse) {
      this.db
        .prepare(
          `UPDATE comments SET status = ?, posted_at = ?, bereach_response = ? WHERE id = ?`
        )
        .run(status, now, extra.bereachResponse, id);
    } else {
      const timeField = status === "posted" ? "posted_at" : "reviewed_at";
      this.db
        .prepare(`UPDATE comments SET status = ?, ${timeField} = ? WHERE id = ?`)
        .run(status, now, id);
    }
  }

  // ── Lead Content ──

  insertLeadContent(
    postId: string,
    summary: string,
    content: {
      commentAj: string;
      commentPk: string;
      connectionNoteAj: string;
      connectionNotePk: string;
      dmAj: string;
      dmPk: string;
    }
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO lead_content
         (post_id, summary, comment, connection_note, dm,
          comment_aj, comment_pk, connection_note_aj, connection_note_pk, dm_aj, dm_pk,
          generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        postId,
        summary,
        content.commentPk, // Legacy: primary comment = PK
        content.connectionNotePk,
        content.dmPk,
        content.commentAj,
        content.commentPk,
        content.connectionNoteAj,
        content.connectionNotePk,
        content.dmAj,
        content.dmPk,
        new Date().toISOString()
      );
  }

  // ── DMs ──

  insertDm(postId: string, authorUrl: string, text: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO dms (post_id, author_url, dm_text, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
      )
      .run(postId, authorUrl, text, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  // Get leads ready for connection request (comment posted, no connection sent yet)
  getReadyToConnect(): Array<{ postId: string; authorUrl: string; authorName: string; postContent: string; positioning: string }> {
    return this.db
      .prepare(
        `SELECT p.id as postId, p.author_url as authorUrl, p.author_name as authorName,
                p.content as postContent, s.positioning
         FROM posts p
         JOIN comments c ON p.id = c.post_id
         JOIN scores s ON p.id = s.post_id
         LEFT JOIN dms d ON p.id = d.post_id
         WHERE c.status = 'posted' AND d.id IS NULL
         ORDER BY c.posted_at ASC`
      )
      .all() as Array<{ postId: string; authorUrl: string; authorName: string; postContent: string; positioning: string }>;
  }

  // Get leads ready for DM (connection sent 12+ hours ago)
  getReadyDms(): Array<QueuedDm & { postContent: string; commentText: string }> {
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT d.*, p.content as postContent, c.comment_text as commentText
         FROM dms d
         JOIN posts p ON d.post_id = p.id
         JOIN comments c ON d.post_id = c.post_id
         WHERE d.status = 'pending' AND d.connection_status = 'pending' AND d.created_at < ?
         ORDER BY d.created_at ASC`
      )
      .all(cutoff) as Array<QueuedDm & { postContent: string; commentText: string }>;
  }

  updateDmStatus(id: number, status: string, extra?: { connectionStatus?: string; sentAt?: string }): void {
    if (extra?.connectionStatus) {
      this.db.prepare(`UPDATE dms SET status = ?, connection_status = ? WHERE id = ?`)
        .run(status, extra.connectionStatus, id);
    } else if (extra?.sentAt) {
      this.db.prepare(`UPDATE dms SET status = ?, sent_at = ? WHERE id = ?`)
        .run(status, extra.sentAt, id);
    } else {
      this.db.prepare(`UPDATE dms SET status = ? WHERE id = ?`).run(status, id);
    }
  }

  // ── Activity Log ──

  logActivity(action: ActionType, targetUrl: string): void {
    this.db
      .prepare(
        `INSERT INTO activity_log (action, target_url, performed_at) VALUES (?, ?, ?)`
      )
      .run(action, targetUrl, new Date().toISOString());
  }

  getTodayCount(action: ActionType): number {
    const today = new Date().toISOString().split("T")[0];
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM activity_log WHERE action = ? AND performed_at >= ?`
      )
      .get(action, today) as { cnt: number };
    return row.cnt;
  }

  // ── Stats ──

  getStats(): PipelineStats {
    const q = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { cnt: number };
      return row.cnt;
    };

    const today = new Date().toISOString().split("T")[0];

    return {
      totalPosts: q("SELECT COUNT(*) as cnt FROM posts"),
      scoredPosts: q("SELECT COUNT(*) as cnt FROM scores"),
      highScorePosts: q("SELECT COUNT(*) as cnt FROM scores WHERE total >= 25"),
      pendingComments: q(
        "SELECT COUNT(*) as cnt FROM comments WHERE status = 'pending'"
      ),
      approvedComments: q(
        "SELECT COUNT(*) as cnt FROM comments WHERE status = 'approved'"
      ),
      postedComments: q(
        "SELECT COUNT(*) as cnt FROM comments WHERE status = 'posted'"
      ),
      rejectedComments: q(
        "SELECT COUNT(*) as cnt FROM comments WHERE status = 'rejected'"
      ),
      pendingDms: q("SELECT COUNT(*) as cnt FROM dms WHERE status = 'pending'"),
      sentDms: q("SELECT COUNT(*) as cnt FROM dms WHERE status = 'sent'"),
      todayComments: q(
        `SELECT COUNT(*) as cnt FROM activity_log WHERE action = 'comment' AND performed_at >= '${today}'`
      ),
      todayConnections: q(
        `SELECT COUNT(*) as cnt FROM activity_log WHERE action = 'connection' AND performed_at >= '${today}'`
      ),
      todayDms: q(
        `SELECT COUNT(*) as cnt FROM activity_log WHERE action = 'dm' AND performed_at >= '${today}'`
      ),
    };
  }

  // ── Scrape Runs (cost + cap tracking) ──

  startScrapeRun(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO scrape_runs (started_at, status) VALUES (?, 'running')`
      )
      .run(now);
    return Number(result.lastInsertRowid);
  }

  finishScrapeRun(
    id: number,
    params: {
      leadsFetched: number;
      leadsInserted: number;
      actorRuns: number;
      estimatedCostUsd: number;
      capped: boolean;
      error?: string;
    }
  ): void {
    const now = new Date().toISOString();
    const status = params.error ? "error" : params.capped ? "capped" : "ok";
    this.db
      .prepare(
        `UPDATE scrape_runs
         SET completed_at = ?, leads_fetched = ?, leads_inserted = ?,
             actor_runs = ?, estimated_cost_usd = ?, capped = ?, status = ?, error = ?
         WHERE id = ?`
      )
      .run(
        now,
        params.leadsFetched,
        params.leadsInserted,
        params.actorRuns,
        params.estimatedCostUsd,
        params.capped ? 1 : 0,
        status,
        params.error ?? null,
        id
      );
  }

  // ── Per-query records within a scrape run (analytics leaderboard) ──

  startQueryRecord(runId: number, q: SearchQuery, startedAt: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO scrape_run_queries
           (run_id, query, query_group, tier, max_results, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        q.query,
        q.group ?? null,
        q.tier ?? null,
        q.maxResults ?? null,
        startedAt
      );
    return Number(result.lastInsertRowid);
  }

  finishQueryRecord(id: number, counts: QueryRunCounts): void {
    // Serialize reason maps as null when empty so analytics filtering
    // `WHERE rejected_geo_reason IS NOT NULL` cleanly means "had rejections".
    const geoJson = Object.keys(counts.geo_reasons).length
      ? JSON.stringify(counts.geo_reasons)
      : null;
    const intentJson = Object.keys(counts.intent_reasons).length
      ? JSON.stringify(counts.intent_reasons)
      : null;
    this.db
      .prepare(
        `UPDATE scrape_run_queries
         SET fetched = ?, inserted = ?, rejected_date = ?,
             rejected_dedup_content = ?, rejected_dedup_db = ?,
             rejected_geo = ?, rejected_intent = ?, rejected_normalize = ?,
             rejected_geo_reason = ?, rejected_intent_reason = ?,
             error = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(
        counts.fetched,
        counts.inserted,
        counts.rejected_date,
        counts.rejected_dedup_content,
        counts.rejected_dedup_db,
        counts.rejected_geo,
        counts.rejected_intent,
        counts.rejected_normalize,
        geoJson,
        intentJson,
        counts.error,
        new Date().toISOString(),
        id
      );
  }

  // Sum of leads_fetched across all runs started today (UTC).
  getTodayScrapeFetched(): number {
    const today = new Date().toISOString().split("T")[0];
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(leads_fetched), 0) as total FROM scrape_runs WHERE started_at >= ?`
      )
      .get(today) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Postgres-backed Store for the linkedin-jobs CLI.
 *
 * Replaces the bun:sqlite Store from Phase 0 — same public API where the
 * scrape/score/generate pipeline depends on it, no-op stubs for the legacy
 * comments/dms/PhantomBuster paths that don't exist in the new platform
 * schema. Pulls the Drizzle client + Postgres schema from src/db.ts (which
 * shares schema with platform/web).
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, pool, schema } from "./db";
import { istDayStart } from "./time";
import type {
  ActionType,
  CommentStatus,
  PipelineStats,
  PostScore,
  QueuedComment,
  QueuedDm,
  ScrapedPost,
  SearchQuery,
} from "./types";

/**
 * Fire-and-forget call to the platform's internal tag endpoint. The
 * endpoint is idempotent (skips if contact already has source='gemini'
 * rows) so retries are safe. Failures are logged but do not throw —
 * ingest must not break because Gemini is rate-limited; the nightly
 * cron `tag-contact-roles.ts` on mediaos sweeps anything missed.
 *
 * No-ops silently if PLATFORM_API_URL or INTERNAL_API_KEY is unset
 * (local dev, tests).
 */
async function tagContactRoleViaPlatform(contactId: string): Promise<void> {
  const url = process.env.PLATFORM_API_URL;
  const key = process.env.INTERNAL_API_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/api/internal/tag-contact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": key,
      },
      body: JSON.stringify({ contactId }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(
        `[tag-contact] non-2xx ${res.status} for ${contactId}: ${(await res.text()).slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[tag-contact] ${contactId} failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

/**
 * Ask the platform to resolve this identity into a contact — either
 * an existing one (cross-platform match) or a brand new one. The
 * endpoint owns the dedup decision; this pipeline just writes the
 * identity row against whatever contact_id comes back.
 *
 * Falls back to "create a new contact locally" when the endpoint is
 * unreachable or returns an error. Better to under-merge than to
 * drop a lead.
 *
 * Returns `{ contactId, isNewContact }` where isNewContact=true means
 * a new row exists in `contacts` and the caller should fire the
 * role tagger; false means the identity is being attached to an
 * existing contact (which is already tagged or will be on the cron).
 */
async function resolveContactViaPlatform(
  args: {
    platform: string;
    username: string;
    displayName: string;
    headline?: string | null;
    location?: string | null;
    profileUrl?: string | null;
  },
  fallbackInsert: () => Promise<string>,
): Promise<{ contactId: string; isNewContact: boolean }> {
  const url = process.env.PLATFORM_API_URL;
  const key = process.env.INTERNAL_API_KEY;
  if (!url || !key) {
    return { contactId: await fallbackInsert(), isNewContact: true };
  }
  try {
    const res = await fetch(`${url}/api/internal/resolve-contact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": key,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000), // Gemini-confirm path can be slow
    });
    if (!res.ok) {
      console.warn(
        `[resolve-contact] non-2xx ${res.status} for ${args.platform}:${args.username}; falling back`,
      );
      return { contactId: await fallbackInsert(), isNewContact: true };
    }
    const data = (await res.json()) as {
      ok?: boolean;
      contactId?: string;
      action?: string;
    };
    if (!data.ok || !data.contactId) {
      return { contactId: await fallbackInsert(), isNewContact: true };
    }
    return {
      contactId: data.contactId,
      isNewContact: data.action === "created_new",
    };
  } catch (err) {
    console.warn(
      `[resolve-contact] ${args.platform}:${args.username} failed: ${(err as Error).message.slice(0, 200)}; falling back`,
    );
    return { contactId: await fallbackInsert(), isNewContact: true };
  }
}

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

const FOUNDER_EMAIL: Record<"aj" | "pk", string> = {
  aj: "jhamb285@gmail.com",
  pk: "pa.parikahlawat@gmail.com",
};

export class Store {
  /**
   * `_dbPath` is accepted but ignored — Postgres connection comes from
   * DATABASE_URL via src/db.ts. Kept for source-compat with the legacy
   * `new Store(config.dbPath)` call sites until they're cleaned up.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_dbPath?: string) {
    // no-op
  }

  async close(): Promise<void> {
    await pool.end();
  }

  // ── User-id resolution (cached) ────────────────────────────────────────

  private founderIds: { aj: string | null; pk: string | null } | null = null;

  private async loadFounderIds(): Promise<{ aj: string | null; pk: string | null }> {
    if (this.founderIds) return this.founderIds;
    const rows = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.role, "founder"));
    const ids: { aj: string | null; pk: string | null } = { aj: null, pk: null };
    for (const r of rows) {
      if (r.email === FOUNDER_EMAIL.aj) ids.aj = r.id;
      if (r.email === FOUNDER_EMAIL.pk) ids.pk = r.id;
    }
    this.founderIds = ids;
    return ids;
  }

  // ── Author dedup ───────────────────────────────────────────────────────

  async wasAuthorRecentlyScraped(authorUrl: string, days: number = 7): Promise<boolean> {
    if (!authorUrl) return false;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.authorUrl, authorUrl),
          gte(schema.posts.scrapedAt, cutoff),
        ),
      );
    return (rows[0]?.n ?? 0) > 0;
  }

  // ── Posts ──────────────────────────────────────────────────────────────

  /**
   * Insert a scraped post. Returns true iff a NEW row was created (false
   * means the URL was already in the DB and the existing row was kept).
   * After this call, `post.id` is rewritten in-place to the canonical
   * Postgres UUID so downstream callers (matcher.insertScore, etc.) see
   * a consistent id.
   */
  /**
   * Upsert a contact from a scraped post. Called from scraper.ts AFTER
   * normalizeApifyResult succeeds, regardless of whether the post itself
   * passes filters — gives us a record of every author we ever fetched.
   *
   * Returns the contact UUID so the caller can link it to a post (when
   * the post survived the filter chain and got inserted). Returns null
   * when we can't extract a LinkedIn slug (rare, e.g. malformed URL).
   *
   * Metadata args carry filter outcome — when a fetch was rejected,
   * `filter_rejected: true` and the reason stay on the identity row so
   * the DB UI can surface "100 recruiters in Bengaluru we filtered out".
   */
  async upsertContactFromPost(args: {
    authorName: string;
    authorHeadline: string;
    authorUrl: string;
    scrapedAt: Date;
    rejection?: { stage: string; reason: string } | null;
    tags?: string[];
    primaryRole?: string | null;
  }): Promise<string | null> {
    if (!args.authorUrl) return null;
    const m = args.authorUrl.match(
      /linkedin\.com\/(in|company|showcase)\/([^/?#]+)/i,
    );
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const platform =
      kind === "in"
        ? "linkedin"
        : kind === "company"
          ? "linkedin_company"
          : "linkedin_showcase";
    const username = decodeURIComponent(m[2]).toLowerCase().trim();
    const displayName = (args.authorName ?? "").trim() || username;
    const headline = args.authorHeadline ?? null;

    // Build the metadata payload from rejection state + classification tags.
    // Both are merged onto a single JSONB column on contact_identities so
    // analytics queries (e.g. "% of scraped authors who are students") can
    // run with a single GIN index lookup.
    const metaParts: Record<string, unknown> = {};
    if (args.rejection) {
      metaParts.filter_rejected = true;
      metaParts.stage = args.rejection.stage;
      metaParts.reason = args.rejection.reason;
    }
    if (args.tags && args.tags.length > 0) {
      metaParts.tags = args.tags;
    }
    if (args.primaryRole) {
      metaParts.primary_role = args.primaryRole;
    }
    const metadata = Object.keys(metaParts).length > 0 ? metaParts : null;

    // Existence check + branch.
    const existing = (await db.execute(sql`
      SELECT id, contact_id, first_seen_at, last_seen_at, metadata
      FROM contact_identities
      WHERE platform = ${platform} AND username = ${username}
      LIMIT 1
    `)).rows[0] as
      | {
          id: string;
          contact_id: string;
          first_seen_at: Date | null;
          last_seen_at: Date | null;
          metadata: Record<string, unknown> | null;
        }
      | undefined;

    if (existing) {
      const newFirst =
        existing.first_seen_at && new Date(existing.first_seen_at) < args.scrapedAt
          ? existing.first_seen_at
          : args.scrapedAt;
      const newLast =
        existing.last_seen_at && new Date(existing.last_seen_at) > args.scrapedAt
          ? existing.last_seen_at
          : args.scrapedAt;
      // Merge metadata: keep prior keys, overlay current state.
      //   - tags / primary_role: latest classification overrides prior
      //   - filter_rejected: if NO rejection in current call, clear the
      //     prior rejection (contact is now confirmed valid)
      //   - if current call has neither rejection nor tags (legacy path),
      //     same clearing behaviour applies via the `else if` branch
      let mergedMetadata: Record<string, unknown> | null = existing.metadata;
      if (metadata) {
        const next: Record<string, unknown> = {
          ...(existing.metadata ?? {}),
          ...metadata,
        };
        if (!args.rejection) {
          delete next.filter_rejected;
          delete next.stage;
          delete next.reason;
        }
        mergedMetadata = Object.keys(next).length > 0 ? next : null;
      } else if (existing.metadata?.filter_rejected) {
        const { filter_rejected, stage, reason, ...rest } = existing.metadata;
        void filter_rejected;
        void stage;
        void reason;
        mergedMetadata = Object.keys(rest).length > 0 ? rest : null;
      }
      await db.execute(sql`
        UPDATE contact_identities
        SET display_name_at_capture = ${displayName},
            headline = COALESCE(${headline}, headline),
            profile_url = COALESCE(${args.authorUrl}, profile_url),
            first_seen_at = ${newFirst},
            last_seen_at = ${newLast},
            appearance_count = appearance_count + 1,
            metadata = ${mergedMetadata}
        WHERE id = ${existing.id}
      `);
      return existing.contact_id;
    }

    // New identity. Ask the platform whether this person already exists
    // under a different platform (e.g., the same author also shows up
    // on X or Reddit). Attach the new identity to whatever contact_id
    // the resolver returns. On resolver failure, fall back to creating
    // a fresh contact locally.
    const { contactId, isNewContact } = await resolveContactViaPlatform(
      {
        platform,
        username,
        displayName,
        headline,
        // linkedin-jobs doesn't capture location on the identity row
        // yet — pass null so the resolver doesn't get bad signal. If
        // we ever extract LinkedIn location, plumb it here.
        location: null,
        profileUrl: args.authorUrl,
      },
      async () => {
        const row = (await db.execute(sql`
          INSERT INTO contacts (display_name)
          VALUES (${displayName})
          RETURNING id
        `)).rows[0] as { id: string };
        return row.id;
      },
    );
    await db.execute(sql`
      INSERT INTO contact_identities (
        contact_id, platform, username, profile_url,
        display_name_at_capture, headline,
        metadata, first_seen_at, last_seen_at
      ) VALUES (
        ${contactId}, ${platform}, ${username}, ${args.authorUrl},
        ${displayName}, ${headline},
        ${metadata}, ${args.scrapedAt}, ${args.scrapedAt}
      )
    `);
    // Tag the contact only when a brand-new one was created. Merged
    // contacts are already tagged or will be picked up by the nightly
    // cron.
    if (isNewContact) {
      void tagContactRoleViaPlatform(contactId);
    }
    return contactId;
  }

  /** Idempotently link a contact to a post they appeared in. */
  async linkContactToPost(contactId: string, postId: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO contact_post_links (contact_id, post_id)
      VALUES (${contactId}, ${postId})
      ON CONFLICT DO NOTHING
    `);
  }

  /**
   * Read the latest classification tags for an author from
   * contact_identities.metadata.tags. Used by matcher.ts to deterministically
   * adjust LLM-produced scores based on author-type (recruiter penalty,
   * product-founder boost, etc.).
   *
   * Returns [] when the author has no contact_identities row yet (first
   * time we're seeing them), or when their metadata.tags is missing.
   * Returns [] on URL-parse failure.
   *
   * Mirrors the URL-parse logic in upsertContactFromPost so the same
   * (platform, username) key is used for both the upsert and the read.
   */
  async getAuthorTags(authorUrl: string): Promise<string[]> {
    if (!authorUrl) return [];
    const m = authorUrl.match(
      /linkedin\.com\/(in|company|showcase)\/([^/?#]+)/i,
    );
    if (!m) return [];
    const kind = m[1].toLowerCase();
    const platform =
      kind === "in"
        ? "linkedin"
        : kind === "company"
          ? "linkedin_company"
          : "linkedin_showcase";
    const username = decodeURIComponent(m[2]).toLowerCase().trim();
    const row = (await db.execute(sql`
      SELECT metadata
      FROM contact_identities
      WHERE platform = ${platform} AND username = ${username}
      LIMIT 1
    `)).rows[0] as { metadata: Record<string, unknown> | null } | undefined;
    if (!row?.metadata) return [];
    const tags = row.metadata.tags;
    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === "string");
  }

  async insertPost(post: ScrapedPost): Promise<boolean> {
    const inserted = await db
      .insert(schema.posts)
      .values({
        url: post.url,
        linkedinPostId: post.linkedinPostId ?? null,
        authorName: post.authorName,
        authorHeadline: post.authorHeadline,
        authorUrl: post.authorUrl,
        content: post.content,
        engagementCount: post.engagementCount ?? 0,
        engagementLikes: post.engagementLikes ?? null,
        engagementComments: post.engagementComments ?? null,
        engagementShares: post.engagementShares ?? null,
        scrapedAt: post.scrapedAt ? new Date(post.scrapedAt) : new Date(),
        queryUsed: post.queryUsed,
        source: "linkedin_jobs",
        testRunId: post.testRunId ?? null,
        // Stored so the drafter + UI can branch on "this post has an email
        // → produce + show email draft" without re-running the regex.
        metadata: post.detectedEmail
          ? { detected_email: post.detectedEmail }
          : null,
      })
      // onConflictDoUpdate (not DoNothing) so a re-scrape that finally
      // detects an email backfills metadata.detected_email on rows that
      // were inserted before detectEmail was wired. content also
      // refreshed in case article-fetch surfaces a longer body on the
      // second pass.
      .onConflictDoUpdate({
        target: schema.posts.url,
        set: {
          content: sql`COALESCE(excluded.content, ${schema.posts.content})`,
          metadata: sql`COALESCE(${schema.posts.metadata}, '{}'::jsonb)
            || COALESCE(excluded.metadata, '{}'::jsonb)`,
        },
      })
      .returning({ id: schema.posts.id });

    if (inserted.length > 0) {
      post.id = inserted[0].id;
      return true;
    }
    // Row already existed — look up its UUID so the caller can still chain.
    const existing = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(eq(schema.posts.url, post.url))
      .limit(1);
    if (existing.length) post.id = existing[0].id;
    return false;
  }

  async getUnscoredPosts(): Promise<ScrapedPost[]> {
    const rows = await db
      .select({
        id: schema.posts.id,
        url: schema.posts.url,
        authorName: schema.posts.authorName,
        authorHeadline: schema.posts.authorHeadline,
        authorUrl: schema.posts.authorUrl,
        content: schema.posts.content,
        engagementCount: schema.posts.engagementCount,
        scrapedAt: schema.posts.scrapedAt,
        queryUsed: schema.posts.queryUsed,
      })
      .from(schema.posts)
      .leftJoin(schema.scores, eq(schema.scores.postId, schema.posts.id))
      .where(sql`${schema.scores.postId} IS NULL AND ${schema.posts.source} = 'linkedin_jobs'`);

    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      authorName: r.authorName ?? "",
      authorHeadline: r.authorHeadline ?? "",
      authorUrl: r.authorUrl ?? "",
      content: r.content ?? "",
      engagementCount: r.engagementCount ?? 0,
      scrapedAt: r.scrapedAt.toISOString(),
      queryUsed: r.queryUsed ?? "",
    }));
  }

  /**
   * Same as `getUnscoredPosts()` but scoped to a specific test_run_id —
   * used by scripts/test-3way.ts so each strategy's qualified-rate is
   * computed only over its own rows.
   */
  async getUnscoredPostsForTest(testRunId: string): Promise<ScrapedPost[]> {
    const rows = await db
      .select({
        id: schema.posts.id,
        url: schema.posts.url,
        authorName: schema.posts.authorName,
        authorHeadline: schema.posts.authorHeadline,
        authorUrl: schema.posts.authorUrl,
        content: schema.posts.content,
        engagementCount: schema.posts.engagementCount,
        scrapedAt: schema.posts.scrapedAt,
        queryUsed: schema.posts.queryUsed,
      })
      .from(schema.posts)
      .leftJoin(schema.scores, eq(schema.scores.postId, schema.posts.id))
      .where(
        sql`${schema.scores.postId} IS NULL AND ${schema.posts.testRunId} = ${testRunId}`,
      );

    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      authorName: r.authorName ?? "",
      authorHeadline: r.authorHeadline ?? "",
      authorUrl: r.authorUrl ?? "",
      content: r.content ?? "",
      engagementCount: r.engagementCount ?? 0,
      scrapedAt: r.scrapedAt.toISOString(),
      queryUsed: r.queryUsed ?? "",
      testRunId,
    }));
  }

  async getPostById(id: string): Promise<ScrapedPost | null> {
    const rows = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, id))
      .limit(1);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      url: r.url,
      authorName: r.authorName ?? "",
      authorHeadline: r.authorHeadline ?? "",
      authorUrl: r.authorUrl ?? "",
      content: r.content ?? "",
      engagementCount: r.engagementCount ?? 0,
      scrapedAt: r.scrapedAt.toISOString(),
      queryUsed: r.queryUsed ?? "",
    };
  }

  // ── Scores ─────────────────────────────────────────────────────────────

  async insertScore(score: PostScore): Promise<void> {
    await db
      .insert(schema.scores)
      .values({
        postId: score.postId,
        relevance: score.relevance,
        fit: score.fit,
        urgency: score.urgency,
        engagementPotential: score.engagementPotential,
        total: score.total,
        positioning: score.positioning,
        reasoning: score.reasoning,
        scoredAt: score.scoredAt ? new Date(score.scoredAt) : new Date(),
      })
      .onConflictDoUpdate({
        target: schema.scores.postId,
        set: {
          relevance: score.relevance,
          fit: score.fit,
          urgency: score.urgency,
          engagementPotential: score.engagementPotential,
          total: score.total,
          positioning: score.positioning,
          reasoning: score.reasoning,
          scoredAt: score.scoredAt ? new Date(score.scoredAt) : new Date(),
        },
      });
  }

  /**
   * Posts in the current ACTIVE batch that don't yet have an
   * engagement_drafts row for the persona they're assigned to.
   *
   * Each row carries `assignedPersona` ('aj' | 'pk') so the commenter
   * knows which persona's RAG + prompt to use. Posts that aren't in
   * the active batch (i.e. weren't picked up by daily.ts.rotateBatch)
   * are excluded — the lead-split feature deliberately limits content
   * gen to the batched-and-assigned set.
   */
  async getBatchedAssignedUncommented(
    threshold: number,
  ): Promise<
    Array<
      ScrapedPost & PostScore & {
        author_url: string;
        author_name: string;
        author_headline: string;
        assignedUserId: string;
        assignedPersona: "aj" | "pk";
      }
    >
  > {
    const ids = await this.loadFounderIds();
    if (!ids.aj || !ids.pk) {
      throw new Error(
        "Founder users (AJ, PK) not seeded — run `bun run db/seed.ts` first.",
      );
    }
    // 2026-05-21: dropped lb.status='active' constraint. Each daily
    // run closes the prior active batch and opens a new one — any
    // post that landed in the prior batch but never got drafted (e.g.
    // because the old per-author dedup skipped it) was silently
    // orphaned. The d.id IS NULL left-join still prevents double
    // drafting; a 14-day floor caps how far back we'll reach for
    // catch-up.
    const rows = (await db.execute(sql`
      SELECT
        p.id, p.url, p.author_name, p.author_headline, p.author_url,
        p.content, p.engagement_count, p.scraped_at, p.query_used,
        p.metadata->>'detected_email' AS detected_email,
        s.relevance, s.fit, s.urgency,
        s.engagement_potential AS "engagementPotential",
        s.total, s.positioning, s.reasoning,
        s.scored_at AS "scoredAt",
        ba.assigned_user_id AS "assignedUserId"
      FROM batch_assignments ba
      JOIN lead_batches lb ON lb.id = ba.batch_id
      JOIN posts p ON p.id = ba.post_id
      JOIN scores s ON s.post_id = p.id
      LEFT JOIN engagement_drafts d
        ON d.post_id = p.id AND d.user_id = ba.assigned_user_id
      WHERE p.source = 'linkedin_jobs'
        AND s.total >= ${threshold}
        AND s.fit > 0
        AND ba.assigned_user_id IS NOT NULL
        AND d.id IS NULL
        AND lb.created_at >= now() - interval '14 days'
      ORDER BY s.total DESC
    `)).rows as Array<{
      id: string;
      url: string;
      author_name: string | null;
      author_headline: string | null;
      author_url: string | null;
      content: string | null;
      engagement_count: number | null;
      scraped_at: Date;
      query_used: string | null;
      detected_email: string | null;
      relevance: number;
      fit: number;
      urgency: number;
      engagementPotential: number;
      total: number;
      positioning: string;
      reasoning: string | null;
      scoredAt: Date;
      assignedUserId: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      authorName: r.author_name ?? "",
      authorHeadline: r.author_headline ?? "",
      authorUrl: r.author_url ?? "",
      content: r.content ?? "",
      engagementCount: r.engagement_count ?? 0,
      scrapedAt: toIso(r.scraped_at),
      queryUsed: r.query_used ?? "",
      detectedEmail: r.detected_email,
      postId: r.id,
      relevance: r.relevance,
      fit: r.fit,
      urgency: r.urgency,
      engagementPotential: r.engagementPotential,
      total: r.total,
      positioning: r.positioning as PostScore["positioning"],
      reasoning: r.reasoning ?? "",
      scoredAt: toIso(r.scoredAt),
      author_url: r.author_url ?? "",
      author_name: r.author_name ?? "",
      author_headline: r.author_headline ?? "",
      assignedUserId: r.assignedUserId,
      assignedPersona: r.assignedUserId === ids.aj ? "aj" : "pk",
    }));
  }

  /**
   * Insert a single-persona engagement_draft. Replaces the dual-persona
   * insertLeadContent in the per-persona RAG flow — daily.ts now calls
   * this once per (post, persona) pair after generating that persona's
   * content via their RAG.
   *
   * Idempotent on (post_id, user_id) — re-runs replace the existing
   * row's content fields.
   */
  async insertPersonaDraft(
    postId: string,
    persona: "aj" | "pk",
    content: {
      comment: string;
      connectionNote: string;
      dm: string;
      email?: string | null;
      emailSubject?: string | null;
      followUpDm?: string | null;
      followUpEmail?: string | null;
      followUpEmailSubject?: string | null;
    },
  ): Promise<void> {
    const ids = await this.loadFounderIds();
    const userId = persona === "aj" ? ids.aj : ids.pk;
    if (!userId) {
      throw new Error(
        `Founder user for persona '${persona}' not seeded — run db/seed.ts first.`,
      );
    }
    const value: typeof schema.engagementDrafts.$inferInsert = {
      postId,
      userId,
      comment: content.comment,
      connectionNote: content.connectionNote,
      dm: content.dm,
      email: content.email ?? null,
      emailSubject: content.emailSubject ?? null,
      followUpDm: content.followUpDm ?? null,
      followUpEmail: content.followUpEmail ?? null,
      followUpEmailSubject: content.followUpEmailSubject ?? null,
      pipeline: "linkedin_jobs",
      status: "pending",
      generatedAt: new Date(),
    };
    await db
      .insert(schema.engagementDrafts)
      .values(value)
      .onConflictDoUpdate({
        target: [
          schema.engagementDrafts.postId,
          schema.engagementDrafts.userId,
        ],
        set: {
          comment: value.comment,
          connectionNote: value.connectionNote,
          dm: value.dm,
          email: value.email,
          emailSubject: value.emailSubject,
          followUpDm: value.followUpDm,
          followUpEmail: value.followUpEmail,
          followUpEmailSubject: value.followUpEmailSubject,
          pipeline: "linkedin_jobs",
          generatedAt: new Date(),
        },
      });
  }

  /**
   * Posts with score >= threshold and fit > 0 that don't yet have an
   * engagement_drafts row for either persona. Returns the union of post +
   * score columns the legacy generator expected (snake_case keys preserved
   * for in-place use by commenter.ts).
   *
   * @deprecated since the per-persona RAG flow — use
   *   getBatchedAssignedUncommented instead. Kept for the smoke-store
   *   script and any out-of-batch CLI invocation.
   */
  async getHighScoringUncommented(
    threshold: number,
  ): Promise<
    Array<
      ScrapedPost & PostScore & {
        author_url: string;
        author_name: string;
        author_headline: string;
      }
    >
  > {
    const rows = (await db.execute(sql`
      SELECT
        p.id, p.url, p.author_name, p.author_headline, p.author_url,
        p.content, p.engagement_count, p.scraped_at, p.query_used,
        s.relevance, s.fit, s.urgency,
        s.engagement_potential AS "engagementPotential",
        s.total, s.positioning, s.reasoning,
        s.scored_at AS "scoredAt"
      FROM posts p
      JOIN scores s ON s.post_id = p.id
      LEFT JOIN engagement_drafts d ON d.post_id = p.id
      WHERE p.source = 'linkedin_jobs'
        AND s.total >= ${threshold}
        AND s.fit > 0
      GROUP BY p.id, s.post_id
      HAVING count(d.id) = 0
      ORDER BY s.total DESC
    `)).rows as Array<{
      id: string;
      url: string;
      author_name: string | null;
      author_headline: string | null;
      author_url: string | null;
      content: string | null;
      engagement_count: number | null;
      scraped_at: Date;
      query_used: string | null;
      relevance: number;
      fit: number;
      urgency: number;
      engagementPotential: number;
      total: number;
      positioning: string;
      reasoning: string | null;
      scoredAt: Date;
    }>;

    return rows.map((r) => ({
      // ScrapedPost shape
      id: r.id,
      url: r.url,
      authorName: r.author_name ?? "",
      authorHeadline: r.author_headline ?? "",
      authorUrl: r.author_url ?? "",
      content: r.content ?? "",
      engagementCount: r.engagement_count ?? 0,
      scrapedAt: toIso(r.scraped_at),
      queryUsed: r.query_used ?? "",
      // PostScore shape (overlapping postId)
      postId: r.id,
      relevance: r.relevance,
      fit: r.fit,
      urgency: r.urgency,
      engagementPotential: r.engagementPotential,
      total: r.total,
      positioning: r.positioning as PostScore["positioning"],
      reasoning: r.reasoning ?? "",
      scoredAt: toIso(r.scoredAt),
      // snake_case duplicates for the legacy commenter.ts callers
      author_url: r.author_url ?? "",
      author_name: r.author_name ?? "",
      author_headline: r.author_headline ?? "",
    }));
  }

  // ── Engagement drafts (replaces legacy lead_content + comments) ───────

  /**
   * Writes the dual-persona generated content as TWO `engagement_drafts`
   * rows (one for AJ, one for PK), keyed on (post_id, user_id) so re-runs
   * upsert cleanly. Replaces the legacy `insertLeadContent` which wrote a
   * single denormalized row.
   */
  async insertLeadContent(
    postId: string,
    summary: string,
    content: {
      commentAj: string;
      commentPk: string;
      connectionNoteAj: string;
      connectionNotePk: string;
      dmAj: string;
      dmPk: string;
      // Optional: the new schema also tracks email + follow-up. Caller may
      // pass them; otherwise the column stays NULL.
      emailAj?: string | null;
      emailPk?: string | null;
      emailSubjectAj?: string | null;
      emailSubjectPk?: string | null;
      followUpDmAj?: string | null;
      followUpDmPk?: string | null;
      followUpEmailAj?: string | null;
      followUpEmailPk?: string | null;
      followUpEmailSubjectAj?: string | null;
      followUpEmailSubjectPk?: string | null;
    },
  ): Promise<void> {
    const ids = await this.loadFounderIds();
    if (!ids.aj || !ids.pk) {
      throw new Error(
        "Founder users (AJ, PK) not seeded in Postgres — run platform's `bun run db:seed` first.",
      );
    }

    const baseValues = (
      userId: string,
      persona: "aj" | "pk",
    ): typeof schema.engagementDrafts.$inferInsert => ({
      postId,
      userId,
      comment: persona === "aj" ? content.commentAj : content.commentPk,
      connectionNote:
        persona === "aj" ? content.connectionNoteAj : content.connectionNotePk,
      dm: persona === "aj" ? content.dmAj : content.dmPk,
      email: persona === "aj" ? content.emailAj ?? null : content.emailPk ?? null,
      emailSubject:
        persona === "aj"
          ? content.emailSubjectAj ?? null
          : content.emailSubjectPk ?? null,
      followUpDm:
        persona === "aj"
          ? content.followUpDmAj ?? null
          : content.followUpDmPk ?? null,
      followUpEmail:
        persona === "aj"
          ? content.followUpEmailAj ?? null
          : content.followUpEmailPk ?? null,
      followUpEmailSubject:
        persona === "aj"
          ? content.followUpEmailSubjectAj ?? null
          : content.followUpEmailSubjectPk ?? null,
      status: "pending",
      generatedAt: new Date(),
    });

    for (const persona of ["aj", "pk"] as const) {
      const userId = persona === "aj" ? ids.aj : ids.pk;
      const value = baseValues(userId, persona);
      await db
        .insert(schema.engagementDrafts)
        .values(value)
        .onConflictDoUpdate({
          target: [schema.engagementDrafts.postId, schema.engagementDrafts.userId],
          set: {
            comment: value.comment,
            connectionNote: value.connectionNote,
            dm: value.dm,
            email: value.email,
            emailSubject: value.emailSubject,
            followUpDm: value.followUpDm,
            followUpEmail: value.followUpEmail,
            followUpEmailSubject: value.followUpEmailSubject,
            generatedAt: new Date(),
          },
        });
    }
    // `summary` has no column in the new schema. The legacy `lead_content.summary`
    // field was UI-only; the platform UI uses post.content directly.
    void summary;
  }

  // ── Legacy outreach methods (no-ops on the new schema) ────────────────
  //
  // The `comments` and `dms` tables existed in the SQLite era for the
  // PhantomBuster-style auto-poster. The new platform's UI flow uses
  // engagement_drafts + engagement_actions, so these are no-ops.

  async insertComment(_postId: string, _text: string): Promise<number> {
    return 0;
  }

  async insertDm(_postId: string, _authorUrl: string, _text: string): Promise<number> {
    return 0;
  }

  async getPendingComments(): Promise<
    Array<QueuedComment & { postContent: string; authorName: string; postUrl: string }>
  > {
    return [];
  }

  async getApprovedComments(): Promise<Array<QueuedComment & { postUrl: string }>> {
    return [];
  }

  async getReadyToConnect(): Promise<
    Array<{
      postId: string;
      authorUrl: string;
      authorName: string;
      postContent: string;
      positioning: string;
    }>
  > {
    return [];
  }

  async getReadyDms(): Promise<Array<QueuedDm & { postContent: string; commentText: string }>> {
    return [];
  }

  async updateCommentStatus(
    _id: number,
    _status: CommentStatus,
    _extra?: { text?: string; bereachResponse?: string },
  ): Promise<void> {
    // no-op
  }

  async updateDmStatus(
    _id: number,
    _status: string,
    _extra?: { connectionStatus?: string; sentAt?: string },
  ): Promise<void> {
    // no-op
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  async getStats(): Promise<PipelineStats> {
    const totals = (await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM posts WHERE source = 'linkedin_jobs') AS total_posts,
        (SELECT count(*)::int FROM posts p JOIN scores s ON s.post_id = p.id WHERE p.source = 'linkedin_jobs') AS scored,
        (SELECT count(*)::int FROM posts p JOIN scores s ON s.post_id = p.id WHERE p.source = 'linkedin_jobs' AND s.total >= 25 AND s.fit > 0) AS high,
        (SELECT count(*)::int FROM engagement_drafts) AS drafts
    `)).rows[0] as {
      total_posts: number;
      scored: number;
      high: number;
      drafts: number;
    };

    const today = istDayStart();
    const todayCounts = (await db.execute(sql`
      SELECT action_type, count(*)::int AS n
        FROM engagement_actions
       WHERE coalesce(posted_at, created_at) >= ${today}
       GROUP BY action_type
    `)).rows as Array<{ action_type: string; n: number }>;
    const today_comments = todayCounts.find((r) => r.action_type === "comment")?.n ?? 0;
    const today_connects = todayCounts.find((r) => r.action_type === "connect")?.n ?? 0;
    const today_dms = todayCounts.find((r) => r.action_type === "dm")?.n ?? 0;

    return {
      totalPosts: totals.total_posts,
      scoredPosts: totals.scored,
      highScorePosts: totals.high,
      pendingComments: totals.drafts,
      approvedComments: 0,
      postedComments: 0,
      rejectedComments: 0,
      pendingDms: 0,
      sentDms: 0,
      todayComments: today_comments,
      todayConnections: today_connects,
      todayDms: today_dms,
    };
  }

  async getTodayCount(action: ActionType): Promise<number> {
    const today = istDayStart();
    const map: Record<ActionType, "comment" | "connect" | "dm"> = {
      comment: "comment",
      connection: "connect",
      dm: "dm",
    };
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.engagementActions)
      .where(
        and(
          eq(schema.engagementActions.actionType, map[action]),
          gte(schema.engagementActions.createdAt, today),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  // ── Scrape runs (apify_runs + scrape_run_queries) ─────────────────────

  async getTodayScrapeFetched(): Promise<number> {
    const today = istDayStart();
    const rows = await db
      .select({
        n: sql<number>`coalesce(sum(${schema.scrapeRunQueries.fetched}), 0)::int`,
      })
      .from(schema.scrapeRunQueries)
      .where(gte(schema.scrapeRunQueries.startedAt, today));
    return rows[0]?.n ?? 0;
  }

  async startScrapeRun(): Promise<string> {
    const inserted = await db
      .insert(schema.apifyRuns)
      .values({
        runId: `cli-${Date.now()}`,
        actor: "harvestapi/linkedin-post-search",
        startedAt: new Date(),
        status: "running",
      })
      .returning({ id: schema.apifyRuns.id });
    return inserted[0].id;
  }

  async finishScrapeRun(
    runId: string,
    args: {
      leadsFetched: number;
      leadsInserted: number;
      actorRuns: number;
      estimatedCostUsd: number;
      capped: boolean;
    },
  ): Promise<void> {
    await db
      .update(schema.apifyRuns)
      .set({
        completedAt: new Date(),
        totalCostUsd: String(args.estimatedCostUsd),
        status: args.capped ? "completed" : "completed",
      })
      .where(eq(schema.apifyRuns.id, runId));
  }

  async startQueryRecord(
    runId: string,
    q: SearchQuery,
    startedAt: string,
  ): Promise<string> {
    const inserted = await db
      .insert(schema.scrapeRunQueries)
      .values({
        runId,
        query: q.query,
        queryGroup: q.group,
        tier: q.tier != null ? String(q.tier) : null,
        maxResults: q.maxResults ?? null,
        startedAt: new Date(startedAt),
      })
      .returning({ id: schema.scrapeRunQueries.id });
    return inserted[0].id;
  }

  async finishQueryRecord(
    rowId: string,
    counts: QueryRunCounts,
  ): Promise<void> {
    await db
      .update(schema.scrapeRunQueries)
      .set({
        fetched: counts.fetched,
        inserted: counts.inserted,
        rejectedDate: counts.rejected_date,
        rejectedDedupContent: counts.rejected_dedup_content,
        rejectedDedupDb: counts.rejected_dedup_db,
        rejectedGeo: counts.rejected_geo,
        rejectedGeoReason: serializeReasons(counts.geo_reasons),
        rejectedIntent: counts.rejected_intent,
        rejectedIntentReason: serializeReasons(counts.intent_reasons),
        rejectedNormalize: counts.rejected_normalize,
        error: counts.error,
        completedAt: new Date(),
      })
      .where(eq(schema.scrapeRunQueries.id, rowId));
  }

  /**
   * Rotating slice of product-founder profile URLs for Phase 3
   * profile-watch scraping. Ordered by `last_seen_at` ASC so we rotate
   * through the pool across days rather than re-pulling the same
   * founders every run. Excludes agency-founders (staffing firms) and
   * any contact whose profile_url is missing.
   */
  async getFreshFoundersForWatch(limit: number = 30): Promise<string[]> {
    const rows = (await db.execute(sql`
      SELECT profile_url
        FROM contact_identities
       WHERE platform = 'linkedin'
         AND profile_url IS NOT NULL
         AND profile_url <> ''
         AND (
           metadata->'tags' ? 'product-founder'
           OR (
             metadata->'tags' ? 'founder'
             AND metadata->'tags' ? 'target-fit'
           )
         )
         AND NOT (metadata->'tags' ? 'agency-founder')
       ORDER BY last_seen_at ASC NULLS FIRST
       LIMIT ${limit}
    `)).rows as Array<{ profile_url: string }>;
    return rows.map((r) => r.profile_url);
  }

  /**
   * Per-query funnel stats over the last N days. Returns one row per
   * distinct `query` string seen in `scrape_run_queries`, with:
   *   - fetched: total posts pulled by Apify for this query
   *   - scored: subset of fetched that survived filters + got a score row
   *   - qualified: subset of scored with total >= 20 (high-score)
   *   - approvalPct: qualified / scored (NOT qualified / fetched — this
   *     way a temporary scoring outage doesn't make a query look "bad").
   *     Queries with 0 scored posts get the default fallback in scraper.ts.
   * Used by the scraper to dynamically rebalance per-query budget toward
   * proven performers.
   */
  async getQueryApprovalStats(lookbackDays: number = 30): Promise<
    Array<{
      query: string;
      fetched: number;
      scored: number;
      qualified: number;
      approvalPct: number;
    }>
  > {
    const rows = (await db.execute(sql`
      WITH q AS (
        SELECT query, sum(fetched)::int AS fetched
          FROM scrape_run_queries
         WHERE started_at >= now() - make_interval(days => ${lookbackDays})
         GROUP BY query
      ),
      sc AS (
        SELECT p.query_used AS query, count(*)::int AS scored
          FROM posts p
          JOIN scores s ON s.post_id = p.id
         WHERE p.scraped_at >= now() - make_interval(days => ${lookbackDays})
           AND p.query_used IS NOT NULL
         GROUP BY p.query_used
      ),
      h AS (
        SELECT p.query_used AS query, count(*)::int AS qualified
          FROM posts p
          JOIN scores s ON s.post_id = p.id
         WHERE s.total >= 20
           AND p.scraped_at >= now() - make_interval(days => ${lookbackDays})
           AND p.query_used IS NOT NULL
         GROUP BY p.query_used
      )
      SELECT
        q.query,
        q.fetched,
        coalesce(sc.scored, 0)::int AS scored,
        coalesce(h.qualified, 0)::int AS qualified
        FROM q
        LEFT JOIN sc ON sc.query = q.query
        LEFT JOIN h ON h.query = q.query
    `)).rows as Array<{
      query: string;
      fetched: number;
      scored: number;
      qualified: number;
    }>;
    return rows.map((r) => ({
      query: r.query,
      fetched: r.fetched,
      scored: r.scored,
      qualified: r.qualified,
      approvalPct: r.scored > 0 ? r.qualified / r.scored : 0,
    }));
  }

  // ── Lead export feed (used by exporter.ts) ────────────────────────────

  async getLeadsForExport(_args: {
    fullExport: boolean;
  }): Promise<
    Array<{
      postId: string;
      url: string;
      authorName: string;
      authorHeadline: string;
      authorUrl: string;
      postContent: string;
      scrapedAt: string;
      queryUsed: string;
      total: number;
      relevance: number;
      fit: number;
      urgency: number;
      engagementPotential: number;
      positioning: string;
      reasoning: string | null;
      commentAj: string | null;
      commentPk: string | null;
      connectionNoteAj: string | null;
      connectionNotePk: string | null;
      dmAj: string | null;
      dmPk: string | null;
    }>
  > {
    const ids = await this.loadFounderIds();
    if (!ids.aj || !ids.pk) {
      throw new Error("Founder users not seeded — cannot export.");
    }
    const rows = (await db.execute(sql`
      SELECT
        p.id          AS post_id,
        p.url         AS url,
        p.author_name AS author_name,
        p.author_headline AS author_headline,
        p.author_url  AS author_url,
        p.content     AS post_content,
        p.scraped_at  AS scraped_at,
        p.query_used  AS query_used,
        s.total, s.relevance, s.fit, s.urgency,
        s.engagement_potential AS "engagementPotential",
        s.positioning, s.reasoning,
        d_aj.comment          AS comment_aj,
        d_pk.comment          AS comment_pk,
        d_aj.connection_note  AS connection_note_aj,
        d_pk.connection_note  AS connection_note_pk,
        d_aj.dm               AS dm_aj,
        d_pk.dm               AS dm_pk
      FROM posts p
      JOIN scores s ON s.post_id = p.id
      LEFT JOIN engagement_drafts d_aj
        ON d_aj.post_id = p.id AND d_aj.user_id = ${ids.aj}
      LEFT JOIN engagement_drafts d_pk
        ON d_pk.post_id = p.id AND d_pk.user_id = ${ids.pk}
      WHERE p.source = 'linkedin_jobs'
      ORDER BY s.total DESC
    `)).rows as Array<{
      post_id: string;
      url: string;
      author_name: string | null;
      author_headline: string | null;
      author_url: string | null;
      post_content: string | null;
      scraped_at: Date;
      query_used: string | null;
      total: number;
      relevance: number;
      fit: number;
      urgency: number;
      engagementPotential: number;
      positioning: string;
      reasoning: string | null;
      comment_aj: string | null;
      comment_pk: string | null;
      connection_note_aj: string | null;
      connection_note_pk: string | null;
      dm_aj: string | null;
      dm_pk: string | null;
    }>;
    return rows.map((r) => ({
      postId: r.post_id,
      url: r.url,
      authorName: r.author_name ?? "",
      authorHeadline: r.author_headline ?? "",
      authorUrl: r.author_url ?? "",
      postContent: r.post_content ?? "",
      scrapedAt: toIso(r.scraped_at),
      queryUsed: r.query_used ?? "",
      total: r.total,
      relevance: r.relevance,
      fit: r.fit,
      urgency: r.urgency,
      engagementPotential: r.engagementPotential,
      positioning: r.positioning,
      reasoning: r.reasoning,
      commentAj: r.comment_aj,
      commentPk: r.comment_pk,
      connectionNoteAj: r.connection_note_aj,
      connectionNotePk: r.connection_note_pk,
      dmAj: r.dm_aj,
      dmPk: r.dm_pk,
    }));
  }
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  // db.execute returns timestamps as ISO strings already.
  return new Date(value).toISOString();
}

function serializeReasons(reasons: Record<string, number>): string | null {
  const keys = Object.keys(reasons);
  if (keys.length === 0) return null;
  return keys
    .sort()
    .map((k) => `${k}=${reasons[k]}`)
    .join("; ");
}

// Suppress unused-import elimination for indexes we may need later.
void inArray;
void desc;

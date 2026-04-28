/**
 * MIRROR of platform/db/schema.ts.
 *
 * The platform repo owns the canonical schema. We copy it here (rather than
 * cross-import) because each repo installs its own drizzle-orm and the
 * Drizzle column types don't unify across separate installs — the tsc
 * errors are unavoidable otherwise.
 *
 * MUST stay in sync with platform/db/schema.ts. When that file changes,
 * copy it back over and run `bun x tsc --noEmit` here to verify.
 *
 * Drift detection: the migration-run sanity check compares the platform
 * file's hash against this one (planned for Phase 7's CI).
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", ["staff", "founder", "editor"]);

export const postSource = pgEnum("post_source", [
  "linkedin_jobs",
  "linkedin_kol",
  "x_intent",
  "reddit",
  "hn",
  "upwork",
  "legacy_finder",
]);

export const actionType = pgEnum("action_type", [
  "comment",
  "connect",
  "dm",
  "email",
  "flag",
  "issue",
]);

export const draftStatus = pgEnum("draft_status", [
  "pending",
  "assigned",
  "completed",
  "flagged",
]);

export const actionStatus = pgEnum("action_status", [
  "pending",
  "completed",
  "failed",
]);

export const batchStatus = pgEnum("batch_status", [
  "active",
  "completed",
  "archived",
]);

export const assignmentStatus = pgEnum("assignment_status", [
  "pending",
  "completed",
  "flagged",
  "replaced",
]);

export const emailSendStatus = pgEnum("email_send_status", [
  "pending",
  "sent",
  "failed",
]);

export const apifyRunStatus = pgEnum("apify_run_status", [
  "running",
  "completed",
  "failed",
]);

// ---------------------------------------------------------------------------
// Core: users + auth
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull(),
  name: text("name").notNull(),
  calendlyUrl: text("calendly_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userGoogleTokens = pgTable("user_google_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const oauthNonces = pgTable("oauth_nonces", {
  nonce: text("nonce").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  state: text("state"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Posts + scoring
// ---------------------------------------------------------------------------

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull().unique(),
    authorName: text("author_name"),
    authorHeadline: text("author_headline"),
    authorUrl: text("author_url"),
    content: text("content"),
    engagementCount: integer("engagement_count").notNull().default(0),
    scrapedAt: timestamp("scraped_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    queryUsed: text("query_used"),
    source: postSource("source").notNull(),
  },
  (t) => ({
    scrapedAtIdx: index("posts_scraped_at_idx").on(t.scrapedAt.desc()),
    sourceIdx: index("posts_source_idx").on(t.source),
  }),
);

export const scores = pgTable("scores", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  relevance: integer("relevance"),
  fit: integer("fit"),
  urgency: integer("urgency"),
  engagementPotential: integer("engagement_potential"),
  total: integer("total"),
  positioning: text("positioning"),
  reasoning: text("reasoning"),
  scoredAt: timestamp("scored_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Engagement: per-user drafts + actions (replaces dual-persona lead_content)
// ---------------------------------------------------------------------------

export const engagementDrafts = pgTable(
  "engagement_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    comment: text("comment"),
    connectionNote: text("connection_note"),
    dm: text("dm"),
    email: text("email"),
    emailSubject: text("email_subject"),
    followUpDm: text("follow_up_dm"),
    followUpEmail: text("follow_up_email"),
    followUpEmailSubject: text("follow_up_email_subject"),
    status: draftStatus("status").notNull().default("pending"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    postUserUnique: uniqueIndex("engagement_drafts_post_user_uniq").on(
      t.postId,
      t.userId,
    ),
    userStatusIdx: index("engagement_drafts_user_status_idx").on(
      t.userId,
      t.status,
    ),
  }),
);

export const engagementActions = pgTable(
  "engagement_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => engagementDrafts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    actionType: actionType("action_type").notNull(),
    status: actionStatus("status").notNull().default("pending"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    replacedByPostId: uuid("replaced_by_post_id").references(() => posts.id),
    errorMessage: text("error_message"),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    draftActionIdx: index("engagement_actions_draft_action_idx").on(
      t.draftId,
      t.actionType,
    ),
    userIdx: index("engagement_actions_user_idx").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Assets (per-user file storage)
// ---------------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    filename: text("filename").notNull(),
    storedPath: text("stored_path").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    description: text("description"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userCategoryIdx: index("assets_user_category_idx").on(
      t.userId,
      t.category,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Daily batches
// ---------------------------------------------------------------------------

export const leadBatches = pgTable("lead_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  totalAssigned: integer("total_assigned").notNull().default(0),
  totalCompleted: integer("total_completed").notNull().default(0),
  totalFlagged: integer("total_flagged").notNull().default(0),
  totalReplaced: integer("total_replaced").notNull().default(0),
  status: batchStatus("status").notNull().default("active"),
});

export const batchAssignments = pgTable(
  "batch_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => leadBatches.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
    assignmentOrder: integer("assignment_order"),
    dayNumber: integer("day_number"),
    status: assignmentStatus("status").notNull().default("pending"),
    replacedByPostId: uuid("replaced_by_post_id").references(() => posts.id),
    contentGeneratedAt: timestamp("content_generated_at", {
      withTimezone: true,
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
  },
  (t) => ({
    batchPostUnique: uniqueIndex("batch_assignments_batch_post_uniq").on(
      t.batchId,
      t.postId,
    ),
  }),
);

export const batchActionLog = pgTable("batch_action_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => leadBatches.id, { onDelete: "cascade" }),
  postId: uuid("post_id").references(() => posts.id),
  userId: uuid("user_id").references(() => users.id),
  action: text("action").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Scrape analytics + prompts + email sends
// ---------------------------------------------------------------------------

export const scrapeRunQueries = pgTable("scrape_run_queries", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  query: text("query").notNull(),
  queryGroup: text("query_group"),
  tier: text("tier"),
  maxResults: integer("max_results"),
  fetched: integer("fetched").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  rejectedDate: integer("rejected_date").notNull().default(0),
  rejectedDedupContent: integer("rejected_dedup_content").notNull().default(0),
  rejectedDedupDb: integer("rejected_dedup_db").notNull().default(0),
  rejectedGeo: integer("rejected_geo").notNull().default(0),
  rejectedGeoReason: text("rejected_geo_reason"),
  rejectedIntent: integer("rejected_intent").notNull().default(0),
  rejectedIntentReason: text("rejected_intent_reason"),
  rejectedNormalize: integer("rejected_normalize").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const contentPrompts = pgTable("content_prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  promptName: text("prompt_name").notNull().unique(),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const emailSends = pgTable("email_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("post_id").references(() => posts.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  draftId: uuid("draft_id").references(() => engagementDrafts.id),
  recipient: text("recipient").notNull(),
  subject: text("subject"),
  body: text("body"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  status: emailSendStatus("status").notNull().default("pending"),
});

// ---------------------------------------------------------------------------
// Cross-cutting: Apify spend, rate limits, platform events
// ---------------------------------------------------------------------------

export const apifyRuns = pgTable("apify_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: text("run_id").notNull(),
  actor: text("actor").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 4 }),
  status: apifyRunStatus("status").notNull().default("running"),
});

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountHandle: text("account_handle"),
    platform: text("platform").notNull(),
    currentCount: integer("current_count").notNull().default(0),
    dailyCap: integer("daily_cap"),
    lastResetAt: timestamp("last_reset_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userPlatformIdx: index("rate_limits_user_platform_idx").on(
      t.userId,
      t.platform,
    ),
  }),
);

export const platformEvents = pgTable(
  "platform_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    workflow: text("workflow"),
    userOwner: uuid("user_owner").references(() => users.id),
    actor: text("actor"),
    payload: jsonb("payload"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventTypeIdx: index("platform_events_event_type_idx").on(t.eventType),
    occurredAtIdx: index("platform_events_occurred_at_idx").on(
      t.occurredAt.desc(),
    ),
    userOwnerIdx: index("platform_events_user_owner_idx").on(
      t.userOwner,
      t.occurredAt.desc(),
    ),
  }),
);


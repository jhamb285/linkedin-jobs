// ── Apify Scraped Post ──

export interface ScrapedPost {
  id: string;
  url: string;
  /** LinkedIn's stable internal post ID (Apify `id` field). Optional —
   *  not every actor exposes it; harvestapi always does. */
  linkedinPostId?: string | null;
  authorName: string;
  authorHeadline: string;
  authorUrl: string;
  content: string;
  /** Total likes + comments + shares — preserved for back-compat. */
  engagementCount: number;
  /** Per-channel breakdowns when the actor exposes them. Null for actors
   *  that only return a rolled-up count. */
  engagementLikes?: number | null;
  engagementComments?: number | null;
  engagementShares?: number | null;
  scrapedAt: string;
  queryUsed: string;
  /** One-off 3-way sourcing test tag (scripts/test-3way.ts). Always
   *  undefined for production scrapes. */
  testRunId?: string | null;
}

// ── AI Scoring ──

export type Positioning = "agent_dev" | "consulting" | "automation_agency";

export interface PostScore {
  postId: string;
  relevance: number;
  fit: number;
  urgency: number;
  engagementPotential: number;
  total: number;
  positioning: Positioning;
  reasoning: string;
  scoredAt: string;
}

export interface ScoringResult {
  relevance: number;
  fit: number;
  urgency: number;
  engagementPotential: number;
  positioning: Positioning;
  reasoning: string;
}

// ── Comment Queue ──

export type CommentStatus =
  | "pending"
  | "approved"
  | "posted"
  | "rejected"
  | "failed";

export interface QueuedComment {
  id: number;
  postId: string;
  commentText: string;
  status: CommentStatus;
  generatedAt: string;
  reviewedAt: string | null;
  postedAt: string | null;
  bereachResponse: string | null;
}

// ── DM Queue ──

export type ConnectionStatus = "pending" | "connected" | "rejected";
export type DmStatus = "pending" | "approved" | "sent" | "rejected" | "failed";

export interface QueuedDm {
  id: number;
  postId: string;
  authorUrl: string;
  connectionStatus: ConnectionStatus;
  dmText: string;
  status: DmStatus;
  createdAt: string;
  sentAt: string | null;
}

// ── Activity Log ──

export type ActionType = "comment" | "connection" | "dm";

export interface ActivityEntry {
  id: number;
  action: ActionType;
  targetUrl: string;
  performedAt: string;
}

// ── Config ──

export interface SearchQuery {
  group: string;
  query: string;
  maxResults?: number;
  tier?: 1 | 2 | 3;
  note?: string;
  /** "keyword" (default) = call linkedin-post-search with `query`.
   *  "profile-watch" = ignore `query`, call linkedin-profile-posts with
   *  rotating product-founder profile URLs from getFreshFoundersForWatch. */
  mode?: "keyword" | "profile-watch";
}

export interface AppConfig {
  apifyToken: string;
  apifyActorId: string;
  geminiApiKey: string;
  geminiModel: string;
  googleCredentialsPath: string;
  googleTokenPath: string;
  spreadsheetId: string;
  dbPath: string;
  scoringThreshold: number;
  maxCommentsPerDay: number;
  maxConnectionsPerDay: number;
  maxDmsPerDay: number;
  dailyScrapeCap: number;
  apifyCostPerLead: number;
}

// ── CLI ──

export type Command =
  | "scrape"
  | "score"
  | "generate"
  | "review"
  | "leads"
  | "export"
  | "connect"
  | "dm"
  | "status"
  | "dry-run"
  | "enrich-truncated";

// ── Pipeline Status ──

export interface PipelineStats {
  totalPosts: number;
  scoredPosts: number;
  highScorePosts: number;
  pendingComments: number;
  approvedComments: number;
  postedComments: number;
  rejectedComments: number;
  pendingDms: number;
  sentDms: number;
  todayComments: number;
  todayConnections: number;
  todayDms: number;
}

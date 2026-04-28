# LinkedIn Lead-Scrape & Reply

Automated pipeline that finds LinkedIn posts from people looking for AI engineers, scores them with AI, generates personalized comments, and exports to Google Sheets for PhantomBuster to execute.

## Pipeline

```
Scrape (Apify) → Score (Gemini Flash) → Generate Comments (Gemini) → Review (CLI) → Export (Google Sheets) → PhantomBuster
```

## First Time Setup

### 1. User Profile

Before running, fill in `config/user-profile.json` with your info. The AI uses this to personalize comments, DMs, and scoring. Each team member should have their own profile.

```json
{
  "name": "Your Name",
  "title": "AI Engineer / Consultant",
  "location": "Where you're based",
  "background": "Brief background (education, work history, global experience)",
  "services": ["agentic AI", "RAG pipelines", "AI consulting", "automation"],
  "valuePitch": "Your unique value prop (e.g. competitive rates, timezone flexibility, niche expertise)",
  "targetRoles": ["freelance", "contract", "consulting", "remote"],
  "dealbreakers": ["on-site only", "full-time permanent only"],
  "timezone": "Your timezone or 'flexible'"
}
```

The prompts in `config/` reference this profile. Update `lead-prompt.md`, `scoring-prompt.md` etc. to match your profile before first run.

### 2. API Keys

```bash
bun install
cp config/.env.example .env
```

Fill in `.env`:
1. **Apify token** -- https://console.apify.com/account/integrations
2. **Gemini API key** -- https://aistudio.google.com/apikey
3. **Google Sheet ID** -- create a sheet with tabs: `Leads`, `Comments`, `Connections`, `DMs`

### 3. Search Queries

Edit `config/search-queries.json` to match your target roles. Each query uses LinkedIn exact match (quoted keywords). Test queries in Apify console before adding.

### 4. PhantomBuster (optional, for automation)

1. **Auto Commenter** -- reads from `Comments` tab (columns: postUrl, comment)
2. **Network Booster** -- reads from `Connections` tab (columns: profileUrl, message)
3. **Message Sender** -- reads from `DMs` tab (columns: profileUrl, message)

Without PhantomBuster, use the Google Sheet as a manual dashboard. Click post URL, paste comment, click profile, send connection.

## Usage

```bash
# 1. Scrape LinkedIn posts (keyword queries, date + location + intent filtered)
bun run scrape

# 2. AI-score posts for relevance, fit, urgency (Gemini Flash)
bun run score

# 3. Generate comments, connection notes, DMs for high-scoring posts
bun run generate

# 4. Review queued comments -- approve/edit/reject
bun run review

# 5. Export all leads to Google Sheets (green=approved, red=rejected)
bun run leads

# 6. Export approved comments to Google Sheets
bun run export

# 7. Export connection requests to Google Sheets
bun run connect

# 8. Generate + export DMs to Google Sheets (12h+ after connection)
bun run dm

# Dashboard
bun run status

# Full pipeline without exporting (test mode)
bun run dry-run

# Daily orchestrator: scrape → score → batch → generate
bun run daily            # full run
bun run daily --dry-run  # scrape+score only
bun run daily --skip-scrape  # iterate downstream only

# Tests
bun test
```

## Cron schedule (live)

The `daily` orchestrator runs **once a day at 10:00 IST (04:30 UTC)** on
mediaos — a few hours after the EU/US workday so fresh posts have
accumulated, and before AJ/PK start engaging with the queue.

Active crontab line (Phase 9 deploy):

```cron
30 4 * * *  cd /opt/automations/inbound/linkedin-jobs && /usr/local/bin/bun run daily >> /var/log/linkedin-jobs/daily.log 2>&1
```

Manual invocation locally:

```bash
cd inbound/linkedin-jobs
bun run daily
```

## TODO — deferred items

These were deliberately scoped out of Phase 9 and are queued as
follow-ups. Tackle in any order.

### Pipeline / scrape logic

- [ ] **Better rejection feedback loop** — current per-query counters in
  `scrape_run_queries` get aggregated in the analytics page, but there's
  no automatic "retire query if it's been yielding 0 inserts × N runs"
  signal. Add a low-yield detector + alert.
- [ ] **Author dedup window tuning** — `wasAuthorRecentlyScraped` uses 7d.
  Verify against the migrated dataset whether 7d / 14d / 30d gives
  better signal-to-noise for repeat-poster filtering.
- [ ] **Hybrid filter expansion** — `analyzeRemoteDays` only fires on
  `remoteDays >= 3`. Add detectors for "fully remote", "100% remote",
  "no office", and "USD pay range present" as positive boosters; add
  "must be in <city>" / "EST hours required" as soft rejections.
- [ ] **Apify actor failover** — currently hard-bound to
  `harvestapi/linkedin-post-search`. If harvestapi is down, the daily
  run silently produces zero leads. Add a fallback actor + alert when
  primary returns < N items for an established query.
- [ ] **Per-query cost model** — track cost-per-inserted-lead per query
  (we have fetched + inserted but no cost per query). Surface a "kill
  this query" recommendation in the analytics page when CPL crosses a
  threshold.
- [ ] **Scoring stage failure handling** — when Gemini returns 429 (e.g.
  monthly cap hit), the matcher loop swallows per-post errors and
  reports the stage as `ok=true` with zero scored. Make the loop throw
  if `scored == 0 && errors > 0` so the orchestrator's stage tracking
  reflects reality.
- [ ] **Score caching** — re-score identical posts (same content fingerprint)
  by reusing the prior score rather than calling Gemini twice.

### Content gen

- [ ] **Recipient-email parsing** at content-gen time — the platform's
  `db/backfill-recipient-email.ts` parses email-shaped strings out of
  `posts.content`. Move that logic into `commenter.ts` so new drafts
  get `recipient_email` populated at insert, not via backfill.
- [ ] **Email subject + body separation** — current generator returns a
  combined string for some legacy rows. Verify the new format
  (`{ "emailSubject": ..., "email": ... }`) ships every time.
- [ ] **Per-persona prompt tuning** — `lead-prompt.md` is one prompt for
  both AJ + PK. Split into `lead-prompt-aj.md` + `lead-prompt-pk.md` so
  each persona has its own voice.

### Outbound (depends on platform)

- [ ] **Gmail OAuth provisioning** — Phase 8.5 ported the email-send
  route to Postgres but `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
  are not yet set on the prod env. Until they're wired, `/api/leads/[postId]/email/send`
  returns 503. Also need to add a "Connect Gmail" + "Send" UI in
  `/staff/today` (the legacy UI's button is gone, ported route has no
  UI caller in the new shell yet).
- [ ] **PhantomBuster reactivation** — comment / connect / DM auto-poster
  paths were stubbed in Phase 6. If we revive PhantomBuster, restore
  `outreach.ts` + `scheduler.ts` to read from `engagement_drafts` and
  write `engagement_actions` on completion.

### Deploy / infra (platform repo)

- [ ] **DNS A record** for `automations.kronus.tech` → `91.99.102.124`.
  Until then the platform is reachable on the server IP only. Add the
  record on the DNS provider, wait for propagation.
- [ ] **Let's Encrypt cert** — once DNS resolves, run
  `certbot --nginx -d automations.kronus.tech` on mediaos. The nginx
  vhost already has the ACME challenge dir prepared.
- [ ] **Srikant flip (Phase 9.5)** — migrate his current state ~1h
  before cutover, flip his bookmark, retire the old
  `/usr/local/bin/lead-pipeline-daily.sh` cron.
- [ ] **Sheets export validation** — `getLeadsForExport()` was ported in
  Phase 6 but never validated end-to-end against a real Google Sheet.
  Needs `GOOGLE_CREDENTIALS_PATH` provisioned + an export run.

## Filtering Pipeline

Posts go through 4 filters:

1. **Apify date filter** -- `postedLimit: "24h"` at API level, only fresh posts returned
2. **Location** -- configurable target/excluded regions in scraper.ts
3. **Intent** -- rejects promo/content posts, keeps seeking-signal posts
4. **AI scoring** -- 4 dimensions (relevance, fit, urgency, engagement), threshold 25/40, fit must be > 0

## Leads Sheet Columns

| Column | What |
|--------|------|
| Status | APPROVED / REJECTED - Bad Fit / REJECTED - Low Score |
| Author | Person's name |
| Headline | Job title/company |
| Profile URL | Click to connect |
| Post URL | Click to comment |
| What They Need | AI-generated summary |
| Score | 0-40 total |
| R, F, U, E | Individual dimension scores |
| Positioning | agent_dev / consulting / automation_agency |
| Why This Score | AI reasoning |
| Our Comment | Generated comment to paste |
| Connection Note | Generated connection message |
| DM Message | Generated follow-up DM |
| Query Used | Which search query found this |

Green rows = approved. Red rows = rejected with reason.

## Stack

- **Runtime:** Bun (TypeScript)
- **Scraping:** Apify (`apimaestro/linkedin-posts-search-scraper-no-cookies`)
- **AI:** Google Gemini 2.5 Flash (scoring + comment/DM generation)
- **Export:** Google Sheets API (direct write, color-coded)
- **Execution:** PhantomBuster or manual via Google Sheet
- **Storage:** Postgres via Drizzle (shared with the platform — schema in `platform/db/schema.ts`, mirrored here in `src/schema.ts`)

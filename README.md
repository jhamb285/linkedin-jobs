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

# Tests
bun test
```

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
- **Storage:** SQLite via `bun:sqlite`

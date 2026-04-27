# Flow: LinkedIn Lead-Scrape & Reply

## Pipeline

```
                    ┌──────────────────┐
                    │   CRON (daily)    │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   1. SCRAPE       │
                    │   Apify API       │
                    │   35 queries      │
                    │   3-layer filter  │
                    └────────┬─────────┘
                             │ posts → SQLite
                    ┌────────▼─────────┐
                    │   2. SCORE        │
                    │   Gemini Flash    │
                    │   4 dimensions    │
                    │   0-40 total      │
                    └────────┬─────────┘
                             │ score >= 25?
                     ┌───────┴───────┐
                     │ YES           │ NO
              ┌──────▼──────┐    [discard]
              │  3. GENERATE │
              │  Gemini Flash│
              │  comment text │
              └──────┬──────┘
                     │ queued as 'pending'
              ┌──────▼──────┐
              │  4. REVIEW   │
              │  Human CLI   │
              │  approve/    │
              │  edit/reject │
              └──────┬──────┘
                     │ approved?
              ┌──────┴──────┐
              │ YES         │ NO
       ┌──────▼──────┐   [rejected]
       │  5. EXPORT   │
       │  → Sheets    │───→ PhantomBuster Auto Commenter
       │  "Comments"  │
       └──────┬──────┘
              │ immediate
       ┌──────▼──────┐
       │  6. CONNECT  │
       │  → Sheets    │───→ PhantomBuster Network Booster
       │  "Connections"│
       └──────┬──────┘
              │ wait 12h
       ┌──────▼──────┐
       │  7. DM       │
       │  Gemini gen  │
       │  → Sheets    │───→ PhantomBuster Message Sender
       │  "DMs"       │
       └─────────────┘
```

## Scoring Dimensions

| Dimension | Range | Signal |
|-----------|-------|--------|
| Relevance | 0-10 | Looking for AI/agentic help? |
| Fit | 0-10 | Freelance/contract/consultant/remote? |
| Urgency | 0-10 | Timeline/budget mentioned? |
| Engagement | 0-10 | Can we add value with a comment? |

**Threshold:** 25/40 to proceed

## Scrape Filters

| Layer | What | Drops |
|-------|------|-------|
| Date | Last 48h only | Old posts |
| Location | US, EU, AU, SG, CA | India, Pakistan, etc. |
| Intent | Seeking signals vs promo | Product promos, articles, threads |

## PhantomBuster Slots

| Slot | Automation | Input Sheet | Columns |
|------|-----------|-------------|---------|
| 1 | Auto Commenter | Comments | postUrl, comment |
| 2 | Network Booster | Connections | profileUrl, message |
| 3 | Message Sender | DMs | profileUrl, message |

## Error Handling

- **Apify error:** Log and skip query, continue with remaining
- **Gemini error:** Log and skip post, continue scoring
- **Sheets error:** Fall back to local CSV export
- **PhantomBuster:** Handles its own rate limits and safety

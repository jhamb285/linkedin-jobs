# Architecture — LinkedIn Jobs Post Monitor

This repo is one workflow in the par1k automations system. The full cross-cutting architecture (folder structure, data model, role gating, sharing rules) lives in:

  https://github.com/pipelines-ajpa/pipelines/blob/main/SETUP.md

Read that before making structural changes here.

Team workflow (branch flow, PR conventions, CODEOWNERS):

  https://github.com/pipelines-ajpa/pipelines/blob/main/COLLABORATION.md

## What this repo specifically owns

**Category:** `inbound`
**Status:** `code-extracted`

Monitors LinkedIn job posts for AI/automation roles + drafts outreach. Bun CLI scraper extracted from old lead-pipeline.

## Where it plugs in

When built, this workflow will:

- **Read from:** [shared Postgres tables / external scrapes / Google Sheets — fill in when built]
- **Write to:** [shared `leads` / `kol_profiles` / `companies` tables, or workflow-specific staging tables]
- **Be called by:** [cron schedule / queue dispatcher / inbound webhook]

The `data layer is the contract` — this workflow does NOT import code from sibling workflow modules. Coordination happens through shared Postgres tables or HTTP webhooks.

## Architectural rules that apply here

Inherited from [`SETUP.md`](https://github.com/pipelines-ajpa/pipelines/blob/main/SETUP.md):

- **`user_owner` on every record** — multi-tenant scoping at the data layer.
- **No cross-workflow imports** — Postgres + HTTP only.
- **Apify per-workflow** for v1 — own your own scraper integration.
- **Slack = lead-handoff notifier**, not per-action approval.
- **Manual curation → Google Sheets → Postgres sync** for any reference data this workflow consumes (KOL DB, saved searches, ICPs, etc.).
- **Role-gating in platform/web/** — UIs respect `users.role` (`staff` / `founder` / `editor`).
- **No "Phavella"** in any client-facing string.

## What this repo is NOT

- It is NOT a complete product on its own — it integrates into the broader `pipelines-ajpa` system.
- It does NOT directly modify the running production lead-pipeline tool at `~/Desktop/par1k/lead-magnet/`.
- It does NOT own UI rendering — that lives in `pipelines-ajpa/platform/web/`.
- It does NOT own analytics — that lives in `pipelines-ajpa/knowledge/`.

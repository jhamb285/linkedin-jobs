import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Store } from "./store";
import type { AppConfig } from "./types";
import { loadPrompt } from "./config";

const EXPORT_DIR = join(import.meta.dir, "..", "data", "exports");

function ensureExportDir(): void {
  if (!existsSync(EXPORT_DIR)) {
    mkdirSync(EXPORT_DIR, { recursive: true });
  }
}

function toCsv(headers: string[], rows: string[][]): string {
  const escape = (val: string) => `"${val.replace(/"/g, '""')}"`;
  const headerLine = headers.map(escape).join(",");
  const dataLines = rows.map((row) => row.map(escape).join(","));
  return [headerLine, ...dataLines].join("\n");
}

async function getSheets(config: AppConfig) {
  const content = readFileSync(config.googleCredentialsPath, "utf-8");
  const credentials = JSON.parse(content);

  let tokenData: Record<string, unknown> = {};
  try {
    tokenData = JSON.parse(readFileSync(config.googleTokenPath, "utf-8"));
  } catch {}

  const { client_id, client_secret } = credentials.installed || credentials.web || {};
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, "http://localhost");

  if (tokenData.access_token) {
    oauth2.setCredentials(tokenData as Record<string, string>);
  }

  return google.sheets({ version: "v4", auth: oauth2 });
}

async function writeToSheet(
  config: AppConfig,
  sheetName: string,
  headers: string[],
  rows: string[][]
): Promise<{ ok: boolean; startRow?: number }> {
  if (!config.spreadsheetId) {
    console.log("  [sheets] No SPREADSHEET_ID set — skipping Google Sheets export");
    return { ok: false };
  }

  try {
    const sheets = await getSheets(config);

    // Check if sheet has existing content
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `${sheetName}!A:A`,
    });
    const existingRows = existing.data.values?.length || 0;

    let startRow: number;
    let valuesToWrite: string[][];

    if (existingRows === 0) {
      // Empty sheet: write headers + rows
      startRow = 1;
      valuesToWrite = [headers, ...rows];
    } else {
      // Append with 2-row gap after existing data
      startRow = existingRows + 3; // +1 for next row, +2 for gap
      valuesToWrite = rows;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `${sheetName}!A${startRow}`,
      valueInputOption: "RAW",
      requestBody: { values: valuesToWrite },
    });

    console.log(
      `  [sheets] Appended ${rows.length} rows to "${sheetName}" tab (starting row ${startRow})`
    );
    return { ok: true, startRow };
  } catch (err) {
    console.log(`  [sheets] Error: ${(err as Error).message}`);
    return { ok: false };
  }
}

/**
 * Export leads to two tabs:
 * - "Leads" — clean dashboard of APPROVED leads only (action-ready)
 * - "Rejected" — rejected leads with reason + scores (audit trail)
 */
export async function exportLeads(store: Store, config: AppConfig): Promise<void> {
  ensureExportDir();

  // FULL_EXPORT toggle is preserved as a CLI affordance even though the new
  // schema doesn't track an `exported_at` column — Phase 6 always re-exports
  // the full lead set. The flag is a no-op for now; Phase 7+ can add an
  // exports audit table if append-only behaviour becomes useful again.
  const fullExport = process.env.FULL_EXPORT === "1";
  void fullExport;

  const allLeadsRaw = await store.getLeadsForExport({ fullExport });

  if (allLeadsRaw.length === 0) {
    console.log("No leads to export.");
    return;
  }

  // Re-shape into the legacy Record<string, unknown> rows the rest of the
  // function consumes, so the Sheets layout stays byte-identical to the
  // SQLite-era export.
  const allLeads = allLeadsRaw.map((r) => ({
    post_id: r.postId,
    author_name: r.authorName,
    author_headline: r.authorHeadline,
    author_url: r.authorUrl,
    post_url: r.url,
    post_content: r.postContent,
    scraped_at: r.scrapedAt,
    query_used: r.queryUsed,
    total: r.total,
    relevance: r.relevance,
    fit: r.fit,
    urgency: r.urgency,
    engagement_potential: r.engagementPotential,
    positioning: r.positioning,
    reasoning: r.reasoning,
    comment_status: r.commentPk || r.commentAj ? "queued" : "pending",
    summary: r.postContent,
    comment: r.commentPk,
    connection_note: r.connectionNotePk,
    dm: r.dmPk,
    comment_aj: r.commentAj,
    comment_pk: r.commentPk,
    connection_note_aj: r.connectionNoteAj,
    connection_note_pk: r.connectionNotePk,
    dm_aj: r.dmAj,
    dm_pk: r.dmPk,
  }));

  const approvedLeads = allLeads.filter(
    (l) => ((l.fit as number) || 0) > 0 && ((l.total as number) || 0) >= config.scoringThreshold
  );
  const rejectedLeads = allLeads.filter(
    (l) => ((l.fit as number) || 0) === 0 || ((l.total as number) || 0) < config.scoringThreshold
  );

  // ── Leads Tab — Clean approved view with dual personas ──
  const leadsHeaders = [
    "Status", "Author", "Headline", "Profile URL", "Post URL",
    "Post Content",
    "Comment AJ", "Comment PK",
    "Connect AJ", "Connect PK",
    "DM AJ", "DM PK",
    "Score", "Positioning", "Query Used", "Date",
  ];

  // Contact info appended to comments — update here if contact info changes
  const AJ_CONTACT = "\n\nCall: https://calendly.com/jhamb285/30min\nEmail: Jhamb285@gmail.com";
  const PK_CONTACT = "\n\nCall: https://calendly.com/parikahlawat/free-consultation\nEmail: pa.parikahlawat@gmail.com";

  const leadsRows = approvedLeads.map((l) => {
    const commentStatus = (l.comment_status as string) || "";
    let status = "APPROVED";
    if (commentStatus === "posted") status = "Commented";
    else if (commentStatus === "approved") status = "Ready";
    else if (commentStatus === "pending") status = "Pending Review";

    // Use persona columns if available, fallback to legacy comment/dm for old leads
    const commentAjRaw = (l.comment_aj as string) || "";
    const commentPkRaw = (l.comment_pk as string) || (l.comment as string) || "";
    const connectionAj = (l.connection_note_aj as string) || "";
    const connectionPk = (l.connection_note_pk as string) || (l.connection_note as string) || "";
    const dmAj = (l.dm_aj as string) || "";
    const dmPk = (l.dm_pk as string) || (l.dm as string) || "";

    // Append contact info to comments (only if comment exists)
    const commentAj = commentAjRaw ? commentAjRaw + AJ_CONTACT : "";
    const commentPk = commentPkRaw ? commentPkRaw + PK_CONTACT : "";

    // Use raw post content if available, fallback to summary
    const postContent = ((l.post_content as string) || (l.summary as string) || "").slice(0, 2000);

    return [
      status,
      (l.author_name as string) || "",
      (l.author_headline as string) || "",
      (l.author_url as string) || "",
      (l.post_url as string) || "",
      postContent,
      commentAj,
      commentPk,
      connectionAj,
      connectionPk,
      dmAj,
      dmPk,
      String(l.total || 0),
      (l.positioning as string) || "",
      (l.query_used as string) || "",
      (l.scraped_at as string) || "",
    ];
  });

  // ── Rejected Tab — Full audit trail ──
  const rejectedHeaders = [
    "Reason", "Author", "Headline", "Profile URL", "Post URL",
    "Score", "R", "F", "U", "E",
    "Positioning", "Why This Score",
    "Query Used", "Date",
  ];

  const rejectedRows = rejectedLeads.map((l) => {
    const fit = (l.fit as number) || 0;
    const total = (l.total as number) || 0;
    const reason = fit === 0 ? "Bad Fit" : "Low Score";

    return [
      reason,
      (l.author_name as string) || "",
      (l.author_headline as string) || "",
      (l.author_url as string) || "",
      (l.post_url as string) || "",
      String(total),
      String(l.relevance || 0),
      String(fit),
      String(l.urgency || 0),
      String(l.engagement_potential || 0),
      (l.positioning as string) || "",
      (l.reasoning as string) || "",
      (l.query_used as string) || "",
      (l.scraped_at as string) || "",
    ];
  });

  // Write both tabs
  let leadsWritten: { ok: boolean; startRow?: number } = { ok: false };
  if (leadsRows.length > 0) {
    leadsWritten = await writeToSheet(config, "Leads", leadsHeaders, leadsRows);
    if (leadsWritten.ok && leadsWritten.startRow !== undefined) {
      const dataStart = leadsWritten.startRow + (leadsWritten.startRow === 1 ? 1 : 0);
      await colorCodeRange(
        config,
        "Leads",
        dataStart,
        dataStart + leadsRows.length - 1,
        leadsHeaders.length,
        "green"
      );
    }
  }

  let rejectedWritten: { ok: boolean; startRow?: number } = { ok: false };
  if (rejectedRows.length > 0) {
    rejectedWritten = await writeToSheet(config, "Rejected", rejectedHeaders, rejectedRows);
    if (rejectedWritten.ok && rejectedWritten.startRow !== undefined) {
      const dataStart = rejectedWritten.startRow + (rejectedWritten.startRow === 1 ? 1 : 0);
      await colorCodeRange(
        config,
        "Rejected",
        dataStart,
        dataStart + rejectedRows.length - 1,
        rejectedHeaders.length,
        "red"
      );
    }
  }

  // (No exported_at column in the new schema — full re-export every run.)

  // Local CSV backups (always append mode)
  writeFileSync(join(EXPORT_DIR, "leads.csv"), toCsv(leadsHeaders, leadsRows));
  writeFileSync(join(EXPORT_DIR, "rejected.csv"), toCsv(rejectedHeaders, rejectedRows));

  console.log(`\nExported ${allLeads.length} ${fullExport ? "(full refresh)" : "new"}:`);
  console.log(`  Leads tab: ${leadsRows.length} approved`);
  console.log(`  Rejected tab: ${rejectedRows.length} rejected`);
  console.log(`  CSVs: data/exports/leads.csv, data/exports/rejected.csv`);
}

async function colorCodeRange(
  config: AppConfig,
  sheetName: string,
  startRow1Indexed: number,
  endRow1Indexed: number,
  columnCount: number,
  color: "green" | "red"
): Promise<void> {
  if (!config.spreadsheetId) return;

  try {
    const sheets = await getSheets(config);
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    const tab = spreadsheet.data.sheets?.find(
      (s) => s.properties?.title === sheetName
    );
    const sheetId = tab?.properties?.sheetId ?? 0;

    const bgColor =
      color === "green"
        ? { red: 0.85, green: 1, blue: 0.85 }
        : { red: 1, green: 0.85, blue: 0.85 };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: startRow1Indexed - 1,
                endRowIndex: endRow1Indexed,
                startColumnIndex: 0,
                endColumnIndex: columnCount,
              },
              cell: {
                userEnteredFormat: { backgroundColor: bgColor },
              },
              fields: "userEnteredFormat.backgroundColor",
            },
          },
        ],
      },
    });
    const count = endRow1Indexed - startRow1Indexed + 1;
    console.log(
      `  [sheets] Color-coded rows ${startRow1Indexed}-${endRow1Indexed} (${count} rows, ${color})`
    );
  } catch (err) {
    console.log(`  [sheets] Color coding failed: ${(err as Error).message}`);
  }
}

/**
 * Legacy PhantomBuster "Comments" tab export.
 *
 * The Comments / Connections / DMs tabs were the SQLite-era handoff to
 * PhantomBuster's Auto Commenter / Network Booster / Message Sender.
 * The new platform routes all of that through engagement_drafts +
 * the Today UI (manual send, no auto-poster) — see LEAD_MAGNET_AUDIT.md
 * decision #6. We keep these CLI commands as no-ops so existing scripts
 * that call `bun run export|connect|dm` don't crash; the canonical path
 * is now `bun run leads`.
 */
export async function exportComments(_store: Store, _config: AppConfig): Promise<string> {
  console.log(
    "exportComments is a no-op in the platform era — drafts live in engagement_drafts " +
      "and ship via the Today UI. Use `bun run leads` for the unified Sheets export.",
  );
  return "";
}

/**
 * Legacy PhantomBuster "Connections" tab export — no-op now. See
 * exportComments above.
 */
export async function exportConnections(_store: Store, _config: AppConfig): Promise<string> {
  console.log(
    "exportConnections is a no-op in the platform era — connection notes live " +
      "in engagement_drafts and ship via the Today UI.",
  );
  return "";
}

/**
 * Legacy PhantomBuster "DMs" tab export — no-op now. See exportComments above.
 */
export async function exportDms(_store: Store, _config: AppConfig): Promise<string> {
  console.log(
    "exportDms is a no-op in the platform era — DM drafts live in engagement_drafts " +
      "and ship via the Today UI.",
  );
  return "";
}

function buildConnectionNote(firstName: string, postContent: string, positioning: string): string {
  const topic = postContent.slice(0, 60).replace(/\n/g, " ").trim();
  switch (positioning) {
    case "agent_dev":
      return `Hi ${firstName} — saw your post about ${topic}... I build agentic AI systems, thought we should connect.`;
    case "automation_agency":
      return `Hi ${firstName} — your post on ${topic}... caught my eye. I work on AI automation — would love to connect.`;
    default:
      return `Hi ${firstName} — your post about ${topic}... resonated. I consult on AI architecture and strategy. Let's connect.`;
  }
}

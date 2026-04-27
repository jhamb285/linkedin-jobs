/**
 * Creates the Google Sheet for the lead pipeline.
 * Run once: bun run scripts/setup-sheet.ts
 *
 * Creates a sheet with 4 tabs:
 *   1. Leads     — all scored leads (post, author, score, status)
 *   2. Comments  — approved comments ready for posting (postUrl, comment)
 *   3. Connections — connection requests (profileUrl, message)
 *   4. DMs       — follow-up DMs (profileUrl, message)
 */

import { google } from "googleapis";
import { readFileSync } from "fs";

const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || "/Users/par1k/.config/google/credentials.json";
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || "/Users/par1k/.config/google/token.json";

async function main() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const tokenData = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));

  const { client_id, client_secret } = credentials.installed || credentials.web || {};
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, "http://localhost");
  oauth2.setCredentials(tokenData);

  const sheets = google.sheets({ version: "v4", auth: oauth2 });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  console.log("Creating Google Sheet: LinkedIn Lead Pipeline...\n");

  // Create the spreadsheet
  const spreadsheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: "LinkedIn Lead Pipeline",
      },
      sheets: [
        {
          properties: {
            title: "Leads",
            index: 0,
            gridProperties: { frozenRowCount: 1 },
          },
        },
        {
          properties: {
            title: "Comments",
            index: 1,
            gridProperties: { frozenRowCount: 1 },
          },
        },
        {
          properties: {
            title: "Connections",
            index: 2,
            gridProperties: { frozenRowCount: 1 },
          },
        },
        {
          properties: {
            title: "DMs",
            index: 3,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    },
  });

  const spreadsheetId = spreadsheet.data.spreadsheetId!;
  const url = spreadsheet.data.spreadsheetUrl!;

  // Add headers to each tab
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        {
          range: "Leads!A1:R1",
          values: [[
            "Status", "Author", "Headline", "Profile URL", "Post URL",
            "What They Need", "Score", "R", "F", "U", "E",
            "Positioning", "Why This Score",
            "Our Comment", "Connection Note", "DM Message",
            "Query Used", "Date",
          ]],
        },
        {
          range: "Comments!A1:D1",
          values: [["postUrl", "comment", "Author", "Status"]],
        },
        {
          range: "Connections!A1:D1",
          values: [["profileUrl", "message", "Author", "Status"]],
        },
        {
          range: "DMs!A1:D1",
          values: [["profileUrl", "message", "Author", "Status"]],
        },
      ],
    },
  });

  // Format headers bold
  const sheetIds = spreadsheet.data.sheets!.map((s) => s.properties!.sheetId!);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: sheetIds.map((sheetId) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
            },
          },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      })),
    },
  });

  console.log("Sheet created successfully!\n");
  console.log(`  ID:  ${spreadsheetId}`);
  console.log(`  URL: ${url}`);
  console.log(`\nAdd this to your .env:`);
  console.log(`  SPREADSHEET_ID=${spreadsheetId}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

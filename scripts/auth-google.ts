/**
 * Re-authenticate with Google OAuth for Sheets API.
 * Run: bun run scripts/auth-google.ts
 *
 * 1. Opens auth URL in browser
 * 2. You authorize and get redirected to localhost
 * 3. Paste the full redirect URL here
 * 4. Token saved to ~/.config/google/token.json
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";

const CREDENTIALS_PATH = "/Users/par1k/.config/google/credentials.json";
const TOKEN_PATH = "/Users/par1k/.config/google/token.json";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

async function main() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web || {};

  const redirectUri = redirect_uris?.[0] || "http://localhost";
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nAfter authorizing, you'll be redirected to a URL.");
  console.log("Copy the FULL redirect URL and paste it below.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const redirectUrl = await new Promise<string>((resolve) => {
    rl.question("Paste redirect URL: ", resolve);
  });
  rl.close();

  // Extract code from URL
  const url = new URL(redirectUrl);
  const code = url.searchParams.get("code");

  if (!code) {
    console.error("No authorization code found in URL. Make sure you pasted the full redirect URL.");
    process.exit(1);
  }

  const { tokens } = await oauth2.getToken(code);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.log("\nToken saved to", TOKEN_PATH);
  console.log("You can now run: bun run leads");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

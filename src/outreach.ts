import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "./types";
import type { Store } from "./store";
import { loadPrompt, randomDelay } from "./config";

/**
 * Step 1: Send connection requests immediately after comment is posted.
 * Called via `bun run connect`
 */
export async function runConnect(
  config: AppConfig,
  store: Store
): Promise<void> {
  const todayConnections = store.getTodayCount("connection");

  if (todayConnections >= config.maxConnectionsPerDay) {
    console.log(
      `Connection limit reached (${todayConnections}/${config.maxConnectionsPerDay}).`
    );
    return;
  }

  const ready = store.getReadyToConnect();
  if (ready.length === 0) {
    console.log("No leads ready for connection (need posted comments first).");
    return;
  }

  const remaining = config.maxConnectionsPerDay - todayConnections;
  const batch = ready.slice(0, remaining);

  console.log(`Sending ${batch.length} connection requests...\n`);

  for (const lead of batch) {
    try {
      // Short personalized connection note
      const note = buildConnectionNote(lead.postContent, lead.positioning);

      await sendConnectionViaBeReach(config.bereachToken, lead.authorUrl, note);

      // Create DM entry (will be sent 12h later)
      store.insertDm(lead.postId, lead.authorUrl, "");
      store.logActivity("connection", lead.authorUrl);

      console.log(`  [connected] ${lead.authorName} — "${note.slice(0, 50)}..."`);

      if (batch.indexOf(lead) < batch.length - 1) {
        const delay = randomDelay(
          config.commentDelayMinMs,
          config.commentDelayMaxMs
        );
        console.log(`  [wait] ${Math.round(delay / 60000)}m...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  [!] Error for ${lead.authorName}: ${msg}`);
      if (msg.includes("rate") || msg.includes("429")) {
        console.log("  [!] Rate limit. Stopping.");
        break;
      }
    }
  }

  console.log(
    `\nConnections done. ${store.getTodayCount("connection")}/${config.maxConnectionsPerDay} today.`
  );
}

/**
 * Step 2: Send DMs 12+ hours after connection request.
 * Called via `bun run dm`
 */
export async function runDm(
  config: AppConfig,
  store: Store
): Promise<void> {
  const todayDms = store.getTodayCount("dm");

  if (todayDms >= config.maxDmsPerDay) {
    console.log(`DM limit reached (${todayDms}/${config.maxDmsPerDay}).`);
    return;
  }

  const ready = store.getReadyDms();
  if (ready.length === 0) {
    console.log("No leads ready for DM (connections need 12+ hours).");
    return;
  }

  const remaining = config.maxDmsPerDay - todayDms;
  const batch = ready.slice(0, remaining);

  console.log(`Sending ${batch.length} DMs...\n`);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const template = loadPrompt("dm-prompt");

  for (const lead of batch) {
    try {
      const prompt = template
        .replace("{post_content_summary}", lead.postContent.slice(0, 200))
        .replace("{comment_summary}", lead.commentText.slice(0, 100))
        .replace("{their_need}", lead.postContent.slice(0, 150))
        .replace("{positioning}", "consulting");

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });

      const dmText =
        response.content[0].type === "text"
          ? response.content[0].text.trim()
          : "";

      if (!dmText) continue;

      await sendDmViaBeReach(config.bereachToken, lead.author_url, dmText);

      store.updateDmStatus(lead.id, "sent", { sentAt: new Date().toISOString() });
      store.logActivity("dm", lead.author_url);

      console.log(`  [sent] ${lead.author_url.split("/").pop()} — "${dmText.slice(0, 60)}..."`);

      if (batch.indexOf(lead) < batch.length - 1) {
        const delay = randomDelay(
          config.commentDelayMinMs,
          config.commentDelayMaxMs
        );
        console.log(`  [wait] ${Math.round(delay / 60000)}m...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  [!] Error for ${lead.author_url}: ${msg}`);
      store.updateDmStatus(lead.id, "failed");

      if (msg.includes("rate") || msg.includes("429")) {
        console.log("  [!] Rate limit. Stopping.");
        break;
      }
    }
  }

  console.log(`\nDMs done. ${store.getTodayCount("dm")}/${config.maxDmsPerDay} today.`);
}

// ── Helpers ──

function buildConnectionNote(postContent: string, positioning: string): string {
  // Short connection note — LinkedIn limits to 300 chars
  const topic = postContent.slice(0, 80).replace(/\n/g, " ");
  switch (positioning) {
    case "agent_dev":
      return `Saw your post about ${topic}... — I build agentic AI systems and thought we should connect.`;
    case "automation_agency":
      return `Your post on ${topic}... caught my eye — I work on AI automation and would love to connect.`;
    default:
      return `Your post about ${topic}... resonated — I consult on AI architecture and strategy. Let's connect.`;
  }
}

async function sendConnectionViaBeReach(
  token: string,
  profileUrl: string,
  message: string
): Promise<unknown> {
  const response = await fetch("https://api.bereach.ai/v1/linkedin/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profileUrl, message }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`BeReach API error ${response.status}: ${body}`);
  }

  return response.json();
}

async function sendDmViaBeReach(
  token: string,
  profileUrl: string,
  text: string
): Promise<unknown> {
  const response = await fetch("https://api.bereach.ai/v1/linkedin/message", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profileUrl, text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`BeReach API error ${response.status}: ${body}`);
  }

  return response.json();
}

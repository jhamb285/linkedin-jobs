/**
 * Expertise / RAG client.
 *
 * PK and AJ each maintain their own Expertise API at:
 *   - https://par1kahl.kronus.tech/rag  (PK)
 *   - https://arpit.kronus.tech/rag     (AJ)
 *
 * Both expose POST /match { text, limit } → ranked past projects with
 * matched automations, skills, tools, and talking points. We use those
 * matches as RAG grounding when generating outreach content for that
 * persona — keeps Gemini's claims tied to real work instead of
 * hallucinating past projects.
 *
 * Auth: X-API-Key header. The key is the same across both APIs today
 * (they were forked from the same Expertise repo). Stored in env as
 * EXPERTISE_API_KEY.
 *
 * If RAG is unreachable or returns zero matches, the caller should
 * still be able to fall back to a no-RAG prompt — the outage of one
 * persona's RAG must not block the other.
 */

export type Persona = "aj" | "pk";

const DEFAULT_URLS: Record<Persona, string> = {
  pk: "https://par1kahl.kronus.tech/rag",
  aj: "https://arpit.kronus.tech/rag",
};

const DEFAULT_TIMEOUT_MS = 5_000;

function getTimeoutMs(): number {
  const raw = parseInt(process.env.RAG_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function getBaseUrl(persona: Persona): string {
  if (persona === "pk") {
    return process.env.EXPERTISE_API_PK_URL || DEFAULT_URLS.pk;
  }
  return process.env.EXPERTISE_API_AJ_URL || DEFAULT_URLS.aj;
}

function getApiKey(persona: Persona): string | null {
  // Per-persona keys; the two RAGs were forked but rotated separately so
  // they don't share a key today. Fall back to a single shared
  // EXPERTISE_API_KEY for back-compat with deployments that haven't
  // rotated yet.
  if (persona === "pk") {
    return (
      process.env.EXPERTISE_API_PK_KEY ||
      process.env.EXPERTISE_API_KEY ||
      null
    );
  }
  return (
    process.env.EXPERTISE_API_AJ_KEY ||
    process.env.EXPERTISE_API_KEY ||
    null
  );
}

interface MatchResponseAutomation {
  name: string;
  score: number;
  category?: string;
}

interface MatchResponseSkill {
  text: string;
  score: number;
  category?: string;
}

interface MatchResponseTool {
  name: string;
  score?: number;
}

interface MatchResponseProject {
  project_name: string;
  project_type?: string;
  industry?: string;
  final_score: number;
  confidence?: string;
  description?: string;
  matched_automations?: MatchResponseAutomation[];
  matched_skills?: MatchResponseSkill[];
  matched_tools?: MatchResponseTool[];
  talking_points?: string[];
}

interface MatchResponse {
  query: string;
  matches: MatchResponseProject[];
}

export interface ExpertiseMatchResult {
  /** Compact prompt-ready string the commenter injects as {rag_context}. */
  context: string;
  /** Raw match count — useful for telemetry. */
  matchCount: number;
  /** True iff at least one match returned. False on network error too. */
  ok: boolean;
}

/**
 * Fetch top-N matches for a free-text query (e.g. the LinkedIn post body)
 * from the persona's expertise API and format them as a prompt-ready block.
 *
 * Soft-fails: any network/auth error returns { context: "", matchCount: 0,
 * ok: false } and logs a warning. The caller decides what to do (we
 * currently fall back to a no-context prompt).
 */
export async function fetchExpertiseMatches(
  persona: Persona,
  text: string,
  limit: number = 3,
): Promise<ExpertiseMatchResult> {
  const apiKey = getApiKey(persona);
  if (!apiKey) {
    console.warn(
      `[expertise] ${persona} API key not set (EXPERTISE_API_${persona.toUpperCase()}_KEY) — RAG grounding disabled for this persona.`,
    );
    return { context: "", matchCount: 0, ok: false };
  }

  const url = `${getBaseUrl(persona)}/match`;
  const trimmed = text.slice(0, 1500);
  const timeoutMs = getTimeoutMs();

  async function fetchOnce(): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({ text: trimmed, limit }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  let res: Response;
  try {
    res = await fetchOnce();
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError") {
      console.warn(
        `[expertise] ${persona} RAG timeout after ${timeoutMs}ms — retrying once`,
      );
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        res = await fetchOnce();
      } catch (err2) {
        const e2 = err2 as Error;
        const reason =
          e2.name === "AbortError"
            ? `timeout after ${timeoutMs}ms (retry also failed)`
            : e2.message;
        console.warn(`[expertise] ${persona} RAG fetch failed: ${reason}`);
        return { context: "", matchCount: 0, ok: false };
      }
    } else {
      console.warn(`[expertise] ${persona} RAG fetch failed: ${e.message}`);
      return { context: "", matchCount: 0, ok: false };
    }
  }

  if (!res.ok) {
    console.warn(
      `[expertise] ${persona} RAG returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
    return { context: "", matchCount: 0, ok: false };
  }

  let data: MatchResponse;
  try {
    data = (await res.json()) as MatchResponse;
  } catch (err) {
    console.warn(
      `[expertise] ${persona} RAG returned non-JSON: ${(err as Error).message}`,
    );
    return { context: "", matchCount: 0, ok: false };
  }

  if (!data.matches || data.matches.length === 0) {
    return { context: "(no relevant past projects found)", matchCount: 0, ok: true };
  }

  return {
    context: formatContext(data.matches),
    matchCount: data.matches.length,
    ok: true,
  };
}

function formatContext(matches: MatchResponseProject[]): string {
  return matches
    .map((m, i) => {
      const desc = m.description?.slice(0, 280).trim() ?? "";
      const automations = (m.matched_automations ?? [])
        .slice(0, 5)
        .map((a) => a.name)
        .join(", ");
      const skills = (m.matched_skills ?? [])
        .slice(0, 3)
        .map((s) => s.text.split(":").slice(1).join(":").trim() || s.text)
        .join(" | ");
      const tools = (m.matched_tools ?? [])
        .slice(0, 5)
        .map((t) => t.name)
        .join(", ");
      const talking = (m.talking_points ?? []).slice(0, 2).join(" | ");

      const lines: string[] = [
        `Project ${i + 1}: ${m.project_name} (${m.project_type ?? "?"}${m.industry ? ", " + m.industry : ""}, score ${m.final_score.toFixed(2)})`,
      ];
      if (desc) lines.push(`  Description: ${desc}`);
      if (automations) lines.push(`  Automations: ${automations}`);
      if (skills) lines.push(`  Skills: ${skills}`);
      if (tools) lines.push(`  Tools: ${tools}`);
      if (talking) lines.push(`  Talking points: ${talking}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Minimal Vertex AI Gemini client.
 *
 * Replaces the @google/generative-ai SDK with a thin fetch wrapper hitting
 * Vertex AI's Express Mode endpoint. Express Mode keys are project-bound
 * but require no service account or OAuth flow — they're passed as
 * `?key=` and the project/location are baked in.
 *
 * Endpoint:
 *   POST https://aiplatform.googleapis.com/v1/publishers/google/models/MODEL:generateContent?key=KEY
 *
 * Surface is intentionally shaped like @google/generative-ai's so callers
 * change just the import + constructor and keep
 *   `await llm.generateContent(prompt)`
 *   `result.response.text()`
 *   `result.response.usageMetadata`
 * unchanged.
 */

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
}

export interface GenerateContentResponse {
  response: {
    text: () => string;
    usageMetadata?: UsageMetadata;
  };
}

export interface VertexClient {
  generateContent(prompt: string): Promise<GenerateContentResponse>;
}

const VERTEX_BASE =
  "https://aiplatform.googleapis.com/v1/publishers/google/models";

export function createVertexClient(opts: { model: string }): VertexClient {
  const apiKey =
    process.env.VERTEX_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
  if (!apiKey) {
    throw new Error(
      "VERTEX_API_KEY (or legacy GEMINI_API_KEY) env var must be set",
    );
  }
  const url = `${VERTEX_BASE}/${opts.model}:generateContent?key=${apiKey}`;

  return {
    async generateContent(prompt: string): Promise<GenerateContentResponse> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Vertex AI ${res.status} ${opts.model}: ${body.slice(0, 300)}`,
        );
      }
      const json = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };
      const text =
        json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("") ?? "";
      const usage: UsageMetadata = {
        promptTokenCount: json.usageMetadata?.promptTokenCount ?? 0,
        candidatesTokenCount: json.usageMetadata?.candidatesTokenCount ?? 0,
      };
      return {
        response: {
          text: () => text,
          usageMetadata: usage,
        },
      };
    },
  };
}

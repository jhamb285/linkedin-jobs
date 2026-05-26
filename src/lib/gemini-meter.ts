/**
 * Per-call Gemini usage logger.
 *
 * Wraps `model.generateContent(prompt)` so every Vertex call across the
 * pipeline emits a `gemini_usage` row with the raw token counts pulled
 * from response.usageMetadata. The Settings → LinkedIn → API page reads
 * this to show real spend by stage + range.
 *
 * Fire-and-forget DB insert: a logging failure must never break the
 * pipeline. Returns the original GenerateContentResponse unchanged so
 * callers can stay on the same client surface.
 */
import type { GenerateContentResponse, VertexClient } from "./vertex";
import { sql } from "drizzle-orm";
import { db } from "../db";

export interface MeterContext {
  /** UUID of the persona doing the work (commenter). Null for matcher
   *  since scoring runs pre-batch-assignment. */
  userOwner?: string | null;
  /** Stable id for this orchestrator run. Used to roll up per-run cost. */
  runId?: string | null;
  /** Defaults to 'linkedin'. Shared gemini_usage table — column
   *  distinguishes rows across pipelines. */
  pipeline?: string;
}

export async function meteredGenerate(
  llm: VertexClient,
  modelName: string,
  stage: string,
  prompt: string,
  ctx: MeterContext = {},
): Promise<GenerateContentResponse> {
  const result = await llm.generateContent(prompt);
  const usage = result.response.usageMetadata;
  const input = usage?.promptTokenCount ?? 0;
  const output = usage?.candidatesTokenCount ?? 0;
  // Don't await — logging must never gate the pipeline. .catch() ensures
  // a promise rejection on the DB insert doesn't propagate as unhandled.
  void db
    .execute(sql`
      INSERT INTO gemini_usage (
        stage, model, input_tokens, output_tokens,
        user_owner, pipeline, run_id
      ) VALUES (
        ${stage}, ${modelName}, ${input}, ${output},
        ${ctx.userOwner ?? null}, ${ctx.pipeline ?? "linkedin"}, ${ctx.runId ?? null}
      )
    `)
    .catch((e: Error) => {
      console.error(
        `[gemini-meter] log failed (${stage}):`,
        e.message.slice(0, 200),
      );
    });
  return result;
}

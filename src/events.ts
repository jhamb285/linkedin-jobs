/**
 * Writer for `platform_events`. Single insert per call, fire-and-forget on
 * failure (we never want a telemetry failure to crash the pipeline).
 *
 * Mirrors platform/web/lib/platform-events.ts so both repos emit identically.
 */

import { db, schema } from "./db";

export type PlatformEventInput = {
  eventType: string;
  workflow?: string | null;
  userOwner?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown> | null;
  costUsd?: number | string | null;
  occurredAt?: Date;
};

export async function recordEvent(input: PlatformEventInput): Promise<void> {
  try {
    await db.insert(schema.platformEvents).values({
      eventType: input.eventType,
      workflow: input.workflow ?? null,
      userOwner: input.userOwner ?? null,
      actor: input.actor ?? null,
      payload: (input.payload as never) ?? null,
      costUsd:
        input.costUsd === null || input.costUsd === undefined
          ? null
          : String(input.costUsd),
      occurredAt: input.occurredAt ?? new Date(),
    });
  } catch (err) {
    console.error(
      "[events] platform_events insert failed:",
      input.eventType,
      (err as Error).message,
    );
  }
}

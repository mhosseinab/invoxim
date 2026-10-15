import { z } from "zod";
import { QUERY_LIMIT } from "./job-configuration";

const measurements = {
  consumedQueryCount: z.number().int().min(0).max(QUERY_LIMIT),
  // Supplied elapsed wall time is not Worker CPU time.
  wallDurationMs: z.number().int().min(0).max(3600000),
};
const eventSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("schedule"),
      outcome: z.enum(["completed", "unavailable", "failed"]),
      scheduledCount: z.number().int().min(0).max(50).nullable(),
      sentCount: z.number().int().min(0).max(50).nullable(),
      ...measurements,
    })
    .superRefine((event, context) => {
      if (
        event.outcome !== "failed" &&
        (event.scheduledCount === null || event.sentCount === null)
      )
        context.addIssue({
          code: "custom",
          message: "Completed counts must be measured",
        });
    }),
  z
    .strictObject({
      kind: z.literal("queue"),
      outcome: z.enum(["ack", "retry", "disabled", "failed"]),
      acknowledgedCount: z.number().int().min(0).max(100).nullable(),
      retriedCount: z.number().int().min(0).max(100).nullable(),
      ...measurements,
    })
    .superRefine((event, context) => {
      if (
        event.outcome !== "failed" &&
        (event.acknowledgedCount === null || event.retriedCount === null)
      )
        context.addIssue({
          code: "custom",
          message: "Completed counts must be measured",
        });
    }),
  z.strictObject({
    kind: z.literal("cleanup"),
    outcome: z.enum(["idle", "pending", "completed", "awaiting_journal"]),
    unitCount: z.number().int().min(0).max(3),
    ...measurements,
  }),
]);

export type OperationalEvent = Readonly<z.infer<typeof eventSchema>>;
export type OperationalSink = (
  event: OperationalEvent,
  signal: AbortSignal,
) => Promise<void>;

/** Construct once per invocation. Observation never changes a product decision. */
export function createOperationalObserver(options: {
  enabled?: boolean;
  deadlineMs?: number;
  sink?: OperationalSink;
}) {
  const deadlineMs = options.deadlineMs ?? 25;
  const sink = options.sink;
  const enabled =
    options.enabled === true &&
    sink !== undefined &&
    Number.isSafeInteger(deadlineMs) &&
    deadlineMs >= 1 &&
    deadlineMs <= 250;
  let emissions = 0;
  return {
    async observe(input: unknown): Promise<void> {
      if (!enabled || !sink || emissions >= 3) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      try {
        const parsed = eventSchema.safeParse(input);
        if (!parsed.success) return;
        const event = Object.freeze(parsed.data);
        if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 512)
          return;
        // Charge synchronously before awaiting, including concurrent sink failures.
        emissions++;
        const expiration = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve();
          }, deadlineMs);
        });
        await Promise.race([
          Promise.resolve().then(() => sink(event, controller.signal)),
          expiration,
        ]);
      } catch {
        // Never serialize validation errors, provider errors or rejected payloads.
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    },
  };
}

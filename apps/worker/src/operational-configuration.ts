import { createOperationalObserver } from "./operational-metrics";
export interface OperationalBindings {
  OPERATIONAL_METRICS_ENABLED?: string;
  OPERATIONAL_METRICS_DEADLINE_MS?: string;
  OPERATIONAL_METRICS?: Fetcher;
  OPERATIONAL_METRICS_SECRET?: string;
}
/** Composition selects an explicitly configured operator-owned destination. */
export function configuredOperationalObserver(bindings: OperationalBindings) {
  const destination = bindings.OPERATIONAL_METRICS;
  const secret = bindings.OPERATIONAL_METRICS_SECRET ?? "";
  const configuredDeadline = bindings.OPERATIONAL_METRICS_DEADLINE_MS;
  const deadlineMs =
    configuredDeadline === undefined
      ? 25
      : /^\d{1,3}$/.test(configuredDeadline)
        ? Number(configuredDeadline)
        : NaN;
  if (
    bindings.OPERATIONAL_METRICS_ENABLED !== "true" ||
    !destination ||
    !/^[\x21-\x7e]{16,1024}$/.test(secret) ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 250
  )
    return createOperationalObserver({});
  return createOperationalObserver({
    enabled: true,
    deadlineMs,
    async sink(event, signal) {
      const response = await destination.fetch(
        new Request("https://operational-metrics.invalid/v1/events", {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(event),
        }),
      );
      if (response.body && !response.body.locked)
        void response.body.cancel().catch(() => undefined);
      if (response.status !== 204) throw new Error("OBSERVATION_UNAVAILABLE");
    },
  });
}

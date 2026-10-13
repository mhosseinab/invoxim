import type { PurchaseDetail } from "@invoxim/contracts";
export function cashEvents(detail: PurchaseDetail) {
  if (detail.ledgerEntries.length > 0) return detail.ledgerEntries;
  return detail.timeline.flatMap((item) =>
    item.events.map((event) => ({
      ...event,
      version: null,
      origin: "source" as const,
      observationId: item.observationId,
    })),
  );
}

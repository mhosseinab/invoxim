import { calendarDate } from "@invoxim/contracts";
import type { AiMissingField, PersistedAiRecord } from "../ai/types";
import { validatePersistableAiResult } from "../ai/validation";
import {
  evaluateCorrectionSettlement,
  settlementEvents,
} from "../corrections/settlement";
import {
  type CorrectionEventFact,
  type CorrectionReviewFact,
  observationEvidenceCode,
} from "../corrections/validation";
import { parseMoney } from "../money";
import type {
  LedgerCashReview,
  LedgerCreditProof,
  LedgerEvent,
  LedgerInput,
  LedgerObservation,
  LedgerPlan,
  LedgerPurchase,
  LedgerReviewReason,
  LedgerSnapshot,
} from "./types";

type MutablePlan = {
  -readonly [K in keyof LedgerPlan]: LedgerPlan[K][number][];
};
const key = (kind: string, ...parts: readonly (string | number)[]) =>
  `${kind}:${JSON.stringify(parts)}`;
export const normalizeLedgerMerchant = (merchant: string) =>
  merchant.trim().toLowerCase();
export function ledgerEventKey(
  identity: LedgerInput["identity"],
  segmentIndex: number,
  record: PersistedAiRecord,
  kind: LedgerEvent["kind"],
): string {
  const reference =
    kind === "payment" ? record.paymentReference : record.refundReference;
  return reference && record.merchant !== null
    ? key(
        "cash-reference",
        normalizeLedgerMerchant(record.merchant),
        kind,
        reference,
      )
    : key("cash-content", identity.contentHash, segmentIndex, kind);
}
function minor(amount: string | null, currency: string): number | null {
  const value = parseMoney(amount, currency);
  return value === null ? null : Number(value);
}
/** User-corrected financial facts; settlement and conflict checks defer to them. */
function hasFinancialOverride(purchase: LedgerPurchase) {
  return purchase.overriddenFields.some(
    (field) => field === "totalMinor" || field === "currency",
  );
}
function review(
  plan: MutablePlan,
  input: LedgerInput,
  reason: LedgerReviewReason,
  observation: LedgerObservation | null,
  missingFields?: readonly AiMissingField[],
) {
  const purchaseId = observation?.purchaseId ?? null;
  const id = key(
    "review",
    input.identity.documentId,
    input.identity.extractionFingerprint,
    observation?.segmentIndex ?? -1,
    reason,
  );
  if (!plan.reviews.some((item) => item.id === id))
    plan.reviews.push({
      id,
      reason,
      ...(missingFields ? { missingFields: missingFields.slice() } : {}),
      blockingScope: "financial",
      documentId: input.identity.documentId,
      observationId: observation?.id ?? null,
      purchaseId,
    });
}
function sameMerchant(purchase: LedgerPurchase, record: PersistedAiRecord) {
  return (
    record.merchant !== null &&
    normalizeLedgerMerchant(purchase.merchant) ===
      normalizeLedgerMerchant(record.merchant)
  );
}
function matchesReference(
  purchase: LedgerPurchase,
  record: PersistedAiRecord,
  observations: readonly LedgerObservation[],
) {
  const refs = [
    {
      merchant: purchase.merchant,
      invoiceNumber: purchase.invoiceNumber,
      orderReference: purchase.orderReference,
    },
    ...observations
      .filter((item) => item.purchaseId === purchase.id)
      .map((item) => item.record),
  ];
  return refs.some(
    (refs) =>
      record.merchant !== null &&
      refs.merchant !== null &&
      normalizeLedgerMerchant(refs.merchant) ===
        normalizeLedgerMerchant(record.merchant) &&
      ((record.orderReference !== null &&
        refs.orderReference === record.orderReference) ||
        (record.invoiceNumber !== null &&
          refs.invoiceNumber === record.invoiceNumber)),
  );
}
function findPurchase(
  input: LedgerInput,
  record: PersistedAiRecord,
  segmentIndex: number,
  snapshot: LedgerSnapshot,
  plan: MutablePlan,
): { matches: LedgerPurchase[]; explicit: boolean; contentConflict?: boolean } {
  const purchases = [...snapshot.purchases, ...plan.purchases];
  const observations = [...snapshot.observations, ...plan.observations];
  const decisions = snapshot.decisions.filter(
    (decision) =>
      decision.contentHash === input.identity.contentHash &&
      decision.segmentIndex === segmentIndex,
  );
  const explicit = decisions.find(
    (decision) => decision.decision === "same-purchase",
  );
  if (explicit)
    return {
      matches: purchases.filter(
        (purchase) => purchase.id === explicit.purchaseId,
      ),
      explicit: true,
    };
  const manual = snapshot.manualEvidence?.find(
    (item) => item.contentHash === input.identity.contentHash,
  );
  if (manual)
    return {
      matches: purchases.filter(
        (purchase) => purchase.id === manual.purchaseId,
      ),
      explicit: true,
    };
  const rejected = new Set(
    decisions
      .filter((decision) => decision.decision === "different-purchase")
      .map((decision) => decision.purchaseId),
  );
  const cashKeys = (["payment", "refund"] as const)
    .filter((kind) =>
      kind === "payment" ? record.paymentReference : record.refundReference,
    )
    .map((kind) => ledgerEventKey(input.identity, segmentIndex, record, kind));
  const eventPurchases = new Set(
    [...snapshot.events, ...plan.events]
      .filter(
        (event) =>
          cashKeys.includes(event.businessKey) &&
          event.purchaseId !== null &&
          !rejected.has(event.purchaseId),
      )
      .map((event) => event.purchaseId),
  );
  if (eventPurchases.size)
    return {
      matches: purchases.filter((purchase) => eventPurchases.has(purchase.id)),
      explicit: false,
    };
  const content = observations.find(
    (item) =>
      item.identity.contentHash === input.identity.contentHash &&
      item.segmentIndex === segmentIndex &&
      item.purchaseId !== null &&
      !rejected.has(item.purchaseId),
  );
  if (content)
    return {
      matches: purchases.filter(
        (purchase) => purchase.id === content.purchaseId,
      ),
      explicit: false,
      contentConflict:
        normalizeLedgerMerchant(content.record.merchant ?? "") !==
          normalizeLedgerMerchant(record.merchant ?? "") ||
        content.record.orderReference !== record.orderReference ||
        content.record.invoiceNumber !== record.invoiceNumber,
    };
  return {
    matches: purchases.filter(
      (purchase) =>
        !rejected.has(purchase.id) &&
        matchesReference(purchase, record, observations),
    ),
    explicit: false,
  };
}
function invoiceConflict(
  record: PersistedAiRecord,
  purchase: LedgerPurchase,
  observations: readonly LedgerObservation[],
) {
  const currency = record.currency;
  if (record.invoiceNumber === null || currency === null) return false;
  const invoiceObservations = observations.filter(
    (item) =>
      item.purchaseId === purchase.id &&
      item.documentType !== "refund" &&
      item.documentType !== "credit-note" &&
      item.record.invoiceNumber === record.invoiceNumber,
  );
  if (invoiceObservations.length === 0) {
    return (
      purchase.invoiceNumber === record.invoiceNumber &&
      !hasFinancialOverride(purchase) &&
      (purchase.currency !== currency ||
        purchase.totalMinor !== minor(record.total, currency))
    );
  }
  return invoiceObservations.some(
    (item) =>
      item.record.currency !== record.currency ||
      (item.record.total !== null &&
        minor(item.record.total, currency) !== minor(record.total, currency)),
  );
}
function cashEvent(
  plan: MutablePlan,
  input: LedgerInput,
  observation: LedgerObservation,
  snapshot: LedgerSnapshot,
  kind: LedgerEvent["kind"],
) {
  const record = observation.record;
  const currency = record.currency;
  if (currency === null) {
    review(plan, input, "incomplete-financial-facts", observation);
    return;
  }
  const amountMinor = minor(
    kind === "payment" ? record.paymentAmount : record.refundAmount,
    currency,
  );
  const eventDate = record.eventDate ?? record.documentDate;
  if (amountMinor === null || eventDate === null) {
    review(plan, input, "incomplete-financial-facts", observation);
    return;
  }
  calendarDate(eventDate);
  const businessKey = ledgerEventKey(
    input.identity,
    observation.segmentIndex,
    record,
    kind,
  );
  const allEvents = [...snapshot.events, ...plan.events];
  const sameContentObservations = new Set(
    [...snapshot.observations, ...plan.observations]
      .filter(
        (item) =>
          item.identity.contentHash === input.identity.contentHash &&
          item.segmentIndex === observation.segmentIndex,
      )
      .map((item) => item.id),
  );
  const existing =
    allEvents.find((event) => event.businessKey === businessKey) ??
    allEvents.find(
      (event) =>
        event.kind === kind &&
        event.observationId !== null &&
        sameContentObservations.has(event.observationId),
    );
  if (existing) {
    if (
      (existing.sourceValues?.amountMinor ?? existing.amountMinor) !==
        amountMinor ||
      (existing.sourceValues?.currency ?? existing.currency) !== currency ||
      (existing.sourceValues?.eventDate ?? existing.eventDate) !== eventDate ||
      existing.purchaseId !== observation.purchaseId
    )
      review(plan, input, "event-conflict", observation);
    return;
  }
  const purchase = snapshot.purchases.find(
    (item) => item.id === observation.purchaseId,
  );
  if (
    kind === "payment" &&
    purchase &&
    purchase.invoiceNumber !== null &&
    purchase.invoiceNumber === record.invoiceNumber &&
    hasFinancialOverride(purchase) &&
    ![...snapshot.observations, ...plan.observations].some(
      (item) =>
        item.id !== observation.id &&
        item.purchaseId === purchase.id &&
        item.documentType !== "refund" &&
        item.documentType !== "credit-note" &&
        item.record.invoiceNumber === record.invoiceNumber,
    )
  ) {
    review(plan, input, "ambiguous-event", observation);
    return;
  }
  const reference =
    kind === "payment" ? record.paymentReference : record.refundReference;
  const previous = allEvents.filter(
    (event) =>
      event.purchaseId === observation.purchaseId && event.kind === kind,
  );
  if (
    previous.length &&
    (!reference ||
      previous.some(
        (event) => !event.businessKey.startsWith("cash-reference:"),
      ))
  ) {
    review(plan, input, "ambiguous-event", observation);
    return;
  }
  if (kind === "refund") {
    const payments = allEvents.filter(
      (event) =>
        event.purchaseId === observation.purchaseId &&
        event.kind === "payment" &&
        event.eligible,
    );
    if (observation.purchaseId === null || payments.length === 0) {
      review(plan, input, "unmatched-refund", observation);
      return;
    }
    if (payments.some((event) => event.currency !== currency)) {
      review(plan, input, "refund-currency-mismatch", observation);
      return;
    }
    const paid = payments.reduce(
      (sum, event) => sum + BigInt(event.amountMinor),
      0n,
    );
    const refunded = previous
      .filter((event) => event.eligible && event.currency === currency)
      .reduce((sum, event) => sum + BigInt(event.amountMinor), 0n);
    if (refunded + BigInt(amountMinor) > paid) {
      review(plan, input, "refund-exceeds-payment", observation);
      return;
    }
  }
  plan.events.push({
    id: key("event", businessKey),
    businessKey,
    purchaseId: observation.purchaseId,
    observationId: observation.id,
    kind,
    amountMinor,
    currency,
    eventDate,
    dateBasis:
      record.eventDate === null ? "document-date" : "explicit-event-date",
    eligible:
      purchase?.recordStatus !== "excluded" &&
      purchase?.recordStatus !== "merged",
    version: 1,
    // `accepted` is settled once all reviews are planned (acceptPlannedCash).
    // The leased connection is live: a deletion disconnects it atomically.
    cashProof: {
      documentId: input.identity.documentId,
      evidenceCode: observationEvidenceCode(record),
      accepted: true,
      connectionDeletionPending: false,
    },
  });
}
function settlementMinor(
  record: PersistedAiRecord,
  currency: string,
): bigint | null {
  const payment = minor(record.paymentAmount, currency);
  const credit = minor(record.storeCreditAmount, currency);
  if (record.paymentMethodHint === "store-credit") {
    const redeemed = credit ?? payment;
    return redeemed === null ? null : BigInt(redeemed);
  }
  return payment === null ? null : BigInt(payment) + BigInt(credit ?? 0);
}
function classify(
  plan: MutablePlan,
  input: LedgerInput,
  observation: LedgerObservation,
  snapshot: LedgerSnapshot,
) {
  const record = observation.record;
  const currency = record.currency;
  if (currency === null) {
    review(plan, input, "incomplete-financial-facts", observation);
    return;
  }
  if (observation.documentType === "credit-note") {
    if (record.refundEvidence === "completed")
      review(plan, input, "credit-note-completion", observation);
    return;
  }
  if (record.paymentMethodHint === "store-credit") {
    if (record.paymentEvidence === "explicitly-paid") {
      const settled = settlementMinor(record, currency);
      const total = minor(record.total, currency);
      if (settled === null || total === null || settled !== BigInt(total))
        review(plan, input, "mixed-tender", observation);
    }
    return;
  }
  if (record.paymentEvidence === "explicitly-paid") {
    const payment = minor(record.paymentAmount, currency);
    const credit = minor(record.storeCreditAmount, currency);
    const total = minor(record.total, currency);
    if (
      record.storeCreditAmount !== null &&
      (payment === null ||
        credit === null ||
        total === null ||
        BigInt(payment) + BigInt(credit) > BigInt(total))
    ) {
      review(plan, input, "mixed-tender", observation);
      return;
    }
    cashEvent(plan, input, observation, snapshot, "payment");
  }
  if (record.refundEvidence === "completed")
    cashEvent(plan, input, observation, snapshot, "refund");
  else if (
    record.paymentEvidence === "unknown" &&
    (record.refundEvidence === "none" || record.refundEvidence === "unknown")
  )
    review(plan, input, "unknown-payment", observation);
}
/** The commit stores an observation with any planned review as needs_review. */
function acceptPlannedCash(plan: MutablePlan) {
  plan.events = plan.events.map((event) => ({
    ...event,
    cashProof: {
      ...event.cashProof,
      accepted: !plan.reviews.some(
        (review) => review.observationId === event.observationId,
      ),
    },
  }));
}
function cashFact(event: LedgerEvent): CorrectionEventFact {
  return {
    id: event.id,
    observationId: event.observationId,
    documentId: event.cashProof.documentId,
    kind: event.kind,
    amountMinor: String(event.amountMinor),
    currency: event.currency,
    eventDate: event.eventDate,
    origin: event.origin ?? "source",
    eligible: event.eligible,
    // Like corrections/data.ts events(): a pending connection deletion
    // unaccepts the source observation (OQ-C).
    accepted:
      event.cashProof.accepted && !event.cashProof.connectionDeletionPending,
    evidenceCode: event.cashProof.evidenceCode,
  };
}
/**
 * OQ-B: the reviews that can block a purchase's cash, as the corrections
 * loader and lifecycle recompute select them: purchase-scoped, or linked
 * through an entry's observation or, without observation, its document.
 */
function cashReviews(
  purchaseId: string,
  facts: readonly CorrectionEventFact[],
  reviews: readonly LedgerCashReview[],
): CorrectionReviewFact[] {
  const observations = new Set(facts.map((fact) => fact.observationId));
  const documents = new Set(facts.map((fact) => fact.documentId));
  return reviews
    .filter((review) => {
      if (review.purchaseId === purchaseId) return true;
      if (review.observationId !== null)
        return observations.has(review.observationId);
      return review.documentId !== null && documents.has(review.documentId);
    })
    .map((review) => ({
      ...review,
      blockingScope: "financial",
      status: "open",
      missingFields: [],
    }));
}
/**
 * The corrections creditProofSql rule over this plan's observations as the
 * commit stores them: an accepted (no planned review) explicitly-paid
 * observation without an open financial review on it or, without
 * observation, on its document. evaluateCorrectionSettlement counts a proof
 * only when its total equals the purchase total.
 */
function plannedCreditProofs(
  plan: MutablePlan,
  reviews: readonly LedgerCashReview[],
): LedgerCreditProof[] {
  return plan.observations.flatMap((observation) => {
    const { record, purchaseId } = observation;
    const currency = record.currency;
    if (
      purchaseId === null ||
      currency === null ||
      record.paymentEvidence !== "explicitly-paid" ||
      reviews.some(
        (review) =>
          review.reason !== "payment-allocation-review" &&
          (review.observationId === observation.id ||
            (review.observationId === null &&
              review.documentId === observation.identity.documentId)),
      )
    )
      return [];
    const total = parseMoney(record.total, currency);
    const credit = parseMoney(
      record.paymentMethodHint === "store-credit"
        ? (record.storeCreditAmount ?? record.paymentAmount)
        : record.storeCreditAmount,
      currency,
    );
    if (total === null || credit === null || credit > total) return [];
    return [
      {
        purchaseId,
        currency,
        totalMinor: String(total),
        creditMinor: String(credit),
      },
    ];
  });
}
function projectPaymentStates(plan: MutablePlan, snapshot: LedgerSnapshot) {
  acceptPlannedCash(plan);
  const events = [...snapshot.events, ...plan.events];
  const reviews: LedgerCashReview[] = [
    ...(snapshot.reviews ?? []),
    ...plan.reviews,
  ];
  // OQ-A (owner decision): recompute from currently supported cash and
  // credit with the corrections rule; a stored 'paid' is not retained.
  // OQ-B: cash support is core settlementEvents over the same facts. This
  // plan's credit is proven only as the commit will store it, so a reviewed
  // observation (any planned review, including possible-duplicate, or an
  // open snapshot review on its document) supports neither cash nor credit.
  const planned = plannedCreditProofs(plan, reviews);
  const credits = [...(snapshot.creditProofs ?? []), ...planned];
  const involved = new Set([
    ...plan.events.map((event) => event.purchaseId),
    ...planned.map((proof) => proof.purchaseId),
  ]);
  for (const purchase of [...snapshot.purchases, ...plan.purchases]) {
    const { currency, totalMinor } = purchase;
    if (currency === null || totalMinor === null) continue;
    if (!involved.has(purchase.id)) continue;
    const facts = events
      .filter((event) => event.purchaseId === purchase.id)
      .map(cashFact);
    const paymentState = purchase.overriddenFields.includes("paymentState")
      ? purchase.paymentState
      : evaluateCorrectionSettlement(
          {
            currency,
            totalMinor: String(totalMinor),
            paymentState: purchase.paymentState,
          },
          settlementEvents(facts, cashReviews(purchase.id, facts, reviews)),
          credits.filter((proof) => proof.purchaseId === purchase.id),
        ).paymentState;
    const newIndex = plan.purchases.findIndex(
      (item) => item.id === purchase.id,
    );
    if (newIndex >= 0) plan.purchases[newIndex] = { ...purchase, paymentState };
    else
      plan.paymentStates.push({
        purchaseId: purchase.id,
        expectedVersion: purchase.version,
        paymentState,
      });
  }
}

export function planLedgerIngestion(
  input: LedgerInput,
  snapshot: LedgerSnapshot,
): LedgerPlan {
  const plan: MutablePlan = {
    observations: [],
    purchases: [],
    evidence: [],
    events: [],
    reviews: [],
    expectedPurchases: [],
    paymentStates: [],
  };
  if (
    Object.values(input.identity).some(
      (value) =>
        typeof value !== "string" || value.length === 0 || value.length > 256,
    )
  )
    throw new Error("INVALID_LEDGER_IDENTITY");
  const result = validatePersistableAiResult(input.result);
  if (!result || result.status === "needs-review" || result.warnings.length) {
    review(
      plan,
      input,
      "extraction-review",
      null,
      result?.status === "needs-review" ? result.missingFields : undefined,
    );
    return plan;
  }
  const manual =
    snapshot.manualEvidence?.filter(
      (item) => item.contentHash === input.identity.contentHash,
    ) ?? [];
  if (
    manual.length &&
    (result.records.length !== 1 ||
      new Set(manual.map((item) => item.purchaseId)).size !== 1)
  ) {
    review(plan, input, "purchase-conflict", null);
    return plan;
  }
  const ignored = [
    "statement",
    "non-purchase",
    "cancellation",
    "unknown",
  ].includes(result.documentType);
  for (const [segmentIndex, record] of result.records.entries()) {
    const id = key(
      "observation",
      input.identity.documentId,
      segmentIndex,
      input.identity.extractionFingerprint,
    );
    if (snapshot.observations.some((item) => item.id === id)) continue;
    let observation: LedgerObservation = {
      id,
      identity: {
        documentId: input.identity.documentId,
        contentHash: input.identity.contentHash,
        extractionFingerprint: input.identity.extractionFingerprint,
      },
      segmentIndex,
      documentType: result.documentType,
      record,
      purchaseId: null,
    };
    if (ignored) {
      plan.observations.push(observation);
      continue;
    }
    if (
      record.merchant === null ||
      record.currency === null ||
      record.total === null ||
      record.documentDate === null
    ) {
      plan.observations.push(observation);
      review(plan, input, "incomplete-financial-facts", observation);
      continue;
    }
    try {
      const totalMinor = minor(record.total, record.currency);
      if (totalMinor === null) throw new Error("MISSING_TOTAL");
      calendarDate(record.documentDate);
      if (record.eventDate !== null) calendarDate(record.eventDate);
      for (const amount of [
        record.tax,
        record.paymentAmount,
        record.refundAmount,
        record.storeCreditAmount,
      ])
        minor(amount, record.currency);
      const { matches, explicit, contentConflict } = findPurchase(
        input,
        record,
        segmentIndex,
        snapshot,
        plan,
      );
      if (
        contentConflict ||
        matches.length > 1 ||
        (explicit && matches.length === 0)
      ) {
        plan.observations.push(observation);
        review(plan, input, "purchase-conflict", observation);
        continue;
      }
      let purchase = matches[0];
      if (
        !purchase &&
        result.documentType !== "refund" &&
        result.documentType !== "credit-note"
      ) {
        const differentDecision = snapshot.decisions.some(
          (decision) =>
            decision.contentHash === input.identity.contentHash &&
            decision.segmentIndex === segmentIndex &&
            decision.decision === "different-purchase",
        );
        const reference =
          record.orderReference ??
          record.invoiceNumber ??
          record.paymentReference;
        const purchaseId = differentDecision
          ? key("purchase-separate", input.identity.documentId, segmentIndex)
          : reference
            ? key(
                "purchase-reference",
                normalizeLedgerMerchant(record.merchant),
                record.currency,
                record.orderReference
                  ? "order"
                  : record.invoiceNumber
                    ? "invoice"
                    : "payment",
                reference,
              )
            : key("purchase-content", input.identity.contentHash, segmentIndex);
        purchase = {
          id: purchaseId,
          merchant: record.merchant,
          currency: record.currency,
          totalMinor,
          documentDate: record.documentDate,
          invoiceNumber: record.invoiceNumber,
          orderReference: record.orderReference,
          category: record.category,
          paymentState:
            record.paymentEvidence === "explicitly-unpaid"
              ? "unpaid"
              : "unknown",
          version: 1,
          overriddenFields: [],
        };
        const similar = snapshot.purchases.some(
          (existing) =>
            sameMerchant(existing, record) &&
            existing.currency === record.currency &&
            existing.totalMinor === totalMinor &&
            existing.documentDate === record.documentDate,
        );
        plan.purchases.push(purchase);
        if (similar)
          review(plan, input, "possible-duplicate", {
            ...observation,
            purchaseId: purchase.id,
          });
      }
      observation = { ...observation, purchaseId: purchase?.id ?? null };
      plan.observations.push(observation);
      if (purchase) {
        plan.evidence.push({
          purchaseId: purchase.id,
          observationId: id,
          relationship: "document",
        });
        if (
          snapshot.purchases.some((item) => item.id === purchase.id) &&
          !plan.expectedPurchases.some((item) => item.id === purchase.id)
        )
          plan.expectedPurchases.push({
            id: purchase.id,
            version: purchase.version,
          });
        if (purchase.currency !== record.currency) {
          review(
            plan,
            input,
            result.documentType === "refund"
              ? "refund-currency-mismatch"
              : "purchase-conflict",
            observation,
          );
          continue;
        }
        if (
          result.documentType !== "refund" &&
          result.documentType !== "credit-note" &&
          invoiceConflict(record, purchase, [
            ...snapshot.observations,
            ...plan.observations.filter((item) => item.id !== observation.id),
          ])
        ) {
          review(plan, input, "invoice-conflict", observation);
          continue;
        }
        if (
          result.documentType === "order-confirmation" &&
          purchase.totalMinor !== totalMinor &&
          !hasFinancialOverride(purchase)
        ) {
          review(plan, input, "purchase-conflict", observation);
          continue;
        }
      }
      classify(plan, input, observation, snapshot);
    } catch {
      if (!plan.observations.some((item) => item.id === id))
        plan.observations.push(observation);
      review(plan, input, "incomplete-financial-facts", observation);
    }
  }
  projectPaymentStates(plan, snapshot);
  return plan;
}

import { describe, expect, it } from "vitest";
import type { PersistedAiRecord } from "../src/ai/types";
import {
  type CorrectionSettlement,
  type CorrectionSettlementEvent,
  evaluateCorrectionSettlement,
  settlementEvents,
} from "../src/corrections/settlement";
import {
  type CorrectionEventFact,
  type CorrectionReviewFact,
  hasCashProof,
  restorationEligibility,
} from "../src/corrections/validation";
import { planLedgerIngestion } from "../src/ledger/plan";
import type {
  LedgerEvent,
  LedgerInput,
  LedgerPurchase,
  LedgerSnapshot,
} from "../src/ledger/types";

/**
 * CORE-1 payment-state parity fork (ext#2, C1, K1).
 *
 * Three rules claim to derive payment state / supported cash from the same facts:
 *   A. projectPaymentStates (core/ledger/plan.ts) — counts eligible payment events
 *   B. evaluateCorrectionSettlement + settlementEvents (core/corrections/settlement.ts)
 *      — counts supported events (hasCashProof && restorationEligibility)
 *   C. the supportedCash SQL CASE in adapters lifecycle/connection-recompute.ts:14
 *      — counts its own "supported" flag, then feeds evaluateCorrectionSettlement
 *
 * This suite runs identical purchases/entries/reviews through all three and
 * records whether they agree. Test-only: no production code changes (CORE-6 is
 * the fix card and is out of scope here).
 */

type PaymentState = "unknown" | "unpaid" | "partially_paid" | "paid";

interface CashFact {
  kind: "payment" | "refund";
  amountMinor: string;
  currency: string;
  origin: "source" | "user-confirmed";
  /** plan.ts gate: set when the owning purchase is not excluded/merged. */
  eligible: boolean;
  /** observations.review_state='accepted' */
  accepted: boolean;
  /** observations.evidence_code */
  evidenceCode: string | null;
  observationId: string | null;
  documentId: string | null;
}

interface ReviewFact {
  id: string;
  observationId: string | null;
  documentId: string | null;
  reason: string;
  blockingScope: "financial" | "operational";
  status: "open" | "resolved" | "dismissed";
  purchaseId: string | null;
}

interface Scenario {
  name: string;
  purchase: {
    currency: string | null;
    totalMinor: string | null;
    paymentState: PaymentState;
  };
  entries: CashFact[];
  reviews?: ReviewFact[];
  connectionDeletionPending?: boolean;
  /**
   * CORE-1 verdict marker. When the three paths disagree the scenario is the
   * evidence that CORE-6 (derivePaymentState) is required.
   */
  expectAgreement: boolean;
}

const triggerEntry = (currency: string): CashFact => ({
  kind: "payment",
  amountMinor: "0",
  currency,
  origin: "source",
  eligible: true,
  accepted: true,
  evidenceCode: "explicitly-paid",
  observationId: "obs-trigger",
  documentId: "doc-trigger",
});

function toCorrectionEventFact(
  entry: CashFact,
  index: number,
): CorrectionEventFact {
  return {
    id: `entry-${index}`,
    observationId: entry.observationId,
    documentId: entry.documentId,
    kind: entry.kind,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    eventDate: "2026-01-01",
    origin: entry.origin,
    eligible: entry.eligible,
    accepted: entry.accepted,
    evidenceCode: entry.evidenceCode,
  };
}

function toReviewFact(review: ReviewFact): CorrectionReviewFact {
  return {
    id: review.id,
    observationId: review.observationId,
    documentId: review.documentId,
    reason: review.reason,
    blockingScope: review.blockingScope,
    status: review.status,
    missingFields: [],
    purchaseId: review.purchaseId,
  };
}

/**
 * TypeScript transcription of the supportedCash CASE in
 * packages/adapters/src/lifecycle/connection-recompute.ts:14.
 * Kept byte-faithful to the SQL NULL semantics (NULL = NULL is not true).
 * A worker/adapters SQL case re-checks this transcription against D1.
 */
function sqlSupportedCash(
  entry: CashFact,
  reviews: readonly ReviewFact[],
  connectionDeletionPending: boolean,
): boolean {
  if (entry.origin === "user-confirmed") return true;
  if (!entry.accepted) return false;
  const expected =
    entry.kind === "payment" ? "explicitly-paid" : "completed-refund";
  if (
    entry.evidenceCode !== "manual-confirmation" &&
    entry.evidenceCode !== expected
  )
    return false;
  if (connectionDeletionPending) return false;
  for (const review of reviews) {
    if (
      review.status !== "open" ||
      review.blockingScope !== "financial" ||
      review.reason === "payment-allocation-review"
    )
      continue;
    if (
      review.observationId !== null &&
      review.observationId === entry.observationId
    )
      return false;
    if (
      review.observationId === null &&
      review.documentId !== null &&
      entry.documentId !== null &&
      review.documentId === entry.documentId &&
      review.reason !== "refund-exceeds-payment" &&
      review.reason !== "refund-currency-mismatch"
    )
      return false;
  }
  return true;
}

function scenarioEntries(scenario: Scenario): CashFact[] {
  return [
    ...scenario.entries,
    triggerEntry(scenario.purchase.currency ?? "EUR"),
  ];
}

function runTsSettlement(scenario: Scenario): CorrectionSettlement {
  const facts = scenarioEntries(scenario).map(toCorrectionEventFact);
  const reviews = (scenario.reviews ?? []).map(toReviewFact);
  return evaluateCorrectionSettlement(
    {
      currency: scenario.purchase.currency,
      totalMinor: scenario.purchase.totalMinor,
      paymentState: scenario.purchase.paymentState,
    },
    settlementEvents(facts, reviews),
    [],
  );
}

function runSqlSettlement(scenario: Scenario): CorrectionSettlement {
  const events: CorrectionSettlementEvent[] = scenarioEntries(scenario).map(
    (entry) => ({
      kind: entry.kind,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      origin: entry.origin,
      supported: sqlSupportedCash(
        entry,
        scenario.reviews ?? [],
        scenario.connectionDeletionPending ?? false,
      ),
    }),
  );
  return evaluateCorrectionSettlement(
    {
      currency: scenario.purchase.currency,
      totalMinor: scenario.purchase.totalMinor,
      paymentState: scenario.purchase.paymentState,
    },
    events,
    [],
  );
}

function runPlan(scenario: Scenario): PaymentState {
  const purchaseId = "parity-purchase";
  const currency = scenario.purchase.currency ?? "EUR";
  const purchase: LedgerPurchase = {
    id: purchaseId,
    merchant: "Parity Shop",
    currency: scenario.purchase.currency,
    totalMinor:
      scenario.purchase.totalMinor === null
        ? null
        : Number(scenario.purchase.totalMinor),
    documentDate: "2026-01-01",
    invoiceNumber: null,
    orderReference: null,
    category: "shopping",
    paymentState: scenario.purchase.paymentState,
    version: 1,
    overriddenFields: [],
  };
  const entries = [...scenario.entries, triggerEntry(currency)];
  const events: LedgerEvent[] = entries.map((entry, index) => ({
    id: `entry-${index}`,
    businessKey: `cash-reference:${JSON.stringify([
      "parity shop",
      entry.kind,
      `ref-${index}`,
    ])}`,
    purchaseId,
    observationId: entry.observationId,
    kind: entry.kind,
    amountMinor: Number(entry.amountMinor),
    currency: entry.currency,
    eventDate: "2026-01-01",
    dateBasis: "document-date",
    eligible: entry.eligible,
    version: 1,
    origin: entry.origin,
  }));
  // Drop the synthetic trigger event: plan receives it from the trigger input.
  const snapshotEvents = events.slice(0, -1);
  const snapshot: LedgerSnapshot = {
    observations: [],
    purchases: [purchase],
    events: snapshotEvents,
    decisions: [],
    manualEvidence: [{ contentHash: "parity-trigger", purchaseId }],
  };
  const record: PersistedAiRecord = {
    merchant: "Parity Shop",
    documentDate: "2026-01-01",
    eventDate: "2026-01-01",
    currency,
    total: "0.00",
    tax: null,
    invoiceNumber: "trigger",
    orderReference: null,
    category: "shopping",
    paymentEvidence: "explicitly-paid",
    refundEvidence: "none",
    paymentMethodHint: "card",
    recurringCadence: "unknown",
    paymentAmount: "0.00",
    refundAmount: null,
    storeCreditAmount: null,
    paymentReference: "trigger-ref",
    refundReference: null,
    provenance: [],
  };
  const input: LedgerInput = {
    identity: {
      documentId: "doc-trigger",
      contentHash: "parity-trigger",
      extractionFingerprint: "v1",
    },
    result: {
      status: "accepted",
      documentType: "receipt",
      warnings: [],
      records: [record],
    },
  };
  const plan = planLedgerIngestion(input, snapshot);
  const projected = plan.paymentStates.find(
    (item) => item.purchaseId === purchaseId,
  );
  if (projected) return projected.paymentState;
  const updated = plan.purchases.find((item) => item.id === purchaseId);
  return updated?.paymentState ?? scenario.purchase.paymentState;
}

const scenarios: Scenario[] = [
  {
    name: "full supported payment settles the purchase",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "unknown" },
    entries: [
      {
        kind: "payment",
        amountMinor: "10000",
        currency: "EUR",
        origin: "source",
        eligible: true,
        accepted: true,
        evidenceCode: "explicitly-paid",
        observationId: "obs-1",
        documentId: "doc-1",
      },
    ],
    expectAgreement: true,
  },
  {
    name: "partial supported payment is partially_paid",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "unknown" },
    entries: [
      {
        kind: "payment",
        amountMinor: "4000",
        currency: "EUR",
        origin: "user-confirmed",
        eligible: true,
        accepted: true,
        evidenceCode: "manual-confirmation",
        observationId: null,
        documentId: null,
      },
    ],
    expectAgreement: true,
  },
  {
    name: "zero supported cash keeps unpaid when the purchase was unpaid",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "unpaid" },
    entries: [],
    expectAgreement: true,
  },
  {
    name: "eligible=false events are excluded by plan but counted by settlement/SQL when proven",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "unknown" },
    entries: [
      {
        kind: "payment",
        amountMinor: "10000",
        currency: "EUR",
        origin: "user-confirmed",
        eligible: false,
        accepted: true,
        evidenceCode: "manual-confirmation",
        observationId: null,
        documentId: null,
      },
    ],
    expectAgreement: false,
  },
  {
    name: "user-confirmed refund is short-circuited by SQL but blocked in TS by refund-exceeds-payment",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "paid" },
    entries: [
      {
        kind: "refund",
        amountMinor: "5000",
        currency: "EUR",
        origin: "user-confirmed",
        eligible: true,
        accepted: true,
        evidenceCode: "manual-confirmation",
        observationId: null,
        documentId: null,
      },
    ],
    reviews: [
      {
        id: "review-refund",
        observationId: null,
        documentId: null,
        reason: "refund-exceeds-payment",
        blockingScope: "financial",
        status: "open",
        purchaseId: "parity-purchase",
      },
    ],
    expectAgreement: false,
  },
  {
    name: "source cash blocked by a no-observation fallback review in TS but not in SQL",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "unknown" },
    entries: [
      {
        kind: "payment",
        amountMinor: "10000",
        currency: "EUR",
        origin: "source",
        eligible: true,
        accepted: true,
        evidenceCode: "explicitly-paid",
        observationId: "obs-2",
        documentId: "doc-2",
      },
    ],
    reviews: [
      {
        id: "review-2",
        observationId: null,
        documentId: null,
        reason: "unknown-payment",
        blockingScope: "financial",
        status: "open",
        purchaseId: "parity-purchase",
      },
    ],
    expectAgreement: false,
  },
  {
    name: "connection deletion pending unsupports SQL cash but not the TS rule",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "unknown" },
    entries: [
      {
        kind: "payment",
        amountMinor: "10000",
        currency: "EUR",
        origin: "source",
        eligible: true,
        accepted: true,
        evidenceCode: "explicitly-paid",
        observationId: "obs-3",
        documentId: "doc-3",
      },
    ],
    connectionDeletionPending: true,
    expectAgreement: false,
  },
  {
    name: "already-paid purchase with zero remaining cash stays paid in plan but unknown in settlement",
    purchase: { currency: "EUR", totalMinor: "10000", paymentState: "paid" },
    entries: [],
    expectAgreement: false,
  },
];

describe("CORE-1 payment-state parity fork (ext#2, C1)", () => {
  it("scenario catalogue covers agreement and divergence", () => {
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.some((scenario) => scenario.expectAgreement)).toBe(true);
    expect(scenarios.some((scenario) => !scenario.expectAgreement)).toBe(true);
  });

  for (const scenario of scenarios) {
    it(`three-path payment state: ${scenario.name}`, () => {
      const plan = runPlan(scenario);
      const settlement = runTsSettlement(scenario).paymentState;
      const sql = runSqlSettlement(scenario).paymentState;
      const states = { plan, settlement, sql };
      if (scenario.expectAgreement) {
        expect(states).toEqual({ plan, settlement: plan, sql: plan });
      } else {
        // CORE-1 fork: identical facts, at least two rules disagree → CORE-6 required.
        expect(new Set(Object.values(states)).size).toBeGreaterThan(1);
      }
    });
  }

  it("CORE-1 supported-flag parity: SQL transcription vs hasCashProof/restorationEligibility", () => {
    const shared: CashFact = {
      kind: "payment",
      amountMinor: "100",
      currency: "EUR",
      origin: "source",
      eligible: true,
      accepted: true,
      evidenceCode: "explicitly-paid",
      observationId: "obs-x",
      documentId: "doc-x",
    };
    const clean: ReviewFact[] = [];
    const tsSupportedFlag = (entry: CashFact, reviews: ReviewFact[]) => {
      const fact = toCorrectionEventFact(entry, 0);
      return (
        hasCashProof(fact) &&
        restorationEligibility(fact, reviews.map(toReviewFact))
      );
    };
    // Clean facts agree.
    expect(sqlSupportedCash(shared, clean, false)).toBe(
      tsSupportedFlag(shared, clean),
    );
    // user-confirmed short-circuit: SQL true even with a blocking refund-exceeds review
    // (user-confirmed entries carry observation_id NULL per schema; TS still blocks refunds).
    const refundBlockReview: ReviewFact[] = [
      {
        id: "r",
        observationId: null,
        documentId: null,
        reason: "refund-exceeds-payment",
        blockingScope: "financial",
        status: "open",
        purchaseId: "p",
      },
    ];
    const confirmedRefund: CashFact = {
      ...shared,
      kind: "refund",
      origin: "user-confirmed",
      evidenceCode: "manual-confirmation",
      observationId: null,
      documentId: null,
    };
    expect(sqlSupportedCash(confirmedRefund, refundBlockReview, false)).toBe(
      true,
    );
    expect(tsSupportedFlag(confirmedRefund, refundBlockReview)).toBe(false);
    // Connection deletion only exists in the SQL rule.
    expect(sqlSupportedCash(shared, clean, true)).toBe(false);
    expect(tsSupportedFlag(shared, clean)).toBe(true);
    // Fallback review reasons without observation/document ids block only the TS rule.
    const fallbackReview: ReviewFact[] = [
      {
        id: "r2",
        observationId: null,
        documentId: null,
        reason: "unknown-payment",
        blockingScope: "financial",
        status: "open",
        purchaseId: "p",
      },
    ];
    expect(sqlSupportedCash(shared, fallbackReview, false)).toBe(true);
    expect(tsSupportedFlag(shared, fallbackReview)).toBe(false);
  });
});

/**
 * Intended rule (CORE-6 target): one derivePaymentState used by plan.ts,
 * settlement.ts and the recompute SQL produces the same paymentState for
 * identical purchases/entries/reviews. Marked `it.fails` so the suite stays
 * green while the three rules still diverge; CORE-6 flips this to a real
 * assertion.
 */
it.fails(
  "CORE-6 intended rule: plan.ts, settlement.ts and supportedCash SQL agree on every scenario",
  () => {
    for (const scenario of scenarios) {
      const plan = runPlan(scenario);
      const settlement = runTsSettlement(scenario);
      const sql = runSqlSettlement(scenario);
      expect({
        name: scenario.name,
        plan,
        settlement: settlement.paymentState,
        sql: sql.paymentState,
      }).toEqual({
        name: scenario.name,
        plan,
        settlement: plan,
        sql: plan,
      });
    }
  },
);

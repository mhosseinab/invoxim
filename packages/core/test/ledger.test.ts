import { describe, expect, it } from "vitest";
import type { PersistedAiRecord } from "../src/ai/types";
import { planLedgerIngestion } from "../src/ledger/plan";
import type {
  LedgerInput,
  LedgerPlan,
  LedgerSnapshot,
} from "../src/ledger/types";

type RecordWithReferences = PersistedAiRecord & {
  paymentReference?: string | null;
  refundReference?: string | null;
};
const empty = (): LedgerSnapshot => ({
  observations: [],
  purchases: [],
  events: [],
  decisions: [],
});
function input(
  id: string,
  patch: Partial<RecordWithReferences> = {},
  documentType:
    | "receipt"
    | "invoice"
    | "order-confirmation"
    | "refund"
    | "credit-note"
    | "statement" = "receipt",
): LedgerInput {
  return {
    identity: {
      documentId: id,
      contentHash: `hash-${id}`,
      extractionFingerprint: "v1",
    },
    result: {
      status: "accepted",
      documentType,
      warnings: [],
      records: [
        {
          merchant: "Synthetic shop",
          documentDate: "2026-10-01",
          eventDate: "2026-10-01",
          currency: "EUR",
          total: "100.00",
          tax: null,
          invoiceNumber: "I1",
          orderReference: "O1",
          category: "shopping",
          paymentEvidence: "explicitly-paid",
          refundEvidence: "none",
          paymentMethodHint: "card",
          recurringCadence: "unknown",
          paymentAmount: "100.00",
          refundAmount: null,
          storeCreditAmount: null,
          paymentReference: "P1",
          refundReference: null,
          provenance: [],
          ...patch,
        },
      ],
    },
  };
}
function apply(snapshot: LedgerSnapshot, plan: LedgerPlan): LedgerSnapshot {
  return {
    ...snapshot,
    observations: [...snapshot.observations, ...plan.observations],
    purchases: [...snapshot.purchases, ...plan.purchases],
    events: [...snapshot.events, ...plan.events],
  };
}
function sequence(inputs: LedgerInput[]) {
  let state = empty();
  const plans = inputs.map((value) => {
    const plan = planLedgerIngestion(value, state);
    state = apply(state, plan);
    return plan;
  });
  return { state, plans };
}
describe("T12 ledger reconciliation", () => {
  it("LEDGER-01 preserves order/invoice/receipt evidence with one actual payment", () => {
    const { state } = sequence([
      input(
        "order",
        { paymentEvidence: "explicitly-unpaid", paymentAmount: null },
        "order-confirmation",
      ),
      input(
        "invoice",
        { paymentEvidence: "explicitly-unpaid", paymentAmount: null },
        "invoice",
      ),
      input("receipt"),
    ]);
    expect(state.observations).toHaveLength(3);
    expect(state.purchases).toHaveLength(1);
    expect(state.events.map((event) => event.amountMinor)).toEqual([10000]);
  });
  it("LEDGER-02 retains distinct references despite identical merchant/amount/day", () => {
    const { state, plans } = sequence([
      input("a"),
      input("b", {
        invoiceNumber: "I2",
        orderReference: "O2",
        paymentReference: "P2",
      }),
    ]);
    expect(state.purchases).toHaveLength(2);
    expect(state.events).toHaveLength(2);
    expect(plans[1]?.reviews.map((review) => review.reason)).toContain(
      "possible-duplicate",
    );
  });
  it("LEDGER-03 keeps two paid installments and excludes the gross order", () => {
    const { state } = sequence([
      input(
        "order",
        {
          invoiceNumber: null,
          paymentEvidence: "explicitly-unpaid",
          paymentAmount: null,
        },
        "order-confirmation",
      ),
      input("first", {
        invoiceNumber: "I1",
        paymentReference: "P1",
        total: "50.00",
        paymentAmount: "50.00",
      }),
      input("second", {
        invoiceNumber: "I2",
        paymentReference: "P2",
        total: "50.00",
        paymentAmount: "50.00",
      }),
    ]);
    expect(state.purchases).toHaveLength(1);
    expect(state.purchases[0]?.totalMinor).toBe(10000);
    expect(state.events.map((event) => event.amountMinor)).toEqual([
      5000, 5000,
    ]);
  });
  it("LEDGER-04 reissued invoice preserves values and blocks extra payment", () => {
    const { state, plans } = sequence([
      input("first"),
      input("changed", { total: "120.00", paymentAmount: "120.00" }),
    ]);
    expect(state.purchases[0]?.totalMinor).toBe(10000);
    expect(state.events).toHaveLength(1);
    expect(plans[1]?.reviews.map((review) => review.reason)).toContain(
      "invoice-conflict",
    );
  });
  it("LEDGER-05 pending refunds and credit notes do not create cash", () => {
    for (const type of ["refund", "credit-note"] as const) {
      const plan = planLedgerIngestion(
        input(
          type,
          {
            paymentEvidence: "unknown",
            paymentAmount: null,
            refundEvidence: "pending",
            refundAmount: "20.00",
          },
          type,
        ),
        empty(),
      );
      expect(plan.events).toEqual([]);
      expect(plan.observations).toHaveLength(1);
    }
  });
  it("LEDGER-06 independent completed refunds retain original payment and correct net", () => {
    const { state } = sequence([
      input("paid"),
      input(
        "r1",
        {
          paymentEvidence: "unknown",
          paymentAmount: null,
          refundEvidence: "completed",
          refundAmount: "25.00",
          refundReference: "R1",
        },
        "refund",
      ),
      input(
        "r2",
        {
          paymentEvidence: "unknown",
          paymentAmount: null,
          refundEvidence: "completed",
          refundAmount: "75.00",
          refundReference: "R2",
        },
        "refund",
      ),
    ]);
    expect(
      state.events.map((event) => [event.kind, event.amountMinor]),
    ).toEqual([
      ["payment", 10000],
      ["refund", 2500],
      ["refund", 7500],
    ]);
  });
  it("LEDGER-07 statements do not produce purchases or aggregate cash", () => {
    const plan = planLedgerIngestion(
      input("statement", {}, "statement"),
      empty(),
    );
    expect(plan.observations).toHaveLength(1);
    expect(plan.purchases).toEqual([]);
    expect(plan.events).toEqual([]);
  });
  it("LEDGER-08 independently reconciles identical content in tenant-scoped snapshots", () => {
    const first = planLedgerIngestion(input("same"), empty());
    const second = planLedgerIngestion(input("same"), empty());
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(second).toEqual(first);
  });
  it("LEDGER-09 records cash component only, retaining gross mixed-tender purchase", () => {
    const plan = planLedgerIngestion(
      input("mixed", { paymentAmount: "70.00", storeCreditAmount: "30.00" }),
      empty(),
    );
    expect(plan.purchases[0]?.totalMinor).toBe(10000);
    expect(plan.events[0]?.amountMinor).toBe(7000);
    expect(plan.purchases[0]?.paymentState).toBe("paid");
    expect(
      planLedgerIngestion(
        input("credit", { paymentMethodHint: "store-credit" }),
        empty(),
      ).events,
    ).toEqual([]);
  });
  it("replay and exact content across documents have zero additional financial effect", () => {
    const original = input("paid");
    const first = planLedgerIngestion(original, empty());
    const state = apply(empty(), first);
    expect(planLedgerIngestion(original, state).events).toEqual([]);
    const second = {
      ...original,
      identity: {
        ...original.identity,
        documentId: "other",
        extractionFingerprint: "v2",
      },
    };
    const plan = planLedgerIngestion(second, state);
    expect(plan.observations).toHaveLength(1);
    expect(plan.events).toEqual([]);
    expect(plan.evidence[0]?.purchaseId).toBe(first.purchases[0]?.id);
  });
  it("same event reference conflicts remain reviewable", () => {
    const { plans, state } = sequence([
      input("first"),
      input("changed", { invoiceNumber: "I2", paymentAmount: "50.00" }),
    ]);
    expect(state.events).toHaveLength(1);
    expect(plans[1]?.reviews.map((review) => review.reason)).toContain(
      "event-conflict",
    );
  });
  it("same order without distinct cash references never invents a second event", () => {
    const { plans, state } = sequence([
      input("first", { paymentReference: null }),
      input("second", { invoiceNumber: "I2", paymentReference: null }),
    ]);
    expect(state.events).toHaveLength(1);
    expect(plans[1]?.reviews.map((review) => review.reason)).toContain(
      "ambiguous-event",
    );
  });
  it("manual overrides and existing versions survive extraction", () => {
    const first = planLedgerIngestion(input("first"), empty());
    const state = apply(empty(), first);
    const purchase = state.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const overridden = {
      ...state,
      purchases: [
        {
          ...purchase,
          totalMinor: 12345,
          category: "other" as const,
          version: 4,
          overriddenFields: ["totalMinor", "category"] as const,
        },
      ],
    };
    const plan = planLedgerIngestion(input("later"), overridden);
    expect(plan.purchases).toEqual([]);
    expect(overridden.purchases[0]?.totalMinor).toBe(12345);
    expect(overridden.purchases[0]?.version).toBe(4);
    expect(plan.events).toEqual([]);
  });
  it("failed extraction produces only a bounded review", () => {
    const plan = planLedgerIngestion(
      {
        identity: input("bad").identity,
        result: { status: "needs-review", reason: "evidence" },
      },
      empty(),
    );
    expect(plan.reviews[0]?.reason).toBe("extraction-review");
    expect(plan.events).toEqual([]);
  });
  it("invalid refund magnitude cannot leave a partial cash payment plan", () => {
    const plan = planLedgerIngestion(
      input("invalid", {
        refundEvidence: "completed",
        refundAmount: "9999999999999.00",
      }),
      empty(),
    );
    expect(plan.events).toEqual([]);
    expect(plan.reviews[0]?.reason).toBe("incomplete-financial-facts");
  });
  it("receipt projects existing unpaid invoice without touching its gross fields", () => {
    const before = sequence([
      input(
        "invoice",
        { paymentEvidence: "explicitly-unpaid", paymentAmount: null },
        "invoice",
      ),
    ]).state;
    const purchase = before.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const plan = planLedgerIngestion(input("receipt"), before);
    expect(plan.paymentStates).toEqual([
      { purchaseId: purchase.id, expectedVersion: 1, paymentState: "paid" },
    ]);
    expect(plan.expectedPurchases).toEqual([{ id: purchase.id, version: 1 }]);
    expect(plan.purchases).toEqual([]);
  });
  it("a strong cash reference links evidence even without order or invoice references", () => {
    const first = sequence([
      input("first", { invoiceNumber: null, orderReference: null }),
    ]).state;
    const plan = planLedgerIngestion(
      input("later", { invoiceNumber: null, orderReference: null }),
      first,
    );
    expect(plan.purchases).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(plan.evidence[0]?.purchaseId).toBe(first.purchases[0]?.id);
  });
  it("a later full order exposes conflicting gross instead of silently replacing an installment total", () => {
    const state = sequence([
      input("installment", { total: "50.00", paymentAmount: "50.00" }),
    ]).state;
    const plan = planLedgerIngestion(
      input(
        "late-order",
        {
          invoiceNumber: null,
          paymentEvidence: "explicitly-unpaid",
          paymentAmount: null,
        },
        "order-confirmation",
      ),
      state,
    );
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "purchase-conflict",
    );
    expect(plan.purchases).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(state.purchases[0]?.totalMinor).toBe(5000);
  });
  it("strong purchase references produce one deterministic identity across concurrent empty snapshots", () => {
    const one = planLedgerIngestion(input("first-source"), empty());
    const two = planLedgerIngestion(input("second-source"), empty());
    expect(one.purchases[0]?.id).toBe(two.purchases[0]?.id);
  });
  it("re-extraction changing a proposed cash reference cannot double-count identical bytes", () => {
    const original = input("first");
    const state = sequence([original]).state;
    const changed = input("new-version", {
      paymentReference: "NEW-PROPOSED-REF",
    });
    const plan = planLedgerIngestion(
      {
        ...changed,
        identity: {
          ...changed.identity,
          contentHash: original.identity.contentHash,
        },
      },
      state,
    );
    expect(plan.events).toEqual([]);
  });
  it("review P1 conflicting invoice totals inside one extraction cannot create two payments", () => {
    const first = input("combined");
    const second = input("other", {
      total: "120.00",
      paymentAmount: "120.00",
      paymentReference: "P2",
    });
    if (
      first.result.status !== "accepted" ||
      second.result.status !== "accepted"
    )
      throw new Error("Missing accepted fixture");
    const plan = planLedgerIngestion(
      {
        ...first,
        result: {
          ...first.result,
          records: [...first.result.records, ...second.result.records],
        },
      },
      empty(),
    );
    expect(plan.events.map((event) => event.amountMinor)).toEqual([10000]);
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "invoice-conflict",
    );
    expect(plan.observations).toHaveLength(2);
  });
  it("review P2 refund document total is independent of its original invoice gross", () => {
    const state = sequence([input("paid")]).state;
    const plan = planLedgerIngestion(
      input(
        "partial-refund",
        {
          total: "25.00",
          paymentEvidence: "unknown",
          paymentAmount: null,
          paymentReference: null,
          refundEvidence: "completed",
          refundAmount: "25.00",
          refundReference: "R25",
        },
        "refund",
      ),
      state,
    );
    expect(plan.events.map((event) => [event.kind, event.amountMinor])).toEqual(
      [["refund", 2500]],
    );
    expect(plan.reviews).toEqual([]);
    expect(plan.purchases).toEqual([]);
  });
  it("review P2 immutable evidence links a later receipt after a manual merchant rename", () => {
    const state = sequence([
      input(
        "invoice",
        {
          paymentEvidence: "explicitly-unpaid",
          paymentAmount: null,
          paymentReference: null,
        },
        "invoice",
      ),
    ]).state;
    const purchase = state.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const edited = {
      ...state,
      purchases: [
        {
          ...purchase,
          merchant: "My renamed shop",
          version: 7,
          overriddenFields: ["merchant"] as const,
        },
      ],
    };
    const plan = planLedgerIngestion(input("receipt"), edited);
    expect(plan.purchases).toEqual([]);
    expect(plan.evidence[0]?.purchaseId).toBe(purchase.id);
    expect(plan.expectedPurchases).toEqual([{ id: purchase.id, version: 7 }]);
    expect(plan.events).toHaveLength(1);
    expect(edited.purchases[0]?.merchant).toBe("My renamed shop");
  });
  it("legacy invoice baseline rejects changed gross without structured observations", () => {
    const state = sequence([input("legacy")]).state;
    const plan = planLedgerIngestion(
      input("reissue", {
        total: "120.00",
        paymentAmount: "120.00",
        paymentReference: "P2",
      }),
      { ...state, observations: [] },
    );
    expect(plan.events).toEqual([]);
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "invoice-conflict",
    );
  });
  it("legacy manually edited gross is preserved but cannot authorize a new cash event", () => {
    const state = sequence([input("legacy")]).state;
    const purchase = state.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const edited = {
      ...state,
      observations: [],
      purchases: [
        {
          ...purchase,
          totalMinor: 12345,
          overriddenFields: ["totalMinor"] as const,
          version: 4,
        },
      ],
    };
    const duplicate = planLedgerIngestion(input("duplicate"), edited);
    expect(duplicate.events).toEqual([]);
    expect(duplicate.reviews.map((item) => item.reason)).not.toContain(
      "invoice-conflict",
    );
    const plan = planLedgerIngestion(
      input("new-cash", { paymentReference: "P2" }),
      edited,
    );
    expect(plan.events).toEqual([]);
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "ambiguous-event",
    );
    expect(edited.purchases[0]?.totalMinor).toBe(12345);
    expect(plan.purchases).toEqual([]);
  });
  it("legacy currency override is a financial correction like a total override", () => {
    const state = sequence([input("legacy")]).state;
    const purchase = state.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const edited = {
      ...state,
      observations: [],
      purchases: [
        {
          ...purchase,
          overriddenFields: ["currency"] as const,
          version: 4,
        },
      ],
    };
    const duplicate = planLedgerIngestion(
      input("reissue", {
        total: "120.00",
        paymentAmount: "120.00",
        paymentReference: "P2",
      }),
      edited,
    );
    expect(duplicate.reviews.map((item) => item.reason)).not.toContain(
      "invoice-conflict",
    );
    const plan = planLedgerIngestion(
      input("new-cash", { paymentReference: "P2" }),
      edited,
    );
    expect(plan.events).toEqual([]);
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "ambiguous-event",
    );
  });
  it("currency override suppresses order-confirmation gross conflict", () => {
    const state = sequence([
      input("installment", { total: "50.00", paymentAmount: "50.00" }),
    ]).state;
    const purchase = state.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const edited = {
      ...state,
      purchases: [
        {
          ...purchase,
          overriddenFields: ["currency"] as const,
          version: 2,
        },
      ],
    };
    const plan = planLedgerIngestion(
      input(
        "late-order",
        {
          invoiceNumber: null,
          paymentEvidence: "explicitly-unpaid",
          paymentAmount: null,
        },
        "order-confirmation",
      ),
      edited,
    );
    expect(plan.reviews.map((item) => item.reason)).not.toContain(
      "purchase-conflict",
    );
  });
  it("legacy unknown event identities cannot be supplemented with a possibly duplicate new reference", () => {
    const state = sequence([input("legacy")]).state;
    const legacy = {
      ...state,
      observations: [],
      events: state.events.map((event) => ({
        ...event,
        businessKey: "legacy-import-1",
      })),
    };
    const plan = planLedgerIngestion(
      input("new-source", { paymentReference: "P2" }),
      legacy,
    );
    expect(plan.events).toEqual([]);
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "ambiguous-event",
    );
  });
  it("content-only replay with changed purchase identity stays unlinked in financial review", () => {
    const original = input("original", { paymentReference: null });
    const state = sequence([original]).state;
    const changed = input("changed", {
      merchant: "Different shop",
      orderReference: "O2",
      invoiceNumber: "I2",
      paymentReference: null,
    });
    const plan = planLedgerIngestion(
      {
        ...changed,
        identity: {
          ...changed.identity,
          contentHash: original.identity.contentHash,
          extractionFingerprint: "v2",
        },
      },
      state,
    );
    expect(plan.reviews.map((item) => item.reason)).toContain(
      "purchase-conflict",
    );
    expect(plan.events).toEqual([]);
    expect(plan.purchases).toEqual([]);
    expect(plan.evidence).toEqual([]);
    expect(plan.observations[0]?.purchaseId).toBeNull();
    expect(state.purchases[0]?.merchant).toBe("Synthetic shop");
  });
  it("unchanged content-only reprocessing retains its purchase and produces no review", () => {
    const original = input("original", { paymentReference: null });
    const state = sequence([original]).state;
    const plan = planLedgerIngestion(
      {
        ...original,
        identity: { ...original.identity, extractionFingerprint: "v2" },
      },
      state,
    );
    expect(plan.reviews).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(plan.evidence[0]?.purchaseId).toBe(state.purchases[0]?.id);
  });
  it("strong cash references permit reordered records without content-slot conflicts", () => {
    const first = input("combined");
    const second = input("second", {
      merchant: "Second shop",
      orderReference: "O2",
      invoiceNumber: "I2",
      paymentReference: "P2",
    });
    if (
      first.result.status !== "accepted" ||
      second.result.status !== "accepted"
    )
      throw new Error("Missing accepted fixture");
    const combined = {
      ...first,
      result: {
        ...first.result,
        records: [...first.result.records, ...second.result.records],
      },
    };
    const state = sequence([combined]).state;
    const plan = planLedgerIngestion(
      {
        ...combined,
        identity: { ...combined.identity, extractionFingerprint: "v2" },
        result: {
          ...combined.result,
          records: [...combined.result.records].reverse(),
        },
      },
      state,
    );
    expect(plan.reviews).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(plan.purchases).toEqual([]);
    expect(plan.observations.map((item) => item.purchaseId)).toEqual(
      [...state.purchases].reverse().map((item) => item.id),
    );
  });
  it("fully redeemed store credit settles a purchase without cash ledger entries", () => {
    const plan = planLedgerIngestion(
      input("full-credit", {
        paymentMethodHint: "store-credit",
        paymentAmount: null,
        storeCreditAmount: "100.00",
      }),
      empty(),
    );
    expect(plan.purchases[0]?.paymentState).toBe("paid");
    expect(plan.events).toEqual([]);
    expect(plan.reviews).toEqual([]);
  });
  it("partial cash installment remains partially paid against gross total", () => {
    const plan = planLedgerIngestion(
      input("installment", { paymentAmount: "50.00" }),
      empty(),
    );
    expect(plan.purchases[0]?.paymentState).toBe("partially_paid");
    expect(plan.events[0]?.amountMinor).toBe(5000);
  });
  it("ambiguous credit redemption remains financial review rather than full settlement", () => {
    const plan = planLedgerIngestion(
      input("unclear-credit", {
        paymentMethodHint: "store-credit",
        paymentAmount: null,
        storeCreditAmount: "30.00",
      }),
      empty(),
    );
    expect(plan.purchases[0]?.paymentState).not.toBe("paid");
    expect(plan.events).toEqual([]);
    expect(plan.reviews.map((item) => item.reason)).toContain("mixed-tender");
  });
  it("mixed settlement never overwrites a manual payment-state override", () => {
    const state = sequence([
      input(
        "invoice",
        { paymentEvidence: "explicitly-unpaid", paymentAmount: null },
        "invoice",
      ),
    ]).state;
    const purchase = state.purchases[0];
    if (!purchase) throw new Error("Missing purchase");
    const edited = {
      ...state,
      purchases: [
        {
          ...purchase,
          paymentState: "unpaid" as const,
          overriddenFields: ["paymentState"] as const,
          version: 4,
        },
      ],
    };
    const plan = planLedgerIngestion(
      input("mixed", { paymentAmount: "70.00", storeCreditAmount: "30.00" }),
      edited,
    );
    expect(plan.paymentStates).toEqual([
      { purchaseId: purchase.id, expectedVersion: 4, paymentState: "unpaid" },
    ]);
    expect(plan.events[0]?.amountMinor).toBe(7000);
  });
});

describe("T14 corrected cash replay", () => {
  function corrected() {
    const original = input("corrected-source");
    const plan = planLedgerIngestion(original, empty());
    return {
      original,
      state: {
        ...apply(empty(), plan),
        events: plan.events.map((event) =>
          Object.assign({}, event, {
            amountMinor: 4500,
            origin: "source" as const,
            sourceValues: { amountMinor: 10000 },
          }),
        ),
      },
    };
  }
  it("EDIT-01 unchanged original evidence preserves corrected event without a duplicate or reopened conflict", () => {
    const { original, state } = corrected();
    const replay = planLedgerIngestion(
      {
        ...original,
        identity: { ...original.identity, extractionFingerprint: "v2" },
      },
      state,
    );
    expect(replay.events).toEqual([]);
    expect(
      replay.reviews.some((item) => item.reason === "event-conflict"),
    ).toBe(false);
    expect(state.events.map((event) => event.amountMinor)).toEqual([4500]);
  });
  it("EDIT-01 a genuinely changed source still conflicts with the recorded original while preserving corrected cash", () => {
    const { state } = corrected();
    const replay = planLedgerIngestion(
      input("changed-source", { paymentAmount: "120.00" }),
      state,
    );
    expect(replay.events).toEqual([]);
    expect(
      replay.reviews.some((item) => item.reason === "event-conflict"),
    ).toBe(true);
    expect(state.events.map((event) => event.amountMinor)).toEqual([4500]);
  });
  it("EDIT-03 later source proof cannot silently add a second payment beside explicit user-confirmed cash", () => {
    const { original, state } = corrected();
    const manual = {
      ...state,
      events: state.events.map((event) =>
        Object.assign({}, event, {
          businessKey: "manual:owned-command",
          origin: "user-confirmed" as const,
          observationId: null,
          sourceValues: {},
        }),
      ),
    };
    const replay = planLedgerIngestion(input("later-proof"), manual);
    expect(replay.events).toEqual([]);
    expect(
      replay.reviews.some((item) => item.reason === "ambiguous-event"),
    ).toBe(true);
    expect(original.result.status).toBe("accepted");
  });
});

it("T14 EDIT-01 user-cleared document fields remain unknown during reprocessing without creating a replacement purchase", () => {
  const original = input("nullable-corrected");
  const initial = planLedgerIngestion(original, empty());
  const state = apply(empty(), initial);
  const corrected = {
    ...state,
    purchases: state.purchases.map((purchase) =>
      Object.assign({}, purchase, {
        currency: "EUR",
        totalMinor: null,
        paymentState: "unknown" as const,
        overriddenFields: ["totalMinor"] as const,
      }),
    ),
  };
  const replay = planLedgerIngestion(
    input("later-installment", {
      paymentReference: "P2",
      paymentAmount: "50.00",
    }),
    corrected,
  );
  expect(replay.purchases).toEqual([]);
  expect(replay.events.map((event) => event.amountMinor)).toEqual([5000]);
  expect(
    replay.paymentStates.every((state) => state.paymentState === "unknown"),
  ).toBe(true);
});

it("T14 corrected partial cash cannot become fully paid when unchanged full-payment evidence is reprocessed", () => {
  const source = input("corrected-partial");
  const original = planLedgerIngestion(source, empty());
  const state = apply(empty(), original);
  const purchase = state.purchases[0];
  const event = state.events[0];
  if (!purchase || !event) throw new Error("missing synthetic payment");
  const corrected: LedgerSnapshot = {
    ...state,
    purchases: [{ ...purchase, paymentState: "partially_paid", version: 2 }],
    events: [
      {
        ...event,
        amountMinor: 4500,
        version: 2,
        sourceValues: { amountMinor: 10000 },
      },
    ],
  };
  const replay = {
    ...source,
    identity: { ...source.identity, extractionFingerprint: "v2" },
  };
  const plan = planLedgerIngestion(replay, corrected);
  expect(plan.events).toEqual([]);
  expect(
    plan.paymentStates.every((update) => update.paymentState !== "paid"),
  ).toBe(true);
});

it("T14 a manually completed source record is reused after extraction becomes complete", () => {
  const source = input("manual-complete", {
    invoiceNumber: null,
    orderReference: null,
  });
  const original = planLedgerIngestion(source, empty());
  const purchase = original.purchases[0];
  if (!purchase) throw new Error("missing synthetic purchase");
  const state: LedgerSnapshot = {
    ...empty(),
    purchases: [
      {
        ...purchase,
        id: "manual-record",
        merchant: "User merchant",
        overriddenFields: [
          "merchant",
          "totalMinor",
          "documentDate",
          "currency",
        ] as const,
        paymentState: "unknown",
      },
    ],
    manualEvidence: [
      { contentHash: source.identity.contentHash, purchaseId: "manual-record" },
    ],
  };
  const plan = planLedgerIngestion(source, state);
  expect(plan.purchases).toEqual([]);
  expect(
    plan.evidence.every((item) => item.purchaseId === "manual-record"),
  ).toBe(true);
  expect(plan.expectedPurchases).toContainEqual({
    id: "manual-record",
    version: 1,
  });
});

it("T14 a multirecord extraction cannot guess which segment a manually completed document described", () => {
  const source = input("manual-multiple");
  if (source.result.status !== "accepted")
    throw new Error("missing synthetic extraction");
  const original = planLedgerIngestion(source, empty());
  const purchase = original.purchases[0];
  if (!purchase) throw new Error("missing synthetic purchase");
  const first = source.result.records[0];
  if (!first) throw new Error("missing synthetic record");
  const multi: LedgerInput = {
    ...source,
    result: {
      ...source.result,
      records: [
        ...source.result.records,
        {
          ...first,
          merchant: "Second shop",
          invoiceNumber: "I2",
          orderReference: "O2",
          paymentReference: "P2",
        },
      ],
    },
  };
  const state: LedgerSnapshot = {
    ...empty(),
    purchases: [purchase],
    manualEvidence: [
      { contentHash: source.identity.contentHash, purchaseId: purchase.id },
    ],
  };
  const plan = planLedgerIngestion(multi, state);
  expect(plan.purchases).toEqual([]);
  expect(plan.events).toEqual([]);
  expect(plan.reviews.map((item) => item.reason)).toContain(
    "purchase-conflict",
  );
});

it("T14 new source installments preserve the purchase exclusion decision", () => {
  const first = planLedgerIngestion(
    input("excluded-first", { paymentAmount: "50.00" }),
    empty(),
  );
  const state = apply(empty(), first);
  const excluded: LedgerSnapshot = {
    ...state,
    purchases: state.purchases.map((purchase) => ({
      ...purchase,
      recordStatus: "excluded",
      version: 2,
    })),
    events: state.events.map((event) => ({ ...event, eligible: false })),
  };
  const later = planLedgerIngestion(
    input("excluded-second", {
      paymentAmount: "50.00",
      paymentReference: "P2",
    }),
    excluded,
  );
  expect(later.events).toHaveLength(1);
  expect(later.events[0]?.eligible).toBe(false);
  expect(later.purchases).toEqual([]);
});

describe("OQ-A ingestion recomputes payment state from current cash and credit", () => {
  function creditPaid() {
    const plan = planLedgerIngestion(
      input("credit-paid", {
        paymentMethodHint: "store-credit",
        paymentAmount: null,
        storeCreditAmount: "100.00",
      }),
      empty(),
    );
    const state = apply(empty(), plan);
    const purchase = state.purchases[0];
    if (purchase?.paymentState !== "paid")
      throw new Error("missing credit-paid synthetic purchase");
    return { state, purchase };
  }
  const installment = () =>
    input("later-cash", { paymentAmount: "10.00", paymentReference: "P2" });
  const proof = (purchaseId: string) => ({
    purchaseId,
    currency: "EUR",
    totalMinor: "10000",
    creditMinor: "10000",
  });
  it("a persisted credit proof keeps a credit-settled purchase paid when later cash arrives", () => {
    const { state, purchase } = creditPaid();
    const plan = planLedgerIngestion(installment(), {
      ...state,
      creditProofs: [proof(purchase.id)],
    });
    expect(plan.events.map((event) => event.amountMinor)).toEqual([1000]);
    expect(plan.paymentStates).toEqual([
      { purchaseId: purchase.id, expectedVersion: 1, paymentState: "paid" },
    ]);
  });
  it("adversarial: another purchase's credit proof does not settle it and stored 'paid' is not retained", () => {
    const { state, purchase } = creditPaid();
    const plan = planLedgerIngestion(installment(), {
      ...state,
      creditProofs: [proof("another-purchase")],
    });
    expect(plan.paymentStates).toEqual([
      {
        purchaseId: purchase.id,
        expectedVersion: 1,
        paymentState: "partially_paid",
      },
    ]);
  });
});

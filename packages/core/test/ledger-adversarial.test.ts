import { expect, it } from "vitest";
import type { PersistableAiResult, PersistedAiRecord } from "../src/ai/types";
import { planLedgerIngestion } from "../src/ledger/plan";
import type {
  LedgerInput,
  LedgerPlan,
  LedgerSnapshot,
} from "../src/ledger/types";

const empty = (): LedgerSnapshot => ({
  observations: [],
  purchases: [],
  events: [],
  decisions: [],
});
function input(
  id: string,
  patch: Partial<PersistedAiRecord> = {},
  type: Extract<
    PersistableAiResult,
    { status: "accepted" }
  >["documentType"] = "receipt",
): LedgerInput {
  return {
    identity: {
      documentId: id,
      contentHash: `hash-${id}`,
      extractionFingerprint: "qa-v1",
    },
    result: {
      status: "accepted",
      documentType: type,
      warnings: [],
      records: [
        {
          merchant: "QA Shop",
          documentDate: "2026-10-01",
          eventDate: "2026-10-01",
          currency: "EUR",
          total: "100.00",
          tax: null,
          invoiceNumber: null,
          orderReference: "QA-ORDER",
          paymentReference: "QA-PAY",
          refundReference: null,
          category: "shopping",
          paymentEvidence: "explicitly-paid",
          refundEvidence: "none",
          paymentMethodHint: "card",
          recurringCadence: "unknown",
          paymentAmount: "100.00",
          refundAmount: null,
          storeCreditAmount: null,
          provenance: [],
          ...patch,
        },
      ],
    },
  };
}
function apply(state: LedgerSnapshot, plan: LedgerPlan): LedgerSnapshot {
  return {
    observations: [...state.observations, ...plan.observations],
    purchases: [...state.purchases, ...plan.purchases].map((purchase) => {
      const update = plan.paymentStates?.find(
        (value) => value.purchaseId === purchase.id,
      );
      return update
        ? {
            ...purchase,
            paymentState: update.paymentState,
            version: purchase.version + 1,
          }
        : purchase;
    }),
    events: [...state.events, ...plan.events],
    decisions: state.decisions,
  };
}
function sequence(inputs: readonly LedgerInput[]) {
  let state = empty();
  const plans: LedgerPlan[] = [];
  for (const value of inputs) {
    const plan = planLedgerIngestion(value, state);
    plans.push(plan);
    state = apply(state, plan);
  }
  return { state, plans };
}
const net = (state: LedgerSnapshot) =>
  state.events
    .filter((e) => e.eligible)
    .reduce(
      (total, e) =>
        total +
        (e.kind === "payment" ? BigInt(e.amountMinor) : -BigInt(e.amountMinor)),
      0n,
    );

it("LEDGER-01 retains order/invoice/receipt evidence and counts only the actual payment", () => {
  const { state, plans } = sequence([
    input(
      "order",
      {
        paymentEvidence: "unknown",
        paymentAmount: null,
        paymentReference: null,
      },
      "order-confirmation",
    ),
    input(
      "invoice",
      {
        invoiceNumber: "INV-1",
        paymentEvidence: "explicitly-unpaid",
        paymentAmount: null,
        paymentReference: null,
      },
      "invoice",
    ),
    input("receipt", { invoiceNumber: "INV-1" }),
  ]);
  expect(state.purchases).toHaveLength(1);
  expect(state.observations).toHaveLength(3);
  expect(plans.flatMap((p) => p.evidence)).toHaveLength(3);
  expect(state.events).toHaveLength(1);
  expect(net(state)).toBe(10000n);
});

it("LEDGER-02 weak equal transactions with different references stay distinct", () => {
  const { state } = sequence([
    input("a", { orderReference: "A", paymentReference: "PAY-A" }),
    input("b", { orderReference: "B", paymentReference: "PAY-B" }),
  ]);
  expect(state.purchases).toHaveLength(2);
  expect(state.events).toHaveLength(2);
  expect(net(state)).toBe(20000n);
});
it("LEDGER-03 two independently identified installments never count the order total", () => {
  const { state } = sequence([
    input(
      "order",
      {
        paymentEvidence: "unknown",
        paymentAmount: null,
        paymentReference: null,
      },
      "order-confirmation",
    ),
    input("first", {
      paymentAmount: "50.00",
      paymentReference: "INSTALLMENT-1",
    }),
    input("second", {
      paymentAmount: "50.00",
      paymentReference: "INSTALLMENT-2",
      eventDate: "2026-10-02",
    }),
  ]);
  expect(state.purchases).toHaveLength(1);
  expect(state.events.map((e) => e.amountMinor)).toEqual([5000, 5000]);
  expect(net(state)).toBe(10000n);
});
it("LEDGER-04 changed invoice preserves the previous value and manual category", () => {
  const first = input(
    "original",
    {
      invoiceNumber: "INV-1",
      paymentEvidence: "explicitly-unpaid",
      paymentAmount: null,
    },
    "invoice",
  );
  const base = sequence([first]).state;
  const state = {
    ...base,
    purchases: base.purchases.map((p) => ({
      ...p,
      category: "groceries" as const,
      overriddenFields: ["category"],
    })),
  };
  const before = JSON.stringify(state);
  const plan = planLedgerIngestion(
    input(
      "reissued",
      {
        invoiceNumber: "INV-1",
        total: "120.00",
        paymentAmount: null,
        paymentEvidence: "explicitly-unpaid",
      },
      "invoice",
    ),
    state,
  );
  expect(JSON.stringify(state)).toBe(before);
  expect(plan.purchases).toEqual([]);
  expect(plan.events).toEqual([]);
  expect(plan.reviews.some((r) => r.reason === "invoice-conflict")).toBe(true);
  expect(state.purchases[0]).toMatchObject({
    totalMinor: 10000,
    category: "groceries",
  });
});
it.each(["pending", "unknown", "none"] as const)(
  "LEDGER-05 incomplete refund %s adds no cash event",
  (refundEvidence) => {
    const { state } = sequence([
      input("paid"),
      input(
        "refund",
        {
          paymentEvidence: "unknown",
          paymentAmount: null,
          paymentReference: null,
          refundEvidence,
          refundAmount: "25.00",
        },
        refundEvidence === "none" ? "credit-note" : "refund",
      ),
    ]);
    expect(state.events).toHaveLength(1);
    expect(net(state)).toBe(10000n);
  },
);
it("LEDGER-06 distinct completed partial refunds preserve the payment and replay safely", () => {
  const refund = (id: string, amount: string) =>
    input(
      id,
      {
        paymentEvidence: "unknown",
        paymentAmount: null,
        paymentReference: null,
        refundEvidence: "completed",
        refundAmount: amount,
        refundReference: id,
        eventDate: "2026-10-02",
      },
      "refund",
    );
  const values = [
    input("paid"),
    refund("refund-1", "25.00"),
    refund("refund-2", "75.00"),
  ];
  const { state } = sequence(values);
  expect(state.events.map((e) => [e.kind, e.amountMinor])).toEqual([
    ["payment", 10000],
    ["refund", 2500],
    ["refund", 7500],
  ]);
  expect(net(state)).toBe(0n);
  for (const value of values)
    expect(planLedgerIngestion(value, state).events).toEqual([]);
});
it("LEDGER-07 statement aggregation has no extra purchase or payment", () => {
  const { state } = sequence([
    input("paid"),
    input(
      "statement",
      { total: "500.00", paymentAmount: "500.00" },
      "statement",
    ),
  ]);
  expect(state.purchases).toHaveLength(1);
  expect(state.events).toHaveLength(1);
  expect(net(state)).toBe(10000n);
});
it("LEDGER-09 mixed tender keeps gross total and only the card amount", () => {
  const { state } = sequence([
    input("mixed", { paymentAmount: "70.00", storeCreditAmount: "30.00" }),
  ]);
  expect(state.purchases[0]?.totalMinor).toBe(10000);
  expect(state.purchases[0]?.paymentState).toBe("paid");
  expect(state.events).toHaveLength(1);
  expect(net(state)).toBe(7000n);
});
it("replay, exact content and strong event identity retain one financial event", () => {
  const paid = input("paid"),
    first = sequence([paid]).state;
  const identical = {
    ...paid,
    identity: { ...paid.identity, documentId: "forwarded" },
  };
  const repeated = input("resent", { paymentReference: "QA-PAY" });
  for (const value of [paid, identical, repeated]) {
    const plan = planLedgerIngestion(value, first);
    expect(plan.events).toEqual([]);
    expect(plan.purchases).toEqual([]);
  }
});
it("unidentified second cash event cannot collapse or inflate an existing payment", () => {
  const { state } = sequence([input("paid", { paymentReference: null })]);
  const plan = planLedgerIngestion(
    input("ambiguous", { paymentReference: null }),
    state,
  );
  expect(plan.events).toEqual([]);
  expect(plan.reviews.some((r) => r.reason === "ambiguous-event")).toBe(true);
});
it.each([
  ["101.00", "EUR", "refund-exceeds-payment"],
  ["25.00", "USD", "refund-currency-mismatch"],
] as const)(
  "LEDGER-06 invalid refund %s %s remains review without modifying payments",
  (refundAmount, currency, reason) => {
    const state = sequence([input("paid")]).state;
    const plan = planLedgerIngestion(
      input(
        "invalid-refund",
        {
          currency,
          refundAmount,
          refundReference: "REFUND-INVALID",
          paymentEvidence: "unknown",
          paymentAmount: null,
          paymentReference: null,
          refundEvidence: "completed",
        },
        "refund",
      ),
      state,
    );
    expect(plan.events).toEqual([]);
    expect(plan.reviews.some((r) => r.reason === reason)).toBe(true);
    expect(net(state)).toBe(10000n);
  },
);
it("LEDGER-09 missing mixed-tender cash magnitude stays in financial review", () => {
  const plan = planLedgerIngestion(
    input("ambiguous-mixed", {
      paymentAmount: null,
      storeCreditAmount: "30.00",
    }),
    empty(),
  );
  expect(plan.events).toEqual([]);
  expect(plan.reviews.some((r) => r.blockingScope === "financial")).toBe(true);
});
it("manual different-purchase decision survives a strong-reference rescan", () => {
  const state = sequence([input("paid")]).state,
    next = input("different", { paymentReference: "DIFFERENT-PAY" });
  const purchase = state.purchases[0];
  if (!purchase) throw new Error("Missing positive control purchase");
  const snapshot: LedgerSnapshot = {
    ...state,
    decisions: [
      {
        contentHash: next.identity.contentHash,
        segmentIndex: 0,
        purchaseId: purchase.id,
        decision: "different-purchase",
      },
    ],
  };
  const plan = planLedgerIngestion(next, snapshot);
  expect(plan.purchases).toHaveLength(1);
  expect(plan.purchases[0]?.id).not.toBe(purchase.id);
  expect(plan.events).toHaveLength(1);
});
it("evidence ordering changes no final payment total or purchase count", () => {
  const order = input(
    "order",
    { paymentEvidence: "unknown", paymentAmount: null, paymentReference: null },
    "order-confirmation",
  );
  const invoice = input(
    "invoice",
    {
      invoiceNumber: "INV-1",
      paymentEvidence: "explicitly-unpaid",
      paymentAmount: null,
      paymentReference: null,
    },
    "invoice",
  );
  const receipt = input("receipt", { invoiceNumber: "INV-1" });
  for (const values of [
    [order, invoice, receipt],
    [order, receipt, invoice],
    [invoice, order, receipt],
    [invoice, receipt, order],
    [receipt, order, invoice],
    [receipt, invoice, order],
  ]) {
    const { state } = sequence(values);
    expect(state.purchases).toHaveLength(1);
    expect(state.observations).toHaveLength(3);
    expect(state.events).toHaveLength(1);
    expect(net(state)).toBe(10000n);
  }
});

it("LEDGER-09 full redeemed store credit settles an existing unpaid purchase without a cash entry", () => {
  const state = sequence([
    input(
      "unpaid",
      {
        paymentAmount: null,
        paymentEvidence: "explicitly-unpaid",
        paymentReference: null,
      },
      "invoice",
    ),
  ]).state;
  const plan = planLedgerIngestion(
    input("credit-paid", {
      paymentAmount: "0.00",
      storeCreditAmount: "100.00",
      paymentMethodHint: "store-credit",
      paymentReference: null,
    }),
    state,
  );
  expect(plan.events).toEqual([]);
  expect(plan.paymentStates).toEqual([
    {
      purchaseId: state.purchases[0]?.id,
      expectedVersion: state.purchases[0]?.version,
      paymentState: "paid",
    },
  ]);
});

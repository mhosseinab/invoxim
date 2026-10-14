import type {
  ProfileView,
  PurchaseCoverage,
  PurchaseDetail,
  PurchaseListResponse,
  PurchaseReview,
  PurchaseSummary,
  PurchaseView,
} from "@invoxim/contracts";
import type { Page } from "@playwright/test";
import { type MockedRequest, mockApi } from "./mock-api";

export const history: PurchaseView = {
  id: "qa-history",
  origin: "source",
  recordStatus: "active",
  merchant: "QA history",
  date: "2026-01-10",
  invoiceReference: "QA-I1",
  orderReference: "QA-O1",
  category: "shopping",
  currency: "EUR",
  documentTotalMinor: "12000",
  paymentState: "paid",
  version: 1,
  evidenceCount: 3,
  reviewReasons: [],
  lifecycle: [
    {
      currency: "EUR",
      paidMinor: "12000",
      refundedMinor: "3000",
      netMinor: "9000",
    },
  ],
  period: [
    {
      currency: "EUR",
      paidMinor: "0",
      refundedMinor: "3000",
      netMinor: "-3000",
    },
  ],
};
export const question: PurchaseView = {
  ...history,
  id: "qa-question",
  merchant: "QA question invoice",
  date: "2026-10-10",
  invoiceReference: "QA-I2",
  orderReference: null,
  documentTotalMinor: "8000",
  paymentState: "unknown",
  evidenceCount: 1,
  reviewReasons: ["unknown-payment"],
  lifecycle: [],
  period: [],
};
export const coverage: PurchaseCoverage = {
  readyPurchaseCount: 2,
  openReviewCount: 1,
  connections: [
    {
      id: "qa-mailbox",
      address: "qa-mail@example.invalid",
      provider: "gmail",
      state: "connected",
      schedulingState: "active",
      pendingJobs: 3,
      pausedJobs: 1,
      failedJobs: 0,
      imports: [
        {
          id: "qa-import",
          from: "2025-10-01T00:00:00Z",
          to: "2026-10-01T00:00:00Z",
          stage: "extracting_older",
          pauseReason: "budget",
          completedAt: null,
          discoveredSources: 80,
          processedSources: 20,
        },
      ],
    },
  ],
};
const detail: PurchaseDetail = {
  manualEvidence: [],
  purchase: history,
  ledgerEntries: [
    {
      id: "qa-pay",
      observationId: "qa-paid",
      origin: "source",
      version: 1,
      kind: "payment",
      minor: "12000",
      currency: "EUR",
      date: "2026-01-10",
      dateBasis: "explicit-event-date",
      eligible: true,
    },
    {
      id: "qa-refund",
      observationId: "qa-refunded",
      origin: "source",
      version: 1,
      kind: "refund",
      minor: "3000",
      currency: "EUR",
      date: "2026-10-10",
      dateBasis: "explicit-event-date",
      eligible: true,
    },
  ],
  timeline: [
    {
      observationId: "qa-paid",
      documentId: "qa-paid-document",
      documentType: "receipt",
      relationship: "document",
      evidenceCode: "explicitly-paid",
      reviewState: "accepted",
      date: "2026-01-10",
      paymentEvidence: "explicitly-paid",
      refundEvidence: "none",
      source: {
        mailboxId: "qa-mailbox",
        provider: "gmail",
        originalAvailable: false,
        reason: "retrieval_not_implemented",
      },
      events: [
        {
          id: "qa-pay",
          kind: "payment",
          minor: "12000",
          currency: "EUR",
          date: "2026-01-10",
          dateBasis: "explicit-event-date",
          eligible: true,
        },
      ],
    },
    {
      observationId: "qa-pending",
      documentId: "qa-pending-document",
      documentType: "refund",
      relationship: "document",
      evidenceCode: "unknown",
      reviewState: "accepted",
      date: "2026-10-10",
      paymentEvidence: "unknown",
      refundEvidence: "pending",
      source: {
        mailboxId: "qa-mailbox",
        provider: "gmail",
        originalAvailable: false,
        reason: "source_deleted",
      },
      events: [],
    },
    {
      observationId: "qa-refunded",
      documentId: "qa-refund-document",
      documentType: "refund",
      relationship: "document",
      evidenceCode: "completed-refund",
      reviewState: "accepted",
      date: "2026-10-10",
      paymentEvidence: "unknown",
      refundEvidence: "completed",
      source: {
        mailboxId: "qa-mailbox",
        provider: "gmail",
        originalAvailable: false,
        reason: "retrieval_not_implemented",
      },
      events: [
        {
          id: "qa-refund",
          kind: "refund",
          minor: "3000",
          currency: "EUR",
          date: "2026-10-10",
          dateBasis: "explicit-event-date",
          eligible: true,
        },
      ],
    },
  ],
};
const defaultProfile: ProfileView = {
  user: {
    id: "qa-private-a",
    name: "QA a",
    email: "qa-private-a@example.invalid",
  },
  settings: { timezone: "UTC", reportingCurrency: "EUR", version: 1 },
  onboarding: { completedAt: null },
  capabilities: { mailProviders: [], driveArchive: false },
  valuation: { status: "not_configured" },
};
const defaultSummary: PurchaseSummary = {
  totals: [
    {
      currency: "EUR",
      paidMinor: "0",
      refundedMinor: "3000",
      netMinor: "-3000",
    },
  ],
  dateBasis: "event",
  recordCount: 2,
  unpaidCount: 0,
  unknownCount: 1,
  reviewCount: 1,
  excludedEntryCount: 0,
  missingCurrencyCount: 0,
  conversion: "not_configured",
};
const defaultReviews: PurchaseReview[] = [
  {
    id: "qa-currency-review",
    documentId: "qa-unlinked-document",
    purchaseId: null,
    reason: "incomplete-financial-facts",
    missingFields: ["currency"],
  },
];

/** Typed contract fixtures the private-workspace mock serves by default. */
export interface PrivateWorkspaceFixtures {
  profile?: ProfileView;
  coverage?: PurchaseCoverage;
  purchases?: PurchaseView[];
  detail?: PurchaseDetail;
  summary?: PurchaseSummary;
  reviews?: PurchaseReview[];
  /**
   * First-page `nextCursor`. When a `cursor` query is present the list
   * returns `null`, matching the app's pagination contract.
   */
  listCursor?: string | null;
}

export interface PrivateFixtureState {
  owner: "a" | "b";
  status: number;
  beforeList?: () => Promise<void>;
  requests: MockedRequest[];
}

export async function mockPrivateWorkspace(
  page: Page,
  fixtures: PrivateWorkspaceFixtures = {},
): Promise<PrivateFixtureState> {
  const state: PrivateFixtureState = { owner: "a", status: 200, requests: [] };
  const purchaseCoverage = fixtures.coverage ?? coverage;
  const purchaseDetail = fixtures.detail ?? detail;
  const summary = fixtures.summary ?? defaultSummary;
  const reviews = fixtures.reviews ?? defaultReviews;
  const listCursor = fixtures.listCursor ?? null;
  const detailPath = `/api/purchases/${purchaseDetail.purchase.id}`;
  const ownedRows = (): PurchaseView[] => {
    if (fixtures.purchases) return fixtures.purchases;
    return state.owner === "a"
      ? [history, question]
      : [
          {
            ...history,
            id: "qa-other",
            merchant: "QA other owner",
            documentTotalMinor: "99900",
            lifecycle: [
              {
                currency: "EUR",
                paidMinor: "99900",
                refundedMinor: "0",
                netMinor: "99900",
              },
            ],
          },
        ];
  };
  const api = await mockApi(page, {
    handlers: {
      "/api/public-config": () => ({
        status: 503,
        json: { error: { code: "unavailable" } },
      }),
      "/api/me": () => {
        if (state.status !== 200)
          return {
            status: state.status,
            json: { error: { code: "unavailable" } },
          };
        if (fixtures.profile) return { json: fixtures.profile };
        return {
          json: {
            ...defaultProfile,
            user: {
              id: `qa-private-${state.owner}`,
              name: `QA ${state.owner}`,
              email: `qa-private-${state.owner}@example.invalid`,
            },
          },
        };
      },
      "/api/purchases/coverage": () => {
        if (state.status !== 200)
          return {
            status: state.status,
            json: { error: { code: "unavailable" } },
          };
        return { json: purchaseCoverage };
      },
      "/api/purchase-reviews": () => {
        if (state.status !== 200)
          return {
            status: state.status,
            json: { error: { code: "unavailable" } },
          };
        return { json: { reviews, hasMore: false } };
      },
      "/api/purchases": async (request) => {
        if (state.status !== 200)
          return {
            status: state.status,
            json: { error: { code: "unavailable" } },
          };
        if (state.beforeList) await state.beforeList();
        const q =
          new URLSearchParams(request.query).get("q")?.toLowerCase() ?? "";
        const list: PurchaseListResponse = {
          rows: ownedRows().filter((row) =>
            row.merchant.toLowerCase().includes(q),
          ),
          nextCursor:
            listCursor === null || request.query.includes("cursor")
              ? null
              : listCursor,
          dateBasis: "document-or-event",
        };
        return { json: list };
      },
      "/api/purchases/summary": () => {
        if (state.status !== 200)
          return {
            status: state.status,
            json: { error: { code: "unavailable" } },
          };
        return { json: summary };
      },
      [detailPath]: () => {
        if (state.status !== 200)
          return {
            status: state.status,
            json: { error: { code: "unavailable" } },
          };
        return { json: purchaseDetail };
      },
    },
    fallback: () => {
      if (state.status !== 200)
        return {
          status: state.status,
          json: { error: { code: "unavailable" } },
        };
      return { status: 404, json: { error: { code: "not_found" } } };
    },
  });
  state.requests = api.requests;
  return state;
}

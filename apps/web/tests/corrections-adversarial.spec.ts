import type {
  CorrectionState,
  ProfileView,
  PurchaseDetail,
} from "@invoxim/contracts";
import { expect, type Page, test } from "@playwright/test";

async function fixture(page: Page, currency = "KWD") {
  const state = {
    owner: "qa-editor-a",
    writes: [] as Array<{
      path: string;
      body: unknown;
      key: string | undefined;
      token: string | undefined;
    }>,
    fail: false,
  };
  const token = "synthetic-qa-workspace-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const detail: PurchaseDetail = {
    manualEvidence: [],
    purchase: {
      id: "same-purchase",
      origin: "source",
      recordStatus: "active",
      merchant: "QA installment",
      date: "2026-10-10",
      invoiceReference: null,
      orderReference: null,
      category: "other",
      currency,
      documentTotalMinor: "10000",
      paymentState: "partially_paid",
      version: 1,
      evidenceCount: 1,
      reviewReasons: [],
      lifecycle: [
        { currency, paidMinor: "5000", refundedMinor: "0", netMinor: "5000" },
      ],
      period: [],
    },
    ledgerEntries: [
      {
        id: "same-entry",
        observationId: "qa-observation",
        origin: "source",
        version: 1,
        kind: "payment",
        minor: "5000",
        currency,
        date: "2026-10-10",
        dateBasis: "explicit-event-date",
        eligible: true,
      },
    ],
    timeline: [
      {
        observationId: "qa-observation",
        documentId: "qa-document",
        documentType: "receipt",
        relationship: "document",
        evidenceCode: "explicitly-paid",
        reviewState: "accepted",
        date: "2026-10-10",
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
            id: "same-entry",
            kind: "payment",
            minor: "5000",
            currency,
            date: "2026-10-10",
            dateBasis: "explicit-event-date",
            eligible: true,
          },
        ],
      },
    ],
  };
  const overlay: CorrectionState = {
    purchaseId: "same-purchase",
    version: 1,
    mutationToken: token,
    origin: "source",
    recordStatus: "active",
    overriddenFields: [],
    entries: [
      { id: "same-entry", version: 1, origin: "source", overriddenFields: [] },
    ],
    reviews: [],
    merges: [],
    capabilities: {
      editable: true,
      maxMergeEvents: 200,
      maxMergeEvidence: 200,
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      state.writes.push({
        path,
        body: request.postDataJSON(),
        key: request.headers()["idempotency-key"],
        token: request.headers()["x-workspace-token"],
      });
      await route.fulfill({
        status: state.fail ? 503 : 409,
        json: { error: state.fail ? "unavailable" : "CONFLICT" },
      });
      return;
    }
    let body: unknown;
    if (path === "/api/me") {
      const profile: ProfileView = {
        user: {
          id: state.owner,
          name: "QA editor",
          email: `${state.owner}@example.invalid`,
        },
        settings: { timezone: "UTC", reportingCurrency: "EUR", version: 1 },
        onboarding: { completedAt: 1 },
        capabilities: { mailProviders: [], driveArchive: false },
        valuation: { status: "not_configured" },
      };
      body = profile;
    } else if (path === "/api/purchases/coverage")
      body = { readyPurchaseCount: 1, openReviewCount: 0, connections: [] };
    else if (path.endsWith("/corrections")) body = overlay;
    else if (path === "/api/purchases/same-purchase") body = detail;
    else
      body = {
        rows: [detail.purchase],
        nextCursor: null,
        dateBasis: "document-or-event",
      };
    await route.fulfill({ json: body });
  });
  return state;
}

test("EDIT-01 existing KWD payment correction keeps identity and exact three-decimal magnitude", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/purchases/same-purchase");
  await page
    .getByRole("button", { name: "Edit payment event", exact: true })
    .click();
  await expect(page.getByLabel("Payment amount", { exact: true })).toHaveValue(
    "5.000",
  );
  await page.getByLabel("Payment amount", { exact: true }).fill("4.501");
  await page
    .getByRole("button", { name: "Save payment correction", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    path: "/api/ledger-entries/same-entry",
    body: { version: 1, changes: { amountMinor: "4501" } },
  });
  expect(state.writes[0]?.token).toBe(
    "synthetic-qa-workspace-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  await expect(page.getByLabel("Payment amount", { exact: true })).toHaveValue(
    "4.501",
  );
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("5.000");
});
test("EDIT-01 JPY fractional input is rejected before any write and retains user entry", async ({
  page,
}) => {
  const state = await fixture(page, "JPY");
  await page.goto("/purchases/same-purchase");
  await page
    .getByRole("button", { name: "Edit payment event", exact: true })
    .click();
  await page.getByLabel("Payment amount", { exact: true }).fill("45.10");
  await page
    .getByRole("button", { name: "Save payment correction", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("currency precision");
  expect(state.writes).toEqual([]);
  await expect(page.getByLabel("Payment amount", { exact: true })).toHaveValue(
    "45.10",
  );
});
test("EDIT-02 account change while an old form is open clears its values before mutation", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/purchases/same-purchase");
  await page
    .getByRole("button", { name: "Edit purchase details", exact: true })
    .click();
  await page
    .getByLabel("Merchant", { exact: true })
    .fill("Private A entered correction");
  state.owner = "qa-editor-b";
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect(
    page.getByText("qa-editor-b@example.invalid", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
  await expect(
    page.locator('input[value="Private A entered correction"]'),
  ).toHaveCount(0);
});
test("EDIT-03 uncertain retry keeps token body and command key and creates no optimistic cash", async ({
  page,
}) => {
  const state = await fixture(page);
  state.fail = true;
  await page.goto("/purchases/same-purchase");
  await page
    .getByRole("button", { name: "Edit payment event", exact: true })
    .click();
  await page.getByLabel("Payment amount", { exact: true }).fill("4.501");
  await page
    .getByRole("button", { name: "Save payment correction", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry the same request", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry the same request", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("5.000");
});

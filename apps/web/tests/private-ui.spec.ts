import AxeBuilder from "@axe-core/playwright";
import type { PurchaseCoverage } from "@invoxim/contracts";
import { expect, type Page, test } from "@playwright/test";

const profile = {
  user: {
    id: "synthetic-user",
    name: "Synthetic Reader",
    email: "reader@example.test",
  },
  settings: { timezone: "Europe/Vienna", reportingCurrency: "EUR", version: 1 },
  onboarding: { completedAt: 1 },
  capabilities: { mailProviders: [], driveArchive: false },
  valuation: { status: "not_configured" },
};
const totals = {
  currency: "EUR",
  paidMinor: "12000",
  refundedMinor: "3000",
  netMinor: "9000",
};
const purchase = {
  id: "purchase-1",
  merchant: "Synthetic Audio",
  date: "2026-09-10",
  invoiceReference: "INV-1",
  orderReference: null,
  category: "other",
  currency: "EUR",
  documentTotalMinor: "12000",
  paymentState: "paid",
  version: 1,
  evidenceCount: 2,
  reviewReasons: [],
  lifecycle: [totals],
  period: [{ ...totals, paidMinor: "0", netMinor: "-3000" }],
};
const coverage: PurchaseCoverage = {
  readyPurchaseCount: 1,
  openReviewCount: 0,
  connections: [
    {
      id: "mailbox-1",
      address: "receipts@example.test",
      provider: "gmail",
      state: "connected",
      schedulingState: "active",
      pendingJobs: 2,
      pausedJobs: 0,
      failedJobs: 0,
      imports: [
        {
          id: "import-1",
          from: "2025-10-01",
          to: "2026-10-01",
          stage: "processing_pending",
          pauseReason: null,
          completedAt: null,
          discoveredSources: 4,
          processedSources: 2,
        },
      ],
    },
  ],
};
async function fixtures(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/me") body = profile;
    else if (url.pathname === "/api/purchases/coverage") body = coverage;
    else if (url.pathname === "/api/purchases/summary")
      body = {
        totals: [purchase.period[0]],
        dateBasis: "event",
        recordCount: 1,
        unpaidCount: 0,
        unknownCount: 0,
        reviewCount: 0,
        excludedEntryCount: 0,
        missingCurrencyCount: 0,
        conversion: "not_configured",
      };
    else if (url.pathname === "/api/purchases/purchase-1")
      body = {
        purchase,
        timeline: [
          {
            observationId: "observation-1",
            documentId: "document-1",
            documentType: "refund",
            relationship: "supporting",
            evidenceCode: "source_exact",
            reviewState: "accepted",
            date: "2026-10-01",
            paymentEvidence: null,
            refundEvidence: "pending",
            source: {
              mailboxId: "mailbox-1",
              provider: "gmail",
              originalAvailable: false,
              reason: "source_deleted",
            },
            events: [],
          },
        ],
      };
    else
      body = {
        rows: [purchase],
        nextCursor: url.searchParams.has("cursor") ? null : "opaque-next",
        dateBasis: "document-or-event",
      };
    await route.fulfill({ json: body });
  });
}

test("HOME-01/04 purchase-first private Home with exact period/lifecycle values and partial coverage", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/home?from=2026-10-01&to=2026-10-31");
  await expect(
    page.getByRole("heading", { name: "Your purchase records" }),
  ).toBeVisible();
  await expect(
    page.getByText("Older history may still be importing."),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Synthetic Audio purchase" }),
  ).toContainText("EUR 90.00");
  await expect(
    page.getByRole("region", { name: "Recorded spending" }),
  ).toContainText("EUR -30.00");
  await page.screenshot({
    path: new URL(
      "../../../evidence/implementation/t13-frontend-home-desktop.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.getByLabel("Find a receipt or purchase").fill("Audio");
  await page.getByRole("button", { name: "Search records" }).click();
  await expect(page).toHaveURL(/q=Audio/);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=opaque-next/);
  await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
});

test("HOME-02/06 pending refund and unavailable original preserve structured details", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/purchases/purchase-1");
  await expect(
    page.getByRole("heading", { name: "Synthetic Audio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Refund pending. Not deducted from recorded spending."),
  ).toBeVisible();
  await expect(
    page.getByText("Original unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("The source message was deleted.")).toBeVisible();
  await expect(page.getByRole("link", { name: /download/i })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 90.00");
});

test("UI-01/02 mobile reflow and accessible keyboard search", async ({
  page,
}) => {
  await fixtures(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/purchases");
  await expect(
    page.getByRole("heading", { name: "Purchases", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Find a receipt or purchase").focus();
  await page.keyboard.type("receipt");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=receipt/);
  await expect(
    page.getByRole("heading", { name: "Purchases", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: new URL(
      "../../../evidence/implementation/t13-frontend-purchases-mobile.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
});

test("UI-03 session expiry clears private records with genuine example escape", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto("/home");
  await expect(
    page.getByText("Synthetic Audio", { exact: true }),
  ).toBeVisible();
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } }),
  );
  await page.getByRole("button", { name: "Refresh records" }).click();
  await expect(page.getByText("Synthetic Audio", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "Try an example" }),
  ).toBeVisible();
});

test("HOME-03 unpaid invoice remains useful without invented spending and services can be unavailable", async ({
  page,
}) => {
  await fixtures(page);
  const unpaid = {
    ...purchase,
    paymentState: "unpaid",
    lifecycle: [],
    period: [],
    reviewReasons: ["unknown-payment"],
  };
  await page.route("**/api/purchases?*", (route) =>
    route.fulfill({
      json: {
        rows: [unpaid],
        nextCursor: null,
        dateBasis: "document-or-event",
      },
    }),
  );
  await page.route("**/api/purchases/summary?*", (route) =>
    route.fulfill({
      json: {
        totals: [],
        dateBasis: "event",
        recordCount: 1,
        unpaidCount: 1,
        unknownCount: 0,
        reviewCount: 1,
        excludedEntryCount: 0,
        missingCurrencyCount: 0,
        conversion: "not_configured",
      },
    }),
  );
  await page.goto("/home");
  await expect(
    page.getByText("Not counted as spending", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Was this invoice paid?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Recorded spending" }),
  ).toContainText(
    "No documented payment or completed refund is included in this range.",
  );
  await expect(
    page.getByRole("button", { name: /connect|upgrade|archive/i }),
  ).toHaveCount(0);
});

test("UI-04 coverage shows budget pause and retains records without fake completion", async ({
  page,
}) => {
  await fixtures(page);
  const paused = structuredClone(coverage);
  const connection = paused.connections[0];
  if (!connection) throw new Error("Missing synthetic connection");
  connection.pausedJobs = 1;
  connection.imports[0] = {
    ...connection.imports[0],
    id: "import-1",
    from: "2025-10-01",
    to: "2026-10-01",
    stage: "paused",
    pauseReason: "budget",
    completedAt: null,
    discoveredSources: 4,
    processedSources: 2,
  };
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: paused }),
  );
  await page.goto("/connections");
  await expect(
    page.getByRole("heading", { name: "Connected inboxes" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Processing is paused at the current allowance or service-capacity limit. Your existing records are still available.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Import paused", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Import in progress", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/\d+%/)).toHaveCount(0);
});

test("HOME-01 category search and pagination preserve matching summary filters", async ({
  page,
}) => {
  await fixtures(page);
  const summaryQueries: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/purchases/summary")
      summaryQueries.push(url.searchParams);
  });
  await page.goto("/purchases?category=other&from=2026-10-01&to=2026-10-31");
  await page
    .getByText("Filter by date, status or inbox", { exact: true })
    .click();
  await expect(page.getByLabel("Category", { exact: true })).toHaveValue(
    "other",
  );
  await page.getByLabel("Find a receipt or purchase").fill("Audio");
  await page.getByRole("button", { name: "Search records" }).click();
  await expect(
    page.getByRole("heading", { name: "Purchases", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("status")).toContainText(
    "1 purchase records ready",
  );
  const query = new URL(page.url()).searchParams;
  expect(query.get("category")).toBe("other");
  expect(query.get("q")).toBe("Audio");
  expect(query.get("from")).toBe("2026-10-01");
  expect(query.get("to")).toBe("2026-10-31");
  const latest = summaryQueries.at(-1);
  expect(latest?.get("category")).toBe("other");
  expect(latest?.get("q")).toBe("Audio");
  expect(latest?.get("cursor")).toBeNull();
});

test("UI-04 paused jobs override importing copy and announce a ready milestone", async ({
  page,
}) => {
  await fixtures(page);
  const paused = structuredClone(coverage);
  const connection = paused.connections[0];
  if (!connection) throw new Error("Missing synthetic connection");
  connection.pausedJobs = 1;
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: paused }),
  );
  await page.goto("/home");
  await expect(page.getByRole("status")).toContainText(
    "1 purchase records ready. Processing is paused.",
  );
  await expect(
    page.getByRole("region", { name: "Inbox coverage" }),
  ).toContainText("Processing is paused.");
  await expect(
    page.getByText("Older history may still be importing.", { exact: true }),
  ).toHaveCount(0);
});

test("HOME-05 only validated missing fields become exact questions including unlinked documents", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "review-1",
            documentId: "doc-1",
            purchaseId: null,
            reason: "incomplete-financial-facts",
            missingFields: ["currency"],
          },
          {
            id: "review-2",
            documentId: "doc-2",
            purchaseId: "purchase-1",
            reason: "incomplete-financial-facts",
            missingFields: [],
          },
          {
            id: "review-3",
            documentId: "doc-3",
            purchaseId: null,
            reason: "incomplete-financial-facts",
            missingFields: ["total", "documentDate"],
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.goto("/needs-attention");
  await expect(
    page.getByRole("heading", { name: "Needs attention", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Which currency does this document use?", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("This document is not linked to a purchase yet."),
  ).toHaveCount(2);
  await expect(
    page.getByText("What total does this document show?", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("What date is shown on this document?", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("article").nth(1)).not.toContainText(
    "Which currency does this document use?",
  );
  await expect(
    page.getByRole("link", { name: "View supported purchase history →" }),
  ).toHaveAttribute("href", "/purchases/purchase-1");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page
    .getByRole("link", { name: "View supported purchase history →" })
    .click();
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 120.00");
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 30.00");
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 90.00");
});

test("HOME-05 review identifies original email before asking for corrections", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "source-review",
            documentId: "doc-1",
            purchaseId: null,
            reason: "incomplete-financial-facts",
            missingFields: ["documentDate"],
            sourceContext: {
              mailboxAddress: "receipts@example.test",
              receivedAt: Date.parse("2026-10-12T10:30:00.000Z"),
              provider: "gmail",
              available: true,
            },
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/source-review/corrections", (route) =>
    route.fulfill({
      json: {
        purchaseId: null,
        purchaseVersion: null,
        mutationToken: "synthetic-token".repeat(4),
        documentId: "doc-1",
        review: {
          id: "source-review",
          version: 1,
          status: "open",
          reason: "incomplete-financial-facts",
          blockingScope: "financial",
          missingFields: ["documentDate"],
          actions: ["complete-record"],
        },
      },
    }),
  );
  let sourceRequests = 0;
  await page.route("**/api/review/source-review/source", (route) => {
    sourceRequests += 1;
    return route.fulfill({
      json: {
        mailboxAddress: "receipts@example.test",
        receivedAt: Date.parse("2026-10-12T10:30:00.000Z"),
        subject: "Synthetic receipt from October",
        sender: "Synthetic Merchant <billing@example.test>",
        originalUrl:
          "https://mail.google.com/mail/#search/rfc822msgid%3Asynthetic%40example.test",
      },
    });
  });
  await page.goto("/needs-attention");
  await expect(
    page.getByText("receipts@example.test", { exact: false }),
  ).toBeVisible();
  expect(sourceRequests).toBe(0);
  await page.getByRole("button", { name: "Show source email" }).click();
  await expect(
    page.getByText("Synthetic receipt from October", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Source email" }),
  ).toContainText("Synthetic Merchant <billing@example.test>");
  await expect(
    page.getByRole("link", { name: "Open original email" }),
  ).toHaveAttribute("href", /mail.google.com/);
  await expect(page.locator("time").first()).toHaveAttribute(
    "datetime",
    "2026-10-12T10:30:00.000Z",
  );
  await page.getByRole("button", { name: "Show available actions" }).click();
  await expect(
    page.getByText("What date is shown on this document?", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(
      "No validated purchase record is available yet. Creating one requires the merchant, currency, total and document date from the original email.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Supply missing record" }).click();
  await expect(page.getByLabel("Merchant", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Document date", { exact: true })).toBeVisible();
});

test("HOME-05 deleted review source stays identifiable without offering a broken link", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "deleted-review",
            documentId: "doc-2",
            purchaseId: null,
            reason: "document-review",
            missingFields: [],
            sourceContext: {
              mailboxAddress: "receipts@example.test",
              receivedAt: Date.parse("2026-10-12T10:30:00.000Z"),
              provider: "gmail",
              available: false,
            },
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.goto("/needs-attention");
  await expect(
    page.getByRole("region", { name: "Source email" }),
  ).toContainText("receipts@example.test");
  await expect(
    page.getByText("The source email is no longer available."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show source email" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open original email" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});

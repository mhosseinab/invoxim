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
  await page.getByText("Why this amount?", { exact: true }).click();
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
  await page
    .getByRole("article", { name: "Synthetic Audio purchase" })
    .getByText("Needs attention", { exact: true })
    .click();
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

test("UI-04 paused scheduling and paused run stage report paused in both the status line and the coverage panel", async ({
  page,
}) => {
  await fixtures(page);
  const scheduled = structuredClone(coverage);
  const inbox = scheduled.connections[0];
  if (!inbox?.imports[0]) throw new Error("Missing fixture inbox");
  inbox.schedulingState = "paused";
  inbox.pendingJobs = 0;
  inbox.pausedJobs = 0;
  inbox.imports[0].completedAt = 1;
  inbox.imports[0].pauseReason = null;
  inbox.imports[0].stage = "processing_pending";
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: scheduled }),
  );
  await page.goto("/home");
  await expect(page.getByRole("status")).toContainText(
    "1 purchase records ready. Processing is paused.",
  );
  await expect(
    page.getByRole("region", { name: "Inbox coverage" }),
  ).toContainText("Processing is paused.");
  const staged = structuredClone(coverage);
  const stagedInbox = staged.connections[0];
  if (!stagedInbox?.imports[0]) throw new Error("Missing fixture inbox");
  stagedInbox.pendingJobs = 0;
  stagedInbox.pausedJobs = 0;
  stagedInbox.imports[0].completedAt = 1;
  stagedInbox.imports[0].pauseReason = null;
  stagedInbox.imports[0].stage = "paused";
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: staged }),
  );
  await page.reload();
  await expect(page.getByRole("status")).toContainText(
    "1 purchase records ready. Processing is paused.",
  );
  await expect(
    page.getByRole("region", { name: "Inbox coverage" }),
  ).toContainText("Processing is paused.");
});

test("UI labels render hyphenated category, payment state and source reason from one map", async ({
  page,
}) => {
  await fixtures(page);
  const labeled = structuredClone(purchase);
  labeled.category = "business-services";
  labeled.paymentState = "partially_paid";
  await page.route("**/api/purchases?*", (route) =>
    route.fulfill({
      json: {
        rows: [labeled],
        nextCursor: null,
        dateBasis: "document-or-event",
      },
    }),
  );
  await page.route("**/api/purchases/purchase-1", (route) =>
    route.fulfill({
      json: {
        purchase: labeled,
        timeline: [
          {
            observationId: "observation-1",
            documentId: "document-1",
            documentType: "receipt",
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
      },
    }),
  );
  await page.goto("/home?from=2026-10-01&to=2026-10-31");
  const card = page.getByRole("article", { name: "Synthetic Audio purchase" });
  await expect(card).toContainText("business services");
  await expect(card).toContainText("Partially paid");
  await expect(card.getByText("business-services")).toHaveCount(0);
  await card
    .getByRole("link", { name: "Synthetic Audio", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Audio", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("business services");
  await expect(page.getByText("business-services")).toHaveCount(0);
  await page
    .locator("summary")
    .filter({ hasText: "Why this amount?" })
    .first()
    .click();
  await expect(
    page.getByText("The source message was deleted.", { exact: true }),
  ).toBeVisible();
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
    page.getByText(
      "Check the original email, then use the available actions below. Add purchase details only if needed.",
      { exact: true },
    ),
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
  await page
    .getByRole("article")
    .nth(1)
    .getByRole("button", { name: /^Review email/ })
    .click();
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
    page
      .locator(".review-list-inbox")
      .getByText("receipts@example.test", { exact: false }),
  ).toBeVisible();
  await expect.poll(() => sourceRequests).toBe(1);
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: /^Review email/ })
    .click();
  await expect.poll(() => sourceRequests).toBe(1);
  await expect(
    page
      .getByRole("dialog")
      .getByText("Synthetic receipt from October", { exact: true }),
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

  await expect(
    page.getByText("What date is shown on this document?", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(
      "If this is a receipt, you can add its details. Saving does not confirm a payment.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add purchase details" }).click();
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
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: /^Review email/ })
    .click();
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

test("UX-PURCHASES-01 three unconfirmed records fit desktop without exposing questions or implying payments", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixtures(page);
  const rows = ["Synthetic Transit", "Synthetic Store", "Synthetic Books"].map(
    (merchant, index) => ({
      ...purchase,
      id: `compact-${index}`,
      merchant,
      paymentState: index === 1 ? "unpaid" : "unknown",
      lifecycle: [],
      period: [],
      reviewReasons: ["unknown-payment"],
    }),
  );
  await page.route("**/api/purchases?*", (route) =>
    route.fulfill({
      json: { rows, nextCursor: null, dateBasis: "document-or-event" },
    }),
  );
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({
      json: { ...coverage, readyPurchaseCount: 3, openReviewCount: 3 },
    }),
  );
  await page.route("**/api/purchases/summary?*", (route) =>
    route.fulfill({
      json: {
        totals: [],
        dateBasis: "event",
        recordCount: 3,
        unpaidCount: 1,
        unknownCount: 2,
        reviewCount: 3,
        excludedEntryCount: 0,
        missingCurrencyCount: 0,
        conversion: "not_configured",
      },
    }),
  );
  await page.goto("/purchases");
  const last = page.getByRole("article", { name: "Synthetic Books purchase" });
  await expect(last).toBeVisible();
  await page.screenshot({
    path: "/tmp/ux-purchases-desktop.png",
    fullPage: true,
  });
  await expect(last).toBeInViewport({ ratio: 1 });
  const first = page.getByRole("article", {
    name: "Synthetic Transit purchase",
  });
  await expect(
    first.getByText("Document total", { exact: true }),
  ).toBeVisible();
  await expect(first.getByText("EUR 120.00", { exact: true })).toBeVisible();
  await expect(
    first.getByText("Was this invoice paid?", { exact: true }),
  ).not.toBeVisible();
  await first.getByText("Needs attention", { exact: true }).click();
  await expect(
    first.getByText("Was this invoice paid?", { exact: true }),
  ).toBeVisible();
  await first.getByText("Needs attention", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    first.getByText("Was this invoice paid?", { exact: true }),
  ).not.toBeVisible();
  console.log("UX-PURCHASES desktop last row", await last.boundingBox());
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const mobileRow = await first.boundingBox();
  const mobileAmount = await first
    .locator(".compact-purchase-amount")
    .boundingBox();
  const mobileMerchant = await first.locator("h3").boundingBox();
  expect(mobileRow?.height).toBeLessThanOrEqual(165);
  expect(
    mobileAmount && mobileMerchant && mobileAmount.y < mobileMerchant.y + 35,
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/ux-purchases-mobile.png",
    fullPage: true,
  });
});

async function captureWorkspace(page: Page, name: string) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: `/tmp/ux-workspace-${name}-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: `/tmp/ux-workspace-${name}-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("UX-WORKSPACE-01 review inbox bounds identifying metadata and keeps actions explicit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixtures(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/review\//.test(request.url())) requests.push(request.url());
  });
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: Array.from({ length: 25 }, (_, index) => ({
          id: `compact-review-${index}`,
          documentId: `doc-${index}`,
          purchaseId: null,
          reason: "incomplete-financial-facts",
          missingFields: ["documentDate"],
          sourceContext: {
            mailboxAddress: "receipts@example.test",
            receivedAt: Date.parse("2026-10-12T10:30:00Z") - index * 86400000,
            provider: "gmail",
            available: true,
          },
        })),
        hasMore: true,
      },
    }),
  );
  await page.goto("/needs-attention");
  await expect(page.getByRole("article").nth(3)).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole("button", { name: "Show source email" }),
  ).toHaveCount(0);
  await expect
    .poll(() => requests.filter((url) => url.endsWith("/source")).length)
    .toBe(8);
  await captureWorkspace(page, "reviews");
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: /^Review email/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Show source email" }),
  ).toBeVisible();
  await expect
    .poll(() => requests.filter((url) => url.endsWith("/source")).length)
    .toBe(9);
});

test("UX-WORKSPACE-01 paused inbox never claims its pending import is active", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixtures(page);
  const paused = structuredClone(coverage);
  if (!paused.connections[0]) throw new Error("Missing fixture connection");
  paused.connections[0].pausedJobs = 6;
  paused.connections[0].failedJobs = 8;
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: paused }),
  );
  await page.goto("/connections");
  await expect(
    page.getByText("Import paused", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Import in progress", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("8 failed jobs", { exact: true })).toBeVisible();
  await captureWorkspace(page, "connections");
  await page.getByText("Import details", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Schedule setting: active", { exact: true }),
  ).toBeVisible();
});

test("UX-WORKSPACE-01 Home opens directly onto searchable recent records", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixtures(page);
  await page.goto("/home?from=2026-10-01&to=2026-10-31");
  await expect(
    page.getByRole("article", { name: "Synthetic Audio purchase" }),
  ).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel("Find a receipt or purchase")).toBeVisible();
  await captureWorkspace(page, "home");
});

test("UX-WORKSPACE-01 paused scheduling takes precedence after a finished historical import", async ({
  page,
}) => {
  await fixtures(page);
  const paused = structuredClone(coverage);
  const inbox = paused.connections[0];
  if (!inbox?.imports[0]) throw new Error("Missing fixture inbox");
  inbox.schedulingState = "paused";
  inbox.pendingJobs = 0;
  inbox.pausedJobs = 0;
  inbox.imports[0].completedAt = 1;
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: paused }),
  );
  await page.goto("/connections");
  await expect(
    page.getByRole("region", { name: "Inbox coverage" }).locator(".status"),
  ).toHaveText("Import paused");
  await expect(page.getByText("Scan finished", { exact: true })).toBeVisible();
});

test("UX-WORKSPACE-01 frozen non-UTC-midnight ranges display their UTC date and time explicitly", async ({
  page,
}) => {
  await fixtures(page);
  const ranges = structuredClone(coverage);
  const run = ranges.connections[0]?.imports[0];
  if (!run) throw new Error("Missing fixture import");
  run.from = "2025-10-11T22:00:00.000Z";
  run.to = "2026-10-12T10:30:00.000Z";
  await page.route("**/api/purchases/coverage", (route) =>
    route.fulfill({ json: ranges }),
  );
  await page.goto("/connections");
  await expect(
    page.getByRole("region", { name: "Inbox coverage" }),
  ).toContainText(
    "Requested history (UTC): 11 Oct 2025, 22:00 – 12 Oct 2026, 10:30 (end exclusive)",
  );
  await expect(
    page.getByText("Requested interval:", { exact: false }),
  ).not.toBeVisible();
});

test("UX-REVIEW-DISCARD-01 groups only actual source identity and shows metadata before optional entry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixtures(page);
  const metadataReads: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(request.url());
  });
  const context = {
    mailboxAddress: "receipts@example.test",
    receivedAt: Date.parse("2026-10-12T10:30:00Z"),
    provider: "gmail",
    available: true,
  };
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "related-warning",
            documentId: "source-a-warning",
            sourceMessageId: "source-a",
            purchaseId: null,
            reason: "document-review",
            missingFields: [],
            sourceContext: context,
          },
          {
            id: "receipt-details",
            documentId: "source-a-document",
            sourceMessageId: "source-a",
            purchaseId: null,
            reason: "incomplete-financial-facts",
            missingFields: ["currency", "total", "documentDate"],
            sourceContext: context,
          },
          {
            id: "same-time-other-email",
            documentId: "source-b-document",
            sourceMessageId: "source-b",
            purchaseId: null,
            reason: "document-review",
            missingFields: [],
            sourceContext: context,
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/*/source", (route) => {
    metadataReads.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: {
        mailboxAddress: context.mailboxAddress,
        receivedAt: context.receivedAt,
        subject: "Synthetic conference invitation",
        sender: "Events <events@example.test>",
        attachments: [
          {
            filename: "conference.pdf",
            mimeType: "application/pdf",
            size: 12000,
          },
          { filename: "agenda.txt", mimeType: "text/plain", size: null },
        ],
        originalUrl:
          "https://mail.google.com/mail/#search/rfc822msgid%3Asynthetic%40example.test",
      },
    });
  });
  await page.route("**/api/review/receipt-details/corrections", (route) =>
    route.fulfill({
      json: {
        purchaseId: null,
        purchaseVersion: null,
        mutationToken: "synthetic-token".repeat(4),
        documentId: "source-a-document",
        review: {
          id: "receipt-details",
          version: 3,
          status: "open",
          reason: "incomplete-financial-facts",
          blockingScope: "financial",
          missingFields: ["currency", "total", "documentDate"],
          actions: ["complete-record", "not-a-purchase"],
        },
      },
    }),
  );
  await page.goto("/needs-attention");
  await expect(page.locator(".private-review")).toHaveCount(2);
  await expect.poll(() => metadataReads.length).toBe(2);
  await page.screenshot({
    path: "/tmp/ux-discard-list-desktop.png",
    fullPage: true,
  });
  const trigger = page.getByRole("button", { name: /^Review email/ }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Review email",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Close review", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByText("Synthetic conference invitation", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("From: Events <events@example.test>", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "Email attachments" }),
  ).toContainText("conference.pdf");
  await expect(
    dialog.getByRole("region", { name: "Email attachments" }),
  ).toContainText("12,000 bytes");
  await expect(
    dialog.getByRole("region", { name: "Email attachments" }),
  ).toContainText("Size unavailable");
  await expect(
    dialog.getByRole("link", { name: "conference.pdf", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Not a purchase", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  expect(metadataReads).toEqual([
    "/api/review/related-warning/source",
    "/api/review/same-time-other-email/source",
  ]);
  expect(writes).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "/tmp/ux-discard-dialog-desktop.png" });
  await dialog
    .getByRole("button", { name: "Add purchase details", exact: true })
    .click();
  await dialog.getByLabel("Merchant", { exact: true }).fill("Synthetic seller");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Merchant", { exact: true })).toHaveValue(
    "Synthetic seller",
  );
  expect(metadataReads).toHaveLength(2);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: "/tmp/ux-discard-dialog-mobile.png" });
  expect(writes).toEqual([]);
});

test("UX-REVIEW-DISCARD-01 linked sibling never promises a withheld false-positive action", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "unlinked-primary",
            documentId: "document-a",
            sourceMessageId: "shared-source",
            purchaseId: null,
            reason: "incomplete-financial-facts",
            missingFields: ["documentDate"],
          },
          {
            id: "linked-sibling",
            documentId: "document-b",
            sourceMessageId: "shared-source",
            purchaseId: "purchase-1",
            reason: "document-review",
            missingFields: [],
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/unlinked-primary/corrections", (route) =>
    route.fulfill({
      json: {
        purchaseId: null,
        purchaseVersion: null,
        documentId: "document-a",
        mutationToken: "synthetic-token".repeat(4),
        review: {
          id: "unlinked-primary",
          version: 3,
          status: "open",
          reason: "incomplete-financial-facts",
          blockingScope: "financial",
          missingFields: ["documentDate"],
          actions: ["complete-record"],
        },
      },
    }),
  );
  await page.goto("/needs-attention");
  await expect(page.locator(".private-review")).toHaveCount(1);
  await page.getByRole("button", { name: /^Review email/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Review email",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Add purchase details", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Not a purchase", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByText(/mark it as Not a purchase/)).toHaveCount(0);
  await expect(
    dialog.getByText(
      "Check the original email, then use the available actions below. Add purchase details only if needed.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
});

test("UX-PRIVATE-LISTS-01 mobile review list identifies bounded visible emails before selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await fixtures(page);
  const reads: string[] = [];
  let active = 0;
  let maximumActive = 0;
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: Array.from({ length: 12 }, (_, index) => ({
          id: `identity-${index}`,
          documentId: `document-${index}`,
          sourceMessageId: `source-${index}`,
          purchaseId: null,
          reason:
            index % 4 === 3 ? "document-review" : "incomplete-financial-facts",
          missingFields:
            index % 4 === 0
              ? ["documentDate"]
              : index % 4 === 1
                ? ["merchant", "total"]
                : index % 4 === 2
                  ? ["currency"]
                  : [],
          sourceContext: {
            mailboxAddress: "receipts@example.test",
            receivedAt: Date.parse("2026-10-12T10:30:00Z") - index * 86400000,
            provider: "gmail",
            available: true,
          },
        })),
        hasMore: true,
      },
    }),
  );
  await page.route("**/api/review/*/source", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    reads.push(id);
    active += 1;
    maximumActive = Math.max(active, maximumActive);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return route.fulfill({
      json: {
        mailboxAddress: "receipts@example.test",
        receivedAt: Date.parse("2026-10-12T10:30:00Z"),
        subject: [
          "Your monthly transit receipt",
          "Invoice 2048 from Cloud Studio",
          "Your order from North Books",
          "Document from Office Supply",
        ][Number(id.split("-").at(-1)) % 4],
        sender: [
          "Transit Tickets <tickets@transit.example.test>",
          "Cloud Studio <billing@studio.example.test>",
          "North Books <orders@books.example.test>",
          "Office Supply <office@example.test>",
        ][Number(id.split("-").at(-1)) % 4],
        attachments: [
          { filename: "receipt.pdf", mimeType: "application/pdf", size: 1200 },
        ],
        originalUrl: null,
      },
    });
  });
  await page.goto("/needs-attention");
  await expect(page.locator(".private-review")).toHaveCount(8);
  await expect.poll(() => reads.length).toBe(8);
  const first = page.locator(".private-review").first();
  await expect(first).toContainText("Your monthly transit receipt");
  await expect(first).toContainText("Transit Tickets");
  await expect(first).toContainText("receipt.pdf");
  await expect(first).toContainText("Receipt date needed");
  await expect(
    page
      .getByText("receipts@example.test", { exact: true })
      .filter({ visible: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Email needs review", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/ux-private-lists-interim.png",
    fullPage: true,
  });
  await expect(page.locator(".private-review").nth(3)).toBeInViewport({
    ratio: 1,
  });
  expect(maximumActive).toBeLessThanOrEqual(3);
  await page.screenshot({
    path: "/tmp/ux-private-lists-reviews-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/ux-private-lists-reviews-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await first.getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(
    "Your monthly transit receipt",
  );
  expect(reads).toHaveLength(8);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Show more emails", exact: true })
    .click();
  await expect(page.locator(".private-review")).toHaveCount(12);
  await expect.poll(() => reads.length).toBe(12);
  expect(new Set(reads).size).toBe(12);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("UX-PRIVATE-LISTS-01 failed metadata remains distinct and dialog retry repairs the row", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "retry-source",
            documentId: "retry-document",
            purchaseId: null,
            sourceMessageId: "retry-message",
            reason: "document-review",
            missingFields: [],
            sourceContext: {
              mailboxAddress: "receipts@example.test",
              receivedAt: 1,
              provider: "gmail",
              available: true,
            },
          },
        ],
        hasMore: false,
      },
    }),
  );
  let attempts = 0;
  await page.route("**/api/review/retry-source/source", (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({
          status: 503,
          json: {
            error: {
              code: "unavailable",
              message: "Request unavailable",
              requestId: "synthetic",
              retryable: true,
            },
          },
        })
      : route.fulfill({
          json: {
            mailboxAddress: "receipts@example.test",
            receivedAt: 1,
            subject: "Recovered synthetic receipt",
            sender: null,
            attachments: [],
            originalUrl: null,
          },
        });
  });
  await page.goto("/needs-attention");
  const row = page.locator(".private-review");
  await expect(
    row.getByText("Email details unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByText("Email without a subject", { exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Review email", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Recovered synthetic receipt",
  );
  await page.keyboard.press("Escape");
  await expect(
    row.getByRole("button", {
      name: "Review email: Recovered synthetic receipt",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    row
      .getByText("Sender unavailable", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("UX-PRIVATE-LISTS-01 actor change while identifying email never publishes old metadata", async ({
  page,
}) => {
  await fixtures(page);
  let changed = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: changed
        ? {
            ...profile,
            user: {
              ...profile.user,
              id: "new-reader",
              email: "new@example.test",
            },
          }
        : profile,
    }),
  );
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: changed
          ? []
          : [
              {
                id: "held-source",
                documentId: "held-document",
                purchaseId: null,
                sourceMessageId: "held-message",
                reason: "document-review",
                missingFields: [],
                sourceContext: {
                  mailboxAddress: "receipts@example.test",
                  receivedAt: 1,
                  provider: "gmail",
                  available: true,
                },
              },
            ],
        hasMore: false,
      },
    }),
  );
  let reads = 0;
  await page.route("**/api/review/held-source/source", async (route) => {
    reads += 1;
    await held;
    await route.fulfill({
      json: {
        mailboxAddress: "receipts@example.test",
        receivedAt: 1,
        subject: "Old actor confidential subject",
        sender: "Old sender",
        originalUrl: null,
      },
    });
  });
  await page.goto("/needs-attention");
  await expect.poll(() => reads).toBe(1);
  changed = true;
  release?.();
  await expect(
    page.getByText("new@example.test", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".private-review")).toHaveCount(0);
  await expect(
    page.getByText("Old actor confidential subject", { exact: true }),
  ).toHaveCount(0);
  expect(reads).toBe(1);
});

test("UX-PRIVATE-LISTS-01 opening a queued email joins its bounded metadata request", async ({
  page,
}) => {
  await fixtures(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads: string[] = [];
  let active = 0;
  let peak = 0;
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: Array.from({ length: 4 }, (_, index) => ({
          id: `queued-${index}`,
          documentId: `queued-document-${index}`,
          sourceMessageId: `queued-source-${index}`,
          purchaseId: null,
          reason: "document-review",
          missingFields: [],
          sourceContext: {
            mailboxAddress: "receipts@example.test",
            receivedAt: 1,
            provider: "gmail",
            available: true,
          },
        })),
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/*/source", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    reads.push(id);
    active += 1;
    peak = Math.max(peak, active);
    await held;
    active -= 1;
    await route.fulfill({
      json: {
        mailboxAddress: "receipts@example.test",
        receivedAt: 1,
        subject: `Email ${id}`,
        sender: null,
        originalUrl: null,
      },
    });
  });
  await page.goto("/needs-attention");
  await expect.poll(() => reads.length).toBe(3);
  await page.locator(".private-review").nth(3).getByRole("button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "/tmp/ux-private-lists-pending-dialog.png" });
  release?.();
  await expect(page.getByRole("dialog")).toContainText("Email queued-3");
  await expect.poll(() => reads.length).toBe(4);
  expect(reads.filter((id) => id === "queued-3")).toHaveLength(1);
  expect(peak).toBeLessThanOrEqual(3);
});

test("UX-PRIVATE-LISTS-01 deliberate metadata retry shares capacity with other visible emails", async ({
  page,
}) => {
  await fixtures(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads: string[] = [];
  let active = 0;
  let peak = 0;
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: Array.from({ length: 4 }, (_, index) => ({
          id: `capacity-${index}`,
          documentId: `capacity-document-${index}`,
          sourceMessageId: `capacity-source-${index}`,
          purchaseId: null,
          reason: "document-review",
          missingFields: [],
          sourceContext: {
            mailboxAddress: "receipts@example.test",
            receivedAt: 1,
            provider: "gmail",
            available: true,
          },
        })),
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/*/source", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    reads.push(id);
    if (
      id === "capacity-0" &&
      reads.filter((value) => value === id).length === 1
    ) {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "unavailable",
            message: "Request unavailable",
            requestId: "synthetic",
            retryable: true,
          },
        },
      });
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    await held;
    active -= 1;
    await route.fulfill({
      json: {
        mailboxAddress: "receipts@example.test",
        receivedAt: 1,
        subject: `Recovered ${id}`,
        sender: null,
        originalUrl: null,
      },
    });
  });
  await page.goto("/needs-attention");
  await expect.poll(() => reads.length).toBe(4);
  const first = page.locator(".private-review").first();
  await expect(
    first.getByText("Email details unavailable", { exact: true }),
  ).toBeVisible();
  await first.getByRole("button").click();
  await page.screenshot({ path: "/tmp/ux-private-lists-retry-capacity.png" });
  release?.();
  await expect(page.getByRole("dialog")).toContainText("Recovered capacity-0");
  await page.keyboard.press("Escape");
  await expect(
    first.getByRole("button", {
      name: "Review email: Recovered capacity-0",
      exact: true,
    }),
  ).toBeVisible();
  expect(reads).toHaveLength(5);
  expect(peak).toBeLessThanOrEqual(3);
});

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const profile = {
  user: {
    id: "synthetic-editor",
    name: "Synthetic Editor",
    email: "editor@example.test",
  },
  settings: { timezone: "UTC", reportingCurrency: "EUR", version: 1 },
  onboarding: { completedAt: 1 },
  capabilities: { mailProviders: [], driveArchive: false },
  valuation: { status: "not_configured" },
};
const purchase = {
  id: "purchase-a",
  merchant: "Synthetic Merchant",
  date: "2026-10-01",
  invoiceReference: null,
  orderReference: null,
  category: "other",
  currency: "EUR",
  documentTotalMinor: "10000",
  paymentState: "partially_paid",
  version: 1,
  evidenceCount: 1,
  reviewReasons: [],
  lifecycle: [
    {
      currency: "EUR",
      paidMinor: "5000",
      refundedMinor: "0",
      netMinor: "5000",
    },
  ],
  period: [],
};
const correction = {
  purchaseId: "purchase-a",
  version: 1,
  mutationToken: "synthetic-workspace-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  origin: "source",
  recordStatus: "active",
  overriddenFields: [],
  entries: [
    { id: "entry-a", version: 1, origin: "source", overriddenFields: [] },
  ],
  reviews: [],
  merges: [],
  capabilities: { editable: true, maxMergeEvents: 200, maxMergeEvidence: 200 },
};
const result = {
  purchaseId: "purchase-a",
  version: 2,
  entryId: null,
  entryVersion: null,
  reviewId: null,
  reviewVersion: null,
  reviewStatus: null,
  mergeId: null,
};
async function workspace(
  page: Page,
  mutate: (request: {
    path: string;
    body: unknown;
    key: string | undefined;
    token: string | undefined;
  }) => { status?: number; body: unknown } = () => ({ body: result }),
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      const response = mutate({
        path,
        body: request.postDataJSON(),
        key: request.headers()["idempotency-key"],
        token: request.headers()["x-workspace-token"],
      });
      await route.fulfill({
        status: response.status ?? 200,
        json: response.body,
      });
      return;
    }
    let body: unknown;
    if (path === "/api/me") body = profile;
    else if (path === "/api/purchases/coverage")
      body = { readyPurchaseCount: 1, openReviewCount: 0, connections: [] };
    else if (path.endsWith("/corrections")) body = correction;
    else if (path === "/api/purchases/purchase-a")
      body = {
        purchase,
        timeline: [
          {
            observationId: "observation-a",
            documentId: "document-a",
            documentType: "receipt",
            relationship: "supporting",
            evidenceCode: "source_exact",
            reviewState: "accepted",
            date: "2026-10-01",
            paymentEvidence: "explicitly-paid",
            refundEvidence: "none",
            source: {
              mailboxId: "mailbox-a",
              provider: "gmail",
              originalAvailable: false,
              reason: "retrieval_not_implemented",
            },
            events: [
              {
                id: "entry-a",
                kind: "payment",
                minor: "5000",
                currency: "EUR",
                date: "2026-10-01",
                dateBasis: "source",
                eligible: true,
              },
            ],
          },
        ],
      };
    else
      body = {
        rows: [purchase],
        nextCursor: null,
        dateBasis: "document-or-event",
      };
    await route.fulfill({ json: body });
  });
}

test("EDIT-01 document total correction remains separate from documented cash", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await workspace(page, (request) => {
    writes.push(request.body);
    return { body: result };
  });
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit purchase details", exact: true })
    .click();
  await page.getByLabel("Document total", { exact: true }).fill("120.00");
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([{ version: 1, changes: { totalMinor: "12000" } }]);
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 50.00");
});

test("EDIT-02 conflict retains entered correction until deliberate reload", async ({
  page,
}) => {
  await workspace(page, () => ({
    status: 409,
    body: { error: "VERSION_CONFLICT" },
  }));
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit purchase details", exact: true })
    .click();
  await page.getByLabel("Merchant", { exact: true }).fill("User correction");
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Your entries are still here",
  );
  await expect(page.getByLabel("Merchant", { exact: true })).toHaveValue(
    "User correction",
  );
  await expect(
    page.getByRole("button", { name: "Reload latest version", exact: true }),
  ).toBeVisible();
});

test("EDIT-03 unknown payment confirmation retry reuses its request identity", async ({
  page,
}) => {
  const writes: {
    body: unknown;
    key: string | undefined;
    token: string | undefined;
  }[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    return writes.length === 1
      ? { status: 503, body: { error: "TEMPORARILY_UNAVAILABLE" } }
      : { body: { ...result, entryId: "confirmed-event", entryVersion: 1 } };
  });
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Confirm a payment", exact: true })
    .click();
  await page.getByLabel("Payment amount", { exact: true }).fill("25.00");
  await page.getByLabel("Event date", { exact: true }).fill("2026-10-02");
  await page
    .getByLabel("I confirm this payment was completed.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save confirmed payment", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry the same request", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes).toHaveLength(2);
  expect(writes[0]?.key).toBeTruthy();
  expect(writes[1]?.key).toBe(writes[0]?.key);
  expect(writes[0]?.token).toBe(correction.mutationToken);
  expect(writes[1]?.token).toBe(writes[0]?.token);
  expect(writes[1]?.body).toEqual(writes[0]?.body);
  expect(writes[0]?.body).toEqual({
    version: 1,
    confirmed: true,
    amountMinor: "2500",
    currency: "EUR",
    eventDate: "2026-10-02",
  });
});

test("EDIT-01 correcting a cash event preserves its identity and carries the read-time workspace token", async ({
  page,
}) => {
  const writes: { path: string; body: unknown; token: string | undefined }[] =
    [];
  await workspace(page, (request) => {
    writes.push(request);
    return { body: { ...result, entryId: "entry-a", entryVersion: 2 } };
  });
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit payment event", exact: true })
    .click();
  await page.getByLabel("Payment amount", { exact: true }).fill("45.00");
  await page
    .getByRole("button", { name: "Save payment correction", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe("/api/ledger-entries/entry-a");
  expect(writes[0]?.body).toEqual({
    version: 1,
    changes: { amountMinor: "4500" },
  });
  expect(writes[0]?.token).toBe(correction.mutationToken);
});

test("EDIT-01 unavailable corrections keep existing purchase and cash readable without false actions", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } }),
  );
  await page.goto("/purchases/purchase-a");
  await expect(
    page.getByText(
      "Corrections are currently unavailable. Your existing purchase records remain readable.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit purchase details", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 50.00");
});

test("EDIT-04 merge and reversal submit distinct owned versions without fabricating ledger changes", async ({
  page,
}) => {
  const writes: { path: string; body: unknown }[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    return { body: { ...result, mergeId: "merge-a" } };
  });
  await page.route("**/api/purchases?*", (route) =>
    route.fulfill({
      json: {
        rows: [
          {
            ...purchase,
            id: "purchase-b",
            merchant: "Synthetic second record",
            version: 3,
          },
        ],
        nextCursor: null,
        dateBasis: "document-or-event",
      },
    }),
  );
  await page.goto("/purchases/purchase-a");
  await page.getByText("Inclusion and merge controls", { exact: true }).click();
  await page
    .getByLabel("Find purchase to merge", { exact: true })
    .fill("second");
  await page
    .getByRole("button", { name: "Find matching purchases", exact: true })
    .click();
  await page
    .getByLabel("Select purchase to merge", { exact: true })
    .selectOption("purchase-b");
  await page
    .getByRole("button", { name: "Merge into this purchase", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: "/api/purchases/merge",
    body: {
      target: { id: "purchase-a", version: 1 },
      source: { id: "purchase-b", version: 3 },
    },
  });
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({
      json: {
        ...correction,
        merges: [
          {
            id: "merge-a",
            targetId: "purchase-a",
            sourceId: "purchase-b",
            targetVersion: 1,
            sourceVersion: 3,
            active: true,
          },
        ],
      },
    }),
  );
  await page
    .getByRole("button", { name: "Refresh records", exact: true })
    .click();
  await page.getByText("Inclusion and merge controls", { exact: true }).click();
  await page
    .getByRole("button", { name: "Reverse merge", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    path: "/api/purchases/purchase-a/unmerge",
    body: { mergeId: "merge-a", version: 1, sourceVersion: 3 },
  });
});

test("EDIT-05 dismissing an operational issue leaves the financial question and valid payment visible", async ({
  page,
}) => {
  let dismissed = false;
  const writes: unknown[] = [];
  await workspace(page, (request) => {
    writes.push(request.body);
    dismissed = true;
    return {
      body: {
        ...result,
        reviewId: "review-op",
        reviewVersion: 2,
        reviewStatus: "dismissed",
      },
    };
  });
  const financial = {
    id: "review-financial",
    version: 2,
    reason: "incomplete-financial-facts",
    blockingScope: "financial",
    missingFields: ["currency"],
    status: "open",
    actions: ["correct-missing-fields"],
  };
  const operational = {
    id: "review-op",
    version: 1,
    reason: "document-review",
    blockingScope: "operational",
    missingFields: [],
    status: "open",
    actions: ["dismiss-operational"],
  };
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({
      json: {
        ...correction,
        reviews: dismissed ? [financial] : [operational, financial],
      },
    }),
  );
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Dismiss operational warning", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([{ version: 1, action: "dismiss-operational" }]);
  await expect(
    page.getByRole("heading", { name: "Operational warning", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Which currency does this document use?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 50.00");
});

test("EDIT-01 mobile correction labels, exact precision and keyboard errors remain accessible", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await workspace(page, (request) => {
    writes.push(request.body);
    return { body: result };
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit purchase details", exact: true })
    .click();
  await page.getByLabel("Document total", { exact: true }).focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("120.001");
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("currency precision");
  expect(writes).toHaveLength(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("EDIT-01 an unsupported original currency does not crash or clear untouched money during a merchant correction", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await workspace(page, (request) => {
    writes.push(request.body);
    return { body: result };
  });
  await page.route("**/api/purchases/purchase-a", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: { purchase: { ...purchase, currency: "CAD" }, timeline: [] },
    });
  });
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit purchase details", exact: true })
    .click();
  await expect(
    page.getByText(/Original amount precision is not configured/),
  ).toBeVisible();
  await page
    .getByLabel("Merchant", { exact: true })
    .fill("User corrected merchant");
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([
    { version: 1, changes: { merchant: "User corrected merchant" } },
  ]);
});

test("EDIT-02 workspace-token rejection clears the old actor's draft and reloads the signed identity", async ({
  page,
}) => {
  let switched = false;
  const tokens: (string | undefined)[] = [];
  await workspace(page, (request) => {
    tokens.push(request.token);
    switched = true;
    return { status: 403, body: { error: "WORKSPACE_CHANGED" } };
  });
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: switched
        ? {
            ...profile,
            user: {
              id: "synthetic-editor-b",
              name: "Editor B",
              email: "editor-b@example.test",
            },
          }
        : profile,
    }),
  );
  await page.route("**/api/purchases/purchase-a", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        purchase: {
          ...purchase,
          merchant: switched
            ? "Other workspace purchase"
            : "Synthetic Merchant",
        },
        timeline: [],
      },
    });
  });
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({
      json: {
        ...correction,
        mutationToken: switched
          ? "synthetic-workspace-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          : correction.mutationToken,
      },
    }),
  );
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit purchase details", exact: true })
    .click();
  await page
    .getByLabel("Merchant", { exact: true })
    .fill("Old actor's unsaved draft");
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect(
    page.getByText("editor-b@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Other workspace purchase",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Merchant", { exact: true })).toHaveCount(0);
  expect(tokens).toEqual([correction.mutationToken]);
});

test("EDIT-05 unlinked source completion collects explicit user values without guessing or confirming cash", async ({
  page,
}) => {
  const writes: { path: string; body: unknown; token: string | undefined }[] =
    [];
  await workspace(page, (request) => {
    writes.push(request);
    return {
      body: {
        ...result,
        purchaseId: "manual-record",
        version: 1,
        reviewId: "unlinked-review",
        reviewVersion: 5,
        reviewStatus: "resolved",
      },
    };
  });
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews: [
          {
            id: "unlinked-review",
            documentId: "unlinked-document",
            purchaseId: null,
            reason: "incomplete-financial-facts",
            missingFields: ["currency"],
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/unlinked-review/corrections", (route) =>
    route.fulfill({
      json: {
        mutationToken: correction.mutationToken,
        review: {
          id: "unlinked-review",
          version: 4,
          reason: "incomplete-financial-facts",
          blockingScope: "financial",
          missingFields: ["currency"],
          status: "open",
          actions: ["complete-record"],
        },
        documentId: "unlinked-document",
        purchaseId: null,
        purchaseVersion: null,
      },
    }),
  );
  await page.goto("/needs-attention");
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: /^Review email/ })
    .click();

  await page
    .getByRole("button", { name: "Add purchase details", exact: true })
    .click();
  await expect(page.getByLabel("Merchant", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Document total", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Merchant", { exact: true }).fill("User supplied cafe");
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(page.getByLabel("Merchant", { exact: true })).not.toBeVisible();
  expect(writes).toEqual([]);
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: /^Review email/ })
    .click();
  await expect(page.getByLabel("Merchant", { exact: true })).toHaveValue(
    "User supplied cafe",
  );
  await page.getByLabel("Currency", { exact: true }).selectOption("JPY");
  await page.getByLabel("Document total", { exact: true }).fill("1000");
  await page.getByLabel("Document date", { exact: true }).fill("2026-10-02");
  await page.getByLabel("Category", { exact: true }).selectOption("dining");
  await page
    .getByRole("button", { name: "Save purchase details", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.path).toBe("/api/review/unlinked-review/resolve");
  expect(writes[0]?.token).toBe(correction.mutationToken);
  expect(writes[0]?.body).toEqual({
    version: 4,
    action: "complete-record",
    record: {
      merchant: "User supplied cafe",
      documentDate: "2026-10-02",
      currency: "JPY",
      totalMinor: "1000",
      category: "dining",
    },
  });
});

test("EDIT-01 exclusion and restoration retain records and send the current purchase version", async ({
  page,
}) => {
  let excluded = false;
  let version = 1;
  const writes: { path: string; body: unknown }[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    excluded = request.path.endsWith("/exclude");
    version += 1;
    return { body: { ...result, version } };
  });
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({
      json: {
        ...correction,
        version,
        recordStatus: excluded ? "excluded" : "active",
      },
    }),
  );
  await page.route("**/api/purchases/purchase-a", (route) =>
    route.request().method() !== "GET"
      ? route.fallback()
      : route.fulfill({
          json: { purchase: { ...purchase, version }, timeline: [] },
        }),
  );
  await page.goto("/purchases/purchase-a");
  await page.getByText("Inclusion and merge controls", { exact: true }).click();
  await page
    .getByLabel("Exclusion reason", { exact: true })
    .selectOption("not-my-purchase");
  await page
    .getByRole("button", { name: "Exclude purchase", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: "/api/purchases/purchase-a/exclude",
    body: { version: 1, reason: "not-my-purchase" },
  });
  await expect(
    page.getByRole("button", { name: "Edit purchase details", exact: true }),
  ).toBeVisible();
  await page.getByText("Inclusion and merge controls", { exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Excluded from recorded spending",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore purchase", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    path: "/api/purchases/purchase-a/restore",
    body: { version: 2 },
  });
  await expect(
    page.getByRole("heading", { name: "Synthetic Merchant", exact: true }),
  ).toBeVisible();
});

test("EDIT-01 an existing cash event can be corrected to zero without confirming a new zero payment", async ({
  page,
}) => {
  const writes: { path: string; body: unknown }[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    return { body: { ...result, entryId: "entry-a", entryVersion: 2 } };
  });
  await page.goto("/purchases/purchase-a");
  await page
    .getByRole("button", { name: "Edit payment event", exact: true })
    .click();
  await page.getByLabel("Payment amount", { exact: true }).fill("0.00");
  await page
    .getByRole("button", { name: "Save payment correction", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: "/api/ledger-entries/entry-a",
    body: { version: 1, changes: { amountMinor: "0" } },
  });
  await expect(
    page.getByRole("button", { name: "Confirm a payment", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm a payment", exact: true })
    .click();
  await page.getByLabel("Payment amount", { exact: true }).fill("0.00");
  await page.getByLabel("Event date", { exact: true }).fill("2026-10-02");
  await page
    .getByLabel("I confirm this payment was completed.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save confirmed payment", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(writes).toHaveLength(1);
});

test("EDIT-03 actual manual cash remains visible and editable without inventing source observations", async ({
  page,
}) => {
  const writes: { path: string; body: unknown }[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    return { body: { ...result, entryId: "manual-event", entryVersion: 4 } };
  });
  const manual = {
    id: "manual-event",
    observationId: null,
    origin: "user-confirmed",
    version: 3,
    kind: "payment",
    minor: "750",
    currency: "EUR",
    date: "2026-10-02",
    dateBasis: "user-confirmed-date",
    eligible: true,
  };
  await page.route("**/api/purchases/purchase-a", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            purchase: {
              ...purchase,
              evidenceCount: 0,
              lifecycle: [
                {
                  currency: "EUR",
                  paidMinor: "750",
                  refundedMinor: "0",
                  netMinor: "750",
                },
              ],
            },
            timeline: [],
            ledgerEntries: [manual],
          },
        })
      : route.fallback(),
  );
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({
      json: {
        ...correction,
        entries: [
          {
            id: "manual-event",
            version: 3,
            origin: "user-confirmed",
            overriddenFields: [],
          },
        ],
      },
    }),
  );
  await page.goto("/purchases/purchase-a");
  await expect(
    page.getByRole("region", { name: "User-confirmed cash events" }),
  ).toContainText("EUR 7.50");
  await expect(
    page.getByText(
      "These cash events were confirmed by you. No source document was created for the confirmation.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit payment event", exact: true })
    .click();
  await expect(page.getByLabel("Payment amount", { exact: true })).toHaveValue(
    "7.50",
  );
  await page.getByLabel("Payment amount", { exact: true }).fill("7.00");
  await page
    .getByRole("button", { name: "Save payment correction", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    path: "/api/ledger-entries/manual-event",
    body: { version: 3, changes: { amountMinor: "700" } },
  });
});

test("EDIT-03 manually associated source stays separate from extracted observations and confirmed cash", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/api/purchases/purchase-a", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            purchase: {
              ...purchase,
              origin: "user-supplied",
              recordStatus: "active",
            },
            timeline: [],
            manualEvidence: [
              {
                documentId: "document-linked",
                provenance: "user-associated",
                source: {
                  mailboxId: "mailbox-a",
                  provider: "gmail",
                  originalAvailable: false,
                  reason: "retrieval_not_implemented",
                },
              },
            ],
            ledgerEntries: [
              {
                id: "manual-payment",
                observationId: null,
                origin: "user-confirmed",
                version: 1,
                kind: "payment",
                minor: "5000",
                currency: "EUR",
                date: "2026-10-01",
                dateBasis: "user-confirmed-date",
                eligible: true,
              },
            ],
          },
        })
      : route.fallback(),
  );
  await page.route("**/api/purchases/purchase-a/corrections", (route) =>
    route.fulfill({
      json: {
        ...correction,
        origin: "user-supplied",
        entries: [
          {
            id: "manual-payment",
            version: 1,
            origin: "user-confirmed",
            overriddenFields: [],
          },
        ],
      },
    }),
  );
  await page.goto("/purchases/purchase-a");
  const linked = page.getByRole("region", {
    name: "Sources you linked",
    exact: true,
  });
  await expect(linked).toBeVisible();
  await expect(linked).toContainText("gmail");
  await expect(linked).toContainText(
    "This link does not create extracted receipt fields or prove a payment.",
  );
  await expect(linked).toContainText("Opening originals is not available yet.");
  await expect(
    page.getByText("Record details were supplied by you.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "User-confirmed cash events" }),
  ).toContainText("EUR 50.00");
  await expect(page.locator(".private-timeline > li")).toHaveCount(0);
  await expect(
    page.getByText("Payment documented", { exact: false }),
  ).toHaveCount(0);
});

test("UX-WORKSPACE-01 purchase detail leads with evidence and keeps corrections explicit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const writes: unknown[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    return { body: result };
  });
  await page.goto("/purchases/purchase-a");
  await expect(
    page.getByRole("heading", { name: "Purchase timeline", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByText("The document total describes the purchase.", {
      exact: false,
    }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm a payment", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "/tmp/ux-workspace-detail-desktop.png",
    fullPage: true,
  });
  await page.getByText("About these amounts", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("The document total describes the purchase.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "/tmp/ux-workspace-detail-mobile.png",
    fullPage: true,
  });
});

test("UX-REVIEW-DISCARD-01 false positive action is explicit and retry survives closing the review", async ({
  page,
}) => {
  const writes: {
    body: unknown;
    key: string | undefined;
    token: string | undefined;
  }[] = [];
  await workspace(page, (request) => {
    writes.push(request);
    return writes.length === 1
      ? { status: 503, body: { error: "UNAVAILABLE" } }
      : {
          body: {
            ...result,
            reviewId: "false-positive",
            reviewVersion: 6,
            reviewStatus: "dismissed",
          },
        };
  });
  await page.route("**/api/purchase-reviews?*", (route) =>
    route.fulfill({
      json: {
        reviews:
          writes.length > 1
            ? []
            : [
                {
                  id: "false-positive",
                  documentId: "unlinked-document",
                  purchaseId: null,
                  reason: "document-review",
                  missingFields: [],
                },
              ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/api/review/false-positive/corrections", (route) =>
    route.fulfill({
      json: {
        purchaseId: null,
        purchaseVersion: null,
        mutationToken: correction.mutationToken,
        documentId: "unlinked-document",
        review: {
          id: "false-positive",
          version: 5,
          status: "open",
          reason: "document-review",
          blockingScope: "operational",
          missingFields: [],
          actions: ["dismiss-operational", "not-a-purchase"],
        },
      },
    }),
  );
  await page.goto("/needs-attention");
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: /^Review email/ })
    .click();

  await page
    .getByRole("button", { name: "Not a purchase", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await page.getByRole("button", { name: /^Review email/ }).click();
  await page
    .getByRole("button", { name: "Retry the same request", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0]?.body).toEqual({ version: 5, action: "not-a-purchase" });
  expect(writes[0]?.key).toBeTruthy();
  expect(writes[1]?.key).toBe(writes[0]?.key);
  expect(writes[1]?.body).toEqual(writes[0]?.body);
  expect(writes[0]?.token).toBe(correction.mutationToken);
  expect(writes[1]?.token).toBe(writes[0]?.token);
  await expect(
    page.getByText("No open questions were found.", { exact: true }),
  ).toBeVisible();
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { history, mockPrivateWorkspace } from "./private-fixture";

test("RECUR-05 user selects actual payments and confirms identity without inventing versions", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  await page.route("**/api/purchases/qa-history", async (route) => {
    await route.fulfill({
      json: {
        purchase: { ...history, version: 9 },
        manualEvidence: [],
        timeline: [],
        ledgerEntries: [
          {
            id: "qa-pay",
            observationId: "qa-paid",
            origin: "source",
            version: 7,
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
            version: 3,
            kind: "refund",
            minor: "3000",
            currency: "EUR",
            date: "2026-10-10",
            dateBasis: "explicit-event-date",
            eligible: true,
          },
        ],
      },
    });
  });
  const writes: unknown[] = [];
  await page.route("**/api/recurring", async (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON());
      expect(route.request().headers()["x-workspace-token"]).toBe(
        "recurring-token",
      );
      return route.fulfill({ json: { status: "stored", version: 1 } });
    }
    return route.fulfill({
      json: {
        status: "current",
        pageScope: "page",
        pageSnapshot: false,
        automaticSuggestionsAvailable: false,
        userSelectionRequired: true,
        records: [],
        nextCursor: null,
        mutationToken: "recurring-token",
      },
    });
  });
  await page.goto("/recurring");
  await expect(
    page.getByRole("heading", { name: "Recurring payments", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose payments from QA history" })
    .click();
  await page.getByLabel("Payment · 2026-01-10 · EUR 120.00").check();
  await expect(page.getByLabel(/Refund/)).toHaveCount(0);
  await page.getByLabel("Service identity").fill("My audio plan");
  await page.getByLabel("Anchor date").fill("2026-01-10");
  await expect(
    page.getByRole("button", { name: "Save recurring series" }),
  ).toBeDisabled();
  await page
    .getByLabel(
      "I confirm these payments belong to the same service and cadence.",
    )
    .check();
  await page.screenshot({
    path: "/tmp/invoxim-recurring-picker-draft-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save recurring series" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    identityKey: "My audio plan",
    cadence: "monthly",
    anchorDate: "2026-01-10",
    entries: [{ entryId: "qa-pay", expectedVersion: 7 }],
  });
});

test("RECUR-UX-02 stale evidence suppresses forecasts; accessible mobile and keyboard", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  await page.route("**/api/recurring", (route) =>
    route.fulfill({
      json: {
        status: "current",
        pageScope: "page",
        pageSnapshot: false,
        automaticSuggestionsAvailable: false,
        userSelectionRequired: true,
        nextCursor: null,
        mutationToken: "recurring-token",
        records: [
          {
            status: "stale",
            reason: "evidence_changed",
            entryIds: ["qa-pay"],
            series: {
              id: "series-1",
              identity_kind: "user-confirmed",
              identity_key: "My audio",
              currency: "EUR",
              cadence: "monthly",
              anchor_date: "2026-01-10",
              state: "confirmed",
              pricing_kind: "unknown",
              selected_entry_count: 1,
              version: 4,
            },
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/recurring");
  await expect(
    page.getByText(
      "Evidence changed. Estimates are unavailable until the payment evidence is reviewed.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/Monthly estimate:/)).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh recurring records" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Recurring payments", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("RECUR-05 configured unavailable is truthful and grants no extra access", async ({
  page,
}) => {
  const state = await mockPrivateWorkspace(page);
  await page.route("**/api/recurring", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "recurring_not_configured" } },
    }),
  );
  await page.goto("/recurring");
  await expect(
    page.getByText("Recurring payments are unavailable in this workspace."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save recurring series" }),
  ).toHaveCount(0);
  expect(
    state.requests.filter((r) => /oauth|drive|mail|ai/.test(r.path)),
  ).toEqual([]);
});

test("RECUR-05 current series version conflicts require review without automatic replay", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  let writes = 0;
  await page.route("**/api/recurring/series-4", async (route) => {
    if (route.request().method() === "PATCH") {
      writes += 1;
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 4,
        state: "paused",
      });
      expect(route.request().headers()["x-workspace-token"]).toBe(
        "current-recurring-token",
      );
      return route.fulfill({
        status: 409,
        json: { error: { code: "recurring_changed" } },
      });
    }
    return route.fulfill({
      json: {
        mutationToken: "current-recurring-token",
        record: {
          status: "current",
          series: {
            id: "series-4",
            identity_kind: "user-confirmed",
            identity_key: "My audio",
            currency: "EUR",
            cadence: "monthly",
            anchor_date: "2026-01-10",
            state: "confirmed",
            pricing_kind: "unknown",
            selected_entry_count: 1,
            version: 4,
          },
          projection: {
            status: "insufficient",
            reason: "insufficient_history",
            decision: { state: "confirmed", version: 4 },
            methodVersion: "recurring-v1",
          },
        },
      },
    });
  });
  await page.goto("/recurring/series-4");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByText(
      "The series or payment evidence changed. Refresh and review before submitting a new decision.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark canceled" }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: "Refresh and review latest evidence" })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  expect(writes).toBe(1);
});

test("RECUR-05 actor change clears selection and token before a new decision", async ({
  page,
}) => {
  const state = await mockPrivateWorkspace(page);
  let writes = 0;
  await page.route("**/api/recurring", (route) => {
    if (route.request().method() !== "GET") writes += 1;
    return route.fulfill({
      json: {
        status: "current",
        pageScope: "page",
        pageSnapshot: false,
        automaticSuggestionsAvailable: false,
        userSelectionRequired: true,
        records: [],
        nextCursor: null,
        mutationToken: `recurring-${state.owner}`,
      },
    });
  });
  await page.goto("/recurring");
  await page
    .getByRole("button", { name: "Choose payments from QA history" })
    .click();
  await page.getByLabel("Payment · 2026-01-10 · EUR 120.00").check();
  await page.getByLabel("Service identity").fill("Old account intent");
  state.owner = "b";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("button", { name: "Choose payments from QA other owner" }),
  ).toBeVisible();
  await expect(page.getByLabel("Service identity")).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Review selected payments (0/20)" }),
  ).toBeVisible();
  expect(writes).toBe(0);
});

const reviewSeries = {
  id: "review-series",
  identity_kind: "user-confirmed",
  identity_key: "Synthetic audio service",
  currency: "EUR",
  cadence: "monthly",
  anchor_date: "2026-01-10",
  state: "suggestion",
  pricing_kind: "unknown",
  selected_entry_count: 1,
  version: 8,
} as const;
const reviewCurrentRecord = {
  status: "current",
  series: reviewSeries,
  projection: {
    status: "series",
    state: "suggested",
    decision: null,
    serviceIdentity: { kind: "user-confirmed", key: "Synthetic audio service" },
    currency: "EUR",
    cadence: "monthly",
    anchorDate: "2026-01-10",
    scheduleBasis: "user-confirmed",
    postingToleranceDays: 3,
    methodVersion: "recurring-v1",
    entryIds: ["qa-pay"],
    lastPayment: {
      entryId: "qa-pay",
      purchaseId: "qa-history",
      kind: "payment",
      eligible: true,
      installment: false,
      amountMinor: "12000",
      currency: "EUR",
      eventDate: "2026-01-10",
      serviceIdentity: {
        kind: "user-confirmed",
        key: "Synthetic audio service",
      },
      pricing: { kind: "unknown", evidence: "unknown" },
    },
    comparison: null,
    forecast: {
      estimatedNextDate: "2026-02-10",
      monthlyMinor: "12000",
      annualMinor: "144000",
      amountBasis: "last-payment",
      weeklyPaymentsPerYear: null,
      certainty: "estimate",
    },
  },
};

test("RECUR-05 review regression recurring pagination uses the actual after key", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  const queries: string[] = [];
  await page.route(/\/api\/recurring(?:\/[^?]+)?(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    if (url.search && url.search !== "?after=next-series")
      return route.fulfill({
        status: 400,
        json: { error: { code: "invalid_request" } },
      });
    const next = url.searchParams.has("after");
    return route.fulfill({
      json: {
        status: "current",
        pageScope: "page",
        pageSnapshot: false,
        automaticSuggestionsAvailable: false,
        userSelectionRequired: true,
        records: next
          ? [
              {
                ...reviewCurrentRecord,
                series: {
                  ...reviewSeries,
                  id: "next-series",
                  identity_key: "Synthetic second page",
                },
              },
            ]
          : [reviewCurrentRecord],
        nextCursor: next ? null : "next-series",
        mutationToken: "recurring-review-token",
      },
    });
  });
  await page.goto("/recurring");
  await expect(page.getByText("Annual estimate:")).toBeVisible();
  await page.screenshot({
    path: "/tmp/invoxim-recurring-current-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Next recurring page" }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic second page" }),
  ).toBeVisible();
  expect(queries).toEqual(["", "?after=next-series"]);
  await expect(
    page.getByRole("link", { name: "Next recurring page" }),
  ).toHaveCount(0);
});

test("RECUR-05 review regression stale series can be canceled without confirming stale evidence", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  let canceled = false;
  const writes: unknown[] = [];
  await page.route(/\/api\/recurring(?:\/[^?]+)?(?:\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON());
      expect(route.request().headers()["x-workspace-token"]).toBe(
        "recurring-review-token",
      );
      canceled = true;
      return route.fulfill({ json: { status: "stored", version: 9 } });
    }
    return route.fulfill({
      json: {
        status: "current",
        pageScope: "page",
        pageSnapshot: false,
        automaticSuggestionsAvailable: false,
        userSelectionRequired: true,
        records: [
          {
            status: "stale",
            reason: "evidence_changed",
            entryIds: ["qa-pay"],
            series: {
              ...reviewSeries,
              state: canceled ? "canceled" : "suggestion",
              version: canceled ? 9 : 8,
            },
          },
        ],
        nextCursor: null,
        mutationToken: "recurring-review-token",
      },
    });
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/recurring");
  await expect(
    page.getByRole("button", { name: "Confirm", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Annual estimate:")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mark canceled" }),
  ).toBeEnabled();
  await page.screenshot({
    path: "/tmp/invoxim-recurring-stale-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Mark canceled" }).click();
  await expect
    .poll(() => writes)
    .toEqual([{ expectedVersion: 8, state: "canceled" }]);
  await expect(
    page
      .getByRole("article", {
        name: "Synthetic audio service recurring series",
      })
      .getByText("canceled", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Annual estimate:")).toHaveCount(0);
});

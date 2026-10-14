import type {
  OnboardingDisclosure,
  OnboardingResponse,
  ProfileView,
} from "@invoxim/contracts";
import { expect, type Page, test } from "@playwright/test";
import { mockPrivateWorkspace } from "./private-fixture";

async function workspace(page: Page) {
  const state = {
    owner: "qa-onboarding-owner-a",
    policy: "A",
    writes: [] as unknown[],
    beforeDisclosure: async () => {},
  };
  const data: OnboardingResponse = {
    view: {
      schemaVersion: 1,
      state: "review_import",
      headlineKey: "import.review.title",
      primaryAction: "start_import",
      canStartImport: true,
      readyRecordCount: 0,
      historyComplete: false,
      hasProcessingConsent: false,
      exampleData: false,
      activeImportId: null,
      connectionId: "qa-receipt-inbox",
      reviewItemCount: 0,
    },
    login: { email: `${state.owner}@example.invalid` },
    settings: { version: 1, timezone: "UTC", reportingCurrency: "JPY" },
    connections: [
      {
        id: "qa-receipt-inbox",
        provider: "gmail",
        address: "receipts-b@example.invalid",
        generation: 3,
        state: "connected",
        schedulingState: "awaiting_import",
        scopeReady: true,
      },
    ],
    capabilities: { mailboxProviders: ["gmail"] },
    mailboxLimit: 3,
    progress: null,
  };
  const disclosure: OnboardingDisclosure = {
    disclosureVersion: "c".repeat(64),
    configurationDigest: "d".repeat(64),
    reviewToken: "synthetic-qa-reviewed-token-a",
    expiresAt: "2099-01-01T00:00:00Z",
    connectionId: "qa-receipt-inbox",
    connectionGeneration: 3,
    mailboxAddress: "receipts-b@example.invalid",
    loginEmail: data.login.email,
    profileVersion: 1,
    aiSettingsRevision: 0,
    selectedAiSettingsRevision: 1,
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    startAt: "2025-01-01T00:00:00Z",
    cutoffAt: "2026-01-01T00:00:00Z",
    timezone: "UTC",
    reportingCurrency: "JPY",
    inference: {
      providerId: "qa-selected-processor",
      model: "qa-selected-model",
      mode: "hosted",
      policyVersion: 1,
      noticeRefs: ["qa-policy"],
      notices: [
        {
          id: "qa-policy",
          displayName: "QA readable policy",
          dataUseSummary: "Synthetic use policy A",
          retentionSummary: "Synthetic retention A",
          privacyUrl: "https://qa-policy.example.invalid/a",
        },
      ],
      ready: true,
    },
    documentConversion: {
      providerId: "local-worker-text-parser",
      version: "local-text-v1",
      policyVersion: "local-parser-v1",
      noticeRefs: ["transient"],
      ready: true,
    },
    allowance: {
      dailyDocumentsRemaining: 2,
      monthlyDocumentsRemaining: 7,
      dailyUnitsRemaining: 100,
      monthlyUnitsRemaining: 500,
      hostedFundingAvailable: true,
      cooldownActive: false,
      dailyResetAt: "2026-10-14T00:00:00Z",
      monthlyResetAt: "2026-11-01T00:00:00Z",
    },
    canStartImport: true,
    availability: "ready",
    retentionNoticeVersion: "purchase-records-transient-v1",
    authorizeHourlySync: true,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      state.writes.push(request.postDataJSON());
      await route.fulfill({
        status: 409,
        json: { error: { code: "processing_review_required" } },
      });
      return;
    }
    let body: unknown;
    if (path === "/api/me") {
      const profile: ProfileView = {
        user: {
          id: state.owner,
          name: "QA reader",
          email: `${state.owner}@example.invalid`,
        },
        settings: data.settings,
        onboarding: { completedAt: null },
        capabilities: { mailProviders: [], driveArchive: false },
        valuation: { status: "not_configured" },
      };
      body = profile;
    } else if (path === "/api/onboarding")
      body = { ...data, login: { email: `${state.owner}@example.invalid` } };
    else if (path === "/api/processing-disclosure") {
      await state.beforeDisclosure();
      body = {
        ...disclosure,
        reviewToken: `synthetic-qa-reviewed-token-${state.policy.toLowerCase()}`,
        disclosureVersion: (state.policy === "A" ? "c" : "e").repeat(64),
        inference: {
          ...disclosure.inference,
          notices: [
            {
              ...disclosure.inference.notices[0],
              dataUseSummary: `Synthetic use policy ${state.policy}`,
              retentionSummary: `Synthetic retention ${state.policy}`,
              privacyUrl: `https://qa-policy.example.invalid/${state.policy.toLowerCase()}`,
            },
          ],
        },
      };
    } else {
      await route.fulfill({
        status: 503,
        json: { error: { code: "not_configured" } },
      });
      return;
    }
    await route.fulfill({ json: body });
  });
  return { state, data, disclosure };
}
const authorization =
  "I authorize the displayed processing and hourly receipt checks.";

test("ONBOARD-06/09 readable policy refresh clears old consent while retaining the full reviewed interval", async ({
  page,
}) => {
  const { state } = await workspace(page);
  await page.goto("/onboarding/review");
  await page
    .getByRole("button", { name: "Processing and privacy details" })
    .click();
  await expect(
    page.getByText("Synthetic retention A", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Read QA readable policy" }),
  ).toHaveAttribute("href", "https://qa-policy.example.invalid/a");
  await expect(
    page.getByRole("region", { name: "Processing allowance" }),
  ).toContainText("2 documents remaining today");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByLabel(authorization, { exact: true }).check();
  state.policy = "B";
  await page
    .getByRole("button", { name: "Refresh review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Processing and privacy details" })
    .click();
  await expect(
    page.getByText("Synthetic retention B", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(
    page.getByLabel(authorization, { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Processing and privacy details" })
    .click();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(
    page.getByText("2025-01-01T00:00:00Z", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2026-01-01T00:00:00Z", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  expect(state.writes).toEqual([]);
  await page.getByLabel(authorization, { exact: true }).check();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    reviewToken: "synthetic-qa-reviewed-token-b",
    acceptedDisclosureVersion: "e".repeat(64),
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    reportingCurrency: "JPY",
  });
});

test("ONBOARD-08/11/RECENT-07 budget pause preserves keyboard focus and available records during unfinished older history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const { data, state } = await workspace(page);
  data.view = {
    ...data.view,
    state: "records_ready",
    activeImportId: "qa-durable-import",
    hasProcessingConsent: true,
    primaryAction: "view_purchases",
    canStartImport: false,
    readyRecordCount: 1,
  };
  data.progress = {
    importRunId: "qa-durable-import",
    connectionId: "qa-receipt-inbox",
    startAt: "2025-01-01T00:00:00Z",
    cutoffAt: "2026-01-01T00:00:00Z",
    stage: "processing",
    discoveredSources: 5,
    processedSources: 1,
    unsupportedSources: 0,
    failedSources: 0,
    reviewSources: 0,
    readyRecordCount: 1,
    reviewItemCount: 0,
    pendingJobs: 4,
    pausedJobs: 0,
    failedJobs: 0,
    historyComplete: false,
    pauseReason: null,
  };
  await page.goto("/onboarding");
  const status = page.getByRole("region", { name: "Import status" });
  await expect(status.getByRole("status")).toContainText(
    "Purchase records are ready",
  );
  const refresh = page.getByRole("button", { name: "Refresh import status" });
  await refresh.focus();
  data.view = { ...data.view, state: "paused_budget" };
  data.progress = {
    ...data.progress,
    pausedJobs: 4,
    pauseReason: "daily_budget",
  };
  await page.keyboard.press("Enter");
  await expect(status.getByRole("status")).toContainText(
    "Processing is paused",
  );
  await expect(refresh).toBeFocused();
  await expect(
    status.getByRole("link", { name: "View purchase records", exact: true }),
  ).toHaveAttribute("href", "/purchases");
  await expect(status).not.toContainText("No matching purchase records");
  expect(page.url()).toContain("/onboarding");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(status.getByRole("status")).toContainText(
    "Processing is paused",
  );
  expect(state.writes).toEqual([]);
});

test("ONBOARD-04/09 account changing during disclosure delivery never publishes old processor approval or enables Start", async ({
  page,
}) => {
  const { state } = await workspace(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  state.beforeDisclosure = async () => {
    entered = true;
    await gate;
  };
  await page.goto("/onboarding/review");
  await expect.poll(() => entered).toBe(true);
  state.owner = "qa-onboarding-owner-b";
  release();
  await expect(
    page.getByText("Synthetic retention A", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel(authorization, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("qa-onboarding-owner-b@example.invalid", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("RECENT-10 separately measures the first user action opening available record history", async ({
  page,
}, info) => {
  const { data } = await workspace(page),
    privateState = await mockPrivateWorkspace(page);
  data.login.email = "qa-private-a@example.invalid";
  data.view = {
    ...data.view,
    state: "records_ready",
    primaryAction: "view_purchases",
    canStartImport: false,
    hasProcessingConsent: true,
    readyRecordCount: 1,
    activeImportId: "qa-action-import",
  };
  data.progress = {
    importRunId: "qa-action-import",
    connectionId: "qa-receipt-inbox",
    startAt: "2025-01-01T00:00:00Z",
    cutoffAt: "2026-01-01T00:00:00Z",
    stage: "processing",
    discoveredSources: 5,
    processedSources: 1,
    unsupportedSources: 0,
    failedSources: 0,
    reviewSources: 0,
    readyRecordCount: 1,
    reviewItemCount: 0,
    pendingJobs: 4,
    pausedJobs: 0,
    failedJobs: 0,
    historyComplete: false,
    pauseReason: null,
  };
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/onboarding");
  const available = page.getByRole("link", {
    name: "View purchase records",
    exact: true,
  });
  await expect(available).toBeVisible();
  const began = Date.now();
  await available.click();
  const record = page.getByRole("article", { name: "QA history purchase" });
  await expect(record).toBeVisible();
  const recordsOpenedMs = Date.now() - began;
  await record.getByRole("link", { name: "QA history", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 90.00");
  const historyOpenedMs = Date.now() - began;
  expect(
    privateState.requests.every((request) => request.method === "GET"),
  ).toBe(true);
  await info.attach("RECENT-10 synthetic first user action", {
    body: JSON.stringify({
      samples: 1,
      recordsOpenedMs,
      historyOpenedMs,
      failures: 0,
      pauses: 0,
      serverHistoryPending: true,
      workload:
        "Browser fixture: completed EUR120 payment, EUR30 cash refund, one separate pending invoice",
      transport:
        "Synthetic immediate API responses; separate from native Start-to-record samples; no live provider/network SLA",
    }),
    contentType: "application/json",
  });
});

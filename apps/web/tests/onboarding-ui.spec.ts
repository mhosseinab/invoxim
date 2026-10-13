import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const profile = {
  user: {
    id: "login-a",
    name: "Synthetic reader",
    email: "login-a@example.test",
  },
  settings: { timezone: "Europe/Vienna", reportingCurrency: "EUR", version: 1 },
  onboarding: { completedAt: null },
  capabilities: { mailProviders: [], driveArchive: false },
  valuation: { status: "not_configured" },
};
const connection = {
  id: "mailbox-b",
  provider: "gmail",
  address: "mailbox-b@example.test",
  generation: 2,
  state: "connected",
  schedulingState: "awaiting_import",
  scopeReady: true,
};
const view = {
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
  connectionId: "mailbox-b",
  reviewItemCount: 0,
};
const onboarding = {
  view,
  login: { email: profile.user.email },
  settings: profile.settings,
  connections: [connection],
  mailboxLimit: 3,
  capabilities: { mailboxProviders: ["gmail"] },
  progress: null,
};
const disclosure = {
  disclosureVersion: "a".repeat(64),
  configurationDigest: "b".repeat(64),
  reviewToken: "synthetic-signed-review-token",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  connectionId: "mailbox-b",
  connectionGeneration: 2,
  mailboxAddress: "mailbox-b@example.test",
  loginEmail: "login-a@example.test",
  profileVersion: 1,
  aiSettingsRevision: 0,
  selectedAiSettingsRevision: 1,
  startDate: "2025-10-12",
  endDate: "2026-10-12",
  startAt: "2025-10-11T22:00:00.000Z",
  cutoffAt: "2026-10-12T12:00:00.000Z",
  timezone: "Europe/Vienna",
  reportingCurrency: "EUR",
  inference: {
    providerId: "synthetic-hosted-processor",
    model: "synthetic-receipt-model",
    mode: "hosted",
    policyVersion: 1,
    noticeRefs: ["synthetic-policy"],
    notices: [
      {
        id: "synthetic-policy",
        displayName: "Synthetic processor policy",
        dataUseSummary: "Synthetic policy text for this browser fixture only.",
        retentionSummary:
          "Synthetic retention terms; no live processing is performed by this test.",
        privacyUrl: "https://privacy.example.test/policy",
      },
    ],
    ready: true,
  },
  documentConversion: {
    providerId: "local-worker-text-parser",
    version: "local-text-v1",
    policyVersion: "local-parser-v1",
    noticeRefs: ["local-transient-parser"],
    ready: true,
  },
  allowance: {
    dailyDocumentsRemaining: 10,
    monthlyDocumentsRemaining: 100,
    dailyUnitsRemaining: 10000,
    monthlyUnitsRemaining: 100000,
    hostedFundingAvailable: true,
    cooldownActive: false,
    dailyResetAt: "2026-10-13T00:00:00.000Z",
    monthlyResetAt: "2026-11-01T00:00:00.000Z",
  },
  canStartImport: true,
  availability: "ready",
  retentionNoticeVersion: "purchase-records-transient-v1",
  authorizeHourlySync: true,
};
async function fixtures(
  page: Page,
  start: (
    body: unknown,
    key: string | undefined,
  ) => { status?: number; body: unknown } = () => ({
    body: { importRunId: "run-b", reused: false },
  }),
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/onboarding/start-import") {
      const response = start(
        request.postDataJSON(),
        request.headers()["idempotency-key"],
      );
      await route.fulfill({
        status: response.status ?? 200,
        json: response.body,
      });
      return;
    }
    let body: unknown;
    if (path === "/api/me") body = profile;
    else if (path === "/api/onboarding") body = onboarding;
    else if (path === "/api/processing-disclosure") body = disclosure;
    else {
      await route.fulfill({
        status: 503,
        json: { error: { code: "not_configured" } },
      });
      return;
    }
    await route.fulfill({ json: body });
  });
}

test("ONBOARD-04/06 actual login and mailbox identities, processors and full frozen range precede explicit Start", async ({
  page,
}) => {
  const starts: unknown[] = [];
  await fixtures(page, (body) => {
    starts.push(body);
    return { body: { importRunId: "run-b", reused: false } };
  });
  await page.goto("/onboarding/review");
  await expect(
    page.getByRole("heading", { name: "Review and start", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("login-a@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("mailbox-b@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("synthetic-hosted-processor", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic policy text for this browser fixture only.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("2025-10-11T22:00:00.000Z", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2026-10-12T12:00:00.000Z", { exact: true }),
  ).toBeVisible();
  expect(starts).toHaveLength(0);
  await page
    .getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    )
    .check();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toEqual({
    connectionId: "mailbox-b",
    expectedConnectionGeneration: 2,
    expectedAiSettingsRevision: 0,
    expectedProfileVersion: 1,
    acceptedDisclosureVersion: disclosure.disclosureVersion,
    reviewToken: disclosure.reviewToken,
    startDate: "2025-10-12",
    endDate: "2026-10-12",
    timezone: "Europe/Vienna",
    reportingCurrency: "EUR",
    authorizeHourlySync: true,
  });
});

test("ONBOARD-09 changed processing disclosure blocks old acceptance and never silently resubmits", async ({
  page,
}) => {
  let starts = 0;
  await fixtures(page, () => {
    starts += 1;
    return {
      status: 409,
      body: {
        error: {
          code: "processing_review_required",
          message: "Request unavailable",
          requestId: "synthetic",
          retryable: false,
        },
      },
    };
  });
  await page.goto("/onboarding/review");
  await page
    .getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    )
    .check();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Review the current details",
  );
  await expect(
    page.getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    ),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
  expect(starts).toBe(1);
});

test("ONBOARD-09 unknown Start retry preserves token, complete body and idempotency key", async ({
  page,
}) => {
  const requests: { body: unknown; key: string | undefined }[] = [];
  await fixtures(page, (body, key) => {
    requests.push({ body, key });
    return requests.length === 1
      ? { status: 503, body: { error: { code: "processing_unavailable" } } }
      : { body: { importRunId: "run-b", reused: true } };
  });
  await page.goto("/onboarding/review");
  await page
    .getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    )
    .check();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("result is unknown");
  await page
    .getByRole("button", { name: "Retry the same Start request" })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]?.key).toBeTruthy();
});

test("ONBOARD-06/09 preference edits require a new reviewed disclosure and clear consent", async ({
  page,
}) => {
  const starts: unknown[] = [];
  await fixtures(page, (body) => {
    starts.push(body);
    return { body: { importRunId: "run-b", reused: false } };
  });
  await page.goto("/onboarding/review");
  await page
    .getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    )
    .check();
  await page
    .getByText("Change dates, time zone or currency", { exact: true })
    .click();
  await page.getByLabel("Start date", { exact: true }).fill("2026-01-01");
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    ),
  ).not.toBeChecked();
  expect(starts).toHaveLength(0);
});

test("ONBOARD-03 unavailable mailbox provider remains honest and never starts authorization", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({
      json: {
        ...onboarding,
        connections: [],
        capabilities: { mailboxProviders: [] },
        view: {
          ...view,
          state: "connect_mailbox",
          headlineKey: "mailbox.title",
          primaryAction: "connect_mailbox",
          canStartImport: false,
          connectionId: null,
        },
      },
    }),
  );
  await page.goto("/onboarding");
  await expect(
    page.getByText("Mailbox connection is not configured.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Gmail inbox" }),
  ).toHaveCount(0);
});

test("ACCESS-02 360px review is keyboard reachable with no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await fixtures(page);
  await page.goto("/onboarding/review");
  await expect(
    page.getByText("2026-10-12T12:00:00.000Z", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  const checkbox = page.getByLabel(
    "I authorize the displayed processing and hourly receipt checks.",
    { exact: true },
  );
  for (
    let step = 0;
    step < 30 &&
    !(await checkbox.evaluate((node) => node === document.activeElement));
    step += 1
  )
    await page.keyboard.press("Tab");
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "evidence/implementation/t29-frontend-mobile.png",
    fullPage: true,
  });
});

test("ONBOARD-14/RECENT-07 actual first records are available during paused partial history without navigation or zero-spend claims", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({
      json: {
        ...onboarding,
        view: {
          ...view,
          state: "paused_budget",
          headlineKey: "import.paused.budget",
          primaryAction: "view_usage",
          canStartImport: false,
          readyRecordCount: 2,
          hasProcessingConsent: true,
          activeImportId: "run-b",
        },
        progress: {
          importRunId: "run-b",
          connectionId: "mailbox-b",
          startAt: disclosure.startAt,
          cutoffAt: disclosure.cutoffAt,
          stage: "older_history",
          discoveredSources: 20,
          processedSources: 3,
          unsupportedSources: 1,
          failedSources: 0,
          reviewSources: 0,
          readyRecordCount: 2,
          reviewItemCount: 0,
          pendingJobs: 4,
          pausedJobs: 1,
          failedJobs: 0,
          historyComplete: false,
          pauseReason: "budget",
        },
      },
    }),
  );
  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "Your import" }),
  ).toBeVisible();
  await expect(page.getByText("Import paused", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View purchase records" }),
  ).toHaveAttribute("href", "/purchases");
  await expect(
    page.getByText("This is not complete receipt coverage.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("No matching purchase records were found", { exact: false }),
  ).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/onboarding");
});

test("ACCESS-02 verified mailbox return focuses the review heading once", async ({
  page,
}) => {
  await fixtures(page);
  await page.goto(
    "/onboarding/review?mailbox=connected&connectionId=mailbox-b",
  );
  await expect(
    page.getByRole("heading", { name: "Review and start", exact: true }),
  ).toBeFocused();
});

test("ONBOARD-04/12 changing to another owned mailbox retains login and requires its own review before Start", async ({
  page,
}) => {
  const starts: unknown[] = [];
  await fixtures(page, (body) => {
    starts.push(body);
    return { body: { importRunId: "run-b", reused: false } };
  });
  await page.route("**/api/onboarding*", (route) =>
    route.fulfill({
      json: {
        ...onboarding,
        connections: [
          connection,
          { ...connection, id: "mailbox-c", address: "mailbox-c@example.test" },
        ],
      },
    }),
  );
  await page.route("**/api/processing-disclosure*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("connectionId");
    return route.fulfill({
      json:
        id === "mailbox-c"
          ? {
              ...disclosure,
              connectionId: id,
              mailboxAddress: "mailbox-c@example.test",
            }
          : disclosure,
    });
  });
  await page.goto("/onboarding/review");
  await page.getByRole("button", { name: "Change mailbox" }).click();
  await page.getByLabel("Receipt inbox").selectOption("mailbox-c");
  await page.getByRole("button", { name: "Review selected inbox" }).click();
  await expect(
    page.getByText("mailbox-c@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("login-a@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
  expect(starts).toHaveLength(0);
});

const aiSettings = {
  version: 0,
  mode: "hosted",
  providerId: "synthetic-hosted-processor",
  modelId: "synthetic-receipt-model",
  keyConfigured: false,
  processingReviewRequired: true,
  configured: true,
  allowance: {
    dailyDocumentsRemaining: 10,
    monthlyDocumentsRemaining: 100,
    dailyUnitsRemaining: 10000,
    monthlyUnitsRemaining: 100000,
    hostedFundingAvailable: true,
    cooldownActive: false,
  },
  availability: "processing-review-required",
  capabilities: {
    text: true,
    image: false,
    nativePdf: false,
    jsonSchema: true,
    jsonObject: true,
  },
  providers: [
    {
      id: "synthetic-hosted-processor",
      models: ["synthetic-receipt-model"],
      policyVersion: 1,
      noticeRefs: ["synthetic-policy"],
    },
  ],
};
test("ONBOARD-08 optional AI settings require and forward the same form's workspace token", async ({
  page,
}) => {
  await fixtures(page);
  const writes: { token: string | undefined; body: unknown }[] = [];
  await page.route("**/api/ai/settings", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { ...aiSettings, mutationToken: "synthetic-ai-workspace-token" },
      });
    writes.push({
      token: route.request().headers()["x-workspace-token"],
      body: route.request().postDataJSON(),
    });
    return route.fulfill({
      json: { ...aiSettings, version: 1, mode: "byok", keyConfigured: true },
    });
  });
  await page.goto("/onboarding/review");
  await page.getByText("Advanced AI (optional)", { exact: true }).click();
  await page
    .getByLabel("AI API key", { exact: true })
    .fill("synthetic-key-no-live-access");
  await page
    .getByLabel(
      "Use this provider and policy revision for the next processing review.",
    )
    .check();
  await page.getByRole("button", { name: "Save AI choice" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    token: "synthetic-ai-workspace-token",
    body: {
      version: 0,
      mode: "byok",
      providerId: "synthetic-hosted-processor",
      modelId: "synthetic-receipt-model",
      acceptedPolicyVersion: 1,
      apiKey: "synthetic-key-no-live-access",
    },
  });
  await expect(page.getByLabel("AI API key", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
});
test("ONBOARD-08 optional AI settings cannot save when the server form has no workspace token", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/ai/settings", (route) =>
    route.fulfill({ json: aiSettings }),
  );
  await page.goto("/onboarding/review");
  await page.getByText("Advanced AI (optional)", { exact: true }).click();
  await page
    .getByLabel(
      "Use this provider and policy revision for the next processing review.",
    )
    .check();
  await expect(
    page.getByRole("button", { name: "Save AI choice" }),
  ).toBeDisabled();
});

test("ONBOARD-05 denied permission keeps login, shows actual partial scope and never loops OAuth", async ({
  page,
}) => {
  await fixtures(page);
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET")
      commands.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({
      json: {
        ...onboarding,
        connections: [{ ...connection, scopeReady: false }],
        view: {
          ...view,
          state: "needs_reconnect",
          headlineKey: "import.paused.auth",
          primaryAction: "reconnect",
          canStartImport: false,
        },
      },
    }),
  );
  await page.goto("/onboarding?mailbox=denied");
  await expect(
    page.getByRole("heading", { name: "Reconnect your receipt inbox" }),
  ).toBeVisible();
  await expect(
    page.getByText("login-a@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Mailbox authorization was not completed.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect mailbox-b@example.test" }),
  ).toBeVisible();
  expect(commands).toEqual([]);
});

test("ONBOARD-11/RECENT-08 reload resumes actual pending older history without another Start or zero spending", async ({
  page,
}) => {
  await fixtures(page);
  let starts = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/onboarding/start-import")
      starts += 1;
  });
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({
      json: {
        ...onboarding,
        view: {
          ...view,
          state: "importing",
          headlineKey: "import.progress.older",
          primaryAction: "none",
          canStartImport: false,
          hasProcessingConsent: true,
          activeImportId: "run-b",
        },
        progress: {
          importRunId: "run-b",
          connectionId: "mailbox-b",
          startAt: disclosure.startAt,
          cutoffAt: disclosure.cutoffAt,
          stage: "older_history",
          discoveredSources: 5,
          processedSources: 0,
          unsupportedSources: 0,
          failedSources: 0,
          reviewSources: 0,
          readyRecordCount: 0,
          reviewItemCount: 0,
          pendingJobs: 5,
          pausedJobs: 0,
          failedJobs: 0,
          historyComplete: false,
          pauseReason: null,
        },
      },
    }),
  );
  await page.goto("/onboarding");
  await expect(
    page.getByText(
      "No purchase records are ready yet. The selected history has not finished processing.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Import in progress", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The selected history has not finished processing.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(starts).toBe(0);
});

test("ONBOARD-14 missing receipt processing is explained without a review retry loop", async ({
  page,
}) => {
  let disclosureReads = 0;
  const writes: string[] = [];
  const requestTrace: { path: string; at: number }[] = [];
  await page.addInitScript(() => {
    const events: { event: string; at: number }[] = [];
    for (const event of ["focus", "pageshow", "visibilitychange"]) {
      const target = event === "visibilitychange" ? document : window;
      target.addEventListener(event, () => {
        events.push({ event, at: Date.now() });
        sessionStorage.setItem(
          "qa-processing-foreground-events",
          JSON.stringify(events),
        );
      });
    }
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requestTrace.push({ path, at: Date.now() });
    if (
      request.method() !== "GET" &&
      new URL(request.url()).pathname.startsWith("/api/")
    )
      writes.push(new URL(request.url()).pathname);
  });
  await fixtures(page);
  await page.route("**/api/processing-disclosure*", (route) => {
    disclosureReads++;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: "processing_not_configured",
          retryable: false,
          message: "UNTRUSTED_INTERNAL_PROVIDER_DETAIL",
        },
      },
    });
  });
  await page.goto("/onboarding/review");
  await expect(page.getByRole("alert")).toHaveText(
    "Import is not available yet because receipt processing has not been configured. Your inbox is connected; this review has not started a new import.",
  );
  await expect(
    page.getByRole("button", { name: "Refresh review", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "View existing records", exact: true }),
  ).toHaveAttribute("href", "/purchases");
  await expect(
    page.getByText("UNTRUSTED_INTERNAL_PROVIDER_DETAIL"),
  ).toHaveCount(0);
  const foregroundEvents = await page.evaluate(() =>
    sessionStorage.getItem("qa-processing-foreground-events"),
  );
  expect(
    disclosureReads,
    JSON.stringify({ requestTrace, foregroundEvents }),
  ).toBe(1);
  expect(writes).toEqual([]);
});

test("ONBOARD-14 resolved processing disclosure explains service configuration without claiming details are unavailable", async ({
  page,
}) => {
  const starts: unknown[] = [];
  await fixtures(page, (body) => {
    starts.push(body);
    return { body: { importRunId: "run-b", reused: false } };
  });
  await page.route("**/api/processing-disclosure*", (route) =>
    route.fulfill({
      json: {
        ...disclosure,
        canStartImport: false,
        availability: "configuration",
      },
    }),
  );
  await page.goto("/onboarding/review");
  await expect(
    page.getByText("synthetic-hosted-processor", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Import is not enabled on this service yet. Your inbox is connected; no new import has started.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Processing details are unavailable.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    ),
  ).toBeDisabled();
  expect(starts).toEqual([]);
});

for (const error of [
  { code: "processing_unavailable", retryable: true },
  { code: "processing_not_configured", retryable: true },
  { code: "unknown", retryable: false },
]) {
  test(`ONBOARD-14 unavailable or invalid processing envelope preserves manual retry (${error.code}/${error.retryable})`, async ({
    page,
  }) => {
    let reads = 0;
    await fixtures(page);
    await page.route("**/api/processing-disclosure*", (route) => {
      reads++;
      return route.fulfill({ status: 503, json: { error } });
    });
    await page.goto("/onboarding/review");
    await expect(page.getByRole("alert")).toHaveText(
      "Processing details are unavailable. Import cannot start until approved processing is configured.",
    );
    await page
      .getByRole("button", { name: "Refresh review", exact: true })
      .click();
    await expect.poll(() => reads).toBe(2);
    await expect(
      page.getByRole("button", { name: "Start import", exact: true }),
    ).toHaveCount(0);
  });
}

test("Disabled Gmail API shows the app configuration problem and prevents blind Start retry", async ({
  page,
}) => {
  let starts = 0;
  await fixtures(page, () => {
    starts++;
    return {
      status: 503,
      body: {
        error: {
          code: "mailbox_api_disabled",
          retryable: false,
          message: "synthetic-provider-response-must-not-be-copy",
        },
      },
    };
  });
  await page.goto("/onboarding/review");
  await page
    .getByLabel(
      "I authorize the displayed processing and hourly receipt checks.",
      { exact: true },
    )
    .check();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Gmail API is disabled for this app. Enable it in the Google Cloud project before importing.",
  );
  await expect(
    page.getByRole("button", { name: "Start import", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Retry the same Start request" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).not.toContainText("result is unknown");
  await expect(page.getByRole("alert")).not.toContainText("Reconnect");
  expect(starts).toBe(1);
});

test("ONBOARD-08 reviewable sources are distinct from failed receipt coverage", async ({
  page,
}) => {
  await fixtures(page);
  let failedSources = 0;
  await page.route("**/api/onboarding", (route) =>
    route.fulfill({
      json: {
        ...onboarding,
        view: {
          ...view,
          state: "importing",
          headlineKey: "import.progress.recent",
          primaryAction: "none",
          canStartImport: false,
          hasProcessingConsent: true,
          activeImportId: "run-b",
        },
        progress: {
          importRunId: "run-b",
          connectionId: "mailbox-b",
          startAt: disclosure.startAt,
          cutoffAt: disclosure.cutoffAt,
          stage: "discovering_recent",
          discoveredSources: 10,
          processedSources: 3,
          unsupportedSources: 0,
          failedSources,
          reviewSources: 2,
          readyRecordCount: 0,
          reviewItemCount: 0,
          pendingJobs: 6,
          pausedJobs: 0,
          failedJobs: 0,
          historyComplete: false,
          pauseReason: null,
        },
      },
    }),
  );
  await page.goto("/onboarding");
  await expect(
    page.getByText(
      "Some source messages could not be processed. This is not complete receipt coverage.",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Some messages need details checked before they can become purchase records. Import is still continuing.",
    ),
  ).toBeVisible();
  failedSources = 1;
  await page.reload();
  await expect(
    page.getByText(
      "Some source messages could not be processed. This is not complete receipt coverage.",
    ),
  ).toBeVisible();
});

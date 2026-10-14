import { expect, type Page, test } from "@playwright/test";

const authorizationUrl =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=synthetic-state&code_challenge=synthetic-challenge";
const profile = {
  user: {
    id: "synthetic-login",
    name: "Synthetic reader",
    email: "login@example.test",
  },
  settings: { timezone: "Europe/Vienna", reportingCurrency: "EUR", version: 1 },
  onboarding: { completedAt: null },
  capabilities: { mailProviders: [], driveArchive: false },
  valuation: { status: "not_configured" },
};
async function setup(
  page: Page,
  options: {
    reconnect?: boolean;
    providers?: ("gmail" | "outlook")[];
    url?: string;
    denied?: boolean;
  } = {},
) {
  const posts: { path: string; body: unknown }[] = [];
  let actorChanged = false;
  await page.route("https://login.microsoftonline.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Synthetic Microsoft authorization</h1>",
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      posts.push({ path, body: request.postDataJSON() });
      await route.fulfill(
        options.denied
          ? {
              status: 403,
              json: { error: { code: "missing_permission" } },
            }
          : { json: { authorizationUrl: options.url ?? authorizationUrl } },
      );
      return;
    }
    if (path === "/api/me") {
      await route.fulfill({
        json: actorChanged
          ? {
              ...profile,
              user: {
                ...profile.user,
                id: "synthetic-other-login",
                email: "other-login@example.test",
              },
            }
          : profile,
      });
      return;
    }
    if (path === "/api/onboarding") {
      await route.fulfill({
        json: {
          view: {
            schemaVersion: 1,
            state: options.reconnect ? "needs_reconnect" : "connect_mailbox",
            headlineKey: "mailbox.title",
            primaryAction: options.reconnect ? "reconnect" : "connect_mailbox",
            canStartImport: false,
            readyRecordCount: 0,
            historyComplete: false,
            hasProcessingConsent: false,
            exampleData: false,
            activeImportId: null,
            connectionId: options.reconnect ? "synthetic-outlook-inbox" : null,
            reviewItemCount: 0,
          },
          login: {
            email: actorChanged
              ? "other-login@example.test"
              : profile.user.email,
          },
          settings: profile.settings,
          connections: options.reconnect
            ? [
                {
                  id: "synthetic-outlook-inbox",
                  provider: "outlook",
                  address: "receipts@example.test",
                  generation: 1,
                  state: "needs_reconnect",
                  schedulingState: "paused_auth",
                  scopeReady: false,
                },
              ]
            : [],
          capabilities: {
            mailboxProviders: options.providers ?? ["outlook"],
          },
          mailboxLimit: 3,
          progress: null,
        },
      });
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: { code: "unavailable" } },
    });
  });
  return { posts, changeActor: () => (actorChanged = true) };
}

test("OUTLOOK-01 connect opens Microsoft authorization without Google or importing", async ({
  page,
}) => {
  const { posts } = await setup(page);
  await page.goto("/onboarding");
  await expect(
    page.getByRole("button", { name: "Connect Gmail inbox" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Connect Outlook inbox" }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Microsoft authorization" }),
  ).toBeVisible();
  expect(posts).toEqual([
    { path: "/api/connections/mailbox/outlook/start", body: {} },
  ]);
});

test("OUTLOOK-01 reconnect preserves the selected Outlook inbox and provider", async ({
  page,
}) => {
  const { posts } = await setup(page, {
    reconnect: true,
    providers: ["gmail", "outlook"],
  });
  await page.goto("/onboarding");
  await page
    .getByRole("button", { name: "Reconnect receipts@example.test" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Microsoft authorization" }),
  ).toBeVisible();
  expect(posts).toEqual([
    {
      path: "/api/connections/mailbox/outlook/start",
      body: { connectionId: "synthetic-outlook-inbox" },
    },
  ]);
});

test("OUTLOOK-01 disabled Outlook cannot reconnect through an available Gmail provider", async ({
  page,
}) => {
  const { posts } = await setup(page, {
    reconnect: true,
    providers: ["gmail"],
  });
  await page.goto("/onboarding");
  await expect(
    page.getByRole("heading", { name: "Reconnect your receipt inbox" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconnect receipts@example.test" }),
  ).toHaveCount(0);
  expect(posts).toEqual([]);
});

for (const url of [
  "https://login.microsoftonline.com.evil.invalid/common/oauth2/v2.0/authorize",
  "https://login.microsoftonline.com:444/common/oauth2/v2.0/authorize",
  "https://login.microsoftonline.com/common/arbitrary-path",
  "https://accounts.google.com/o/oauth2/v2/auth",
]) {
  test(`OUTLOOK-01 rejects a mismatched authorization destination: ${url}`, async ({
    page,
  }) => {
    const { posts } = await setup(page, { url });
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Connect Outlook inbox" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "The mailbox authorization could not be started",
    );
    await expect(page).toHaveURL(/\/onboarding$/);
    expect(posts).toEqual([
      { path: "/api/connections/mailbox/outlook/start", body: {} },
    ]);
  });
}

test("OUTLOOK-01 denied mailbox authorization keeps the workspace and does not import", async ({
  page,
}) => {
  const { posts } = await setup(page, { denied: true });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Connect Outlook inbox" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Mailbox permission was not granted",
  );
  await expect(
    page.getByRole("heading", {
      name: "Connect the inbox where you receive receipts.",
    }),
  ).toBeVisible();
  expect(posts).toEqual([
    { path: "/api/connections/mailbox/outlook/start", body: {} },
  ]);
});

test("OUTLOOK-01 changed login prevents the old authorization POST", async ({
  page,
}) => {
  const { posts, changeActor } = await setup(page);
  await page.goto("/onboarding");
  const connect = page.getByRole("button", { name: "Connect Outlook inbox" });
  await expect(connect).toBeVisible();
  changeActor();
  await connect.click();
  await expect(
    page.getByText("other-login@example.test", { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([]);
});

test("OUTLOOK-01 mobile provider choice stays visible and keyboard reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await setup(page, { providers: ["gmail", "outlook"] });
  await page.goto("/onboarding");
  await expect(
    page.getByRole("button", { name: "Connect Gmail inbox" }),
  ).toBeVisible();
  const outlook = page.getByRole("button", { name: "Connect Outlook inbox" });
  await expect(outlook).toBeVisible();
  await page.getByRole("button", { name: "Connect Gmail inbox" }).focus();
  await page.keyboard.press("Tab");
  await expect(outlook).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

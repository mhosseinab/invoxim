import { expect, test } from "@playwright/test";
import { mockPrivateWorkspace } from "./private-fixture";

const publicConfig = {
  displayName: "Invoxim",
  signupMode: "allowlist",
  demoEnabled: true,
  loginEnabled: true,
  mailProviders: ["gmail"],
  features: {
    outlook: false,
    driveArchive: false,
    recurring: false,
    useTags: false,
  },
  policyRoutes: { privacy: null, terms: null },
};

test("T29 landing offers onboarding when server login is available, without signing in automatically", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      requests.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/public-config", (route) =>
    route.fulfill({ json: publicConfig }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Sign in with Google", exact: true }),
  ).toHaveAttribute("href", "/onboarding");
  expect(requests).toEqual(["/api/public-config"]);
});

test("T29 invalid public capability data cannot enable login and demo remains static", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/public-config", (route) => {
    reads++;
    return route.fulfill({ json: { ...publicConfig, loginEnabled: "true" } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign in to the beta", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Sign in with Google", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Try an example", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Example data. Nothing from your inbox.", { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);
});

test("T29 fresh anonymous onboarding uses neutral sign-in recovery copy", async ({
  page,
}) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } }),
  );
  await page.route("**/api/public-config", (route) =>
    route.fulfill({ json: publicConfig }),
  );
  await page.goto("/onboarding");
  await expect(page.getByRole("alert")).toHaveText(
    "Sign in to continue to your private workspace.",
  );
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Sign in to continue to your private workspace.",
  );
});

for (const path of ["/home", "/purchases", "/connections"]) {
  test(`T29 anonymous ${path} offers keyboard sign-in recovery when configured`, async ({
    page,
  }) => {
    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } }),
    );
    await page.route("**/api/public-config", (route) =>
      route.fulfill({ json: publicConfig }),
    );
    await page.goto(path);
    const recovery = page.getByRole("link", { name: "Sign in", exact: true });
    await expect(recovery).toHaveAttribute("href", "/onboarding");
    await expect(page.getByRole("alert")).toContainText(
      "Sign in to continue to your private workspace.",
    );
    await expect(page.getByRole("article")).toHaveCount(0);
    await recovery.focus();
    await expect(recovery).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(
      page.getByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
  });
}

for (const capability of [false, "true", "unavailable"]) {
  test(`T29 anonymous private recovery does not offer unavailable or invalid login (${capability})`, async ({
    page,
  }) => {
    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } }),
    );
    await page.route("**/api/public-config", (route) =>
      capability === "unavailable"
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({
            json: { ...publicConfig, loginEnabled: capability },
          }),
    );
    await page.goto("/home");
    await expect(page.getByRole("alert")).toContainText(
      "Sign-in is unavailable right now. You can still explore the example.",
    );
    await expect(
      page.getByRole("link", { name: "Sign in", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Try an example", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
  });
}

test("T29 delayed anonymous capability response cannot replace a refreshed private workspace", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  fixture.status = 401;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested: () => void = () => {};
  const capabilityRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let finished: () => void = () => {};
  const capabilityFinished = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/api/public-config", async (route) => {
    requested();
    await gate;
    await route.fulfill({ json: publicConfig });
    finished();
  });
  await page.goto("/home");
  await capabilityRequested;
  fixture.status = 200;
  await page
    .getByRole("button", { name: "Refresh records", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toBeVisible();
  release();
  await capabilityFinished;
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable", exact: true }),
  ).toHaveCount(0);
});

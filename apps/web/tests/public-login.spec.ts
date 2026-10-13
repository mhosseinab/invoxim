import { expect, test } from "@playwright/test";

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

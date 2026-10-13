import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockPrivateWorkspace } from "./private-fixture";

test("HOME-05 known payment uncertainty asks the exact question rather than full re-entry", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  await page.goto("/home?from=2026-10-01&to=2026-10-31");
  await expect(
    page.getByRole("heading", { name: "Your purchase records", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Was this invoice paid?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Recorded spending" }),
  ).toContainText("EUR -30.00");
});
test("HOME-01/02/04/06 private periods, lifecycle and unavailable originals remain honest", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  await page.goto("/home?from=2026-10-01&to=2026-10-31");
  await expect(
    page.getByRole("region", { name: "Inbox coverage" }),
  ).toContainText("Processing is paused");
  await expect(
    page.getByText("Older history may still be importing.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Recorded spending" }),
  ).toContainText("EUR -30.00");
  const record = page.getByRole("article", { name: "QA history purchase" });
  await expect(record).toContainText("EUR 120.00");
  await expect(record).toContainText("EUR 90.00");
  await record.getByRole("link", { name: "QA history", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Across this purchase history" }),
  ).toContainText("EUR 90.00");
  await expect(
    page.getByText("Refund pending. Not deducted from recorded spending.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Original unavailable", { exact: true }),
  ).toHaveCount(3);
  expect(fixture.requests.every((r) => r.method === "GET")).toBe(true);
  await expect(
    page.getByRole("link", { name: /download|open original/i }),
  ).toHaveCount(0);
});
test("UI-04 mobile keyboard focus, search, exact money and accessibility remain usable", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/home");
  const search = page.getByLabel("Find a receipt or purchase", { exact: true });
  await expect(search).toBeVisible();
  for (
    let step = 0;
    step < 12 &&
    !(await search.evaluate((node) => node === document.activeElement));
    step++
  )
    await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.keyboard.type("QA history");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "QA question invoice purchase" }),
  ).toHaveCount(0);
  expect(
    fixture.requests.some(
      (r) =>
        r.path === "/api/purchases" &&
        new URLSearchParams(r.query).get("q") === "QA history",
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
test("private identity/session revalidation clears old records without falling back to demo", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  await page.goto("/home");
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toBeVisible();
  fixture.owner = "b";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("article", { name: "QA other owner purchase" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toHaveCount(0);
  fixture.status = 401;
  await page
    .getByRole("button", { name: "Refresh records", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByText("Example data. Nothing from your inbox.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Try an example", exact: true }),
  ).toBeVisible();
});
test("demo navigation and private errors never prefetch or substitute private data", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  await page.goto("/demo");
  await expect(
    page.getByText("Example data. Nothing from your inbox.", { exact: true }),
  ).toBeVisible();
  expect(
    fixture.requests.filter((r) => r.path !== "/api/public-config"),
  ).toEqual([]);
  fixture.status = 503;
  await page.goto("/home");
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});
test("UI-04 loading and ready/error announcements support the complete keyboard journey and 200 percent reflow", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.beforeList = () => gate;
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/home");
  await expect(page.getByRole("status")).toContainText("Loading your records");
  release();
  await expect(
    page.getByRole("status").filter({ hasText: /2.*purchase records ready/i }),
  ).toBeVisible();
  const search = page.getByLabel("Find a receipt or purchase", { exact: true });
  for (
    let step = 0;
    step < 12 &&
    !(await search.evaluate((node) => node === document.activeElement));
    step++
  )
    await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  expect(
    await search.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Search records", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const filters = page
    .locator("summary")
    .filter({ hasText: "Filter by date, status or inbox" });
  await expect(filters).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("From", { exact: true })).toBeFocused();
  const history = page.getByRole("link", { name: "QA history", exact: true });
  for (
    let step = 0;
    step < 20 &&
    !(await history.evaluate((node) => node === document.activeElement));
    step++
  )
    await page.keyboard.press("Tab");
  await expect(history).toBeFocused();
  await page.keyboard.press("Enter");
  const why = page
    .locator("summary")
    .filter({ hasText: "Why this amount?" })
    .first();
  for (
    let step = 0;
    step < 16 &&
    !(await why.evaluate((node) => node === document.activeElement));
    step++
  )
    await page.keyboard.press("Tab");
  await expect(why).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/Source: gmail\. Relationship:/).first(),
  ).toBeVisible();
  // Halving the viewport gives the effective CSS width of 200% zoom.
  await expect(
    page.getByRole("link", { name: "Connections", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../evidence/implementation/t13-qa-keyboard-reflow.png",
    fullPage: true,
  });
  const connections = page.getByRole("link", {
    name: "Connections",
    exact: true,
  });
  for (
    let step = 0;
    step < 30 &&
    !(await connections.evaluate((node) => node === document.activeElement));
    step++
  )
    await page.keyboard.press("Shift+Tab");
  await expect(connections).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Connected inboxes", exact: true }),
  ).toBeVisible();
  fixture.status = 500;
  const refresh = page.getByRole("button", {
    name: "Refresh records",
    exact: true,
  });
  for (
    let step = 0;
    step < 12 &&
    !(await refresh.evaluate((node) => node === document.activeElement));
    step++
  )
    await page.keyboard.press("Tab");
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "We could not load your records",
  );
});
test("private account changing while purchase responses are in flight never publishes the old owner's records", async ({
  page,
}) => {
  const fixture = await mockPrivateWorkspace(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.beforeList = () => gate;
  await page.goto("/home");
  await expect(page.getByRole("status")).toContainText("Loading your records");
  fixture.owner = "b";
  release();
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "QA other owner purchase" }),
  ).toHaveCount(0);
});
test("HOME-05 unlinked document review asks only its known missing currency and preserves access to valid history", async ({
  page,
}) => {
  await mockPrivateWorkspace(page);
  await page.goto("/needs-attention");
  await expect(
    page.getByText("Which currency does this document use?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("What amount does this document show?", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "QA history purchase" }),
  ).toContainText("EUR 90.00");
});

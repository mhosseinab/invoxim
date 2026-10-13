import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("PRESENT-02 only the example is an available product action", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Your purchase records, across inboxes.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to the beta" }),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: "Try an example", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Example data. Nothing from your inbox.", { exact: true }),
  ).toBeVisible();
});

test("DEMO-01/03/04 exact records, local retrieval and evidence without API traffic", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/demo");
  await expect(page.getByTestId("summary-paid")).toHaveText("EUR 150.00");
  await expect(page.getByTestId("summary-refunded")).toHaveText("EUR 30.00");
  await expect(page.getByTestId("summary-net")).toHaveText("EUR 120.00");
  await expect(
    page.getByRole("article", { name: "Example Supplies purchase" }),
  ).toHaveCount(2);
  const audio = page.getByRole("article", { name: "Example Audio purchase" });
  await expect(audio.getByTestId("purchase-net")).toHaveText("EUR 90.00");
  await expect(
    page.getByText("Not counted as spending", { exact: true }),
  ).toBeVisible();
  await audio.getByText("View purchase history").click();
  await page.getByText("Payment documented · 2026-09-10").click();
  await expect(
    audio
      .locator(".timeline details[open]")
      .getByText("Synthetic receipt for demonstration only.", {
        exact: true,
      }),
  ).toBeVisible();
  await expect(page.getByText(/Payment PAY-AUDIO-001 received/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await page.getByLabel("Find a receipt or purchase").fill("Supplies");
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "Unpaid", exact: true }).click();
  await expect(
    page.getByText("No example purchases match these filters."),
  ).toBeVisible();
  await page.getByLabel("Find a receipt or purchase").fill("");
  await expect(
    page.getByRole("article", { name: "Example Studio purchase" }),
  ).toHaveCount(1);
  expect(
    requests.filter(
      (url) =>
        !url.startsWith("http://127.0.0.1:4175/") ||
        new URL(url).pathname.startsWith("/api/"),
    ),
  ).toEqual([]);
});

test("DEMO-02 storage sentinels cannot influence static example (not real auth/cache integration)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("private-purchases", "PRIVATE_ACCOUNT_A_SENTINEL");
    sessionStorage.setItem("session", "PRIVATE_ACCOUNT_B_SENTINEL");
  });
  await page.goto("/demo");
  await expect(page.getByTestId("summary-net")).toHaveText("EUR 120.00");
  await expect(page.getByText(/PRIVATE_ACCOUNT/)).toHaveCount(0);
});

test("mobile keyboard, reduced motion, reflow and automated accessibility", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/demo");
  await page.getByLabel("Find a receipt or purchase").focus();
  await page.keyboard.type("Audio");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Clear search", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Find a receipt or purchase")).toBeFocused();
  await expect(page.getByLabel("Find a receipt or purchase")).toHaveValue("");
  await page.getByRole("button", { name: "With refund", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByText("View purchase history", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Across this purchase history", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: new URL(
      "../../../evidence/implementation/t28-demo-mobile.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByLabel("Find a receipt or purchase")).toBeVisible();
  await page.screenshot({
    path: new URL(
      "../../../evidence/implementation/t28-demo-zoom.png",
      import.meta.url,
    ).pathname,
    fullPage: true,
  });
});

test("UX-01 example actions lead to real refund and unpaid histories without dead ends", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/demo");
  const refundLink = page.getByRole("button", {
    name: "See a refund",
    exact: true,
  });
  await expect(refundLink).toBeVisible();
  await expect(page.locator("button:disabled")).toHaveCount(0);
  await refundLink.click();
  await expect(page.getByRole("article")).toHaveCount(1);
  const audio = page.getByRole("article", { name: "Example Audio purchase" });
  await expect(audio.locator(".history")).toHaveAttribute("open", "");
  await expect(
    page.getByRole("button", { name: "With refund", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#purchase-results")).toBeFocused();
  await expect(page.getByTestId("summary-net")).toHaveText("EUR 120.00");
  await page
    .getByRole("button", { name: "Find an unpaid invoice", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(1);
  const studio = page.getByRole("article", { name: "Example Studio purchase" });
  await expect(studio.locator(".history")).toHaveAttribute("open", "");
  await expect(
    studio.getByText("Not counted as spending", { exact: true }),
  ).toBeVisible();
  expect(
    requests.filter(
      (url) =>
        !url.startsWith("http://127.0.0.1:4175/") ||
        new URL(url).pathname.startsWith("/api/"),
    ),
  ).toEqual([]);
});

test("UX-02 search finds receipt details and quick filters recover from empty results", async ({
  page,
}) => {
  await page.goto("/demo");
  const search = page.getByLabel("Find a receipt or purchase");
  await search.fill("  RECEIVED   pay-audio-001  ");
  await expect(
    page.getByRole("article", { name: "Example Audio purchase" }),
  ).toHaveCount(1);
  await expect(page.getByRole("article")).toHaveCount(1);
  await search.fill("SUP-A");
  await expect(
    page.getByRole("article", { name: "Example Supplies purchase" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("article")).toHaveCount(4);
  await page.getByRole("button", { name: "Paid", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Paid", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await search.fill("studio");
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByText("No example purchases match these filters.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .first()
    .click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "Reset filters", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("summary-paid")).toHaveText("EUR 150.00");
  await expect(page.getByTestId("summary-refunded")).toHaveText("EUR 30.00");
});

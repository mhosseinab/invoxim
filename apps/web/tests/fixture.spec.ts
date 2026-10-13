import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { demoFixture } from "../src/demo-fixture";

test("DEMO-03 production example matches canonical synthetic fixture", () => {
  const canonical: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../../test-design/fixtures/presentation-demo.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(demoFixture).toEqual(canonical);
  expect(demoFixture.purchases).toHaveLength(4);
});

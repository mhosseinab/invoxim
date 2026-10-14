import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { expect, it } from "vitest";
import config from "../../../config/app.example.json";
import configDesign from "../../../contracts/config.schema.json";
import extractionDesign from "../../../contracts/extraction.schema.json";
import onboardingDesign from "../../../contracts/onboarding-view.schema.json";
import views from "../../../test-design/fixtures/onboarding-views.json";
import receipts from "../../../test-design/fixtures/receipts.json";
import { requireFixture } from "../../testkit/src/fixture-value";
import {
  configSchema,
  extractionSchema,
  onboardingViewSchema,
} from "../src/index";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const [label, design, schema, fixtures] of [
  ["config", configDesign, configSchema, [config]],
  [
    "extraction",
    extractionDesign,
    extractionSchema,
    receipts.fixtures.map((f) => f.expectedExtraction),
  ],
  [
    "onboarding",
    onboardingDesign,
    onboardingViewSchema,
    views.fixtures.map((f) => f.view),
  ],
] as const) {
  const validate = ajv.compile(design);
  for (const [index, value] of fixtures.entries())
    it(`${label} fixture ${index + 1} strict JSON/Zod parity`, () => {
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      expect(schema.safeParse(value).success).toBe(true);
      const hostile = { ...value, userId: "attacker", secretRef: "secret" };
      expect(validate(hostile)).toBe(false);
      expect(schema.safeParse(hostile).success).toBe(false);
    });
}
it("PRESENT-03 ready review does not require accepted consent; unknown copy/state rejected", () => {
  const view = requireFixture(views.fixtures[1]).view;
  expect(onboardingViewSchema.safeParse(view).success).toBe(true);
  expect(view.hasProcessingConsent).toBe(false);
  expect(
    onboardingViewSchema.safeParse({ ...view, headlineKey: "made.up" }).success,
  ).toBe(false);
  expect(
    onboardingViewSchema.safeParse({ ...view, state: "importing" }).success,
  ).toBe(false);
});
it("JSON/Zod parity rejects nested extras, wrong types, invalid dates and state contradictions", () => {
  const pairs = [
    {
      design: configDesign,
      schema: configSchema,
      values: [
        { ...config, publicSignupEnabled: true, signupMode: "allowlist" },
        {
          ...config,
          ai: {
            ...config.ai,
            hosted: { ...config.ai.hosted, enabled: true, model: null },
          },
        },
        {
          ...config,
          product: {
            ...config.product,
            features: { ...config.product.features, outlook: true },
          },
        },
        { ...config, mail: { ...config.mail, maxMailboxesPerUser: 0 } },
        { ...config, mail: { ...config.mail, userId: "attacker" } },
      ],
    },
    {
      design: extractionDesign,
      schema: extractionSchema,
      values: [
        {
          ...requireFixture(receipts.fixtures[0]).expectedExtraction,
          records: [
            {
              ...requireFixture(
                requireFixture(receipts.fixtures[0]).expectedExtraction
                  .records[0],
              ),
              documentDate: "2026-02-30",
            },
          ],
        },
        {
          ...requireFixture(receipts.fixtures[0]).expectedExtraction,
          records: [
            {
              ...requireFixture(
                requireFixture(receipts.fixtures[0]).expectedExtraction
                  .records[0],
              ),
              evidence: [
                {
                  field: "payment",
                  inputPartId: "body",
                  quote: "paid",
                  url: "evil",
                },
              ],
            },
          ],
        },
      ],
    },
    {
      design: onboardingDesign,
      schema: onboardingViewSchema,
      values: [
        { ...requireFixture(views.fixtures[5]).view, readyRecordCount: 0 },
        { ...requireFixture(views.fixtures[8]).view, historyComplete: false },
        {
          ...requireFixture(views.fixtures[0]).view,
          hasProcessingConsent: true,
        },
        { ...requireFixture(views.fixtures[14]).view, reviewItemCount: 0 },
      ],
    },
  ];
  for (const { design, schema, values } of pairs) {
    const validate = ajv.compile(design);
    for (const value of values) {
      expect(validate(value)).toBe(false);
      expect(schema.safeParse(value).success).toBe(false);
    }
  }
});

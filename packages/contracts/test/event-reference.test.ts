import Ajv2020 from "ajv/dist/2020";
import { expect, it } from "vitest";
import design from "../../../contracts/extraction.schema.json";
import receipts from "../../../test-design/fixtures/receipts.json";
import { extractionSchema, inferenceExtractionSchema } from "../src/index";

const fixture = receipts.fixtures[0];
if (!fixture) throw new Error("MISSING_FIXTURE");
const record = fixture.expectedExtraction.records[0];
if (!record) throw new Error("MISSING_RECORD");
const validate = new Ajv2020({ strict: false }).compile(design);

it("new cash references retain JSON/Zod parity and historical records remain readable", () => {
  expect(extractionSchema.safeParse(fixture.expectedExtraction).success).toBe(
    true,
  );
  const extended = {
    ...fixture.expectedExtraction,
    records: [
      { ...record, paymentReference: "PAY-001", refundReference: null },
    ],
  };
  expect(validate(extended)).toBe(true);
  expect(extractionSchema.safeParse(extended).success).toBe(true);
  expect(inferenceExtractionSchema.safeParse(extended).success).toBe(true);
  expect(
    inferenceExtractionSchema.safeParse(fixture.expectedExtraction).success,
  ).toBe(false);
});

it.each(["", "x".repeat(161), 12, "PAY-001\n"])(
  "rejects invalid payment reference in both contracts: %s",
  (paymentReference) => {
    const extended = {
      ...fixture.expectedExtraction,
      records: [{ ...record, paymentReference }],
    };
    expect(validate(extended)).toBe(false);
    expect(extractionSchema.safeParse(extended).success).toBe(false);
  },
);

import { extractionSchema } from "@invoxim/contracts";
import { object } from "./candidate";
import {
  AI_MISSING_FIELDS,
  AI_REASONS,
  type AiMissingField,
  type AiReason,
  type PersistableAiResult,
} from "./types";

/** Validates the storage boundary without allowing hidden transcript fields. */
export function validatePersistableAiResult(
  value: unknown,
): PersistableAiResult | null {
  if (!object(value)) return null;
  if (value.status === "needs-review") {
    if (
      Object.keys(value).some(
        (key) => !["status", "reason", "missingFields"].includes(key),
      ) ||
      typeof value.reason !== "string" ||
      !(AI_REASONS as readonly string[]).includes(value.reason)
    )
      return null;
    if (Object.hasOwn(value, "missingFields")) {
      const fields = value.missingFields;
      if (
        value.reason !== "incomplete" ||
        !Array.isArray(fields) ||
        fields.length < 1 ||
        fields.length > 4 ||
        new Set(fields).size !== fields.length ||
        !fields.every(
          (field) =>
            typeof field === "string" &&
            (AI_MISSING_FIELDS as readonly string[]).includes(field),
        )
      )
        return null;
      return {
        status: "needs-review",
        reason: "incomplete",
        missingFields: fields.slice() as AiMissingField[],
      };
    }
    return { status: "needs-review", reason: value.reason as AiReason };
  }
  if (
    value.status !== "accepted" ||
    Object.keys(value).some(
      (key) => !["status", "documentType", "records", "warnings"].includes(key),
    ) ||
    !Array.isArray(value.records) ||
    value.records.length > 10 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 12
  )
    return null;
  const records = [];
  for (const row of value.records) {
    if (
      !object(row) ||
      !Array.isArray(row.provenance) ||
      row.provenance.length > 20
    )
      return null;
    const { provenance, ...fields } = row;
    const evidence = [];
    for (const item of provenance) {
      if (
        !object(item) ||
        Object.keys(item).some(
          (key) => !["field", "inputPartId"].includes(key),
        ) ||
        typeof item.inputPartId !== "string" ||
        !item.inputPartId ||
        item.inputPartId.length > 100
      )
        return null;
      evidence.push({ ...item, quote: "" });
    }
    records.push({ ...fields, evidence });
  }
  const parsed = extractionSchema.safeParse({
    schemaVersion: 1,
    documentType: value.documentType,
    records,
    warnings: value.warnings,
  });
  if (!parsed.success) return null;
  return {
    status: "accepted",
    documentType: parsed.data.documentType,
    warnings: parsed.data.warnings,
    records: parsed.data.records.map(({ evidence, ...fields }) => ({
      ...fields,
      provenance: evidence.map(({ field, inputPartId }) => ({
        field,
        inputPartId,
      })),
    })),
  };
}

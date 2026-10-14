import { type Extraction, extractionSchema } from "@invoxim/contracts";
import {
  AI_MISSING_FIELDS,
  type AiMissingField,
  type PersistableAiResult,
} from "./types";

/** Narrow unknown JSON to the bounded extraction envelope (K6). */
export function boundedExtractionShape(value: unknown): boolean {
  if (
    !object(value) ||
    !Array.isArray(value.records) ||
    value.records.length > 10 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 12
  )
    return false;
  return value.records.every(
    (record) =>
      object(record) &&
      Array.isArray(record.evidence) &&
      record.evidence.length <= 20,
  );
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shared parse preamble for both validators (K6). Returns the schema-valid
 * candidate or the exact needs-review result the caller must propagate.
 */
export type ParseCandidateOutcome =
  | { readonly status: "accepted"; readonly candidate: Extraction }
  | Extract<PersistableAiResult, { readonly status: "needs-review" }>;

export function parseCandidate(
  output: string,
  maxBytes: number,
): ParseCandidateOutcome {
  if (
    output.length > maxBytes ||
    new TextEncoder().encode(output).length > maxBytes
  )
    return { status: "needs-review", reason: "schema" };
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    console.warn("ai_extraction_validation", { code: "invalid-json" });
    return { status: "needs-review", reason: "schema" };
  }
  if (!boundedExtractionShape(raw)) {
    console.warn("ai_extraction_validation", { code: "invalid-shape" });
    return { status: "needs-review", reason: "schema" };
  }
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("ai_extraction_validation", {
      code: "invalid-schema",
      issues: [
        ...new Set(parsed.error.issues.map((issue) => issue.code)),
      ].slice(0, 8),
    });
    return { status: "needs-review", reason: "schema" };
  }
  const candidate = parsed.data;
  const missingFields: readonly AiMissingField[] = AI_MISSING_FIELDS.filter(
    (field) => candidate.records.some((record) => record[field] === null),
  );
  if (missingFields.length)
    return { status: "needs-review", reason: "incomplete", missingFields };
  if (
    candidate.warnings.length ||
    (candidate.records.length === 0 &&
      candidate.documentType !== "non-purchase")
  )
    return { status: "needs-review", reason: "incomplete" };
  return { status: "accepted", candidate };
}

/** Map schema evidence to the persistable provenance shape (K6). */
export function toPersistable(candidate: Extraction): PersistableAiResult {
  return {
    status: "accepted",
    documentType: candidate.documentType,
    warnings: candidate.warnings,
    records: candidate.records.map(({ evidence, ...record }) => ({
      ...record,
      provenance: evidence.map(({ field, inputPartId }) => ({
        field,
        inputPartId,
      })),
    })),
  };
}

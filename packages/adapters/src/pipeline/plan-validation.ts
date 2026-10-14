import { hasControlCharacters } from "@invoxim/contracts";
import type {
  LedgerInput,
  LedgerPlan,
  PersistableAiResult,
} from "@invoxim/core";
import {
  calendarDate,
  ENTRY_MINOR_BOUND,
  minorDigits,
  validatePersistableAiResult,
} from "@invoxim/core";
import { z } from "zod";
import { json, PipelinePersistenceError } from "./repository-guards";

export const identifier = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacters(value));
export const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const metadataSchema = z
  .strictObject({
    id: identifier,
    partKey: z
      .string()
      .max(256)
      .refine((value) => !hasControlCharacters(value)),
    contentHash: fingerprintSchema,
    mime: z
      .string()
      .max(100)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
    byteLength: z.number().int().min(0).max(4194304),
    parseState: z.enum([
      "ready",
      "extracted",
      "needs_review",
      "unsupported",
      "unreadable",
      "incomplete",
    ]),
    parserVersion: z.string().min(1).max(120),
    code: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .optional(),
  })
  .refine(
    (document) =>
      !["ready", "extracted"].includes(document.parseState) ||
      [
        "application/pdf",
        "text/plain",
        "text/html",
        "image/png",
        "image/jpeg",
        "image/webp",
      ].includes(document.mime) ||
      (document.parserVersion === "documents-direct-v1" &&
        [
          "multipart/alternative",
          "multipart/mixed",
          "multipart/related",
        ].includes(document.mime)),
    "Unsupported ready document MIME",
  );

export function checkedResult(value: unknown): PersistableAiResult {
  const result = validatePersistableAiResult(value);
  if (!result) throw new PipelinePersistenceError("INVALID_PIPELINE");
  return result;
}
export function checkedInput(input: LedgerInput): void {
  identifier.parse(input.identity.documentId);
  fingerprintSchema.parse(input.identity.contentHash);
  fingerprintSchema.parse(input.identity.extractionFingerprint);
  checkedResult(input.result);
}
export function monetary(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number(ENTRY_MINOR_BOUND)
  )
    throw new PipelinePersistenceError("INVALID_PIPELINE");
}
export function validatePlan(input: LedgerInput, plan: LedgerPlan): void {
  checkedInput(input);
  if (
    plan.observations.length > 10 ||
    plan.purchases.length > 10 ||
    plan.events.length > 20 ||
    plan.evidence.length > 10 ||
    plan.reviews.length > 50 ||
    plan.expectedPurchases.length > 100 ||
    plan.paymentStates.length > 100
  )
    throw new PipelinePersistenceError("PIPELINE_LIMIT");
  for (const observation of plan.observations) {
    identifier.parse(observation.id);
    if (
      observation.identity.documentId !== input.identity.documentId ||
      observation.identity.contentHash !== input.identity.contentHash ||
      observation.identity.extractionFingerprint !==
        input.identity.extractionFingerprint ||
      input.result.status !== "accepted" ||
      !Number.isInteger(observation.segmentIndex) ||
      observation.segmentIndex < 0 ||
      observation.segmentIndex >= input.result.records.length ||
      json(observation.record) !==
        json(input.result.records[observation.segmentIndex]) ||
      observation.documentType !== input.result.documentType
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    checkedResult({
      status: "accepted",
      documentType: observation.documentType,
      records: [observation.record],
      warnings: [],
    });
  }
  for (const purchase of plan.purchases) {
    identifier.parse(purchase.id);
    if (purchase.totalMinor === null || purchase.currency === null)
      throw new PipelinePersistenceError("INVALID_PIPELINE");
    monetary(purchase.totalMinor);
    calendarDate(purchase.documentDate);
    minorDigits(purchase.currency);
    if (
      purchase.version !== 1 ||
      purchase.merchant.length > 200 ||
      purchase.merchant.trim().length === 0
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  }
  for (const event of plan.events) {
    identifier.parse(event.id);
    identifier.parse(event.businessKey);
    monetary(event.amountMinor);
    calendarDate(event.eventDate);
    minorDigits(event.currency);
    if (
      !plan.observations.some(
        (observation) => observation.id === event.observationId,
      ) ||
      !["payment", "refund"].includes(event.kind) ||
      !["explicit-event-date", "document-date"].includes(event.dateBasis) ||
      event.version !== 1
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  }
  for (const review of plan.reviews)
    if (
      review.documentId !== input.identity.documentId ||
      review.blockingScope !== "financial"
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  for (const expected of plan.expectedPurchases) {
    identifier.parse(expected.id);
    if (!Number.isSafeInteger(expected.version) || expected.version < 1)
      throw new PipelinePersistenceError("INVALID_PIPELINE");
  }
  if (
    new Set(plan.expectedPurchases.map((item) => item.id)).size !==
      plan.expectedPurchases.length ||
    new Set(plan.paymentStates.map((item) => item.purchaseId)).size !==
      plan.paymentStates.length
  )
    throw new PipelinePersistenceError("INVALID_PIPELINE");
  for (const state of plan.paymentStates)
    if (
      !plan.expectedPurchases.some(
        (expected) =>
          expected.id === state.purchaseId &&
          expected.version === state.expectedVersion,
      ) ||
      !["unknown", "unpaid", "partially_paid", "paid"].includes(
        state.paymentState,
      )
    )
      throw new PipelinePersistenceError("INVALID_PIPELINE");
}

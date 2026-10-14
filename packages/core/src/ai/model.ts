import { parseMoney } from "../money";
import { parseCandidate, toPersistable } from "./candidate";
import {
  type AiTextPart,
  NON_CASH_DOCUMENT_TYPES,
  type PersistableAiResult,
} from "./types";

/** Validates model-interpreted originals without interpreting their language or markup. */
export function validateModelExtraction(
  output: string,
  parts: readonly AiTextPart[],
  maxBytes: number,
): PersistableAiResult {
  const outcome = parseCandidate(output, maxBytes);
  if (outcome.status !== "accepted") return outcome;
  const candidate = outcome.candidate;
  const inputIds = new Set(parts.map((part) => part.id));
  for (const record of candidate.records) {
    const hasEvidence = (field: string) =>
      record.evidence.some((item) => item.field === field);
    if (
      record.evidence.some(
        (item) => !inputIds.has(item.inputPartId) || !item.quote.trim(),
      )
    )
      return { status: "needs-review", reason: "evidence" };
    for (const field of [
      "merchant",
      "documentDate",
      "eventDate",
      "currency",
      "total",
      "tax",
      "invoiceNumber",
      "orderReference",
      "paymentReference",
      "refundReference",
      "paymentAmount",
      "refundAmount",
      "storeCreditAmount",
    ] as const) {
      if (
        record[field] != null &&
        (!hasEvidence(field) ||
          (typeof record[field] === "string" && !record[field].trim()))
      )
        return { status: "needs-review", reason: "evidence" };
    }
    if (
      (record.paymentEvidence !== "unknown" && !hasEvidence("payment")) ||
      (["completed", "pending"].includes(record.refundEvidence) &&
        !hasEvidence("refund")) ||
      (record.recurringCadence !== "unknown" && !hasEvidence("recurring"))
    )
      return { status: "needs-review", reason: "evidence" };
    if (record.currency === null || record.total === null)
      return { status: "needs-review", reason: "incomplete" };
    let total: bigint | null,
      tax: bigint | null,
      paid: bigint | null,
      refunded: bigint | null,
      credit: bigint | null;
    try {
      total = parseMoney(record.total, record.currency);
      tax = parseMoney(record.tax, record.currency);
      paid = parseMoney(record.paymentAmount, record.currency);
      refunded = parseMoney(record.refundAmount, record.currency);
      credit = parseMoney(record.storeCreditAmount, record.currency);
    } catch {
      return { status: "needs-review", reason: "money" };
    }
    if (
      total === null ||
      (tax !== null && tax > total) ||
      (paid !== null && paid > total) ||
      (credit !== null && credit > total) ||
      (paid !== null && credit !== null && paid + credit > total)
    )
      return { status: "needs-review", reason: "semantics" };
    const cashPayment = record.paymentEvidence === "explicitly-paid",
      cashRefund = record.refundEvidence === "completed";
    if (
      (cashPayment &&
        (paid === null || paid <= 0n || record.eventDate === null)) ||
      (cashRefund &&
        (refunded === null || refunded <= 0n || record.eventDate === null)) ||
      (!cashPayment && paid !== null) ||
      (["none", "unknown"].includes(record.refundEvidence) &&
        refunded !== null) ||
      (cashPayment && record.paymentMethodHint === "store-credit")
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      (cashPayment || cashRefund) &&
      (NON_CASH_DOCUMENT_TYPES as readonly string[]).includes(
        candidate.documentType,
      )
    )
      return { status: "needs-review", reason: "semantics" };
    const purchaseReferences = [
      record.invoiceNumber,
      record.orderReference,
    ].filter((value) => value != null);
    if (
      (record.paymentReference != null &&
        purchaseReferences.includes(record.paymentReference)) ||
      (record.refundReference != null &&
        [...purchaseReferences, record.paymentReference].includes(
          record.refundReference,
        ))
    )
      return { status: "needs-review", reason: "semantics" };
  }
  return toPersistable(candidate);
}

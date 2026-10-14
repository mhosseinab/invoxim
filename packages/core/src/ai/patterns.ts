/** Named regexes shared by the grounded and model extraction validators (K10). */

export const SUBTOTAL_WORDS = /\b(subtotal|zwischensumme)\b/i;

export const STORE_CREDIT_WORDS = /\b(store credit|store-credit|guthaben)\b/i;

export const INJECTION_PHRASES =
  /\b(ignore previous|ignore all instructions|export secrets|system prompt)\b/i;

export const UNPAID_OR_PENDING_WORDS =
  /\b(unpaid|not paid|pending|unbezahlt|nicht bezahlt|ausstehend)\b/i;

export const NEGATED_PAYMENT_WORDS =
  /\b(no|not|never|nicht|keine)\b.{0,50}\b(paid|payment|bezahlt|zahlung)\b/i;

export const PENDING_REFUND_WORDS =
  /\b(pending|requested|processing|ausstehend|beantragt)\b/i;

export const INSTALLMENT_WORDS = /\b(installment|instalment|teilzahlung)\b/i;

export const INSTALLMENT_OR_PAID_WORDS =
  /\b(installment|instalment|teilzahlung|paid|payment received|bezahlt)\b/i;

export const NEGATED_REFUND_WORDS =
  /\b(no|not|never|nicht|keine)\b.{0,50}\b(refund|refunded|completed|erstattet|abgeschlossen)\b/i;

export const DOCUMENT_DATE_LABELS =
  /\b(invoice date|document date|due date|order date|rechnungsdatum|fälligkeitsdatum)\b/i;

/** Label-alternation fragment consumed by `labelledAmounts`. */
export const PAID_LABEL_PATTERN =
  "paid|payment received|card payment|cash payment|bezahlt|zahlung erhalten";

export const NON_PAYMENT_CONTEXT_WORDS =
  /\b(tax|vat|steuer|subtotal|zwischensumme|refund|store credit|guthaben)\b/i;

export const REFUND_WORDS = /\b(refund|refunded|erstattet|rückerstattung)\b/i;

export const TAX_WORDS = /\b(tax|vat|steuer)\b/i;

export const PAID_WORDS =
  /\b(paid|payment received|bezahlt|zahlung erhalten)\b/i;

export const UNPAID_OR_DUE_WORDS =
  /\b(unpaid|not paid|due|unbezahlt|nicht bezahlt|ausstehend)\b/i;

export const REFUND_COMPLETED_WORDS =
  /\b(refunded|refund completed|refund issued|erstattet|rückerstattung abgeschlossen)\b/i;

/** Labels whose following date is not the document/event date (due, sent, expiry). */
export const FORBIDDEN_DATE_LABELS =
  /\b(?:due(?:\s*date)?|expires?(?:\s*(?:date|on|at))?|expiry(?:\s*date)?|expiration(?:\s*date)?|(?:email|mail|message)\s+(?:(?:sent|received)(?:\s*(?:date|time|at|on))?|date)|(?:sent|received)\s+(?:email|mail|message)(?:\s*(?:date|time))?)\s*[:=]?/gi;

/** Boundary that ends a forbidden-date label segment before a real date label. */
export const DATE_SEGMENT_END =
  /[;\n]|\b(?:invoice|receipt|transaction|order|payment|refund)\s+(?:date|on|at)\b|\bpaid\s+on\b/i;

export const INVOICE_REFERENCE_PREFIX = /^(?:INV|INVOICE|RECHNUNG)[-_]/i;
export const ORDER_REFERENCE_PREFIX = /^(?:ORDER|BESTELLUNG)[-_]/i;

export const INVOICE_REFERENCE_LABEL =
  "invoice|receipt|rechnung|factura|facture";
export const ORDER_REFERENCE_LABEL = "order|bestellung|commande";

export const EVENT_REFERENCE_BLOCKERS =
  /\b(original|previous|order|invoice|requested|pending)\b/i;

export const PRINTED_MONTH_PATTERNS = [
  "jan(?:uary)?",
  "feb(?:ruary)?",
  "mar(?:ch)?",
  "apr(?:il)?",
  "may",
  "jun(?:e)?",
  "jul(?:y)?",
  "aug(?:ust)?",
  "sep(?:t(?:ember)?)?",
  "oct(?:ober)?",
  "nov(?:ember)?",
  "dec(?:ember)?",
] as const;

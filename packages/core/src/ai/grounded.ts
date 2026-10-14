import { hasControlCharacters } from "@invoxim/contracts";
import { parseMoney } from "../money";
import { parseCandidate, toPersistable } from "./candidate";
import {
  DATE_SEGMENT_END,
  DOCUMENT_DATE_LABELS,
  EVENT_REFERENCE_BLOCKERS,
  FORBIDDEN_DATE_LABELS,
  INJECTION_PHRASES,
  INSTALLMENT_OR_PAID_WORDS,
  INSTALLMENT_WORDS,
  INVOICE_REFERENCE_LABEL,
  INVOICE_REFERENCE_PREFIX,
  NEGATED_PAYMENT_WORDS,
  NEGATED_REFUND_WORDS,
  NON_PAYMENT_CONTEXT_WORDS,
  ORDER_REFERENCE_LABEL,
  ORDER_REFERENCE_PREFIX,
  PAID_LABEL_PATTERN,
  PAID_WORDS,
  PENDING_REFUND_WORDS,
  PRINTED_MONTH_PATTERNS,
  REFUND_COMPLETED_WORDS,
  REFUND_WORDS,
  STORE_CREDIT_WORDS,
  SUBTOTAL_WORDS,
  TAX_WORDS,
  UNPAID_OR_DUE_WORDS,
  UNPAID_OR_PENDING_WORDS,
} from "./patterns";
import {
  type AiTextPart,
  NON_CASH_DOCUMENT_TYPES,
  type PersistableAiResult,
} from "./types";

export function validateExtraction(
  output: string,
  parts: readonly Pick<AiTextPart, "id" | "text">[],
  maxBytes: number,
): PersistableAiResult {
  const outcome = parseCandidate(output, maxBytes);
  if (outcome.status !== "accepted") return outcome;
  const candidate = outcome.candidate;
  const inputs = new Map(parts.map((part) => [part.id, part.text]));
  for (const record of candidate.records) {
    const quotes = (field: string) =>
      record.evidence
        .filter((item) => item.field === field)
        .map((item) => item.quote);
    for (const evidence of record.evidence) {
      if (
        !evidence.quote.trim() ||
        !inputs.get(evidence.inputPartId)?.includes(evidence.quote)
      )
        return { status: "needs-review", reason: "evidence" };
    }
    for (const field of [
      "merchant",
      "invoiceNumber",
      "orderReference",
    ] as const) {
      const value = record[field];
      if (
        value !== null &&
        (!value.trim() || !quotes(field).some((quote) => quote.includes(value)))
      )
        return { status: "needs-review", reason: "evidence" };
    }
    for (const field of ["invoiceNumber", "orderReference"] as const) {
      const value = record[field];
      if (value === null) continue;
      if (
        !record.evidence
          .filter((item) => item.field === field)
          .some((item) =>
            contextLines(inputs.get(item.inputPartId) ?? "", item.quote).every(
              (line) => groundedPurchaseReference(line, value, field),
            ),
          )
      )
        return { status: "needs-review", reason: "evidence" };
    }
    for (const field of ["paymentReference", "refundReference"] as const) {
      const value = record[field];
      if (value == null) continue;
      const kind = field === "paymentReference" ? "payment" : "refund";
      const evidence = record.evidence.filter((item) => item.field === field);
      if (
        !evidence.some(
          (item) =>
            groundedEventReference(item.quote, value, kind) &&
            contextLines(inputs.get(item.inputPartId) ?? "", item.quote).every(
              (line) => groundedEventReference(line, value, kind),
            ),
        )
      )
        return { status: "needs-review", reason: "evidence" };
    }
    for (const field of ["documentDate", "eventDate"] as const) {
      const value = record[field];
      if (
        value !== null &&
        !record.evidence
          .filter((item) => item.field === field)
          .some(
            (item) =>
              groundedDate(item.quote, value) &&
              contextLines(
                inputs.get(item.inputPartId) ?? "",
                item.quote,
              ).every(
                (line) =>
                  groundedDate(line, value) &&
                  !forbiddenDateContext(line, value, item.quote),
              ),
          )
      )
        return { status: "needs-review", reason: "date" };
    }
    if (
      record.currency === null ||
      record.total === null ||
      record.merchant === null ||
      record.documentDate === null
    )
      return { status: "needs-review", reason: "incomplete" };
    if (
      !quotes("currency").some(
        (quote) =>
          new RegExp(`\\b${record.currency}\\b`).test(quote) ||
          (record.currency === "EUR" && quote.includes("€")),
      )
    )
      return { status: "needs-review", reason: "evidence" };
    const currency = record.currency;
    for (const field of [
      "total",
      "tax",
      "paymentAmount",
      "refundAmount",
      "storeCreditAmount",
    ] as const) {
      const value = record[field];
      if (value === null) continue;
      try {
        const minor = parseMoney(value, record.currency);
        if (
          !quotes(field).some((quote) =>
            groundedAmount(quote, currency, value),
          ) ||
          minor === null
        )
          return { status: "needs-review", reason: "money" };
      } catch {
        return { status: "needs-review", reason: "money" };
      }
    }
    for (const field of [
      "total",
      "paymentAmount",
      "refundAmount",
      "storeCreditAmount",
    ] as const) {
      const evidence = record.evidence.filter((item) => item.field === field);
      if (
        evidence.some((item) =>
          contextLines(inputs.get(item.inputPartId) ?? "", item.quote).some(
            (line) => field === "total" && SUBTOTAL_WORDS.test(line),
          ),
        )
      )
        return { status: "needs-review", reason: "semantics" };
    }
    for (const field of [
      "total",
      "tax",
      "paymentAmount",
      "refundAmount",
      "storeCreditAmount",
    ] as const) {
      if (record[field] === null) continue;
      for (const item of record.evidence.filter(
        (entry) => entry.field === field,
      )) {
        const source = inputs.get(item.inputPartId) ?? "";
        for (const line of contextLines(source, item.quote)) {
          if (unsupportedSignedAmount(line))
            return { status: "needs-review", reason: "money" };
          const localCurrencies = monetaryCurrencies(line);
          const currencies = localCurrencies.length
            ? localCurrencies
            : monetaryCurrencies(source);
          if (currencies.length !== 1 || currencies[0] !== currency)
            return { status: "needs-review", reason: "money" };
        }
      }
    }
    const paymentLines = record.evidence
      .filter((item) => item.field === "payment")
      .flatMap((item) =>
        contextLines(inputs.get(item.inputPartId) ?? "", item.quote),
      );
    const refundLines = record.evidence
      .filter((item) => item.field === "refund")
      .flatMap((item) =>
        contextLines(inputs.get(item.inputPartId) ?? "", item.quote),
      );
    const wholeSource = record.evidence
      .map((item) => inputs.get(item.inputPartId) ?? "")
      .join("\n");
    if (
      record.paymentEvidence === "explicitly-paid" &&
      STORE_CREDIT_WORDS.test(wholeSource) &&
      record.storeCreditAmount === null
    )
      return { status: "needs-review", reason: "semantics" };
    if (INJECTION_PHRASES.test(wholeSource))
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-paid" &&
      paymentLines.some(
        (line) =>
          UNPAID_OR_PENDING_WORDS.test(line) ||
          NEGATED_PAYMENT_WORDS.test(line),
      )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "completed" &&
      refundLines.some((line) => PENDING_REFUND_WORDS.test(line))
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-paid" &&
      INSTALLMENT_WORDS.test(wholeSource) &&
      !record.evidence
        .filter((item) => item.field === "paymentAmount")
        .some((item) =>
          contextLines(inputs.get(item.inputPartId) ?? "", item.quote).some(
            (line) => INSTALLMENT_OR_PAID_WORDS.test(line),
          ),
        )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "completed" &&
      refundLines.some((line) => NEGATED_REFUND_WORDS.test(line))
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.eventDate !== null &&
      record.evidence
        .filter((item) => item.field === "eventDate")
        .some((item) =>
          contextLines(inputs.get(item.inputPartId) ?? "", item.quote).some(
            (line) => DOCUMENT_DATE_LABELS.test(line),
          ),
        )
    )
      return { status: "needs-review", reason: "date" };
    const explicitPayments = labelledAmounts(
      wholeSource,
      PAID_LABEL_PATTERN,
      currency,
    );
    if (
      record.paymentEvidence === "explicitly-paid" &&
      explicitPayments.length &&
      !record.evidence
        .filter((item) => item.field === "paymentAmount")
        .some((item) =>
          labelledAmounts(
            contextLines(inputs.get(item.inputPartId) ?? "", item.quote).join(
              "\n",
            ),
            PAID_LABEL_PATTERN,
            currency,
          ).includes(
            parseMoney(record.paymentAmount, currency)?.toString() ?? "",
          ),
        )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-paid" &&
      explicitPayments.length === 0 &&
      (record.paymentAmount === null ||
        parseMoney(record.paymentAmount, currency) !==
          parseMoney(record.total, currency) ||
        !record.evidence
          .filter((item) => item.field === "paymentAmount")
          .some((item) =>
            contextLines(inputs.get(item.inputPartId) ?? "", item.quote).every(
              (line) => !NON_PAYMENT_CONTEXT_WORDS.test(line),
            ),
          ))
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundAmount !== null &&
      !record.evidence
        .filter((item) => item.field === "refundAmount")
        .some((item) =>
          contextLines(inputs.get(item.inputPartId) ?? "", item.quote).some(
            (line) => REFUND_WORDS.test(line) && !TAX_WORDS.test(line),
          ),
        )
    )
      return { status: "needs-review", reason: "semantics" };
    const payment = quotes("payment").join("\n");
    const refund = quotes("refund").join("\n");
    if (
      record.paymentEvidence === "explicitly-paid" &&
      (!PAID_WORDS.test(payment) ||
        UNPAID_OR_DUE_WORDS.test(payment) ||
        record.paymentAmount === null ||
        record.eventDate === null)
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-unpaid" &&
      !UNPAID_OR_DUE_WORDS.test(payment)
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "completed" &&
      (!REFUND_COMPLETED_WORDS.test(refund) ||
        PENDING_REFUND_WORDS.test(refund) ||
        record.refundAmount === null ||
        record.eventDate === null ||
        candidate.documentType === "credit-note")
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "pending" &&
      !PENDING_REFUND_WORDS.test(refund)
    )
      return { status: "needs-review", reason: "semantics" };
    if (record.recurringCadence !== "unknown" && !quotes("recurring").length)
      return { status: "needs-review", reason: "evidence" };
    const total = parseMoney(record.total, record.currency);
    const tax = parseMoney(record.tax, record.currency);
    const paid = parseMoney(record.paymentAmount, record.currency);
    const credit = parseMoney(record.storeCreditAmount, record.currency);
    if (
      total !== null &&
      ((tax !== null && tax > total) ||
        (paid !== null && paid > total) ||
        (credit !== null && credit > total) ||
        (paid !== null && credit !== null && paid + credit > total))
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      (NON_CASH_DOCUMENT_TYPES as readonly string[]).includes(
        candidate.documentType,
      ) &&
      (record.paymentEvidence === "explicitly-paid" ||
        record.refundEvidence === "completed")
    )
      return { status: "needs-review", reason: "semantics" };
  }
  return toPersistable(candidate);
}

function contextLines(text: string, quote: string): string[] {
  const lines = new Set<string>();
  let position = text.indexOf(quote);
  while (position >= 0) {
    const start = text.lastIndexOf("\n", position - 1) + 1;
    const newline = text.indexOf("\n", position + quote.length);
    lines.add(text.slice(start, newline < 0 ? text.length : newline));
    position = text.indexOf(quote, position + quote.length);
  }
  return Array.from(lines);
}

function forbiddenDateContext(
  line: string,
  date: string,
  quote: string,
): boolean {
  for (const match of line.matchAll(FORBIDDEN_DATE_LABELS)) {
    const tail = line.slice((match.index ?? 0) + match[0].length);
    const nextLabel = tail.search(DATE_SEGMENT_END);
    const labelledDate = nextLabel < 0 ? tail : tail.slice(0, nextLabel);
    if (!groundedDate(labelledDate, date)) continue;
    const segmentStart = (match.index ?? 0) + match[0].length;
    const segmentEnd = segmentStart + labelledDate.length;
    let quoteStart = line.indexOf(quote);
    if (quoteStart < 0) return true;
    while (quoteStart >= 0) {
      if (quoteStart < segmentEnd && quoteStart + quote.length > segmentStart)
        return true;
      quoteStart = line.indexOf(quote, quoteStart + 1);
    }
  }
  return false;
}

function groundedDate(quote: string, date: string): boolean {
  if (new RegExp(`(?<![0-9])${date}(?![0-9])`).test(quote)) return true;
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return false;
  const monthNumber = Number(month),
    dayNumber = Number(day);
  const printedDay = dayNumber < 10 ? `0?${dayNumber}` : String(dayNumber);
  const printedMonth =
    monthNumber < 10 ? `0?${monthNumber}` : String(monthNumber);
  if (
    new RegExp(
      `(?<![0-9])${printedDay}\\.${printedMonth}\\.${year}(?![0-9])`,
    ).test(quote)
  )
    return true;
  const monthName = PRINTED_MONTH_PATTERNS[monthNumber - 1];
  if (!monthName) return false;
  // Named months have an explicit order; numeric slash dates remain unsupported.
  const monthToken = `(?:${monthName})\\.?`;
  const dayToken = `${printedDay}(?:st|nd|rd|th)?`;
  return new RegExp(
    `(?<![A-Za-z0-9])(?:${monthToken}\\s+${dayToken},?\\s+${year}|${dayToken}\\s+${monthToken}\\s+${year})(?![A-Za-z0-9])`,
    "i",
  ).test(quote);
}

function groundedAmount(
  quote: string,
  currency: string,
  value: string,
): boolean {
  if (SUBTOTAL_WORDS.test(quote)) return false;
  const tokens =
    quote.match(
      /(?:^|[^\d.,])(?:0|[1-9]\d{0,12})(?:[.,]\d{1,3})?(?![\d.,])/g,
    ) ?? [];
  return tokens.some((token) => {
    const number = token.replace(/^[^\d]+/, "").replace(",", ".");
    try {
      return parseMoney(number, currency) === parseMoney(value, currency);
    } catch {
      return false;
    }
  });
}

function labelledAmounts(
  text: string,
  labels: string,
  currency: string,
): string[] {
  const results: string[] = [];
  const pattern = new RegExp(
    `\\b(?:${labels})\\b[^\\n0-9]{0,60}(?:${currency}\\s*)?((?:0|[1-9][0-9]{0,12})(?:[.,][0-9]{1,3})?)(?![0-9.,-])`,
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    const amount = match[1];
    if (amount === undefined) continue;
    try {
      const minor = parseMoney(amount.replace(",", "."), currency);
      if (minor !== null) results.push(minor.toString());
    } catch {
      // Unsupported precision or magnitude is not monetary evidence.
    }
  }
  return results;
}

function monetaryCurrencies(text: string): string[] {
  const codes = new Set<string>();
  // Preserve explicit code-shaped monetary markers even when precision is unsupported.
  // An unknown CAD/SEK/etc. cannot disappear and borrow a different line's EUR.
  for (const match of text.matchAll(
    /\b([A-Z]{3})(?![A-Z])\s*[)]?\s*[-+−]?\s*[(]?\s*[0-9]/g,
  )) {
    if (match[1] !== undefined) codes.add(match[1]);
  }
  for (const match of text.matchAll(
    /\b[0-9]+(?:[.,][0-9]{1,3})?\s*[-+−]?\s*[)]?\s*([A-Z]{3})\b/g,
  )) {
    if (match[1] !== undefined) codes.add(match[1]);
  }
  for (const match of text.matchAll(
    /\b(?:currency|währung)\s*[:=]?\s*([A-Z]{3})\b/gi,
  )) {
    if (match[1] !== undefined) codes.add(match[1].toUpperCase());
  }
  for (const token of text.match(/\b[A-Z]{3}\b/g) ?? []) {
    try {
      parseMoney("0", token);
      codes.add(token);
    } catch {
      // Uppercase words outside the supported currency registry are ignored.
    }
  }
  if (text.includes("€")) codes.add("EUR");
  // Other symbols cannot borrow an unrelated EUR marker from another line.
  for (const [symbol, explicitCode] of [
    ["$", "USD"],
    ["£", "GBP"],
    ["¥", "JPY"],
  ] as const) {
    if (text.includes(symbol) && !codes.has(explicitCode))
      codes.add("unsupported-symbol");
  }
  return Array.from(codes);
}

function unsupportedSignedAmount(line: string): boolean {
  // Detect signed/accounting monetary tokens regardless of whether the currency
  // sits before the sign, after the sign, or against the digits. Dates remain
  // unsigned digit-hyphen-digit tokens and do not match these boundaries.
  return (
    /(?:^|[\s:(])(?:[A-Z]{3}\s*|[€$£¥]\s*)?[-+−]\s*(?:[A-Z]{3}\s*|[€$£¥]\s*)?[0-9]/.test(
      line,
    ) ||
    /\(\s*(?:[A-Z]{3}\s*|[€$£¥]\s*)?[0-9]+(?:[.,][0-9]+)?\s*(?:[A-Z]{3}|[€$£¥])?\s*\)/.test(
      line,
    ) ||
    /(?:^|[\s:(])(?:[A-Z]{3}\s*|[€$£¥]\s*)?[0-9]+(?:[.,][0-9]+)?\s*(?:[A-Z]{3}|[€$£¥])?\s*[-−](?:\s|$)/.test(
      line,
    )
  );
}

function groundedEventReference(
  text: string,
  value: string,
  kind: "payment" | "refund",
): boolean {
  if (!value.trim() || EVENT_REFERENCE_BLOCKERS.test(text)) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${kind}\\s+(?:(?:transaction|confirmation)\\s+)?(?:reference|id|number)\\s*[:#=]?\\s*${escaped}(?![\\p{L}\\p{N}_./-])`,
    "iu",
  ).test(text);
}

function groundedPurchaseReference(
  text: string,
  value: string,
  field: "invoiceNumber" | "orderReference",
): boolean {
  if (hasControlCharacters(value)) return false;
  const prefix =
    field === "invoiceNumber"
      ? INVOICE_REFERENCE_PREFIX
      : ORDER_REFERENCE_PREFIX;
  if (text.trim() === value && prefix.test(value)) return true;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const label =
    field === "invoiceNumber" ? INVOICE_REFERENCE_LABEL : ORDER_REFERENCE_LABEL;
  return new RegExp(
    `\\b(?:${label})\\s*(?:(?:reference|number|no\\.?|id|nr\\.?)\\s*)?[:#=]?\\s*${escaped}(?![\\p{L}\\p{N}_./-])`,
    "iu",
  ).test(text);
}

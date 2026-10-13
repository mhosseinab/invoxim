import { extractionSchema, hasControlCharacters } from "@invoxim/contracts";
import { parseMoney } from "../index";
import type {
  AiMissingField,
  AiReason,
  AiTextPart,
  PersistableAiResult,
} from "./types";

export function validateExtraction(
  output: string,
  parts: readonly AiTextPart[],
  maxBytes: number,
): PersistableAiResult {
  if (
    output.length > maxBytes ||
    new TextEncoder().encode(output).length > maxBytes
  )
    return { status: "needs-review", reason: "schema" };
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return { status: "needs-review", reason: "schema" };
  }
  if (!boundedExtractionShape(raw))
    return { status: "needs-review", reason: "schema" };
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) return { status: "needs-review", reason: "schema" };
  const candidate = parsed.data;
  const missingFields = (
    ["merchant", "currency", "total", "documentDate"] as const
  ).filter((field) =>
    candidate.records.some((record) => record[field] === null),
  );
  if (missingFields.length)
    return { status: "needs-review", reason: "incomplete", missingFields };
  if (
    candidate.warnings.length ||
    (candidate.records.length === 0 &&
      candidate.documentType !== "non-purchase")
  )
    return { status: "needs-review", reason: "incomplete" };
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
              ).every((line) => groundedDate(line, value)),
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
            (line) =>
              field === "total" && /\b(subtotal|zwischensumme)\b/i.test(line),
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
      /\b(store credit|store-credit|guthaben)\b/i.test(wholeSource) &&
      record.storeCreditAmount === null
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      /\b(ignore previous|ignore all instructions|export secrets|system prompt)\b/i.test(
        wholeSource,
      )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-paid" &&
      paymentLines.some(
        (line) =>
          /\b(unpaid|not paid|pending|unbezahlt|nicht bezahlt|ausstehend)\b/i.test(
            line,
          ) ||
          /\b(no|not|never|nicht|keine)\b.{0,50}\b(paid|payment|bezahlt|zahlung)\b/i.test(
            line,
          ),
      )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "completed" &&
      refundLines.some((line) =>
        /\b(pending|requested|processing|ausstehend|beantragt)\b/i.test(line),
      )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-paid" &&
      /\b(installment|instalment|teilzahlung)\b/i.test(wholeSource) &&
      !record.evidence
        .filter((item) => item.field === "paymentAmount")
        .some((item) =>
          contextLines(inputs.get(item.inputPartId) ?? "", item.quote).some(
            (line) =>
              /\b(installment|instalment|teilzahlung|paid|payment received|bezahlt)\b/i.test(
                line,
              ),
          ),
        )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "completed" &&
      refundLines.some((line) =>
        /\b(no|not|never|nicht|keine)\b.{0,50}\b(refund|refunded|completed|erstattet|abgeschlossen)\b/i.test(
          line,
        ),
      )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.eventDate !== null &&
      record.evidence
        .filter((item) => item.field === "eventDate")
        .some((item) =>
          contextLines(inputs.get(item.inputPartId) ?? "", item.quote).some(
            (line) =>
              /\b(invoice date|document date|due date|order date|rechnungsdatum|fälligkeitsdatum)\b/i.test(
                line,
              ),
          ),
        )
    )
      return { status: "needs-review", reason: "date" };
    const explicitPayments = labelledAmounts(
      wholeSource,
      "paid|payment received|card payment|cash payment|bezahlt|zahlung erhalten",
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
            "paid|payment received|card payment|cash payment|bezahlt|zahlung erhalten",
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
              (line) =>
                !/\b(tax|vat|steuer|subtotal|zwischensumme|refund|store credit|guthaben)\b/i.test(
                  line,
                ),
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
            (line) =>
              /\b(refund|refunded|erstattet|rückerstattung)\b/i.test(line) &&
              !/\b(tax|vat|steuer)\b/i.test(line),
          ),
        )
    )
      return { status: "needs-review", reason: "semantics" };
    const payment = quotes("payment").join("\n");
    const refund = quotes("refund").join("\n");
    if (
      record.paymentEvidence === "explicitly-paid" &&
      (!/\b(paid|payment received|bezahlt|zahlung erhalten)\b/i.test(payment) ||
        /\b(unpaid|not paid|pending|due|unbezahlt|nicht bezahlt|ausstehend)\b/i.test(
          payment,
        ) ||
        record.paymentAmount === null ||
        record.eventDate === null)
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.paymentEvidence === "explicitly-unpaid" &&
      !/\b(unpaid|not paid|due|unbezahlt|nicht bezahlt|ausstehend)\b/i.test(
        payment,
      )
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "completed" &&
      (!/\b(refunded|refund completed|refund issued|erstattet|rückerstattung abgeschlossen)\b/i.test(
        refund,
      ) ||
        /\b(pending|requested|processing|ausstehend|beantragt)\b/i.test(
          refund,
        ) ||
        record.refundAmount === null ||
        record.eventDate === null ||
        candidate.documentType === "credit-note")
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      record.refundEvidence === "pending" &&
      !/\b(pending|requested|processing|ausstehend|beantragt)\b/i.test(refund)
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
        (paid !== null && credit !== null && paid + credit > total))
    )
      return { status: "needs-review", reason: "semantics" };
    if (
      ["non-purchase", "cancellation", "statement", "unknown"].includes(
        candidate.documentType,
      ) &&
      (record.paymentEvidence === "explicitly-paid" ||
        record.refundEvidence === "completed")
    )
      return { status: "needs-review", reason: "semantics" };
  }
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
const printedMonthPatterns = [
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
  const monthName = printedMonthPatterns[monthNumber - 1];
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
  if (/\b(subtotal|zwischensumme)\b/i.test(quote)) return false;
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

/** Validates the storage boundary without allowing hidden transcript fields. */
export function validatePersistableAiResult(
  value: unknown,
): PersistableAiResult | null {
  if (!object(value)) return null;
  if (value.status === "needs-review") {
    const reasons = [
      "schema",
      "evidence",
      "money",
      "date",
      "semantics",
      "incomplete",
      "input-limit",
      "settings-changed",
      "budget",
      "in-progress",
      "timeout",
      "rate-limit",
      "invalid-key",
      "unsupported",
      "refusal",
      "outage",
    ];
    if (
      Object.keys(value).some(
        (key) => !["status", "reason", "missingFields"].includes(key),
      ) ||
      typeof value.reason !== "string" ||
      !reasons.includes(value.reason)
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
            ["merchant", "currency", "total", "documentDate"].includes(field),
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
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function boundedExtractionShape(value: unknown): boolean {
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
  if (
    !value.trim() ||
    /\b(original|previous|order|invoice|requested|pending)\b/i.test(text)
  )
    return false;
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
      ? /^(?:INV|INVOICE|RECHNUNG)[-_]/i
      : /^(?:ORDER|BESTELLUNG)[-_]/i;
  if (text.trim() === value && prefix.test(value)) return true;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const label =
    field === "invoiceNumber"
      ? "invoice|receipt|rechnung|factura|facture"
      : "order|bestellung|commande";
  return new RegExp(
    `\\b(?:${label})\\s*(?:(?:reference|number|no\\.?|id|nr\\.?)\\s*)?[:#=]?\\s*${escaped}(?![\\p{L}\\p{N}_./-])`,
    "iu",
  ).test(text);
}

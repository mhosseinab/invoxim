import type { LifecycleExport } from "@invoxim/contracts";
export class LifecycleError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "CONFLICT"
      | "UNAVAILABLE"
      | "TOO_LARGE",
  ) {
    super(code);
  }
}
/** Formula-leading text remains text after RFC4180 parsing, including hidden prefixes. */
function spreadsheetText(value: string): string {
  const trimmed = value.trimStart();
  let unsafe = /^[=+@-]/.test(trimmed);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) {
      if (code < 32 || code === 127) unsafe = true;
    } else break;
  }
  return unsafe ? `'${value}` : value;
}
function text(value: string | null) {
  return `"${spreadsheetText(value ?? "").replaceAll('"', '""')}"`;
}
export function encodeLifecycleExport(
  input: LifecycleExport,
  format: "csv" | "json",
): string {
  let result: string;
  if (format === "json") result = JSON.stringify(input);
  else {
    const rows = [
      "purchase_id,merchant,document_date,document_total_minor,document_currency,category,payment_state,value_scope,currency,paid_minor,refunded_minor,net_minor,entry_id,entry_kind,event_date,date_basis,eligible,entry_minor",
    ];
    for (const purchase of input.purchases) {
      const prefix = [
        text(purchase.id),
        text(purchase.merchant),
        text(purchase.date),
        purchase.documentTotalMinor ?? "",
        text(purchase.currency),
        text(purchase.category),
        text(purchase.paymentState),
      ];
      for (const scope of ["lifecycle", "period"] as const) {
        const values = purchase[scope];
        if (values.length === 0)
          rows.push(
            [
              ...prefix,
              text(scope),
              "",
              "",
              "",
              "",
              "",
              "",
              "",
              "",
              "",
              "",
            ].join(","),
          );
        for (const value of values)
          rows.push(
            [
              ...prefix,
              text(scope),
              text(value.currency),
              value.paidMinor,
              value.refundedMinor,
              value.netMinor,
              "",
              "",
              "",
              "",
              "",
              "",
            ].join(","),
          );
      }
    }
    const purchases = new Map(input.purchases.map((p) => [p.id, p]));
    for (const entry of input.ledgerEntries) {
      const purchase = purchases.get(entry.purchaseId);
      if (!purchase) throw new LifecycleError("INVALID_REQUEST");
      const period =
        (!input.filters.from || entry.date >= input.filters.from) &&
        (!input.filters.to || entry.date <= input.filters.to);
      rows.push(
        [
          text(purchase.id),
          text(purchase.merchant),
          text(purchase.date),
          purchase.documentTotalMinor ?? "",
          text(purchase.currency),
          text(purchase.category),
          text(purchase.paymentState),
          text(period ? "period-event" : "lifecycle-event"),
          text(entry.currency),
          "",
          "",
          "",
          text(entry.id),
          text(entry.kind),
          text(entry.date),
          text(entry.dateBasis),
          String(entry.eligible),
          entry.minor,
        ].join(","),
      );
    }
    result = `${rows.join("\r\n")}\r\n`;
  }
  if (new TextEncoder().encode(result).byteLength > 2 * 1024 * 1024)
    throw new LifecycleError("TOO_LARGE");
  return result;
}

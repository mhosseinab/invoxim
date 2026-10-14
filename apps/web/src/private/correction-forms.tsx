import {
  type CorrectionState,
  cashConfirmationRequestSchema,
  currencyMinorDigits,
  eventCorrectionRequestSchema,
  extractionSchema,
  type PurchaseDetail,
  purchaseCorrectionRequestSchema,
} from "@invoxim/contracts";
import { parseMoney } from "@invoxim/core";
import { useId, useState } from "react";
import { amountInput } from "../format";
import { cashEvents } from "./cash";
import { categoryLabel } from "./copy";
import type { CorrectionMutation } from "./mutations";
export function moneyMinor(value: string, currency: string): string {
  const minor = parseMoney(value, currency);
  if (minor === null) throw new Error("Missing amount");
  return minor.toString();
}
export function CurrencyField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id}>
      Currency
      <select
        id={id}
        aria-label="Currency"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a currency</option>
        {Object.keys(currencyMinorDigits).map((currency) => (
          <option key={currency} value={currency}>
            {currency}
          </option>
        ))}
      </select>
    </label>
  );
}
export function CategoryField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id}>
      Category
      <select
        id={id}
        aria-label="Category"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {extractionSchema.shape.records.element.shape.category.options.map(
          (category) => (
            <option key={category} value={category}>
              {categoryLabel(category)}
            </option>
          ),
        )}
      </select>
    </label>
  );
}
export function PurchaseEditor({
  detail,
  state,
  mutation,
}: {
  detail: PurchaseDetail;
  state: CorrectionState;
  mutation: CorrectionMutation;
}) {
  const original = detail.purchase;
  const [merchant, setMerchant] = useState(original.merchant);
  const [invoiceReference, setInvoiceReference] = useState(
    original.invoiceReference ?? "",
  );
  const [orderReference, setOrderReference] = useState(
    original.orderReference ?? "",
  );
  const [category, setCategory] = useState<string>(original.category);
  const [date, setDate] = useState(original.date);
  const [currency, setCurrency] = useState(original.currency ?? "");
  const originalCurrencySupported =
    original.currency !== null &&
    Object.hasOwn(currencyMinorDigits, original.currency);
  const [total, setTotal] = useState(
    original.documentTotalMinor !== null &&
      originalCurrencySupported &&
      original.currency
      ? amountInput(original.documentTotalMinor, original.currency)
      : "",
  );
  const [totalTouched, setTotalTouched] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const changes: Record<string, unknown> = {};
          if (merchant !== original.merchant) changes.merchant = merchant;
          if (invoiceReference !== (original.invoiceReference ?? ""))
            changes.invoiceReference = invoiceReference.trim() || null;
          if (orderReference !== (original.orderReference ?? ""))
            changes.orderReference = orderReference.trim() || null;
          if (category !== original.category) changes.category = category;
          if (date !== original.date) changes.documentDate = date;
          if (currency !== (original.currency ?? ""))
            changes.currency = currency || null;
          const currencyChanged = currency !== (original.currency ?? "");
          if (
            totalTouched ||
            (currencyChanged && original.documentTotalMinor !== null)
          ) {
            if (currencyChanged && total === "" && !totalTouched)
              return mutation.invalid();
            const minor = total === "" ? null : moneyMinor(total, currency);
            if (minor !== original.documentTotalMinor)
              changes.totalMinor = minor;
          }
          const parsed = purchaseCorrectionRequestSchema.safeParse({
            version: state.version,
            changes,
          });
          if (!parsed.success) return mutation.invalid();
          mutation.submit(
            `/api/purchases/${encodeURIComponent(state.purchaseId)}`,
            "PATCH",
            parsed.data,
          );
        } catch {
          mutation.invalid();
        }
      }}
    >
      {!originalCurrencySupported && original.documentTotalMinor !== null && (
        <p>
          Original amount precision is not configured for this currency. Enter a
          confirmed amount when changing its currency; untouched monetary fields
          are preserved.
        </p>
      )}
      <p>
        Changing the document total does not change a payment or refund. Correct
        cash events separately.
      </p>
      <fieldset disabled={mutation.locked} aria-describedby={mutation.errorId}>
        <legend>Purchase details</legend>
        <div className="private-filter-grid">
          <label>
            Merchant
            <input
              aria-label="Merchant"
              value={merchant}
              onChange={(event) => setMerchant(event.target.value)}
              maxLength={200}
              required
            />
          </label>
          <CategoryField value={category} onChange={setCategory} />
          <label>
            Invoice reference
            <input
              aria-label="Invoice reference"
              value={invoiceReference}
              onChange={(event) => setInvoiceReference(event.target.value)}
              maxLength={160}
            />
          </label>
          <label>
            Order reference
            <input
              aria-label="Order reference"
              value={orderReference}
              onChange={(event) => setOrderReference(event.target.value)}
              maxLength={160}
            />
          </label>
          <label>
            Document date
            <input
              aria-label="Document date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </label>
          <CurrencyField value={currency} onChange={setCurrency} />
          <label>
            Document total
            <input
              aria-label="Document total"
              inputMode="decimal"
              value={total}
              onChange={(event) => {
                setTotalTouched(true);
                setTotal(event.target.value);
              }}
            />
          </label>
        </div>
        <button type="submit">Save purchase details</button>
      </fieldset>
    </form>
  );
}
export function CashEditor({
  kind,
  detail,
  state,
  mutation,
  entryId,
  review,
}: {
  kind: "payment" | "refund";
  detail: PurchaseDetail;
  state: CorrectionState;
  mutation: CorrectionMutation;
  entryId?: string;
  review?: { id: string; version: number };
}) {
  const event = cashEvents(detail).find((event) => event.id === entryId);
  const entry = state.entries.find((entry) => entry.id === entryId);
  const [currency, setCurrency] = useState(
    event?.currency ?? detail.purchase.currency ?? "",
  );
  const [amount, setAmount] = useState(
    event && Object.hasOwn(currencyMinorDigits, event.currency)
      ? amountInput(event.minor, event.currency)
      : "",
  );
  const [date, setDate] = useState(event?.date ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const label = kind === "payment" ? "Payment" : "Refund";
  return (
    <form
      onSubmit={(submit) => {
        submit.preventDefault();
        try {
          const minor = moneyMinor(amount, currency);
          if (entryId && entry && event) {
            const changes: Record<string, string> = {};
            if (minor !== event.minor) changes.amountMinor = minor;
            if (currency !== event.currency) changes.currency = currency;
            if (date !== event.date) changes.eventDate = date;
            const parsed = eventCorrectionRequestSchema.safeParse({
              version: event.version ?? entry.version,
              changes,
            });
            if (!parsed.success) return mutation.invalid();
            mutation.submit(
              `/api/ledger-entries/${encodeURIComponent(entryId)}`,
              "PATCH",
              parsed.data,
            );
          } else {
            const parsed = cashConfirmationRequestSchema.safeParse({
              version: state.version,
              confirmed,
              amountMinor: minor,
              currency,
              eventDate: date,
              ...(review ? { review } : {}),
            });
            if (!parsed.success) return mutation.invalid();
            mutation.submit(
              `/api/purchases/${encodeURIComponent(state.purchaseId)}/${kind}-confirmation`,
              "POST",
              parsed.data,
            );
          }
        } catch {
          mutation.invalid();
        }
      }}
    >
      <p>
        {entryId
          ? "Correct this existing cash event. Its identity and kind stay the same."
          : `Confirm a completed ${kind} only. Pending refunds and store credit are not cash events.`}
      </p>
      <fieldset disabled={mutation.locked} aria-describedby={mutation.errorId}>
        <legend>{entryId ? `Correct ${kind}` : `Confirm ${kind}`}</legend>
        <div className="private-filter-grid">
          <label>
            {label} amount
            <input
              aria-label={`${label} amount`}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          <CurrencyField value={currency} onChange={setCurrency} />
          <label>
            Event date
            <input
              aria-label="Event date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </label>
        </div>
        {!entryId && (
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              required
            />
            I confirm this {kind} was completed.
          </label>
        )}
        <button type="submit">
          {entryId ? `Save ${kind} correction` : `Save confirmed ${kind}`}
        </button>
      </fieldset>
    </form>
  );
}

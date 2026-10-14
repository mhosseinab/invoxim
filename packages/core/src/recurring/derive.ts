import {
  minorDigits,
  type RecurringCadence,
  type RecurringInput,
  type RecurringPayment,
  type RecurringResult,
  recurringInputSchema,
  recurringMethodVersion,
  recurringPostingToleranceDays,
  recurringResultSchema,
} from "@invoxim/contracts";
import { monthlyAnchor } from "../calendar-anchor";
import { roundRatio } from "../money-conversion";
import { RecurringInputError } from "./types";

type Series = Extract<RecurringResult, { status: "series" }>;
const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / 86400000;
const month = (date: string) =>
  Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

function occurrence(
  cadence: RecurringCadence,
  anchor: string,
  index: number,
): string | null {
  if (cadence === "weekly") {
    const time = (day(anchor) + index * 7) * 86400000;
    if (
      time < Date.parse("0001-01-01T00:00:00.000Z") ||
      time > Date.parse("9999-12-31T00:00:00.000Z")
    )
      return null;
    return new Date(time).toISOString().slice(0, 10);
  }
  const nextMonth = month(anchor) + index * (cadence === "annual" ? 12 : 1);
  const year = Math.floor(nextMonth / 12);
  if (year < 1 || year > 9999) return null;
  const target = `${String(year).padStart(4, "0")}-${String((nextMonth % 12) + 1).padStart(2, "0")}`;
  return monthlyAnchor(target, Number(anchor.slice(8, 10)));
}

function nearestIndex(
  cadence: RecurringCadence,
  anchor: string,
  date: string,
): number | null {
  const approximate = Math.round(
    cadence === "weekly"
      ? (day(date) - day(anchor)) / 7
      : (month(date) - month(anchor)) / (cadence === "annual" ? 12 : 1),
  );
  let selected: number | null = null;
  let distance = Infinity;
  for (const index of [approximate - 1, approximate, approximate + 1]) {
    const expected = occurrence(cadence, anchor, index);
    if (expected === null) continue;
    const offset = Math.abs(day(date) - day(expected));
    if (offset <= recurringPostingToleranceDays && offset < distance) {
      selected = index;
      distance = offset;
    }
  }
  return selected;
}
function scheduleMatches(
  cadence: RecurringCadence,
  anchor: string,
  payments: readonly RecurringPayment[],
): number | null {
  const first = payments[0];
  if (!first) return null;
  const start = nearestIndex(cadence, anchor, first.eventDate);
  if (start === null) return null;
  for (const [index, payment] of payments.entries()) {
    const expected = occurrence(cadence, anchor, start + index);
    if (
      expected === null ||
      Math.abs(day(expected) - day(payment.eventDate)) >
        recurringPostingToleranceDays
    )
      return null;
  }
  return start;
}

/**
 * Recurring eligibility (C15): two layers, intentionally not one rule.
 *
 * SQL (adapters/recurring/service.ts) pre-filters database rows at query time:
 * active profile, active purchase record, no pending lifecycle deletion/recompute,
 * plus `kind='payment' AND eligible=1`. It also computes the `installment` flag
 * (`partially_paid` OR more than one cash payment on the purchase).
 *
 * This TS layer validates the derivation basis independently so the pure
 * function stays correct for callers that supply payments without the SQL
 * pre-filter (tests, future non-D1 sources). It re-checks kind/eligible,
 * drops `installment`, and excludes multi-payment purchases — the latter is
 * redundant with the SQL `installment` computation when rows come from the
 * adapter, but is the only guard otherwise.
 */
function eligiblePayments(input: RecurringInput): RecurringPayment[] {
  const entries = new Map<string, RecurringPayment>();
  for (const payment of input.payments) {
    const previous = entries.get(payment.entryId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(payment))
      throw new RecurringInputError();
    entries.set(payment.entryId, payment);
  }
  const cash = [...entries.values()].filter(
    (payment) => payment.kind === "payment" && payment.eligible,
  );
  const purchases = new Map<string, number>();
  for (const payment of cash)
    purchases.set(
      payment.purchaseId,
      (purchases.get(payment.purchaseId) ?? 0) + 1,
    );
  return cash
    .filter(
      (payment) =>
        !payment.installment && purchases.get(payment.purchaseId) === 1,
    )
    .sort(
      (left, right) =>
        left.eventDate.localeCompare(right.eventDate) ||
        left.entryId.localeCompare(right.entryId),
    );
}

function compare(
  previous: RecurringPayment,
  current: RecurringPayment,
): Series["comparison"] {
  const comparable =
    previous.pricing.kind === "fixed" &&
    current.pricing.kind === "fixed" &&
    previous.comparableCharge &&
    current.comparableCharge &&
    previous.comparableCharge.basisKey === current.comparableCharge.basisKey;
  const before = BigInt(
    comparable
      ? (previous.comparableCharge?.amountMinor ?? previous.amountMinor)
      : previous.amountMinor,
  );
  const after = BigInt(
    comparable
      ? (current.comparableCharge?.amountMinor ?? current.amountMinor)
      : current.amountMinor,
  );
  const delta = after - before;
  const usage =
    previous.pricing.kind === "usage-variable" ||
    current.pricing.kind === "usage-variable";
  return {
    previousEntryId: previous.entryId,
    currentEntryId: current.entryId,
    previousAmountMinor: before.toString(),
    currentAmountMinor: after.toString(),
    deltaMinor: delta.toString(),
    percentHundredths:
      before === 0n ? null : roundRatio(delta * 10000n, before).toString(),
    signal:
      delta === 0n
        ? "stable"
        : usage
          ? "usage_variation"
          : comparable
            ? delta > 0n
              ? "fixed_price_increase"
              : "fixed_price_decrease"
            : "charged_amount_changed",
    basis: comparable ? "comparable-charge" : "payment-amount",
  };
}

/** Suggestions and estimates only. The caller supplies owned, validated payment/evidence facts. */
export function deriveRecurringSuggestion(
  input: RecurringInput,
): RecurringResult {
  const parsed = recurringInputSchema.safeParse(input);
  if (!parsed.success) throw new RecurringInputError();
  const decision = parsed.data.decision ?? null;
  const insufficient = (
    reason: Extract<RecurringResult, { status: "insufficient" }>["reason"],
  ): RecurringResult => ({
    status: "insufficient",
    reason,
    decision,
    methodVersion: recurringMethodVersion,
  });
  const usable = eligiblePayments(parsed.data);
  if (usable.length === 0) return insufficient("no_eligible_payments");
  if (usable.some((payment) => payment.serviceIdentity === null))
    return insufficient("missing_service_identity");
  const first = usable[0];
  const last = usable.at(-1);
  if (!first?.serviceIdentity || !last)
    return insufficient("missing_service_identity");
  const identity = first.serviceIdentity;
  if (
    usable.some(
      (payment) =>
        payment.serviceIdentity?.kind !== identity.kind ||
        payment.serviceIdentity?.key !== identity.key,
    )
  )
    return insufficient("mixed_service_identity");
  if (usable.some((payment) => payment.currency !== first.currency))
    return insufficient("mixed_currency");
  try {
    minorDigits(first.currency);
  } catch {
    return insufficient("unsupported_currency");
  }
  const terms = usable.flatMap((payment) =>
    payment.terms ? [payment.terms] : [],
  );
  const explicit = terms.at(-1);
  let payments = usable;
  let cadence: RecurringCadence;
  let anchor: string;
  let start: number | null;
  if (explicit) {
    cadence = explicit.cadence;
    anchor = explicit.anchorDate;
    for (const term of terms) {
      const aligned = nearestIndex(cadence, anchor, term.anchorDate);
      if (
        term.cadence !== cadence ||
        aligned === null ||
        occurrence(cadence, anchor, aligned) !== term.anchorDate
      )
        return insufficient("terms_conflict");
    }
    start = scheduleMatches(cadence, anchor, payments);
    if (start === null) return insufficient("terms_conflict");
  } else {
    payments = usable.filter((payment) => payment.amountMinor !== "0");
    const initial = payments[0];
    if (!initial || payments.length < 2)
      return insufficient("insufficient_history");
    anchor = initial.eventDate;
    const candidates: RecurringCadence[] =
      payments.length >= 3 ? ["monthly", "weekly", "annual"] : ["annual"];
    const match = candidates
      .map((candidate) => ({
        candidate,
        start: scheduleMatches(candidate, anchor, payments),
      }))
      .find((result) => result.start !== null);
    if (!match)
      return insufficient(
        payments.length < 3 ? "insufficient_history" : "unstable_intervals",
      );
    cadence = match.candidate;
    start = match.start;
  }
  if (start === null) return insufficient("unstable_intervals");
  const latest = payments.at(-1);
  if (!latest) return insufficient("no_eligible_payments");
  const value = BigInt(latest.amountMinor);
  const annual =
    cadence === "monthly"
      ? value * 12n
      : cadence === "weekly"
        ? value * 52n
        : value;
  const monthly = cadence === "monthly" ? value : roundRatio(annual, 12n);
  const state = decision?.state ?? "suggested";
  const previous = payments.at(-2);
  return recurringResultSchema.parse({
    status: "series",
    state,
    decision,
    serviceIdentity: first.serviceIdentity,
    currency: first.currency,
    cadence,
    anchorDate: anchor,
    scheduleBasis: explicit?.evidence ?? "first-payment-estimate",
    postingToleranceDays: recurringPostingToleranceDays,
    methodVersion: recurringMethodVersion,
    entryIds: payments.map((payment) => payment.entryId),
    lastPayment: latest,
    comparison: previous ? compare(previous, latest) : null,
    forecast:
      state === "dismissed" || state === "paused" || state === "canceled"
        ? null
        : {
            estimatedNextDate: occurrence(
              cadence,
              anchor,
              start + payments.length,
            ),
            monthlyMinor: monthly.toString(),
            annualMinor: annual.toString(),
            amountBasis: "last-payment",
            weeklyPaymentsPerYear: cadence === "weekly" ? 52 : null,
            certainty: "estimate",
          },
  });
}

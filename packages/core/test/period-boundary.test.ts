import { describe, expect, it } from "vitest";
import { ledgerTotals } from "../src/index";

/**
 * CORE-3 (P0.8, unverified) — rule G4 reproduction and close.
 *
 * Finding: `ledgerTotals` treats the period end as exclusive while
 * `matchesPeriod` (adapters/purchase-views) treats `filter.to` as
 * inclusive.
 *
 * Reproduction result: the two rules differ on a boundary day, but they
 * are two named conventions on two different APIs, not uncontrolled drift:
 *
 *   - `ledgerTotals(period)` takes `{ startDate, endExclusive }` — the
 *     field name states the half-open rule. UI copy says "end exclusive"
 *     (apps/web private/copy.ts, onboarding/copy.ts).
 *   - `matchesPeriod(event, filter)` takes `PurchaseFilters.{from,to}` —
 *     the purchase-filter UI label is "To (inclusive)"
 *     (apps/web/src/private/page.tsx). The same inclusive `to` is used by
 *     SQL `BETWEEN` in purchase-views and fx/period.
 *
 * No production code converts one shape into the other, so the two
 * conventions cannot silently disagree on a shared period object.
 * Worker suite `purchase-views.test.ts` HOME-02/04 already pins the
 * inclusive filter (`to: "2026-10-31"` includes 2026-10-10 events).
 *
 * Decision: keep both rules. Pin the core half-open contract here. Do not
 * edit adapters (the one-function clearance is not needed once the
 * finding is a documented dual convention).
 */

const entry = (date: string) => ({
  kind: "payment" as const,
  minor: "100",
  currency: "EUR",
  date,
  eligible: true,
});

describe("CORE-3 ledgerTotals period end is half-open [startDate, endExclusive)", () => {
  it("includes the start day and excludes the endExclusive day", () => {
    expect(
      ledgerTotals(
        [entry("2026-02-01"), entry("2026-02-28"), entry("2026-03-01")],
        "EUR",
        { startDate: "2026-02-01", endExclusive: "2026-03-01" },
      ),
    ).toEqual({ paidMinor: "200", refundedMinor: "0", netMinor: "200" });
  });

  it("drops an entry that falls exactly on endExclusive", () => {
    expect(
      ledgerTotals([entry("2026-03-01")], "EUR", {
        startDate: "2026-02-01",
        endExclusive: "2026-03-01",
      }),
    ).toEqual({ paidMinor: "0", refundedMinor: "0", netMinor: "0" });
    expect(
      ledgerTotals([entry("2026-03-01")], "EUR", {
        startDate: "2026-03-01",
        endExclusive: "2026-04-01",
      }),
    ).toEqual({ paidMinor: "100", refundedMinor: "0", netMinor: "100" });
  });

  it("rejects a reversed or empty period", () => {
    expect(() =>
      ledgerTotals([entry("2026-02-01")], "EUR", {
        startDate: "2026-03-01",
        endExclusive: "2026-03-01",
      }),
    ).toThrow("INVALID_RANGE");
    expect(() =>
      ledgerTotals([entry("2026-02-01")], "EUR", {
        startDate: "2026-03-01",
        endExclusive: "2026-02-01",
      }),
    ).toThrow("INVALID_RANGE");
  });
});

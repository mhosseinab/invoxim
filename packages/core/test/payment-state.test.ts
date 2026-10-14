import { describe, expect, it } from "vitest";
import { derivePaymentState } from "../src/ledger/payment-state";

describe("CORE-6 derivePaymentState", () => {
  it.each([
    [0n, "unknown"],
    [1n, "partially_paid"],
    [9999n, "partially_paid"],
    [10000n, "paid"],
    [10001n, "paid"],
  ] as const)(
    "derives %s settled minor units as %s",
    (settledMinor, expected) => {
      expect(derivePaymentState({ totalMinor: 10000n, settledMinor })).toBe(
        expected,
      );
    },
  );

  it("compares amounts beyond safe integer precision exactly", () => {
    expect(
      derivePaymentState({
        totalMinor: 9007199254740993n,
        settledMinor: 9007199254740992n,
      }),
    ).toBe("partially_paid");
  });

  it("does not infer payment from a zero total without settlement evidence", () => {
    expect(derivePaymentState({ totalMinor: 0n, settledMinor: 0n })).toBe(
      "unknown",
    );
  });

  it("retains explicitly selected zero-cash context", () => {
    expect(
      derivePaymentState({
        totalMinor: 10000n,
        settledMinor: 0n,
        zeroPaymentState: "unpaid",
      }),
    ).toBe("unpaid");
  });

  it("complete document evidence can settle without cash", () => {
    expect(
      derivePaymentState({
        totalMinor: 10000n,
        settledMinor: 0n,
        fullSettlement: true,
      }),
    ).toBe("paid");
  });
});

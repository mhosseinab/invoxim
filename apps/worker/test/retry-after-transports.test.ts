import { afterEach, expect, it, vi } from "vitest";
import { createGmailDiscovery } from "../../../packages/adapters/src/discovery/gmail";
import { createOutlookGraphDiscovery } from "../../../packages/adapters/src/discovery/outlook";

/**
 * INT-5/G5: Gmail and Graph discovery transports read Retry-After through
 * SEC-4's parseRetryAfter, each keeping its own 30 s default when the header
 * is absent or unusable. Long cooldowns stay pauses (> 1 day sentinel).
 */
afterEach(() => vi.restoreAllMocks());

const transports = {
  gmail: (signal: AbortSignal) =>
    createGmailDiscovery("synthetic-access").anchor(signal),
  outlook: (signal: AbortSignal) =>
    createOutlookGraphDiscovery("synthetic-graph-access").folders({ signal }),
} as const;

async function retryAfterMs(
  transport: keyof typeof transports,
  header: string | null,
): Promise<number | undefined> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 429,
      headers: header === null ? {} : { "Retry-After": header },
    }),
  );
  try {
    await transports[transport](new AbortController().signal);
  } catch (cause) {
    expect(cause).toMatchObject({ code: "RATE_LIMITED" });
    return (cause as { retryAfterMs?: number }).retryAfterMs;
  }
  throw new Error("Synthetic 429 did not rate-limit");
}

const pinned = [
  ["absent", null, 30_000],
  ["delay-seconds", "120", 120_000],
  ["zero floored to one second", "0", 1_000],
  ["two-hour delay", "7200", 7_200_000],
  ["oversized numeric", "9".repeat(400), 86_400_001],
  ["past HTTP-date floored", "Wed, 01 Jan 2020 00:00:00 GMT", 1_000],
] as const;

type PinnedCase = [keyof typeof transports, string, string | null, number];
it.each(
  (["gmail", "outlook"] as const).flatMap((transport) =>
    pinned.map(
      ([name, header, expected]): PinnedCase => [
        transport,
        name,
        header,
        expected,
      ],
    ),
  ),
)(
  "%s Retry-After %s is unchanged",
  async (transport, _name, header, expected) => {
    expect(await retryAfterMs(transport, header)).toBe(expected);
  },
);

it.each(["gmail", "outlook"] as const)(
  "%s future HTTP-date Retry-After keeps its exact cooldown",
  async (transport) => {
    const before = Date.now();
    const header = new Date(before + 120_000).toUTCString();
    const delay = await retryAfterMs(transport, header);
    expect(delay).toBeGreaterThanOrEqual(119_000 - (Date.now() - before));
    expect(delay).toBeLessThanOrEqual(120_000);
  },
);

it("gmail unparseable Retry-After keeps the 30 s default", async () => {
  expect(await retryAfterMs("gmail", "not a date")).toBe(30_000);
});

it("outlook oversized unparseable Retry-After stays a pause", async () => {
  expect(await retryAfterMs("outlook", "a".repeat(129))).toBe(86_400_001);
});

// Behaviour changes from adopting G5's single rule (RED before migration).
it.each(["gmail", "outlook"] as const)(
  "INT-5/G5 %s over-day delay-seconds becomes the pause sentinel",
  async (transport) => {
    expect(await retryAfterMs(transport, "90000")).toBe(86_400_001);
  },
);

it.each(["gmail", "outlook"] as const)(
  "INT-5/G5 %s non-HTTP-date timestamp is not fed to Date.parse",
  async (transport) => {
    const header = new Date(Date.now() + 120_000).toISOString();
    expect(await retryAfterMs(transport, header)).toBe(30_000);
  },
);

it.each(["gmail", "outlook"] as const)(
  "INT-5/G5 %s signed delay-seconds is treated as absent",
  async (transport) => {
    expect(await retryAfterMs(transport, "-1")).toBe(30_000);
  },
);

it("INT-5/G5 outlook unparseable Retry-After uses the 30 s default instead of pausing", async () => {
  expect(await retryAfterMs("outlook", "not a date")).toBe(30_000);
});

it("INT-5/G5 gmail oversized unparseable Retry-After pauses instead of a 30 s default", async () => {
  expect(await retryAfterMs("gmail", "a".repeat(129))).toBe(86_400_001);
});

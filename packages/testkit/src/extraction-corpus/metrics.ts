import type { CorpusCase, OfflineOutcome, OfflineSummary } from "./types";
export function summarizeOffline(
  cases: readonly CorpusCase[],
  results: ReadonlyMap<string, OfflineOutcome>,
): OfflineSummary {
  const clean = { accepted: 0, denominator: 0 };
  const challenges = {
    accepted: 0,
    reviewed: 0,
    parserBlocked: 0,
    denominator: 0,
  };
  let falseCashCases = 0;
  let missingCashCases = 0;
  let incorrectFinancialCases = 0;
  for (const input of cases) {
    const result = results.get(input.id);
    if (!result) throw new Error("MISSING_OFFLINE_OUTCOME");
    if (input.clean) {
      clean.denominator++;
      if (result.validation === "accepted") clean.accepted++;
    } else {
      challenges.denominator++;
      if (result.validation === "accepted") challenges.accepted++;
      else if (result.validation === "needs-review") challenges.reviewed++;
      else challenges.parserBlocked++;
    }
    const expectedCounts = eventCounts(input.expected.events);
    const actualCounts = eventCounts(result.events);
    if (
      Array.from(actualCounts).some(
        ([key, count]) => count > (expectedCounts.get(key) ?? 0),
      )
    )
      falseCashCases++;
    if (
      Array.from(expectedCounts).some(
        ([key, count]) => count > (actualCounts.get(key) ?? 0),
      )
    )
      missingCashCases++;
    if (JSON.stringify(result.events) !== JSON.stringify(input.expected.events))
      incorrectFinancialCases++;
  }
  return {
    label: "preset-candidate application conformance; not model quality",
    cases: cases.length,
    clean,
    challenges,
    falseCashCases,
    missingCashCases,
    incorrectFinancialCases,
    refusals: cases.filter((input) => input.response === "refusal").length,
    truncatedResponses: cases.filter((input) => input.response === "truncated")
      .length,
    providerRequests: 0,
    costMinor: 0,
  };
}

function eventCounts(events: OfflineOutcome["events"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = JSON.stringify([event.kind, event.currency, event.amountMinor]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

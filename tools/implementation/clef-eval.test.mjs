import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDevelopmentThresholds,
  loadClefCorpus,
  runClefEvaluation,
  summarizeClefResults,
} from "./clef-eval.mjs";

test("CLEF-ACCURACY-02 frozen corpus has disjoint eighty/forty split, balanced languages and no scripted responses", async () => {
  const corpus = await loadClefCorpus();
  assert.equal(corpus.development.length, 80);
  assert.equal(corpus.holdout.length, 40);
  assert.equal(
    new Set([...corpus.development, ...corpus.holdout].map((c) => c.id)).size,
    120,
  );
  for (const rows of [corpus.development, corpus.holdout]) {
    assert.equal(
      rows.filter((c) => c.language === "en").length,
      rows.length / 2,
    );
    assert.equal(
      rows.filter((c) => c.language === "de").length,
      rows.length / 2,
    );
    assert.ok(rows.some((c) => c.expected === "candidate"));
    assert.ok(rows.some((c) => c.expected === "non-document"));
    assert.ok(rows.some((c) => c.expected === "review"));
    assert.ok(rows.every((c) => !Object.hasOwn(c, "response")));
  }
});
test("CLEF-ACCURACY-02 metric oracle counts false positives, silent misses and abstentions separately", () => {
  const metrics = summarizeClefResults([
    { expected: "candidate", outcome: "candidate" },
    { expected: "candidate", outcome: "non-document" },
    { expected: "candidate", outcome: "uncertain" },
    { expected: "non-document", outcome: "candidate" },
    { expected: "non-document", outcome: "non-document" },
    { expected: "non-document", outcome: "uncertain" },
    { expected: "review", outcome: "review" },
  ]);
  assert.deepEqual(metrics, {
    total: 7,
    truePositives: 1,
    falsePositives: 1,
    trueNegatives: 1,
    falseNegatives: 1,
    positiveReviews: 1,
    negativeReviews: 1,
    unsupportedReviews: 1,
    errors: 0,
    precision: { numerator: 1, denominator: 2, value: 0.5 },
    recall: { numerator: 1, denominator: 3, value: 1 / 3 },
    decisionCoverage: { numerator: 4, denominator: 6, value: 2 / 3 },
    reviewRate: { numerator: 3, denominator: 7, value: 3 / 7 },
  });
});
test("CLEF-ACCURACY-02 dry run never reads credentials or calls a provider", async () => {
  let calls = 0;
  const result = await runClefEvaluation({
    live: false,
    partition: "all",
    maxCalls: 120,
    maxCostUsd: "0.30",
    fetcher: async () => {
      calls++;
      throw new Error("OFFLINE");
    },
    getToken: async () => {
      calls++;
      throw new Error("OFFLINE");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.totalCases, 120);
  assert.equal(result.networkCalls, 0);
  assert.equal(result.metrics, null);
  assert.ok(result.plannedCalls <= 120);
  assert.ok(BigInt(result.worstCaseUsdMicros) <= 300000n);
});
test("CLEF-ACCURACY-02 insufficient budget blocks before credentials or requests", async () => {
  let calls = 0;
  await assert.rejects(
    runClefEvaluation({
      live: true,
      partition: "development",
      maxCalls: 80,
      maxCostUsd: "0.000001",
      fetcher: async () => {
        calls++;
        throw new Error("NO");
      },
      getToken: async () => {
        calls++;
        return "synthetic-token";
      },
      accountId: "a".repeat(32),
    }),
    /COST_CAP/,
  );
  assert.equal(calls, 0);
});
test("CLEF-ACCURACY-02 live runner uses production protocol, one attempt and redacts transport failures", async () => {
  let calls = 0;
  const result = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 1,
    maxCostUsd: "0.01",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher: async (url, init) => {
      calls++;
      assert.equal(
        url,
        "https://api.cloudflare.com/client/v4/accounts/" +
          "a".repeat(32) +
          "/ai/run/@cf/cloudflare/clef",
      );
      assert.equal(init.redirect, "error");
      const request = JSON.parse(init.body);
      assert.equal(request.model, "clef");
      assert.equal(request.questions.receipt.type, "noul");
      assert.equal(request.questions.category.type, "choice");
      return Response.json({
        success: true,
        result: {
          model: "clef",
          answers: {
            documentType: {
              type: "choice",
              choice: "invoice",
              probabilities: { invoice: 1 },
              confidence: 1,
            },
            receipt: { type: "noul", noul: 0.97 },
            category: {
              type: "choice",
              choice: "other",
              probabilities: { other: 1 },
              confidence: 1,
            },
          },
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.networkCalls, 1);
  assert.equal(result.results[0].outcome, "candidate");
  assert.equal(JSON.stringify(result).includes("synthetic-token"), false);
  assert.equal(result.spentUsdMicros, "24");
  assert.equal(result.complete, false);
});

test("CLEF-ACCURACY-02 failed request stops once, hides provider body and retains reserved cost", async () => {
  let calls = 0;
  const result = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 80,
    maxCostUsd: "0.10",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-private-token",
    fetcher: async () => {
      calls++;
      return new Response("synthetic-private-provider-error", { status: 403 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "provider-error");
  assert.equal(result.results[0].outcome, "error");
  assert.ok(BigInt(result.uncertainReservedUsdMicros) > 0n);
  assert.equal(JSON.stringify(result).includes("synthetic-private"), false);
});
test("CLEF-ACCURACY-02 missing usage retains reservation without discarding valid model decision", async () => {
  const result = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 1,
    maxCostUsd: "0.01",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher: async () =>
      Response.json({
        success: true,
        result: {
          model: "clef",
          answers: {
            documentType: {
              type: "choice",
              choice: "delivery",
              probabilities: { delivery: 1 },
              confidence: 1,
            },
            receipt: { type: "noul", noul: 0.02 },
            category: {
              type: "choice",
              choice: "uncategorized",
              probabilities: { uncategorized: 1 },
              confidence: 1,
            },
          },
        },
      }),
  });
  assert.equal(result.results[0].outcome, "non-document");
  assert.equal(result.results[0].usage, null);
  assert.equal(result.spentUsdMicros, "0");
  assert.ok(BigInt(result.uncertainReservedUsdMicros) > 0n);
});
test("CLEF-ACCURACY-02 malformed category distribution is rejected by shared production decoder", async () => {
  const result = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 1,
    maxCostUsd: "0.01",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher: async () =>
      Response.json({
        success: true,
        result: {
          model: "clef",
          answers: {
            documentType: {
              type: "choice",
              choice: "invoice",
              probabilities: { invoice: 1 },
              confidence: 1,
            },
            receipt: { type: "noul", noul: 0.99 },
            category: {
              type: "choice",
              choice: "other",
              probabilities: { other: 0.1, uncategorized: 0.9 },
              confidence: 0.99,
            },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
  });
  assert.equal(result.results[0].outcome, "error");
  assert.equal(result.metrics.truePositives, 0);
});
test("CLEF-ACCURACY-02 oversized provider output is bounded and never included in results", async () => {
  const result = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 1,
    maxCostUsd: "0.01",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher: async () => new Response("x".repeat(16385)),
  });
  assert.equal(result.results[0].outcome, "error");
  assert.ok(JSON.stringify(result).length < 10000);
});

test("CLEF-ACCURACY-02 live all-partition run is rejected before authorization", async () => {
  let credentials = 0;
  await assert.rejects(
    runClefEvaluation({
      live: true,
      partition: "all",
      maxCostUsd: "0.30",
      getToken: async () => {
        credentials++;
        return "synthetic-token";
      },
    }),
    /EXPLICIT_LIVE_PARTITION_REQUIRED/,
  );
  assert.equal(credentials, 0);
});

test("CLEF-ACCURACY-02 held-out access requires a matching complete development freeze before credentials", async () => {
  let credentials = 0;
  await assert.rejects(
    runClefEvaluation({
      live: true,
      partition: "holdout",
      maxCalls: 40,
      maxCostUsd: "0.10",
      accountId: "a".repeat(32),
      getToken: async () => {
        credentials++;
        return "synthetic-token";
      },
      fetcher: async () => {
        throw new Error("OFFLINE");
      },
    }),
    /FROZEN_DEVELOPMENT/,
  );
  assert.equal(credentials, 0);
});
test("CLEF-ACCURACY-02 threshold analysis uses development scores only and retains abstentions", () => {
  const table = analyzeDevelopmentThresholds([
    {
      partition: "development",
      expected: "candidate",
      outcome: "uncertain",
      receiptProbability: 0.75,
      documentType: {
        type: "choice",
        choice: "invoice",
        probabilities: { invoice: 1 },
        confidence: 1,
      },
    },
    {
      partition: "development",
      expected: "non-document",
      outcome: "non-document",
      receiptProbability: 0.01,
      documentType: {
        type: "choice",
        choice: "delivery",
        probabilities: { delivery: 1 },
        confidence: 1,
      },
    },
    {
      partition: "holdout",
      expected: "non-document",
      outcome: "candidate",
      receiptProbability: 0.99,
    },
  ]);
  assert.equal(table.length, 6);
  assert.equal(
    table.find((row) => row.positiveThreshold === 0.7).metrics.truePositives,
    1,
  );
  assert.equal(
    table.find((row) => row.positiveThreshold === 0.9).metrics.positiveReviews,
    1,
  );
  assert.ok(
    table.every(
      (row) => row.metrics.total === 2 && row.metrics.falsePositives === 0,
    ),
  );
});

test("CLEF-ACCURACY-02 held-out run matches a frozen development artifact and rejects invalid or inconsistent freezes", async () => {
  const fetcher = async () =>
    Response.json({
      success: true,
      result: {
        model: "clef",
        answers: {
          documentType: {
            type: "choice",
            choice: "invoice",
            probabilities: { invoice: 1 },
            confidence: 1,
          },
          receipt: { type: "noul", noul: 0.97 },
          category: {
            type: "choice",
            choice: "other",
            probabilities: { other: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
  const development = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 80,
    maxCostUsd: "0.10",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher,
  });
  assert.equal(development.complete, true);
  const heldout = await runClefEvaluation({
    live: true,
    partition: "holdout",
    maxCalls: 40,
    maxCostUsd: "0.05",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher,
    frozenDevelopment: development,
  });
  assert.equal(heldout.complete, true);
  assert.equal(heldout.networkCalls, 38);
  assert.equal(heldout.metricsByPartition.development.total, 0);
  assert.equal(heldout.metricsByPartition.holdout.total, 40);
  assert.equal(
    heldout.developmentThresholdSweep.every((row) => row.metrics.total === 0),
    true,
  );
  for (const mutation of [
    { ...development, protocolSha256: "changed" },
    {
      ...development,
      thresholds: { negativeThreshold: 0.1, positiveThreshold: 0.49 },
    },
    {
      ...development,
      thresholds: { negativeThreshold: 0.05, positiveThreshold: 0.9 },
    },
    { ...development, complete: false },
    { ...development, metrics: { ...development.metrics, errors: 1 } },
  ]) {
    let auth = 0;
    await assert.rejects(
      runClefEvaluation({
        live: true,
        partition: "holdout",
        maxCalls: 40,
        maxCostUsd: "0.05",
        accountId: "a".repeat(32),
        getToken: async () => {
          auth++;
          return "synthetic-token";
        },
        fetcher,
        frozenDevelopment: mutation,
      }),
      /FROZEN_DEVELOPMENT/,
    );
    assert.equal(auth, 0);
  }
});

test("CLEF-ACCURACY-02 matching recorded development sweep freezes threshold-only candidate without new development calls", async () => {
  const fetcher = async () =>
    Response.json({
      success: true,
      result: {
        model: "clef",
        answers: {
          documentType: {
            type: "choice",
            choice: "invoice",
            probabilities: { invoice: 1 },
            confidence: 1,
          },
          receipt: { type: "noul", noul: 0.97 },
          category: {
            type: "choice",
            choice: "other",
            probabilities: { other: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
  const measured = await runClefEvaluation({
    live: true,
    partition: "development",
    maxCalls: 80,
    maxCostUsd: "0.10",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher,
  });
  const oldThresholdReport = {
    ...measured,
    thresholds: { ...measured.thresholds, positiveThreshold: 0.95 },
  };
  const heldout = await runClefEvaluation({
    live: true,
    partition: "holdout",
    maxCalls: 1,
    maxCostUsd: "0.01",
    accountId: "a".repeat(32),
    getToken: async () => "synthetic-token",
    fetcher,
    frozenDevelopment: oldThresholdReport,
  });
  assert.equal(heldout.networkCalls, 1);
  assert.equal(
    heldout.frozenDevelopmentRouting.origin,
    "recorded-development-threshold-sweep",
  );
  assert.deepEqual(heldout.frozenDevelopmentRouting.measurementThresholds, {
    negativeThreshold: 0.1,
    positiveThreshold: 0.95,
  });
  assert.deepEqual(heldout.frozenDevelopmentRouting.selectedThresholds, {
    negativeThreshold: 0.1,
    positiveThreshold: 0.9,
  });
  const tampered = structuredClone(oldThresholdReport);
  tampered.developmentThresholdSweep.find(
    (row) => row.positiveThreshold === 0.9,
  ).metrics.falsePositives = 0;
  let auth = 0;
  await assert.rejects(
    runClefEvaluation({
      live: true,
      partition: "holdout",
      maxCalls: 1,
      maxCostUsd: "0.01",
      accountId: "a".repeat(32),
      getToken: async () => {
        auth++;
        return "synthetic-token";
      },
      fetcher,
      frozenDevelopment: tampered,
    }),
    /FROZEN_DEVELOPMENT/,
  );
  assert.equal(auth, 0);
});

test("CLEF-TYPE offline threshold sweep preserves explicit document type routing", () => {
  const table = analyzeDevelopmentThresholds([
    {
      partition: "development",
      expected: "non-document",
      outcome: "uncertain",
      receiptProbability: 0.97,
      documentType: {
        type: "choice",
        choice: "delivery",
        probabilities: { delivery: 1 },
        confidence: 1,
      },
    },
    {
      partition: "development",
      expected: "non-document",
      outcome: "non-document",
      receiptProbability: 0.45,
      documentType: {
        type: "choice",
        choice: "delivery",
        probabilities: { delivery: 1 },
        confidence: 1,
      },
    },
  ]);
  const metrics = table.find((row) => row.positiveThreshold === 0.9).metrics;
  assert.equal(metrics.falsePositives, 0);
  assert.equal(metrics.trueNegatives, 1);
  assert.equal(metrics.negativeReviews, 1);
});

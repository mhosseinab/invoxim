import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import classificationConfiguration from "../../config/ai.classification.production.json" with { type: "json" };
import {
  buildDecisionRequest,
  RECEIPT_DECISION_POLICY_VERSION as CLEF_RECEIPT_POLICY_VERSION,
  parseDecisionResponse,
  routeDecisionDocument as routeClefDocument,
} from "../../packages/adapters/src/ai/decision-protocol.ts";

// Same Clef identity as packages/adapters/src/ai/clef-protocol.ts; the
// provider-neutral protocol module is self-contained so Node can load it.
const buildClefRequest = (parts) => buildDecisionRequest(parts, "clef");
const parseClefResponse = (raw) =>
  parseDecisionResponse(raw, ["clef", "@cf/cloudflare/clef"]);

const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 16384;
if (
  classificationConfiguration.model !== "@cf/cloudflare/clef" ||
  classificationConfiguration.pricing.approved !== true ||
  !/^[0-9]{1,15}$/.test(
    classificationConfiguration.pricing.inputUsdMicrosPerMillion,
  )
)
  throw new Error("INVALID_EVALUATION_CONFIGURATION");
const RATE_MICROS_PER_MILLION = BigInt(
  classificationConfiguration.pricing.inputUsdMicrosPerMillion,
);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cost = (tokens) =>
  (BigInt(tokens) * RATE_MICROS_PER_MILLION + 999999n) / 1000000n;
const ratio = (numerator, denominator) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});
export async function loadClefCorpus() {
  const load = (name) =>
    readFile(
      new URL(`../../test-design/fixtures/clef-${name}.json`, import.meta.url),
      "utf8",
    ).then(JSON.parse);
  const manifest = await load("manifest");
  const development = await load("development");
  const holdout = await load("holdout");
  const ids = new Set();
  for (const [name, data] of [
    ["development", development],
    ["holdout", holdout],
  ]) {
    if (
      data.synthetic !== true ||
      digest(data) !== manifest.partitions[name].sha256 ||
      data.cases.length !== manifest.partitions[name].cases
    )
      throw new Error("CORPUS_HASH_MISMATCH");
    for (const c of data.cases) {
      if (
        ids.has(c.id) ||
        c.partition !== name ||
        !["candidate", "non-document", "review"].includes(c.expected) ||
        !["en", "de"].includes(c.language) ||
        !Array.isArray(c.parts) ||
        c.parts.length > 64 ||
        c.parts.some(
          (p) =>
            typeof p.id !== "string" ||
            typeof p.text !== "string" ||
            !p.text.trim(),
        ) ||
        (c.parts.length === 0) !== c.unreadableDocument
      )
        throw new Error("INVALID_CORPUS_CASE");
      ids.add(c.id);
    }
  }
  return { development: development.cases, holdout: holdout.cases, manifest };
}
export function summarizeClefResults(rows) {
  const n = (expected, outcome) =>
    rows.filter((r) => r.expected === expected && r.outcome === outcome).length;
  const truePositives = n("candidate", "candidate"),
    falsePositives = n("non-document", "candidate"),
    trueNegatives = n("non-document", "non-document"),
    falseNegatives = n("candidate", "non-document");
  const positiveReviews =
      n("candidate", "uncertain") + n("candidate", "review"),
    negativeReviews =
      n("non-document", "uncertain") + n("non-document", "review"),
    unsupportedReviews = n("review", "review");
  const positives = rows.filter((r) => r.expected === "candidate").length;
  const decidable = rows.filter((r) => r.expected !== "review").length;
  return {
    total: rows.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    positiveReviews,
    negativeReviews,
    unsupportedReviews,
    errors: rows.filter((r) => r.outcome === "error").length,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, positives),
    decisionCoverage: ratio(
      truePositives + falsePositives + trueNegatives + falseNegatives,
      decidable,
    ),
    reviewRate: ratio(
      positiveReviews + negativeReviews + unsupportedReviews,
      rows.length,
    ),
  };
}
function routeSavedDecision(row, options) {
  const parsed = parseClefResponse({
    model: "clef",
    answers: {
      receipt: { type: "noul", noul: row.receiptProbability },
      documentType: row.documentType,
      category: {
        type: "choice",
        choice: "uncategorized",
        probabilities: { uncategorized: 1 },
        confidence: 1,
      },
    },
  });
  return parsed ? clefOutcome(routeClefDocument(parsed, options)) : "uncertain";
}
function clefOutcome(result) {
  return typeof result === "string" ? result : result.outcome;
}
export function analyzeDevelopmentThresholds(rows) {
  const development = rows.filter((row) => row.partition === "development");
  return [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((positiveThreshold) => ({
    positiveThreshold,
    negativeThreshold: classificationConfiguration.negativeThreshold,
    notice:
      "Post-hoc development routing only; not calibrated confidence or held-out quality.",
    metrics: summarizeClefResults(
      development.map((row) => ({
        ...row,
        outcome:
          typeof row.receiptProbability === "number" &&
          Number.isFinite(row.receiptProbability)
            ? routeSavedDecision(row, {
                positiveThreshold,
                negativeThreshold:
                  classificationConfiguration.negativeThreshold,
              })
            : row.outcome,
      })),
    ),
  }));
}
function validateDevelopmentFreeze(report, base, cases) {
  const fail = () => {
    throw new Error("FROZEN_DEVELOPMENT_REQUIRED_OR_MISMATCHED");
  };
  if (
    report?.mode !== "live-synthetic" ||
    report.partition !== "development" ||
    report.complete !== true ||
    report.metrics?.errors !== 0 ||
    report.protocolSha256 !== base.protocolSha256 ||
    ["development", "holdout"].some(
      (name) =>
        report.partitionHashes?.[name]?.sha256 !==
        base.partitionHashes[name].sha256,
    ) ||
    !Array.isArray(report.results) ||
    report.results.length !== cases.length
  )
    fail();
  if (
    typeof report.thresholds?.negativeThreshold !== "number" ||
    report.thresholds.negativeThreshold < 0 ||
    report.thresholds.negativeThreshold > 0.1 ||
    typeof report.thresholds?.positiveThreshold !== "number" ||
    report.thresholds.positiveThreshold < 0.5 ||
    report.thresholds.positiveThreshold > 1
  )
    fail();
  const ids = new Set();
  for (const row of report.results) {
    const source = cases.find((c) => c.id === row.id);
    if (
      !source ||
      ids.has(row.id) ||
      row.partition !== "development" ||
      row.expected !== source.expected
    )
      fail();
    ids.add(row.id);
    if (
      source.parts.length &&
      (!Number.isFinite(row.receiptProbability) ||
        row.receiptProbability < 0 ||
        row.receiptProbability > 1)
    )
      fail();
    const expectedOutcome = source.parts.length
      ? routeSavedDecision(row, report.thresholds)
      : "review";
    if (row.outcome !== expectedOutcome) fail();
  }
  if (
    JSON.stringify(report.metrics) !==
    JSON.stringify(summarizeClefResults(report.results))
  )
    fail();
  if (JSON.stringify(report.thresholds) === JSON.stringify(base.thresholds))
    return {
      origin: "measured-routing",
      measurementThresholds: report.thresholds,
      selectedThresholds: base.thresholds,
    };
  if (
    report.thresholds?.negativeThreshold !== base.thresholds.negativeThreshold
  )
    fail();
  const selected = report.developmentThresholdSweep?.find(
    (row) =>
      row.negativeThreshold === base.thresholds.negativeThreshold &&
      row.positiveThreshold === base.thresholds.positiveThreshold,
  );
  const computed = analyzeDevelopmentThresholds(report.results).find(
    (row) => row.positiveThreshold === base.thresholds.positiveThreshold,
  );
  if (
    !selected ||
    !computed ||
    JSON.stringify(selected.metrics) !== JSON.stringify(computed.metrics)
  )
    fail();
  return {
    origin: "recorded-development-threshold-sweep",
    measurementThresholds: report.thresholds,
    selectedThresholds: base.thresholds,
  };
}
function usdMicros(value) {
  if (typeof value !== "string" || !/^0\.(?:\d{1,6})$/.test(value))
    throw new Error("INVALID_COST_CAP");
  const result = BigInt(value.slice(2).padEnd(6, "0"));
  if (result < 1n || result > 500000n) throw new Error("INVALID_COST_CAP");
  return result;
}
async function readResponse(response) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error("PROVIDER_HTTP");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("PROVIDER_BODY");
  const data = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0,
    chunks = 0,
    empty = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        ++chunks > 4096 ||
        (value.length === 0 && ++empty > 32) ||
        length + value.length > MAX_RESPONSE_BYTES
      )
        throw new Error("PROVIDER_BODY_LIMIT");
      data.set(value, length);
      length += value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        data.subarray(0, length),
      ),
    );
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error("PROVIDER_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}
export async function runClefEvaluation(options = {}) {
  const {
    live = false,
    partition = "all",
    maxCalls = 120,
    maxCostUsd = "0.30",
    fetcher = fetch,
    getToken = wranglerToken,
    accountId,
    signal,
    frozenDevelopment,
  } = options;
  if (
    !["development", "holdout", "all"].includes(partition) ||
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 240
  )
    throw new Error("INVALID_EVALUATION_OPTIONS");
  if (live && partition === "all")
    throw new Error("EXPLICIT_LIVE_PARTITION_REQUIRED");
  const cap = usdMicros(maxCostUsd);
  const corpus = await loadClefCorpus();
  const cases =
    partition === "all"
      ? [...corpus.development, ...corpus.holdout]
      : corpus[partition];
  let plannedCalls = 0,
    worstCase = 0n;
  const prepared = cases.map((c) => {
    if (!c.parts.length) return { c, body: null, reserve: 0n };
    const body = JSON.stringify(buildClefRequest(c.parts));
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_REQUEST_BYTES) throw new Error("REQUEST_BYTES_LIMIT");
    if (plannedCalls >= maxCalls)
      return { c, body: null, reserve: 0n, omitted: true };
    plannedCalls++;
    // Text-only conservative byte/token upper estimate, including complete questions and envelope.
    const reserve = cost(bytes + 1024);
    worstCase += reserve;
    return { c, body, reserve };
  });
  if (worstCase > cap) throw new Error("COST_CAP_BEFORE_REQUEST");
  const base = {
    schemaVersion: 1,
    mode: live ? "live-synthetic" : "dry-run",
    model: "@cf/cloudflare/clef",
    policyVersion: CLEF_RECEIPT_POLICY_VERSION,
    protocolSha256: digest(buildClefRequest([])),
    datasetVersion: corpus.manifest.datasetVersion,
    partition,
    partitionHashes: corpus.manifest.partitions,
    totalCases: cases.length,
    plannedCalls,
    maxCalls,
    maxCostUsd,
    worstCaseUsdMicros: String(worstCase),
    maxRequestBytes: MAX_REQUEST_BYTES,
    timeoutMs: 30000,
    thresholds: {
      negativeThreshold: classificationConfiguration.negativeThreshold,
      positiveThreshold: classificationConfiguration.positiveThreshold ?? 0.9,
    },
    tariff: {
      version: classificationConfiguration.pricing.version,
      checkedAt: classificationConfiguration.pricing.checkedAt,
      inputUsdMicrosPerMillion: String(RATE_MICROS_PER_MILLION),
    },
  };
  const freeze =
    live && partition === "holdout"
      ? validateDevelopmentFreeze(frozenDevelopment, base, corpus.development)
      : null;
  if (!live)
    return {
      ...base,
      networkCalls: 0,
      spentUsdMicros: "0",
      metrics: null,
      complete: false,
    };
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId))
    throw new Error("CLOUDFLARE_ACCOUNT_REQUIRED");
  const token = await getToken();
  if (typeof token !== "string" || !token || /[\r\n]/.test(token))
    throw new Error("CLOUDFLARE_AUTH_REQUIRED");
  const results = [];
  let networkCalls = 0,
    spent = 0n,
    uncertainReserve = 0n,
    stopReason = null;
  const started = Date.now();
  const runDeadline = AbortSignal.timeout(1200000);
  for (const { c, body, reserve, omitted } of prepared) {
    if (omitted) continue;
    if (signal?.aborted || Date.now() - started >= 1200000) {
      stopReason = "canceled-or-deadline";
      break;
    }
    const row = {
      id: c.id,
      partition: c.partition,
      language: c.language,
      family: c.family,
      expected: c.expected,
    };
    if (!body) {
      results.push({
        ...row,
        outcome: "review",
        reason: "unreadable-document",
        latencyMs: 0,
      });
      continue;
    }
    if (networkCalls >= maxCalls || spent + uncertainReserve + reserve > cap) {
      stopReason = "cost-or-call-cap";
      break;
    }
    networkCalls++;
    uncertainReserve += reserve;
    const began = Date.now();
    const timeout = AbortSignal.timeout(30000);
    const requestSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      timeout,
      runDeadline,
    ]);
    try {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          redirect: "error",
          signal: requestSignal,
          body,
        },
      );
      const envelope = await readResponse(response);
      const answer =
        envelope?.success === true ? parseClefResponse(envelope.result) : null;
      if (!answer) throw new Error("PROVIDER_SCHEMA");
      const usage = answer.usage;
      if (usage) {
        const actual = cost(usage.input_tokens);
        uncertainReserve -= reserve;
        spent += actual;
        if (actual > reserve) {
          stopReason = "usage-exceeded-reservation";
        }
      }
      results.push({
        ...row,
        outcome: clefOutcome(
          routeClefDocument(answer, classificationConfiguration),
        ),
        receiptProbability: answer.answers.receipt.noul,
        documentType: answer.answers.documentType,
        category: answer.answers.category.choice,
        usage: usage ?? null,
        latencyMs: Date.now() - began,
      });
      if (stopReason) break;
    } catch {
      results.push({
        ...row,
        outcome: "error",
        reason: requestSignal.aborted
          ? "timeout-or-canceled"
          : "provider-error",
        latencyMs: Date.now() - began,
      });
      // No retry; an error may still be billed, so retain its full reservation.
      stopReason = requestSignal.aborted
        ? "timeout-or-canceled"
        : "provider-error";
      break;
    }
  }
  return {
    ...base,
    networkCalls,
    spentUsdMicros: String(spent),
    uncertainReservedUsdMicros: String(uncertainReserve),
    complete: results.length === cases.length,
    stopReason,
    elapsedMs: Date.now() - started,
    metrics: summarizeClefResults(results),
    developmentThresholdSweep: analyzeDevelopmentThresholds(results),
    frozenDevelopmentRouting: freeze,
    frozenDevelopmentProtocolSha256:
      partition === "holdout" ? frozenDevelopment.protocolSha256 : null,
    metricsByPartition: {
      development: summarizeClefResults(
        results.filter((row) => row.partition === "development"),
      ),
      holdout: summarizeClefResults(
        results.filter((row) => row.partition === "holdout"),
      ),
    },
    results,
  };
}
async function wranglerToken() {
  try {
    const { stdout } = await promisify(execFile)(
      "pnpm",
      [
        "--filter",
        "@invoxim/worker",
        "exec",
        "wrangler",
        "auth",
        "token",
        "--json",
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: "/dev/null",
          WRANGLER_SEND_METRICS: "false",
        },
        timeout: 30000,
        maxBuffer: 16384,
      },
    );
    const result = JSON.parse(stdout);
    if (
      !["oauth", "api_token"].includes(result.type) ||
      typeof result.token !== "string"
    )
      throw new Error("AUTH");
    return result.token;
  } catch {
    throw new Error("WRANGLER_AUTH_UNAVAILABLE");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2),
    options = {};
  let out, frozenDevelopmentPath;
  try {
    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--live":
          options.live = true;
          break;
        case "--wrangler-auth":
          options.getToken = wranglerToken;
          break;
        case "--frozen-development":
          frozenDevelopmentPath = args[++i];
          break;
        case "--account-id":
          options.accountId = args[++i];
          break;
        case "--partition":
          options.partition = args[++i];
          break;
        case "--max-calls":
          options.maxCalls = Number(args[++i]);
          break;
        case "--max-cost-usd":
          options.maxCostUsd = args[++i];
          break;
        case "--out":
          out = args[++i];
          break;
        default:
          throw new Error("UNKNOWN_EVALUATION_ARGUMENT");
      }
    }
    if (options.live && !args.includes("--max-cost-usd"))
      throw new Error("EXPLICIT_LIVE_COST_CAP_REQUIRED");
    if (frozenDevelopmentPath) {
      const data = await readFile(frozenDevelopmentPath, "utf8");
      if (Buffer.byteLength(data) > 262144)
        throw new Error("FROZEN_DEVELOPMENT_REQUIRED_OR_MISMATCHED");
      options.frozenDevelopment = JSON.parse(data);
    }
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const report = await runClefEvaluation({
      ...options,
      signal: controller.signal,
    });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (out) await writeFile(out, text);
    else process.stdout.write(text);
  } catch (error) {
    const codes = new Set([
      "CORPUS_HASH_MISMATCH",
      "INVALID_CORPUS_CASE",
      "INVALID_EVALUATION_OPTIONS",
      "INVALID_COST_CAP",
      "COST_CAP_BEFORE_REQUEST",
      "REQUEST_BYTES_LIMIT",
      "CLOUDFLARE_ACCOUNT_REQUIRED",
      "CLOUDFLARE_AUTH_REQUIRED",
      "WRANGLER_AUTH_UNAVAILABLE",
      "UNKNOWN_EVALUATION_ARGUMENT",
      "EXPLICIT_LIVE_COST_CAP_REQUIRED",
      "EXPLICIT_LIVE_PARTITION_REQUIRED",
      "FROZEN_DEVELOPMENT_REQUIRED_OR_MISMATCHED",
    ]);
    console.error(
      codes.has(error?.message) ? error.message : "EVALUATION_FAILED",
    );
    process.exitCode = 1;
  }
}
